/**
 * Host-side voice controller.
 * The page owns the pin gesture. This decides whether the microphone feeds the
 * wake word or a command, and which sentence the speaker may play.
 * The child process only captures, recognizes, synthesizes, and plays.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isDismiss, isInterject, normalizeUtterance } from '@dsh-orb/voice/dismiss'
import { createIdle, stepIdle, type IdleClock } from '@dsh-orb/voice/idle'
import { holdsDevice, listenMode, transcribing, type ListenMode } from '@dsh-orb/voice/listen'
import {
  bodyBusy,
  createQueue,
  localBusy,
  queueView,
  reduceQueue,
  voiceHold,
  type QueueEffect,
  type QueueEvent,
  type QueueState,
} from '@dsh-orb/voice/queue'
import { hasWakeWord, ttsReady, type VoiceSettings } from '@dsh-orb/voice/settings'

export interface VoicePresence {
  readonly wake: boolean
  readonly asr: boolean
  readonly tts: boolean
}

export interface VoicePageMessage {
  readonly type: 'pin' | 'unpin' | 'voice-hold' | 'voice-prompt' | 'voice-mode' | 'voice-level' | 'voice-speech'
  readonly hold?: boolean
  readonly text?: string
  readonly mode?: ListenMode
  readonly value?: number
  /** `voice-speech`: a VAD speech segment is open and this audio is going to ASR. */
  readonly open?: boolean
}

export interface VoiceLink {
  send(message: unknown): void
  close(): void
  onMessage(handler: (message: unknown) => void): void
  onExit(handler: () => void): void
}

export interface VoiceControllerOptions {
  settings(): VoiceSettings
  /** Model files on disk. A missing model turns that column off without changing the switch. */
  presence(): VoicePresence
  now(): number
  /** Model directories. Absent until the host knows where DeepSeek Harness keeps them. */
  paths?(): { kws: string, asrModel: string, asrTokens: string, asrVad: string, tts: string }
  send(message: VoicePageMessage): void
  /** Fork the voice child. Undefined means this host has no voice runtime. */
  open(): VoiceLink | undefined
  /** 插话原话。orb 会硬停旧轮，再把这句话当作新任务发送。 */
  interject?(text: string): void
  /** 和点「停止」相同的执行停止。没有在执行时不做事。 */
  stopTurn?(): void
}

const RESTART_LIMIT = 3

const VOICE_DEBUG_MARKER = join(tmpdir(), 'dsh-orb-voice-debug.on')
const VOICE_DEBUG_LOG = join(tmpdir(), 'dsh-orb-voice-debug.log')

/** Opt-in tracing for "the answer is on screen but nothing is spoken" reports. */
function debug(message: string): void {
  if (!existsSync(VOICE_DEBUG_MARKER)) return
  try {
    appendFileSync(VOICE_DEBUG_LOG, `${new Date().toISOString()} host ${message}\n`)
  } catch {
    // Diagnostics must never take speech down.
  }
}

type BlockOrder = readonly [turn: number, step: number, index: number]

/** `b:turn:step:index` is the orb's assistant block key. Test-only keys parse to undefined. */
function blockOrder(key: string): BlockOrder | undefined {
  const match = /^b:(\d+):(\d+):(\d+)$/.exec(key)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareBlockOrder(left: BlockOrder, right: BlockOrder): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

export class VoiceController {
  private queue: QueueState = createQueue(false)
  private idle: IdleClock = createIdle()
  private link: VoiceLink | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private live = false
  private closing = false
  private restarts = 0
  private failed = false
  private pinned = false
  private agentBusy = false
  private questionOpen = false
  private speechOpen = false
  private micOpen = false
  private micKnown = false
  private mode: ListenMode = 'off'
  /** 子进程最近一次采集带不带回声消除。还没收到 mic 时按没有算。 */
  private echoCancel = false
  /** 上次发给子进程的设备占用。提问卡关掉后重新打开时用来把种子清零。 */
  private device = false
  /** 停止或退下之后，被停的那一轮剩下的正文都不播，直到下一轮开始。 */
  private muted = false
  /** 停止或退下已经发出、执行还没真正停下。这段时间不听。 */
  private stopping = false
  /** 插话那一刻正在进行的步（`b:${turn}:${step}`）。这些步里的正文只上屏，不出声。 */
  private readonly silencedSteps = new Set<string>()
  /**
   * Audio from just before a command starts, kept so the first syllable survives the switch.
   * Factory 300; one wake with a spoken reply uses zero so that reply is not echoed.
   */
  private commandSeed = 300
  /** The child heard the interject keyword; TTS is stopped and the command is coming. */
  private bargePending = false
  private bargeMuted = false
  private bargeTimer: ReturnType<typeof setTimeout> | undefined
  private hold = false
  private seen = new Map<string, string>()
  /** The assistant block currently streaming; a new key starts a new block. */
  private assistantKey: string | undefined
  /** Keys that belonged to a previous turn; late updates must not reach the new queue. */
  private staleKeys = new Set<string>()

  constructor(private readonly options: VoiceControllerOptions) {
    this.queue = createQueue(this.ttsOn())
  }

  /**
   * The master switch gates the three columns without rewriting them. The stored column
   * switches keep their values, so turning voice back on restores the user's combination.
   * Reads that do not drive voice behavior (the idle clock) still get the raw values.
   */
  private settings(): VoiceSettings {
    const settings = this.options.settings()
    if (settings.voiceEnabled !== false) return settings
    return {
      ...settings,
      wakeEnabled: false,
      commandEnabled: false,
      ttsEnabled: false,
    }
  }

  /**
   * Start the child. A second call while it is up does nothing.
   *
   * `initial` is the state of the ball when this lifecycle starts. The helper is freshly
   * launched and its page starts unpinned, so the pin is always false here; a turn or a
   * question can already exist when the ball is switched back on.
   */
  start(initial: { agentBusy?: boolean, questionOpen?: boolean } = {}): void {
    if (this.live) return
    this.fresh(initial)
    this.launchChild()
  }

  /**
   * Stop the child for this lifecycle. A later {@link start} is a new lifecycle: it must
   * not inherit `closing` or a spent restart budget, or switching the ball off and on
   * would leave voice dead until the whole app restarts.
   */
  close(): void {
    this.clearBarge()
    this.closing = true
    this.live = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.link?.close()
    this.link = undefined
    this.resetPlayback()
    this.micOpen = false
    this.micKnown = false
    this.echoCancel = false
    this.device = false
    this.mode = 'off'
    this.hold = false
    this.setSpeech(false)
    this.options.send({ type: 'voice-hold', hold: false })
    this.options.send({ type: 'voice-mode', mode: 'off' })
    this.options.send({ type: 'voice-level', value: 0 })
  }

  /**
   * Null until the child reports, or while the current pin/turn state does not need
   * an open microphone. False means the device is needed but could not be opened.
   */
  microphone(): boolean | null {
    if (!this.deviceWanted()) return null
    if (!this.live || !this.micKnown) return null
    return this.micOpen
  }

  /**
   * Whether the current pin/turn state has a column that can actually listen.
   * A wake-only ball is released while pinned, and a command-only ball while
   * collapsed, so the system does not show a microphone no decoder reads.
   */
  private deviceWanted(settings = this.settings(), presence = this.options.presence()): boolean {
    return holdsDevice({
      wakeEnabled: settings.wakeEnabled,
      wakeWords: settings.wakeWords,
      wakeModel: presence.wake,
      commandEnabled: settings.commandEnabled,
      asrModel: presence.asr,
      pinned: this.pinned,
      agentBusy: this.agentBusy,
      questionOpen: this.questionOpen,
      bodyBusy: bodyBusy(this.queue),
      interjectEnabled: this.interjectEnabled(),
      echoCancel: this.echoCancel,
    })
  }

  /** Whether the page should keep the panel up and the stop button for a closing line or prompt. */
  holdState(): boolean {
    return this.hold
  }

  /** The settings file changed. Switches take effect without reloading a model. */
  applySettings(): void {
    debug(`apply-settings live=${this.live} tts=${this.ttsOn()} enabled=${this.queue.enabled}`)
    if (!this.live) return
    const enabled = this.ttsOn()
    if (enabled !== this.queue.enabled) this.apply({ type: 'enabled', enabled })
    this.pushConfigure()
    this.pushListen(true)
    this.poll()
  }

  /** The page owns the gesture; keep the state even while the child is restarting. */
  setPinned(pinned: boolean): void {
    if (this.pinned === pinned) return
    this.pinned = pinned
    if (!pinned) this.idle = createIdle()
    this.pushListen(false)
    this.poll()
  }

  /** A keystroke, or a text command that was just sent. */
  activity(): void {
    if (!this.live) return
    const step = stepIdle(this.idle, { ...this.sample(), activity: true })
    this.idle = step.clock
  }

  beginTurn(): void {
    debug('beginTurn')
    this.agentBusy = true
    this.muted = false
    this.stopping = false
    this.silencedSteps.clear()
    this.assistantKey = undefined
    // Anything already seen belongs to an older turn. Late updates for those blocks
    // must not leak into the new queue.
    this.staleKeys = new Set(this.seen.keys())
    // A new command owns the speaker: stop the previous closing and drop its queue before
    // the first sentence of this turn arrives.
    this.apply({ type: 'stop' })
    if (this.live) this.link?.send({ type: 'stop-speak', id: 'new-turn' })
    this.pushListen(false)
    this.poll()
  }

  /**
   * A new user command arrived while the old turn may still be running. Stop the old
   * speaker immediately and keep the old turn's remaining text silent until {@link beginTurn}.
   */
  prepareNewTurn(): void {
    debug('prepareNewTurn')
    this.muted = true
    this.stopping = this.agentBusy
    this.assistantKey = undefined
    this.apply({ type: 'stop' })
    if (this.live) this.link?.send({ type: 'stop-speak', id: 'new-turn' })
    this.pushListen(false)
    this.poll()
  }

  /** The turn's assistant text is already in the queue. Fold the tail into a closing line. */
  endTurn(): void {
    debug(`endTurn live=${this.live} agentBusy=${this.agentBusy}`)
    this.agentBusy = false
    this.stopping = false
    // With no live child there is no speaker to drain; queueing here would leave a
    // `playing` item that never ends after the restart.
    if (!this.live) {
      this.pushListen(false)
      return
    }
    this.apply({ type: 'turn-end' })
    this.poll()
  }

  /** Full assistant text for one block. Only the newly arrived suffix is spoken. */
  noteAssistant(key: string, text: string): void {
    if (this.staleKeys.has(key)) {
      debug(`stale key=${key}`)
      return
    }
    if (this.assistantKey !== undefined && this.assistantKey !== key) {
      const previous = blockOrder(this.assistantKey)
      const next = blockOrder(key)
      if (previous !== undefined && next !== undefined && compareBlockOrder(next, previous) <= 0) {
        // Settled blocks can arrive out of order at turn end. An old block must not clear
        // the newest block's held tail; only a strictly newer block starts a new segment.
        debug(`skip-old key=${key} newest=${this.assistantKey}`)
        return
      }
      // A new assistant block supersedes anything the previous block left in the holding
      // area. The sentence already playing caught the speaker and keeps going.
      this.apply({ type: 'block' })
    }
    this.assistantKey = key
    const previous = this.seen.get(key) ?? ''
    const starts = text.startsWith(previous)
    // Track text even while the child is restarting; otherwise the first update after the
    // restart would feed the whole block to the speaker again.
    this.seen.set(key, text)
    const silenced = this.silencedSteps.has(stepOf(key))
    debug(`note key=${key} prev=${previous.length} next=${text.length} starts=${starts} muted=${this.muted} silenced=${silenced} live=${this.live} enabled=${this.queue.enabled}`)
    if (this.muted || silenced) return
    // A settled message may rewrite what was streamed (formatting, a trimmed prefix, a
    // retry). Requiring startsWith used to drop the whole final answer with no sound.
    let delta = ''
    if (starts) {
      delta = text.slice(previous.length)
    } else {
      let common = 0
      const limit = Math.min(previous.length, text.length)
      while (common < limit && previous[common] === text[common]) common += 1
      delta = text.slice(common)
      debug(`rewrite common=${common} speak=${delta.length}`)
    }
    if (delta && this.live) this.apply({ type: 'text', text: delta })
  }

  tool(): void {
    if (!this.live) return
    this.apply({ type: 'tool' })
  }

  questionOpened(): void {
    this.questionOpen = true
    // Without a live child the card still closes the ears once the child is back; there is
    // no speaker to queue the prompt for yet.
    if (!this.live) {
      this.pushListen(false)
      return
    }
    this.apply({ type: 'question', text: this.settings().questionPrompt })
    this.poll()
  }

  questionClosed(): void {
    if (!this.questionOpen) return
    this.questionOpen = false
    if (!this.live) {
      this.pushListen(false)
      return
    }
    this.apply({ type: 'question-closed' })
    this.poll()
  }

  /** Stop button: drop speech. The caller stops the agent turn separately when one is running. */
  haltSpeech(): void {
    debug(`haltSpeech live=${this.live} busy=${this.agentBusy}`)
    // Remember the mute before the liveness check. A child that is restarting must not
    // speak the rest of the stopped turn once it comes back.
    if (this.agentBusy) {
      this.muted = true
      this.stopping = true
    }
    if (!this.live) return
    this.apply({ type: 'stop' })
    this.poll()
  }

  /** The panel moved to another conversation. */
  clearSession(): void {
    this.seen.clear()
    this.assistantKey = undefined
    this.staleKeys.clear()
    this.muted = false
    this.stopping = false
    this.silencedSteps.clear()
    this.questionOpen = false
    this.agentBusy = false
    if (!this.live) {
      this.pushListen(false)
      return
    }
    this.apply({ type: 'stop' })
    this.poll()
  }

  /** Advance the idle clock. Tests call this instead of waiting. */
  poll(): void {
    if (!this.live) return
    const step = stepIdle(this.idle, this.sample())
    this.idle = step.clock
    if (step.unpin) this.requestUnpin()
  }

  /** What the child was last told to listen for. Tests read this. */
  listenMode(): ListenMode {
    return this.mode
  }

  /** Whether the child has an open VAD speech segment. A reloaded page seeds its ASR lamp from this. */
  speaking(): boolean {
    return this.speechOpen
  }

  snapshot(): { hold: boolean, pinned: boolean, mode: ListenMode, queued: readonly string[] } {
    const view = queueView(this.queue)
    return {
      hold: this.hold,
      pinned: this.pinned,
      mode: this.mode,
      queued: [
        ...view.playing ? [view.playing.text] : [],
        ...view.queued.map((item) => item.text),
      ],
    }
  }

  private onChild(message: unknown): void {
    const record = asRecord(message)
    const type = record?.type
    if (type === 'mic') {
      this.micKnown = true
      this.micOpen = record?.open === true
      this.echoCancel = record?.aec === true
      debug(`mic open=${this.micOpen} aec=${this.echoCancel}`)
      this.pushListen(false)
      return
    }
    if (type === 'wake') {
      this.onWake()
      return
    }
    if (type === 'barge') {
      this.onBarge()
      return
    }
    if (type === 'speech') {
      // A late `speech: true` from a transcription mode that has already ended must not
      // pause the idle clock forever. A falling edge is what releases a listen change
      // that waited out the rest of the sentence.
      const open = record?.open === true
      this.setSpeech(open && transcribing(this.mode))
      if (!open) this.pushListen(false)
      this.poll()
      return
    }
    if (type === 'level' && typeof record?.value === 'number') {
      // The child measures the same microphone the page is waiting on. Forward it only
      // while transcription is open; never during wake or playback.
      if (transcribing(this.mode)) {
        const value = Math.max(0, Math.min(1, record.value))
        this.options.send({ type: 'voice-level', value })
      }
      return
    }
    if (type === 'utterance' && typeof record?.text === 'string') {
      this.onUtterance(record.text, record.mode, record.interject === true)
      return
    }
    if (type === 'playback' && typeof record?.id === 'string' && record.phase === 'end') {
      debug(`playback-end id=${record.id}`)
      this.apply({ type: 'playback-ended', id: record.id })
      this.poll()
    }
  }

  /**
   * Forward the VAD speech edge to the page's ASR lamp. The lamp means "this audio is being
   * fed to the recognizer", so a segment that opened before transcription ended must go dark
   * with the mode, and a repeated close must not send another message.
   */
  private setSpeech(open: boolean): void {
    if (this.speechOpen === open) return
    this.speechOpen = open
    this.options.send({ type: 'voice-speech', open })
  }

  private onBarge(): void {
    if (!this.live) return
    if (this.bargePending) return
    this.bargePending = true
    this.commandSeed = 0
    // Stop the speaker now; keep the turn alive until the command arrives. While
    // the command is being recognized, new body text must not start speaking
    // again.
    if (!this.muted) {
      this.muted = true
      this.bargeMuted = true
    }
    this.apply({ type: 'stop' })
    this.bargeTimer = setTimeout(() => {
      this.clearBarge()
      this.poll()
    }, 8000)
    debug('barge')
  }

  private clearBarge(): void {
    if (this.bargeTimer) clearTimeout(this.bargeTimer)
    this.bargeTimer = undefined
    this.bargePending = false
    if (this.bargeMuted) {
      this.bargeMuted = false
      this.muted = false
    }
  }

  private onWake(): void {
    if (this.mode !== 'wake') return
    this.clearBarge()
    this.pinned = true
    this.options.send({ type: 'pin' })
    const reply = this.localReply(this.settings().wakeReply)
    // The reply is about to play in the same room; do not hand its tail to the recognizer.
    this.commandSeed = reply ? 0 : 300
    if (reply) this.apply({ type: 'local', text: reply })
    else this.pushListen(false)
    this.poll()
  }

  private onUtterance(text: string, tagged: unknown, flagged = false): void {
    const mode: ListenMode = tagged === 'command' || tagged === 'interject' ? tagged : this.mode
    this.setSpeech(false)
    if (mode !== 'command' && mode !== 'interject') return this.poll()
    if (!this.canFinish(mode)) return this.poll()
    if (flagged && mode === 'interject') {
      this.clearBarge()
      const spoken = text.trim()
      if (spoken) this.interject(spoken)
      else this.poll()
      return
    }
    const settings = this.settings()
    if (mode === 'command') {
      const spoken = stripWakePrefix(text, settings.wakeWords)
      if (!spoken) return this.poll()
      if (isDismiss(spoken, settings.dismissPhrases)) return this.dismiss()
      this.options.send({ type: 'voice-prompt', text: spoken })
      this.activity()
      return this.poll()
    }
    // interject：用原话判，不去唤醒词前缀。否则「你好大肥鱼，……」会被剥掉关键词。
    const spoken = text.trim()
    if (isDismiss(spoken, settings.dismissPhrases)) return this.dismiss()
    if (isInterject(spoken, settings.interjectKeyword)) return this.interject(spoken)
    this.poll()
  }

  /** 开口之后出现了「硬性关掉」的情况，这句就不要了。只是执行结束、正文播完这种变化不算。 */
  private canFinish(mode: 'command' | 'interject'): boolean {
    if (this.questionOpen || this.stopping || localBusy(this.queue) || !this.micOpen) return false
    return mode === 'command' ? this.commandEnabled() : this.interjectEnabled()
  }

  private commandEnabled(): boolean {
    const settings = this.settings()
    return settings.commandEnabled && this.options.presence().asr
  }

  private interjectEnabled(): boolean {
    return this.commandEnabled() && normalizeUtterance(this.settings().interjectKeyword) !== ''
  }

  private dismiss(): void {
    this.clearBarge()
    debug(`dismiss busy=${this.agentBusy} live=${this.live}`)
    if (this.agentBusy) {
      this.muted = true
      this.stopping = true
      this.options.stopTurn?.()
    }
    this.apply({ type: 'stop' })
    const reply = this.localReply(this.settings().dismissReply)
    if (reply) this.apply({ type: 'local', text: reply })
    this.requestUnpin()
    this.poll()
  }

  private interject(text: string): void {
    this.clearBarge()
    debug(`interject busy=${this.agentBusy} live=${this.live}`)
    // The old turn is about to be cancelled. Re-entering transcription must not seed the
    // speaker tail of the task that is being stopped.
    this.commandSeed = 0
    if (this.agentBusy) {
      this.muted = true
      this.stopping = true
    }
    for (const key of this.seen.keys()) this.silencedSteps.add(stepOf(key))
    this.apply({ type: 'stop' })
    this.options.interject?.(text)
    this.poll()
  }

  /**
   * The hard interjection could not cancel the old turn. Undo the muted/stopping state
   * so the turn that is still running keeps speaking and listening.
   */
  resumeAfterInterjectFailure(): void {
    this.muted = false
    this.stopping = false
    this.commandSeed = 300
    this.silencedSteps.clear()
    if (!this.live) return
    this.pushListen(false)
    this.poll()
  }

  private onChildExit(link?: VoiceLink): void {
    // A replaced lifecycle closed this link; its late exit must not take the new one down.
    if (link !== undefined && link !== this.link) return
    debug(`child-exit closing=${this.closing} restarts=${this.restarts}`)
    this.link = undefined
    this.live = false
    this.micOpen = false
    this.micKnown = false
    this.echoCancel = false
    this.device = false
    this.setSpeech(false)
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.closing) return
    // The dead child will not send the playback end this queue is waiting for.
    // Clearing it here keeps the microphone from staying shut after a crash.
    this.resetPlayback()
    this.idle = createIdle()
    this.commandSeed = 300
    this.options.send({ type: 'voice-mode', mode: 'off' })
    this.restartChild()
  }

  /** A new lifecycle starts with no inherited queue, pin, speech edge, or restart budget. */
  private fresh(initial: { agentBusy?: boolean, questionOpen?: boolean }): void {
    this.clearBarge()
    this.closing = false
    this.restarts = 0
    this.failed = false
    this.pinned = false
    this.agentBusy = initial.agentBusy === true
    this.questionOpen = initial.questionOpen === true
    this.setSpeech(false)
    this.micOpen = false
    this.micKnown = false
    this.echoCancel = false
    this.device = false
    this.mode = 'off'
    this.commandSeed = 300
    this.hold = false
    this.idle = createIdle()
    this.assistantKey = undefined
    this.staleKeys.clear()
    // `seen` follows the displayed conversation, not the child lifecycle. Clearing it here
    // would make the first block update after a ball toggle replay a whole assistant answer.
    this.queue = createQueue(this.ttsOn())
    this.options.send({ type: 'voice-hold', hold: false })
    this.options.send({ type: 'voice-mode', mode: 'off' })
    this.options.send({ type: 'voice-level', value: 0 })
  }

  private launchChild(): void {
    if (this.live) return
    let link: VoiceLink | undefined
    try {
      link = this.options.open()
    } catch {
      link = undefined
    }
    if (link === undefined) {
      debug('launch failed: no link')
      this.failed = true
      this.mode = 'off'
      return
    }
    this.live = true
    this.link = link
    debug(`launch ok tts=${this.ttsOn()}`)
    // A settings edit during a crash/restart may have changed whether speech is allowed.
    const enabled = this.ttsOn()
    if (enabled !== this.queue.enabled) this.queue = createQueue(enabled)
    // Messages and exits from a link that a later lifecycle replaced must be ignored.
    link.onMessage((message) => { if (this.link === link) this.onChild(message) })
    this.timer = setInterval(() => this.poll(), 250)
    this.timer.unref()
    link.onExit(() => this.onChildExit(link))
    this.pushConfigure()
    this.pushListen(true)
  }

  /** A crashed child gets a fresh process, up to the documented limit. */
  private restartChild(): void {
    if (this.closing) return
    this.restarts += 1
    if (this.restarts > RESTART_LIMIT) {
      this.failed = true
      this.mode = 'off'
      return
    }
    this.launchChild()
  }

  private resetPlayback(): void {
    this.queue = createQueue(this.ttsOn())
    if (this.hold) {
      this.hold = false
      this.options.send({ type: 'voice-hold', hold: false })
    }
  }

  private requestUnpin(): void {
    if (!this.pinned) return
    this.pinned = false
    this.idle = createIdle()
    this.options.send({ type: 'unpin' })
    this.pushListen(false)
  }

  private apply(event: QueueEvent): void {
    const step = reduceQueue(this.queue, event)
    this.queue = step.state
    this.dispatch(step.effects)
    this.syncHold()
    this.pushListen(false)
  }

  private dispatch(effects: readonly QueueEffect[]): void {
    for (const effect of effects) {
      debug(`dispatch ${effect.type} id=${effect.id}${effect.type === 'play' ? ` text=${effect.text.length}` : ''} link=${this.link !== undefined} live=${this.live}`)
      if (effect.type === 'play') this.link?.send({ type: 'speak', id: effect.id, text: effect.text })
      else this.link?.send({ type: 'stop-speak', id: effect.id })
    }
  }

  private syncHold(): void {
    const hold = voiceHold(this.queue)
    if (hold === this.hold) return
    this.hold = hold
    this.options.send({ type: 'voice-hold', hold })
  }

  private pushConfigure(): void {
    this.link?.send({
      type: 'configure',
      settings: this.settings(),
      paths: this.options.paths?.(),
    })
  }

  private pushListen(force: boolean): void {
    const settings = this.settings()
    const presence = this.options.presence()
    const mode = listenMode({
      pinned: this.pinned,
      agentBusy: this.agentBusy,
      questionOpen: this.questionOpen,
      bodyBusy: bodyBusy(this.queue),
      localBusy: localBusy(this.queue),
      stopping: this.stopping,
      // An empty wake list means there is no wake word, even when the switch and the model are ready.
      wakeEnabled: settings.wakeEnabled && hasWakeWord(settings.wakeWords) && presence.wake,
      commandEnabled: this.commandEnabled(),
      interjectEnabled: this.interjectEnabled(),
      echoCancel: this.echoCancel,
      micOpen: this.micOpen,
    })
    // The user is mid-sentence. Leaving transcription now would drop it, so wait until
    // the child reports the edge closed. A hard close (question, reply, stop, mic, setting)
    // still switches immediately because canFinish is false.
    if ((this.mode === 'command' || this.mode === 'interject') && !transcribing(mode) && this.speechOpen && this.canFinish(this.mode)) return
    const device = this.deviceWanted(settings, presence)
    if (!force && mode === this.mode && device === this.device) return
    if (transcribing(this.mode) && !transcribing(mode)) this.setSpeech(false)
    const entering = transcribing(mode) && !transcribing(this.mode)
    let seedMs = entering ? this.commandSeed : 0
    // Only the switch right after a spoken reply uses zero. Later entries get the normal
    // pre-roll back, so the first syllable after an agent turn is not clipped.
    if (entering) this.commandSeed = 300
    // Audio buffered before a question card must not prefix the first sentence after it.
    if (!this.device && device) seedMs = 0
    this.mode = mode
    this.device = device
    this.link?.send({ type: 'listen', mode, seedMs, device })
    this.options.send({ type: 'voice-mode', mode })
    if (!transcribing(mode)) this.options.send({ type: 'voice-level', value: 0 })
  }

  private localReply(text: string): string {
    const reply = text.trim()
    if (!reply || !this.ttsOn()) return ''
    return reply
  }

  private ttsOn(): boolean {
    // The selected backend decides readiness: Qwen only needs its key, local needs
    // the downloaded files. An unready backend behaves exactly like the TTS switch off.
    return ttsReady(this.settings(), this.options.presence().tts)
  }

  private sample() {
    return {
      now: this.options.now(),
      pinned: this.pinned,
      agentBusy: this.agentBusy,
      questionOpen: this.questionOpen,
      playbackBusy: queueView(this.queue).playbackBusy,
      speechOpen: this.speechOpen,
      idleMs: this.settings().idleMs,
    }
  }
}

/** `b:${turn}:${step}:${index}` → `b:${turn}:${step}`. Any other key is returned unchanged. */
function stepOf(key: string): string {
  return /^b:\d+:\d+:\d+$/.test(key) ? key.slice(0, key.lastIndexOf(':')) : key
}

/** A leading wake word is not a command. An empty remainder is dropped by the caller. */
export function stripWakePrefix(text: string, words: readonly string[]): string {
  const spoken = text.trim()
  for (const word of words) {
    const phrase = word.trim()
    if (!phrase || !spoken.startsWith(phrase)) continue
    return spoken.slice(phrase.length).trim()
  }
  return spoken
}

/**
 * Fork the voice child when this install has one beside the host.
 * A test run does not start it; the voice tests pass their own script.
 */
export function openVoiceChild(): VoiceLink | undefined {
  if (process.env.NODE_TEST_CONTEXT) return undefined
  const built = fileURLToPath(new URL('../voice/child.js', import.meta.url))
  if (existsSync(built)) return forkChild(built, [])
  const source = fileURLToPath(new URL('../../voice/src/child.ts', import.meta.url))
  if (existsSync(source)) {
    return forkChild(source, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'])
  }
  return undefined
}

function forkChild(script: string, execArgv: string[]): VoiceLink {
  // The desktop host is the Electron binary in Node mode. The child must keep that
  // marker, or Electron opens another app window instead of running the script.
  const child = fork(script, [], {
    execArgv,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
  })
  return linkProcess(child)
}

/** NDJSON over a child process's stdin and stdout. Lines that arrive before a handler are kept. */
export function linkProcess(child: ChildProcess): VoiceLink {
  const pending: unknown[] = []
  let handler: ((message: unknown) => void) | undefined
  const exits = new Set<() => void>()
  let exited = false
  const finish = () => {
    if (exited) return
    exited = true
    for (const exit of exits) exit()
  }
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        return
      }
      if (handler) handler(message)
      else pending.push(message)
    })
  }
  // A spawn failure may never produce `exit`. Both mean the link is gone.
  child.once('error', finish)
  child.once('exit', finish)
  return {
    send(message) {
      if (exited || child.stdin === null || child.stdin.destroyed) return
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {
        finish()
      }
    },
    close() {
      child.kill()
    },
    onMessage(next) {
      handler = next
      const queued = pending.splice(0)
      for (const message of queued) next(message)
    },
    onExit(exit) {
      // The child may already have died between fork() and this registration. Defer so the
      // starting caller can finish wiring the link before the exit path runs.
      if (exited) queueMicrotask(exit)
      else exits.add(exit)
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
