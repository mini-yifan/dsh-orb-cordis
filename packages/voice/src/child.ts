/**
 * Voice child process.
 * One microphone is shared by wake and command; it is released when neither column
 * can run. SenseVoice decode runs on a worker thread. This thread resamples, mixes,
 * and runs VAD.
 */

import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import { appendFileSync, existsSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contextFromFiles, keywordLines } from './keywords.ts'
import { LevelMeter } from './level.ts'
import { needsMicrophone, transcribing, type ListenMode } from './listen.ts'
import { cutAtKeyword, isEcho, stripEcho, type SpokenLine } from './echo.ts'
import { EchoCanceller } from './aec.ts'
import { speakQwen as startQwenSpeech, type QwenSpeech } from './qwen-tts.ts'
import { DEFAULT_QWEN_SPEED, DEFAULT_QWEN_VOICE } from './qwen.ts'
import { isRecoverableSpeakerError } from './speaker.ts'
import { DEFAULT_TTS_VOLUME, scaledSample } from './volume.ts'
import { captureBinary, CpalCapture, NativeCapture, SystemTapCapture, systemAudioBinary, type CaptureSource } from './capture.ts'
import { type VoiceSettings } from './settings.ts'

const require = createRequire(import.meta.url)
const TARGET_RATE = 16000
const RING_SAMPLES = TARGET_RATE / 2

const VOICE_DEBUG_MARKER = join(tmpdir(), 'dsh-orb-voice-debug.on')
const VOICE_DEBUG_LOG = join(tmpdir(), 'dsh-orb-voice-debug.log')

/** Opt-in tracing shared with the host; inert unless the marker file exists. */
function debug(message: string): void {
  if (!existsSync(VOICE_DEBUG_MARKER)) return
  try {
    appendFileSync(VOICE_DEBUG_LOG, `${new Date().toISOString()} child ${message}\n`)
  } catch {
    // Diagnostics must never take speech down.
  }
}

interface ConfigureMessage {
  readonly type: 'configure'
  readonly settings?: VoiceSettings
  readonly paths?: {
    readonly kws?: string
    readonly asrModel?: string
    readonly asrTokens?: string
    readonly asrVad?: string
    readonly tts?: string
  }
}

const emit = (message: unknown) => {
  // A pipe buffers process.stdout, so the host would not see a wake or a
  // playback edge until the buffer filled. The protocol is one line at a time.
  writeSync(1, `${JSON.stringify(message)}\n`)
}

const fail = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-orb voice: ${message}\n`)
}

class Ring {
  private readonly samples = new Float32Array(RING_SAMPLES)
  private writeAt = 0
  private filled = 0

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i += 1) {
      this.samples[this.writeAt] = chunk[i] ?? 0
      this.writeAt = (this.writeAt + 1) % RING_SAMPLES
      if (this.filled < RING_SAMPLES) this.filled += 1
    }
  }

  /** The newest `ms` of audio, in order. */
  last(ms: number): Float32Array {
    const count = Math.min(this.filled, Math.round((TARGET_RATE * ms) / 1000))
    const out = new Float32Array(count)
    const start = (this.writeAt - count + RING_SAMPLES) % RING_SAMPLES
    for (let i = 0; i < count; i += 1) out[i] = this.samples[(start + i) % RING_SAMPLES] ?? 0
    return out
  }

  /** Forget pre-playback audio, so the next command does not inherit the speaker's echo. */
  clear(): void {
    this.writeAt = 0
    this.filled = 0
  }
}

class VadEar {
  private detector: { acceptWaveform(samples: Float32Array): void, isDetected(): boolean, isEmpty(): boolean, front(copy: boolean): { start: number, samples: Float32Array }, pop(): void, flush(): void }
  private readonly frameSize = 512
  private readonly padSamples: number
  private readonly minSilenceSamples: number
  private absFed = 0
  private carry = new Float32Array(0)
  private history: { abs: number, samples: Float32Array }[] = []
  private lastEnd = -Infinity
  private detected = false
  private preroll: Float32Array | undefined
  private readonly onSpeech: (open: boolean) => void
  private readonly onSegment: (samples: Float32Array) => void

  constructor(vad: VadEar['detector'], padSeconds: number, minSilence: number, onSpeech: (open: boolean) => void, onSegment: (samples: Float32Array) => void) {
    this.detector = vad
    this.padSamples = Math.round(padSeconds * TARGET_RATE)
    this.minSilenceSamples = Math.round(minSilence * TARGET_RATE)
    this.onSpeech = onSpeech
    this.onSegment = onSegment
  }

  /** Keep the audio from just before the switch, and attach it to the next phrase only. */
  seed(samples: Float32Array): void {
    if (samples.length === 0) return
    this.preroll = samples
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return
    this.history.push({ abs: this.absFed, samples })
    this.absFed += samples.length
    const all = this.carry.length ? concat(this.carry, samples) : samples
    let index = 0
    for (; index + this.frameSize <= all.length; index += this.frameSize) {
      this.detector.acceptWaveform(all.subarray(index, index + this.frameSize))
      this.noteDetected()
      this.drain()
    }
    this.carry = all.slice(index)
    this.trim()
  }

  private noteDetected(): void {
    const now = this.detector.isDetected()
    if (now === this.detected) return
    this.detected = now
    // Both edges matter: the host uses the close edge to unpause its idle clock even
    // when the segment was too short to produce an utterance.
    this.onSpeech(now)
  }

  /** The listening mode changed away from commands. Drop state that must not leak into the next phrase. */
  reset(): void {
    const wasSpeaking = this.detected
    this.detected = false
    this.preroll = undefined
    this.carry = new Float32Array(0)
    this.history = []
    this.lastEnd = -Infinity
    // Discard a segment the old mode had already produced; it must not become an utterance
    // after the mode changed.
    while (!this.detector.isEmpty()) this.detector.pop()
    if (wasSpeaking) this.onSpeech(false)
  }

  private drain(): void {
    while (!this.detector.isEmpty()) {
      const segment = this.detector.front(false)
      const start = segment.start
      const end = start + segment.samples.length
      let speech = segment.samples
      const gap = start - this.lastEnd
      const needsPad = this.padSamples > 0 && (this.lastEnd === -Infinity || gap >= this.minSilenceSamples)
      if (this.preroll && this.preroll.length > 0) {
        speech = concat(this.preroll, speech)
        this.preroll = undefined
      } else if (needsPad) {
        const head = this.slice(Math.max(0, start - this.padSamples), start)
        if (head.length) speech = concat(head, segment.samples)
      }
      this.lastEnd = end
      this.detector.pop()
      this.onSegment(speech)
    }
  }

  private slice(from: number, to: number): Float32Array {
    const parts: Float32Array[] = []
    for (const chunk of this.history) {
      const start = Math.max(chunk.abs, from)
      const end = Math.min(chunk.abs + chunk.samples.length, to)
      if (end > start) parts.push(chunk.samples.subarray(start - chunk.abs, end - chunk.abs))
    }
    return concat(...parts)
  }

  private trim(): void {
    const keepFrom = this.absFed - (30 + 0.3 + 1) * TARGET_RATE
    while (this.history.length > 0) {
      const first = this.history[0]
      if (!first || first.abs + first.samples.length >= keepFrom) break
      this.history.shift()
    }
  }
}

function concat(...parts: Float32Array[]): Float32Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

interface Native {
  sherpa: any
  cpal: any
}

function loadNative(): Native | undefined {
  try {
    return { sherpa: require('sherpa-onnx-node'), cpal: require('node-cpal') }
  } catch (error) {
    fail(error)
    return undefined
  }
}

class Engine {
  private mode: ListenMode = 'off'
  private settings: VoiceSettings | undefined
  private paths: ConfigureMessage['paths']
  private readonly ring = new Ring()
  private kws: any
  private kwsStream: any
  private kwsKey = ''
  private lastWake = 0
  /** True while our own TTS is reaching the speaker. */
  private speaking = false
  /** The streaming spotter saw the interject keyword; the next utterance is a command. */
  private bargeHeard = false
  private bargeAt = 0
  /** Raw microphone blocks for the streaming spotter; the AEC output can lag. */
  private readonly bargeQueue: Float32Array[] = []
  private bargeScheduled = false
  /** Raw blocks from just before a barge; they seed the VAD with the command start. */
  private readonly bargePreroll: Float32Array[] = []
  private bargePrerollSamples = 0
  /** True while the level/VAD feed is held back during our own playback. */
  private ttsMuted = false
  /** Keep the AEC queue's tail from opening a VAD segment after the last sentence. */
  private ttsQuietUntil = 0
  private vad: VadEar | undefined
  private worker: Worker | undefined
  private workerReady = false
  private jobs: { samples: Float32Array, mode: ListenMode, from: number, to: number }[] = []
  private decoding = false
  private jobId = 0
  private readonly pending = new Map<number, { mode: ListenMode, from: number, to: number }>()
  /** The mode at the moment this utterance opened. command and interject share one segment. */
  private segmentMode: ListenMode = 'off'
  private capture: CaptureSource | undefined
  /** False until the host's first listen, so a restart during a question card does not flash the mic. */
  private hostDevice = false
  /** Once native capture cannot be used, this process stays on node-cpal. */
  private useCpal = false
  private sawReady = false
  private captureFailures: number[] = []
  private relaunchTimer: ReturnType<typeof setTimeout> | undefined
  private spoken: SpokenLine[] = []
  private audioHost: any
  private ttsWorker: Worker | undefined
  private readonly ttsWait = new Map<number, (message: { samples?: ArrayBuffer, sampleRate?: number, error?: string }) => void>()
  private ttsSeq = 0
  private speakToken = 0
  /** A segment accepted by the synthesizer and not yet handed to the speaker. */
  private armed: { id: string, token: number } | undefined
  private player: { stop(): void } | undefined
  /** The cloud request for the current sentence, so a stop can close it. */
  private qwen: QwenSpeech | undefined
  /** Smoothed microphone level for the input meter. Commands only; never wake or playback. */
  private readonly meter = new LevelMeter()
  /**
   * The native VPIO helper ducks every other application while it is open, and
   * macOS 26.4 ignores the ducking-level property and the private unduck call.
   * Production therefore uses node-cpal and the software AEC in aec-worker.ts.
   * The native helper is still available for the capture tests and for
   * DSH_ORB_VOICE_AEC=native; DSH_ORB_VOICE_AEC=off falls back to text echo
   * filtering only.
   */
  private readonly nativeCapture = process.env.DSH_ORB_CAPTURE_BIN !== undefined
    || process.env.DSH_ORB_VOICE_AEC === 'native'
  private readonly softwareAec = process.env.DSH_ORB_CAPTURE_BIN === undefined
    && process.env.DSH_ORB_VOICE_AEC !== 'native'
    && process.env.DSH_ORB_VOICE_AEC !== 'off'
  private readonly aec = new EchoCanceller({ filterLength: 1024, stepSize: 0.04 })
  /** Raw microphone blocks waiting for the AEC, so the audio callback never runs the filter. */
  private readonly aecQueue: { samples: Float32Array, startFrame: number }[] = []
  private aecScheduled = false
  /** Samples captured so far, including blocks still waiting in aecQueue. */
  private micFrame = 0
  private aecWorker: Worker | undefined
  private aecWorkerFailed = false
  private readonly aecReference: EchoReference = {
    // When a live system tap is present it owns the reference; do not mix the
    // per-sentence TTS PCM into the same ring.
    pushReference: (block) => {
      if (this.systemReference) return
      this.forwardReference(block)
    },
  }
  private systemTap: SystemTapCapture | undefined
  private systemReference = false
  private systemTapFailed = false

  constructor(private readonly native: Native) {}

  configure(message: ConfigureMessage): void {
    this.settings = message.settings
    this.paths = message.paths
    debug(`configure backend=${this.settings?.ttsBackend ?? 'local'} key=${this.settings?.qwenApiKey?.trim() ? 'yes' : 'no'} voice=${this.settings?.qwenVoice ?? ''} speed=${this.settings?.qwenSpeed ?? ''} volume=${this.settings?.ttsVolume ?? DEFAULT_TTS_VOLUME} tts=${this.settings?.ttsEnabled === true}`)
    // Build the recognizers before the microphone callback starts. Loading them
    // on the audio thread makes CoreAudio drop the stream.
    this.ensureKws()
    this.ensureAsr()
    // Releasing the device when both listening columns are off is what clears the
    // macOS microphone indicator. It also stops paying for an open input stream.
    this.syncMic()
  }

  listen(mode: ListenMode, seedMs: number, device = true): void {
    const previous = this.mode
    this.mode = mode
    const wasTranscribing = transcribing(previous)
    const nowTranscribing = transcribing(mode)
    if (wasTranscribing && !nowTranscribing) {
      this.vad?.reset()
      emit({ type: 'level', value: 0 })
    }
    if (mode === 'wake' && previous !== 'wake' && this.kws && this.kwsStream) this.kws.reset(this.kwsStream)
    if (!wasTranscribing && nowTranscribing) {
      this.meter.reset()
      if (seedMs > 0) this.vad?.seed(this.ring.last(seedMs))
    }
    this.hostDevice = device
    this.syncMic()
  }

  speak(id: string, text: string): void {
    // The host normally serializes sentences, but a new command can arrive while an old
    // player is still draining. Make the new sentence the only audio before it starts.
    this.stopSpeak()
    const token = ++this.speakToken
    debug(`speak id=${id} backend=${this.settings?.ttsBackend ?? 'local'} chars=${text.length}`)
    this.cancelQwen()
    if (this.settings?.ttsBackend === 'qwen') {
      this.speakWithQwen(id, text, token)
      return
    }
    const speed = this.settings?.ttsSpeed ?? 1.5
    const volume = this.settings?.ttsVolume ?? DEFAULT_TTS_VOLUME
    const worker = this.ensureTts()
    if (!worker) {
      debug(`local id=${id} no-worker`)
      emit({ type: 'playback', id, phase: 'start' })
      emit({ type: 'playback', id, phase: 'end' })
      return
    }
    this.armed = { id, token }
    const job = ++this.ttsSeq
    worker.postMessage({ id: job, text, speed })
    this.ttsWait.set(job, (message) => {
      if (token !== this.speakToken) return
      if (this.armed?.token === token) this.armed = undefined
      const samples = message.samples ? new Float32Array(message.samples) : new Float32Array(0)
      const sampleRate = message.sampleRate ?? 22050
      if (message.error || samples.length === 0) {
        debug(`local id=${id} error=${String(message.error ?? 'empty')} samples=${samples.length}`)
        if (message.error) fail(new Error(message.error))
        emit({ type: 'playback', id, phase: 'start' })
        emit({ type: 'playback', id, phase: 'end' })
        return
      }
      emit({ type: 'playback', id, phase: 'start' })
      debug(`local id=${id} play samples=${samples.length} rate=${sampleRate}`)
      try {
        const line = { text, startedAt: Date.now(), endedAt: undefined as number | undefined }
        this.noteSpoken(line)
        this.flushAec()
        if (this.softwareAec) this.aecSetActive(true)
        this.armBarge()
        this.speaking = true
        this.player = playPcm(this.native.cpal, this.ensureHost(), samples, sampleRate, volume, this.ttsReference(), (stopped) => {
          this.aecSetActive(false)
          this.endSpeaking()
          this.player = undefined
          line.endedAt = Date.now()
          // The command that follows must not seed the recognizer with the speaker's own tail.
          this.ring.clear()
          if (token !== this.speakToken && !stopped) return
          emit({ type: 'playback', id, phase: 'end', ...(stopped ? { stopped: true } : {}) })
        })
      } catch (error) {
        this.aecSetActive(false)
        this.endSpeaking()
        fail(error)
        this.ring.clear()
        emit({ type: 'playback', id, phase: 'end' })
      }
    })
  }

  /**
   * One queued sentence on the cloud backend. Voice and speed are read here, so a
   * settings change reaches the next sentence and never the one already speaking.
   */
  private speakWithQwen(id: string, text: string, token: number): void {
    const apiKey = this.settings?.qwenApiKey ?? ''
    debug(`qwen id=${id} key=${apiKey.trim() ? 'yes' : 'no'} chars=${text.length}`)
    if (!apiKey.trim() || !text.trim()) {
      debug(`qwen id=${id} skipped empty`)
      emit({ type: 'playback', id, phase: 'end' })
      return
    }
    const voice = this.settings?.qwenVoice ?? DEFAULT_QWEN_VOICE
    const speed = this.settings?.qwenSpeed ?? DEFAULT_QWEN_SPEED
    const volume = this.settings?.ttsVolume ?? DEFAULT_TTS_VOLUME
    let player: StreamPlayer | undefined
    let line: { text: string, startedAt: number, endedAt: number | undefined } | undefined
    let job: QwenSpeech | undefined
    let settled = false
    this.armed = { id, token }

    const finish = (stopped: boolean): void => {
      settled = true
      this.aecSetActive(false)
      this.endSpeaking()
      debug(`qwen id=${id} finish stopped=${stopped} player=${player !== undefined}`)
      if (player && this.player === player) this.player = undefined
      if (this.qwen === job) this.qwen = undefined
      if (line) line.endedAt = Date.now()
      this.ring.clear()
      if (token !== this.speakToken && !stopped) return
      emit({ type: 'playback', id, phase: 'end', ...(stopped ? { stopped: true } : {}) })
    }

    job = startQwenSpeech({
      text,
      apiKey,
      voice,
      speed,
      onAudio: (samples, sampleRate) => {
        if (token !== this.speakToken) return
        if (!player) {
          this.armed = undefined
          try {
            this.flushAec()
            if (this.softwareAec) this.aecSetActive(true)
            this.armBarge()
            this.speaking = true
            player = createStreamPlayer(this.native.cpal, this.ensureHost(), sampleRate, volume, this.ttsReference(), (stopped) => finish(stopped))
          } catch (error) {
            fail(error)
            this.armed = undefined
            job?.cancel()
            finish(true)
            return
          }
          this.player = player
          debug(`qwen id=${id} first-audio rate=${sampleRate} first=${samples.length}`)
          const started = { text, startedAt: Date.now(), endedAt: undefined as number | undefined }
          line = started
          this.noteSpoken(started)
          emit({ type: 'playback', id, phase: 'start' })
        }
        player.push(samples)
      },
      onDone: () => {
        if (token !== this.speakToken) return
        debug(`qwen id=${id} done player=${player !== undefined}`)
        settled = true
        this.qwen = undefined
        if (this.armed?.id === id) this.armed = undefined
        if (player) player.end()
        else finish(false)
      },
      onRetry: (message, attempt) => {
        debug(`qwen id=${id} retry=${attempt} ${message.slice(0, 80)}`)
      },
      onError: (message) => {
        if (token !== this.speakToken) return
        debug(`qwen id=${id} error ${message.slice(0, 120)}`)
        settled = true
        this.qwen = undefined
        if (this.armed?.id === id) this.armed = undefined
        fail(new Error(message))
        if (player) player.stop()
        else finish(false)
      },
    })
    this.qwen = job
    if (settled) {
      job.cancel()
      this.qwen = undefined
    }
  }

  private cancelQwen(): void {
    const job = this.qwen
    this.qwen = undefined
    job?.cancel()
  }

  stopSpeak(): void {
    debug(`stop-speak armed=${this.armed?.id ?? 'none'} player=${this.player !== undefined}`)
    this.aecSetActive(false)
    this.endSpeaking()
    this.bargeQueue.length = 0
    this.bargeScheduled = false
    this.bargePreroll.length = 0
    this.bargePrerollSamples = 0
    this.speakToken += 1
    this.cancelQwen()
    const armed = this.armed
    this.armed = undefined
    const player = this.player
    this.player = undefined
    this.ring.clear()
    if (player) player.stop()
    else if (armed) emit({ type: 'playback', id: armed.id, phase: 'end', stopped: true })
  }

  /** Keep the input device only while the host asked for it and a listening column can run. */
  private micWanted(): boolean {
    if (!this.hostDevice) return false
    const settings = this.settings
    const paths = this.paths
    if (!settings || !paths) return false
    const kws = paths.kws ? kwsFiles(paths.kws, settings.wakeChunk) : undefined
    const wakeModel = kws !== undefined && existsSync(kws.tokens)
    const asrModel = Boolean(
      paths.asrModel && paths.asrTokens && paths.asrVad
      && existsSync(paths.asrModel) && existsSync(paths.asrTokens) && existsSync(paths.asrVad),
    )
    return needsMicrophone({
      wakeEnabled: settings.wakeEnabled,
      wakeWords: settings.wakeWords,
      wakeModel,
      commandEnabled: settings.commandEnabled,
      asrModel,
    })
  }

  private syncMic(): void {
    if (this.micWanted()) this.startMic()
    else this.stopMic()
  }

  private stopMic(): void {
    this.stopSystemReference()
    if (this.relaunchTimer) clearTimeout(this.relaunchTimer)
    this.relaunchTimer = undefined
    const capture = this.capture
    this.capture = undefined
    this.sawReady = false
    this.ring.clear()
    this.aecQueue.length = 0
    this.aecScheduled = false
    this.bargeQueue.length = 0
    this.bargeScheduled = false
    this.bargePreroll.length = 0
    this.bargePrerollSamples = 0
    this.bargeHeard = false
    this.bargeAt = 0
    this.ttsMuted = false
    this.ttsQuietUntil = 0
    this.micFrame = 0
    this.aecWorker?.postMessage({ type: 'reset' })
    this.aec.reset()
    try { capture?.close() } catch (error) { fail(error) }
  }

  startMic(): void {
    if (this.softwareAec) this.ensureAecWorker()
    if (this.capture) return
    const binary = this.nativeCapture && !this.useCpal ? captureBinary() : undefined
    if (!binary) {
      this.useCpal = true
      if (this.nativeCapture && !this.softwareAec) debug('capture helper missing; node-cpal has no echo cancellation')
      this.openCpal()
      return
    }
    this.openNative(binary)
  }

  private openNative(binary: string): void {
    const source = new NativeCapture(binary)
    this.capture = source
    source.start({
      onPcm: (samples) => this.onAudio(samples),
      onReady: ({ aec }) => {
        this.sawReady = true
        debug(`mic open source=native aec=${aec}`)
        emit({ type: 'mic', open: true, aec })
      },
      onFailure: (reason, detail) => this.onCaptureFailure(reason, detail),
    })
  }

  private openCpal(): void {
    const source = new CpalCapture(this.native)
    this.capture = source
    source.start({
      onPcm: (samples) => this.onAudio(samples),
      onReady: ({ aec }) => {
        this.sawReady = true
        // The software canceller runs in this process, so the host may keep
        // listening for an interjection while our own TTS is playing.
        const active = this.softwareAec || aec
        debug(`mic open source=cpal software-aec=${this.softwareAec} aec=${active}`)
        emit({ type: 'mic', open: true, aec: active })
      },
      onFailure: (reason, detail) => this.onCaptureFailure(reason, detail),
    })
    // Start the system tap after the microphone playback has begun. Starting
    // it first would anchor the reference clock ahead of the capture clock.
    this.startSystemReference()
  }

  private onCaptureFailure(reason: 'mic-denied' | 'no-device' | 'unavailable' | 'failed' | 'crashed', detail: string): void {
    const capture = this.capture
    this.capture = undefined
    try { capture?.close() } catch { /* already closing */ }
    if (reason === 'mic-denied') {
      emit({ type: 'mic', open: false })
      return
    }
    if (this.useCpal) {
      emit({ type: 'mic', open: false })
      return
    }
    const now = Date.now()
    this.captureFailures = this.captureFailures.filter((at) => now - at < 60_000)
    this.captureFailures.push(now)
    if (!this.sawReady || this.captureFailures.length >= 3) {
      this.useCpal = true
      this.sawReady = false
      fail(new Error(`capture fallback: ${reason} ${detail}`))
      if (this.micWanted()) this.startMic()
      return
    }
    this.relaunchTimer = setTimeout(() => {
      this.relaunchTimer = undefined
      if (this.micWanted()) this.startMic()
    }, 1000)
  }

  close(): void {
    this.stopSpeak()
    this.stopMic()
    this.stopAsr()
    void this.ttsWorker?.terminate()
    void this.aecWorker?.terminate()
    this.aecWorker = undefined
  }

  private ensureHost(): any {
    this.audioHost ??= this.native.cpal.defaultHost()
    return this.audioHost
  }

  private ensureTts(): Worker | undefined {
    if (this.ttsWorker) return this.ttsWorker
    const root = this.paths?.tts
    if (!root) return undefined
    const beside = new URL('./tts-worker.js', import.meta.url)
    const source = new URL('./tts-worker.ts', import.meta.url)
    const url = existsSync(fileURLToPath(beside)) ? beside : source
    let worker: Worker
    try {
      worker = new Worker(url, { workerData: { tts: root } })
    } catch (error) {
      fail(error)
      return undefined
    }
    worker.on('message', (message: { id?: number, samples?: ArrayBuffer, sampleRate?: number, error?: string }) => {
      if (typeof message.id !== 'number') return
      const done = this.ttsWait.get(message.id)
      this.ttsWait.delete(message.id)
      done?.(message)
    })
    worker.on('error', (error) => {
      fail(error)
      for (const done of this.ttsWait.values()) done({ error: error.message })
      this.ttsWait.clear()
      this.ttsWorker = undefined
    })
    this.ttsWorker = worker
    return worker
  }

  /** 16 kHz mono PCM from the capture source. */
  private onAudio(samples: Float32Array): void {
    // The spotter runs on the raw microphone. The AEC worker can deliver its
    // output a little late, and the keyword must be seen before TTS ends.
    if (this.speaking && this.mode === 'interject') this.queueBarge(samples)
    if (!this.softwareAec) {
      this.handleAudio(samples)
      return
    }
    if (!this.aecWorker && !this.aecWorkerFailed) this.ensureAecWorker()
    const startFrame = this.micFrame
    this.micFrame += samples.length
    const worker = this.aecWorker
    if (worker && !this.aecWorkerFailed) {
      // The worker owns the filter. Transfer the block so the audio callback
      // only copies a reference to it and returns.
      const buffer = samples.buffer as ArrayBuffer
      worker.postMessage({
        type: 'process',
        samples: buffer,
        offset: samples.byteOffset,
        length: samples.length,
        startFrame,
      }, [buffer])
      return
    }
    // Worker unavailable: keep the old in-process fallback. It is heavier, but
    // the text echo filter still covers the case where it cannot keep up.
    this.aecQueue.push({ samples, startFrame })
    if (this.aecQueue.length > 50) this.aecQueue.shift()
    if (this.aecScheduled) return
    this.aecScheduled = true
    setImmediate(() => this.drainAec())
  }

  private ensureAecWorker(): void {
    if (!this.softwareAec || this.aecWorker || this.aecWorkerFailed) return
    const beside = new URL('./aec-worker.js', import.meta.url)
    const source = new URL('./aec-worker.ts', import.meta.url)
    let url = beside
    try {
      if (!existsSync(fileURLToPath(beside))) url = source
    } catch {
      url = source
    }
    try {
      const worker = new Worker(url)
      worker.on('message', (message: unknown) => this.onAecMessage(message))
      worker.on('error', (error) => {
        debug(`aec-worker failed: ${String(error)}`)
        this.aecWorkerFailed = true
        this.aecWorker = undefined
        // Keep the continuous reference alive in this thread if the worker dies.
        if (this.systemReference) this.aec.setContinuous(true, this.micFrame)
      })
      worker.unref()
      this.aecWorker = worker
      debug('aec-worker started')
    } catch (error) {
      debug(`aec-worker unavailable: ${String(error)}`)
      this.aecWorkerFailed = true
    }
  }

  private onAecMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const item = message as { type?: string, samples?: ArrayBuffer }
    if (item.type !== 'cleaned' || !(item.samples instanceof ArrayBuffer)) return
    this.handleAudio(new Float32Array(item.samples))
  }

  private forwardReference(block: Float32Array): void {
    const worker = this.aecWorker
    if (worker && !this.aecWorkerFailed) {
      const copy = block.slice()
      const buffer = copy.buffer as ArrayBuffer
      worker.postMessage({ type: 'reference', samples: buffer }, [buffer])
      return
    }
    this.aec.pushReference(block)
  }

  private aecSetActive(active: boolean): void {
    // The system loopback reference is continuous; sentence edges must not
    // disable or re-anchor it.
    if (this.systemReference) return
    const worker = this.aecWorker
    if (worker && !this.aecWorkerFailed) {
      worker.postMessage({ type: 'active', active, anchor: this.micFrame })
      return
    }
    this.aec.setActive(active, this.micFrame)
  }

  private aecSetContinuous(active: boolean): void {
    const worker = this.aecWorker
    if (worker && !this.aecWorkerFailed) {
      worker.postMessage({ type: 'continuous', active, anchor: this.micFrame })
      return
    }
    this.aec.setContinuous(active, this.micFrame)
  }

  /** Start the CoreAudio system-output tap that feeds the continuous AEC. */
  private startSystemReference(): void {
    if (this.systemTap || this.systemTapFailed || !this.softwareAec) return
    if (process.env.DSH_ORB_SYSTEM_AEC === 'off') {
      debug('system-aec off')
      this.systemTapFailed = true
      return
    }
    const binary = systemAudioBinary()
    if (!binary) {
      debug('system-aec helper missing')
      this.systemTapFailed = true
      return
    }
    const tap = new SystemTapCapture(binary, this.native)
    this.systemTap = tap
    tap.start({
      onPcm: (samples) => {
        if (this.systemTap !== tap || samples.length === 0) return
        if (!this.systemReference) {
          this.systemReference = true
          this.aecSetContinuous(true)
          debug('system-aec reference on')
        }
        this.forwardReference(samples)
      },
      onReady: ({ rate }) => debug(`system-aec ready rate=${rate}`),
      onFailure: (reason, detail) => {
        if (this.systemTap !== tap) return
        this.systemTap = undefined
        this.systemTapFailed = true
        if (this.systemReference) {
          this.systemReference = false
          this.aecSetContinuous(false)
        }
        debug(`system-aec failed ${reason} ${detail}`)
      },
    })
  }

  private stopSystemReference(): void {
    const tap = this.systemTap
    this.systemTap = undefined
    if (this.systemReference) {
      this.systemReference = false
      this.aecSetContinuous(false)
    }
    tap?.close()
  }

  private ttsReference(): EchoReference | undefined {
    return this.softwareAec && !this.systemReference ? this.aecReference : undefined
  }

  /** Feed one cleaned block to the ring, wake spotter, or VAD. */
  private handleAudio(samples: Float32Array): void {
    this.ring.push(samples)
    if (this.mode === 'wake') {
      this.feedWake(samples)
      return
    }
    if (!transcribing(this.mode)) return
    // Our own TTS is inert for the ear: its residual must not open a VAD
    // segment or light the ASR lamp. The KWS listens on the raw microphone; a
    // barge opens the ear immediately, otherwise the AEC queue's tail is held
    // back for a short quiet period after playback.
    if (!this.systemReference && (this.speaking || (!this.bargeHeard && Date.now() < this.ttsQuietUntil))) {
      if (!this.bargeHeard) {
        if (!this.ttsMuted) {
          this.ttsMuted = true
          emit({ type: 'level', value: 0 })
        }
        return
      }
    }
    this.ttsMuted = false
    const level = this.meter.push(samples, Date.now())
    if (level !== undefined) emit({ type: 'level', value: level })
    // The VAD segment keeps the whole phrase so the command after the keyword
    // is not lost when the stop reaches the speaker a few frames late.
    this.vad?.push(samples)
  }

  private endSpeaking(): void {
    this.speaking = false
    this.ttsQuietUntil = Date.now() + 500
  }

  /** Start a sentence: reset the spotter and wait for the interject keyword. */
  private armBarge(): void {
    this.bargeHeard = false
    this.bargeAt = 0
    this.bargeQueue.length = 0
    this.bargeScheduled = false
    this.bargePreroll.length = 0
    this.bargePrerollSamples = 0
    this.ttsMuted = false
    this.ttsQuietUntil = 0
    // The command that started this sentence has already been decoded; drop any
    // stale open VAD segment so its speech edge cannot keep the ASR lamp on
    // while the VAD feed is held back. A live system tap keeps the VAD running
    // through playback, so it must not be reset.
    if (!this.systemReference) this.vad?.reset()
    if (this.kws && this.kwsStream) this.kws.reset(this.kwsStream)
  }

  private bargeActive(): boolean {
    return this.bargeHeard && Date.now() - this.bargeAt < 8000
  }

  private queueBarge(samples: Float32Array): void {
    if (!this.bargeHeard && !this.systemReference) this.pushBargePreroll(samples)
    if (!this.kws || !this.kwsStream || this.bargeHeard) return
    this.bargeQueue.push(samples.slice())
    if (this.bargeQueue.length > 20) this.bargeQueue.shift()
    if (this.bargeScheduled) return
    this.bargeScheduled = true
    setImmediate(() => this.drainBarge())
  }

  /** Keep the raw audio just before a barge so the VAD starts with the keyword. */
  private pushBargePreroll(samples: Float32Array): void {
    this.bargePreroll.push(samples.slice())
    this.bargePrerollSamples += samples.length
    const keep = TARGET_RATE / 2
    while (this.bargePrerollSamples > keep && this.bargePreroll.length > 1) {
      const head = this.bargePreroll.shift()
      if (head) this.bargePrerollSamples -= head.length
    }
  }

  private seedBargeVad(): void {
    if (this.systemReference || this.bargePrerollSamples === 0) return
    const samples = new Float32Array(this.bargePrerollSamples)
    let offset = 0
    for (const block of this.bargePreroll) {
      samples.set(block, offset)
      offset += block.length
    }
    this.vad?.seed(samples)
    this.bargePreroll.length = 0
    this.bargePrerollSamples = 0
  }

  private drainBarge(): void {
    this.bargeScheduled = false
    const block = this.bargeQueue.shift()
    if (block) this.feedBarge(block)
    if (this.bargeQueue.length > 0) {
      this.bargeScheduled = true
      setImmediate(() => this.drainBarge())
    }
  }

  private feedBarge(samples: Float32Array): void {
    const spotter = this.kws
    const stream = this.kwsStream
    if (!spotter || !stream || this.bargeHeard) return
    stream.acceptWaveform({ sampleRate: TARGET_RATE, samples })
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const result = spotter.getResult(stream)
      if (!result?.keyword) continue
      spotter.reset(stream)
      this.bargeHeard = true
      this.bargeAt = Date.now()
      // The keyword was spoken a few hundred milliseconds ago; seed the VAD
      // with the raw lead-in so the command after it is not clipped.
      this.seedBargeVad()
      this.ttsMuted = false
      emit({ type: 'barge', keyword: result.keyword })
      return
    }
  }

  private drainAec(): void {
    this.aecScheduled = false
    this.processAecChunk(256)
    if (this.aecQueue.length > 0) {
      this.aecScheduled = true
      setImmediate(() => this.drainAec())
    }
  }

  /** Process at most `budget` samples, so one turn stays short. */
  private processAecChunk(budget: number): void {
    const entry = this.aecQueue[0]
    if (!entry) return
    const take = Math.min(budget, entry.samples.length)
    const chunk = entry.samples.subarray(0, take)
    this.handleAudio(this.aec.process(chunk, entry.startFrame))
    entry.startFrame += take
    entry.samples = entry.samples.subarray(take)
    if (entry.samples.length === 0) this.aecQueue.shift()
  }

  /** Start a sentence on an up-to-date microphone frame. */
  private flushAec(): void {
    this.aecScheduled = false
    while (this.aecQueue.length > 0) this.processAecChunk(256)
  }

  private feedWake(samples: Float32Array): void {
    const spotter = this.kws
    const stream = this.kwsStream
    if (!spotter || !stream) return
    stream.acceptWaveform({ sampleRate: TARGET_RATE, samples })
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const result = spotter.getResult(stream)
      if (!result?.keyword) continue
      spotter.reset(stream)
      // The spotter also carries the interject keyword. It must not wake the
      // ball when that phrase is different from every configured wake word.
      const wakeWords = this.settings?.wakeWords ?? []
      if (!wakeWords.some((word) => word.trim() === result.keyword.trim())) continue
      const now = Date.now()
      const cooldown = this.settings?.wakeCooldownMs ?? 1500
      if (now - this.lastWake < cooldown) continue
      this.lastWake = now
      emit({ type: 'wake' })
    }
  }

  private ensureKws(): void {
    const settings = this.settings
    const dir = this.paths?.kws
    const interject = settings?.interjectKeyword?.trim() ?? ''
    const barge = settings?.commandEnabled === true && interject !== ''
    if ((!settings?.wakeEnabled && !barge) || !dir) {
      this.clearKws()
      return
    }
    const files = kwsFiles(dir, settings.wakeChunk)
    if (!files || !existsSync(files.tokens)) {
      this.clearKws()
      return
    }
    const words = settings.wakeEnabled ? [...settings.wakeWords] : []
    if (interject && !words.includes(interject)) words.push(interject)
    let lines: string[] = []
    try {
      lines = keywordLines(words, contextFromFiles(dir))
    } catch (error) {
      fail(error)
      // The configured phrase cannot be built. Keeping the previous list would make the
      // removed phrase keep waking the ball.
      this.clearKws()
      return
    }
    // An empty list means the user removed every wake word. Keeping the spotter built from
    // the old list would still fire on the old phrase.
    if (lines.length === 0) {
      this.clearKws()
      return
    }
    const key = `${settings.wakeChunk}:${settings.wakeThreshold}:${settings.wakeScore}:${lines.join('|')}`
    if (key === this.kwsKey && this.kws) return
    const keywordsFile = join(tmpdir(), `dsh-orb-kws-${process.pid}.txt`)
    writeFileSync(keywordsFile, `${lines.join('\n')}\n`)
    try {
      const spotter = new this.native.sherpa.KeywordSpotter({
        featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: files.tokens,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        keywordsFile,
        keywordsScore: settings.wakeScore,
        keywordsThreshold: settings.wakeThreshold,
      })
      this.kws = spotter
      this.kwsStream = spotter.createStream()
      this.kwsKey = key
    } catch (error) {
      fail(error)
      this.clearKws()
    }
  }

  private clearKws(): void {
    this.kws = undefined
    this.kwsStream = undefined
    this.kwsKey = ''
  }

  private ensureAsr(): void {
    const model = this.paths?.asrModel
    const tokens = this.paths?.asrTokens
    const vadModel = this.paths?.asrVad
    const enabled = Boolean(
      this.settings?.commandEnabled && model && tokens && vadModel
      && existsSync(model) && existsSync(tokens) && existsSync(vadModel),
    )
    if (!enabled) {
      // Switching voice input off should release the recognizer's memory too, not
      // only stop feeding it.
      this.stopAsr()
      return
    }
    if (!this.vad) {
      try {
        const detector = new this.native.sherpa.Vad({
          sileroVad: {
            model: vadModel,
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 30,
            windowSize: 512,
          },
          sampleRate: TARGET_RATE,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        }, 31.5)
        this.vad = new VadEar(detector, 0.3, 0.5, (open) => {
          if (open) this.segmentMode = this.mode
          emit({ type: 'speech', open })
        }, (samples) => this.enqueue(samples))
      } catch (error) {
        fail(error)
      }
    }
    if (this.worker) return
    let worker: Worker
    try {
      worker = new Worker(new URL('./decode-worker.mjs', import.meta.url), { workerData: { model, tokens } })
    } catch (error) {
      fail(error)
      return
    }
    worker.on('message', (message: { ready?: boolean, id?: number, text?: string, error?: string }) => {
      if (this.worker !== worker) return
      if (message.ready) {
        this.workerReady = true
        this.pump()
        return
      }
      this.decoding = false
      const meta = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (typeof message.id === 'number') this.pending.delete(message.id)
      if (message.error) fail(message.error)
      else if (message.text) {
        const commands = [
          this.settings?.interjectKeyword ?? '',
          ...(this.settings?.dismissPhrases ?? []),
        ]
        const window = meta !== undefined ? { from: meta.from, to: meta.to } : undefined
        const mode = meta?.mode ?? this.mode
        const echo = window !== undefined && isEcho(message.text, this.spoken, window, commands)
        if (echo) process.stderr.write('echo dropped\n')
        else {
          // Our own TTS is still allowed to leak a little past the AEC. Trim the
          // part of the transcript that matches the line being spoken, so the
          // host receives the user's command without the sentence tail.
          const cleaned = window !== undefined
            ? stripEcho(message.text, this.spoken, window, commands)
            : message.text
          const keyword = this.settings?.interjectKeyword?.trim() ?? ''
          const cut = mode === 'interject' && keyword
            ? cutAtKeyword(cleaned, keyword)
            : { text: cleaned, matched: false }
          const flagged = mode === 'interject' && (this.bargeActive() || cut.matched)
          const text = cut.matched && window !== undefined
            ? stripEcho(cut.text, this.spoken, window, commands).trim()
            : cleaned.trim()
          if (text) {
            emit({
              type: 'utterance',
              text,
              ...(meta ? { mode: meta.mode } : {}),
              ...(flagged ? { interject: true } : {}),
            })
            if (flagged) {
              this.bargeHeard = false
              this.bargeAt = 0
            }
          }
        }
      }
      emit({ type: 'speech', open: false })
      this.pump()
    })
    worker.on('error', (error) => {
      if (this.worker === worker) fail(error)
    })
    this.worker = worker
  }

  /** Drop the recognizer and its queued segments; a later enable rebuilds them. */
  private stopAsr(): void {
    const worker = this.worker
    this.worker = undefined
    this.workerReady = false
    this.vad = undefined
    this.jobs = []
    this.decoding = false
    this.pending.clear()
    if (worker) void worker.terminate()
  }

  private enqueue(samples: Float32Array): void {
    const copy = new Float32Array(samples)
    const mode = transcribing(this.segmentMode) ? this.segmentMode : this.mode
    this.jobs.push({
      samples: copy,
      mode,
      from: Date.now() - samples.length / 16 - 500,
      to: Date.now(),
    })
    this.pump()
  }

  private pump(): void {
    if (!this.workerReady || this.decoding || this.jobs.length === 0 || !this.worker) return
    const job = this.jobs.shift()
    if (!job) return
    this.decoding = true
    const id = ++this.jobId
    this.pending.set(id, { mode: job.mode, from: job.from, to: job.to })
    const bytes = new ArrayBuffer(job.samples.byteLength)
    new Uint8Array(bytes).set(new Uint8Array(job.samples.buffer, job.samples.byteOffset, job.samples.byteLength))
    this.worker.postMessage({ id, samples: bytes }, [bytes])
  }

  private noteSpoken(line: SpokenLine): void {
    const cutoff = Date.now() - 30_000
    this.spoken = this.spoken.filter((item) => item.endedAt === undefined || item.endedAt >= cutoff)
    this.spoken.push(line)
  }
}

function kwsFiles(dir: string, chunk: 8 | 16): { encoder: string, decoder: string, joiner: string, tokens: string } | undefined {
  const tag = `chunk-${chunk}`
  const files = {
    encoder: join(dir, `encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`),
    decoder: join(dir, `decoder-epoch-13-avg-2-${tag}-left-64.onnx`),
    joiner: join(dir, `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`),
    tokens: join(dir, 'tokens.txt'),
  }
  if (!existsSync(files.encoder) || !existsSync(files.decoder) || !existsSync(files.joiner)) return undefined
  return files
}

interface StreamPlayer {
  push(samples: Float32Array): void
  /** No more samples will come; finish after the buffer drains. */
  end(): void
  stop(): void
}

interface EchoReference {
  pushReference(block: Float32Array): void
}

/**
 * The output callback already knows the exact samples that reach the speaker.
 * Downsample them to the canceller's 16 kHz reference and stamp them with the
 * callback clock. The phase carries across callbacks so the reference does not
 * drift when the device rate is not a multiple of 16 kHz.
 */
class ReferenceFeed {
  private phase = 0
  private count = 0
  private readonly scratch = new Float32Array(65_536)

  constructor(private readonly target: EchoReference) {}

  push(sample: number, rate: number): void {
    this.phase += TARGET_RATE / rate
    if (this.phase < 1) return
    this.phase -= 1
    if (this.count >= this.scratch.length) this.flush()
    this.scratch[this.count] = sample
    this.count += 1
  }

  flush(): void {
    if (this.count === 0) return
    this.target.pushReference(this.scratch.subarray(0, this.count))
    this.count = 0
  }
}

/**
 * The speaker end of a cloud sentence. Chunks arrive while the stream is already
 * running; the callback pulls across them and writes silence when the network is
 * behind playback. One call to `onEnded`, exactly like {@link playPcm}.
 */
function createStreamPlayer(
  cpal: any,
  host: any,
  sampleRate: number,
  volume: number,
  reference: EchoReference | undefined,
  onEnded: (stopped: boolean) => void,
): StreamPlayer {
  const chunks: Float32Array[] = []
  let head = 0
  let headOffset = 0
  let ended = false
  let finished = false
  let rate = sampleRate
  let stream: { close(): void, play(): void } | undefined

  const finish = (stopped: boolean, defer = false): void => {
    if (finished) return
    finished = true
    const close = (): void => {
      try { stream?.close() } catch { /* already closed */ }
      onEnded(stopped)
    }
    // Closing from inside the audio callback throws in the native addon.
    if (defer) setImmediate(close)
    else close()
  }

  const device = host.defaultOutputDevice()
  if (!device) {
    finished = true
    setImmediate(() => onEnded(false))
    return { push() {}, end() {}, stop() {} }
  }

  const pull = (): number | undefined => {
    while (head < chunks.length) {
      const chunk = chunks[head]
      if (chunk === undefined) {
        head += 1
        headOffset = 0
        continue
      }
      if (headOffset < chunk.length) {
        const value = chunk[headOffset] ?? 0
        headOffset += 1
        if (headOffset >= chunk.length) {
          head += 1
          headOffset = 0
        }
        return scaledSample(value, volume)
      }
      head += 1
      headOffset = 0
    }
    return undefined
  }

  try {
    const chosen = pickOutput(cpal, device, sampleRate)
    rate = chosen.rate
    const config = chosen.config
    const feed = reference ? new ReferenceFeed(reference) : undefined
    const output = device.buildOutputStream(
      config,
      cpal.SampleFormat.F32,
      (data: Float32Array) => {
        const channels = config.channels
        const frames = Math.floor(data.length / channels)
        for (let frame = 0; frame < frames; frame += 1) {
          const sample = pull()
          for (let channel = 0; channel < channels; channel += 1) {
            data[frame * channels + channel] = sample ?? 0
          }
          feed?.push(sample ?? 0, rate)
        }
        feed?.flush()
        if (ended && head >= chunks.length) finish(false, true)
      },
      (error: unknown) => {
        // A streaming source underruns whenever the network pauses; the callback
        // already writes silence, so this notice must not end the sentence.
        if (isRecoverableSpeakerError(error)) return
        fail(error)
        finish(true, true)
      },
    )
    stream = output
    output.play()
  } catch (error) {
    fail(error)
    finish(true)
  }

  return {
    push(samples) {
      if (finished || samples.length === 0) return
      chunks.push(rate === sampleRate ? samples : resampleLinear(samples, sampleRate, rate))
    },
    end() {
      if (finished) return
      ended = true
      if (head >= chunks.length) finish(false)
    },
    stop() {
      finish(true)
    },
  }
}

function playPcm(
  cpal: any,
  host: any,
  samples: Float32Array,
  sampleRate: number,
  volume: number,
  reference: EchoReference | undefined,
  onEnded: (stopped: boolean) => void,
): { stop(): void } {
  const device = host.defaultOutputDevice()
  if (!device) {
    onEnded(false)
    return { stop() {} }
  }
  const chosen = pickOutput(cpal, device, sampleRate)
  const config = chosen.config
  const pcm = chosen.rate === sampleRate ? samples : resampleLinear(samples, sampleRate, chosen.rate)
  const feed = reference ? new ReferenceFeed(reference) : undefined
  let cursor = 0
  let ended = false
  let stream: { close(): void, play(): void }
  const finish = (stopped: boolean) => {
    if (ended) return
    ended = true
    try { stream.close() } catch { /* already closed */ }
    onEnded(stopped)
  }
  stream = device.buildOutputStream(
    config,
    cpal.SampleFormat.F32,
    (data: Float32Array) => {
      const channels = config.channels
      const frames = Math.floor(data.length / channels)
      for (let frame = 0; frame < frames; frame += 1) {
        const sample = scaledSample(cursor < pcm.length ? pcm[cursor] ?? 0 : 0, volume)
        for (let channel = 0; channel < channels; channel += 1) data[frame * channels + channel] = sample
        feed?.push(sample, chosen.rate)
        cursor += 1
      }
      feed?.flush()
      if (cursor >= pcm.length) setImmediate(() => finish(false))
    },
    (error: unknown) => {
      fail(error)
      finish(true)
    },
  )
  stream.play()
  return { stop() { finish(true) } }
}

function pickOutput(cpal: any, device: any, sampleRate: number): { config: { channels: number, sampleRate: number }, rate: number } {
  const ranges = [...device.supportedOutputConfigs()]
  const f32 = ranges.filter((range: any) => range.sampleFormat() === cpal.SampleFormat.F32)
  const exact = f32.find((range: any) => range.channels() === 1 && range.containsRate(sampleRate))
    ?? f32.find((range: any) => range.containsRate(sampleRate))
  if (exact) {
    const supported = exact.tryWithSampleRate?.(sampleRate) ?? exact
    const config = typeof supported.config === 'function' ? supported.config() : new cpal.StreamConfig({
      channels: exact.channels(),
      sampleRate,
      bufferSize: cpal.BufferSize.Default,
    })
    return { config, rate: config.sampleRate ?? sampleRate }
  }
  const fallback = device.defaultOutputConfig()
  return { config: fallback.config(), rate: fallback.config().sampleRate }
}

function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples
  const length = Math.max(1, Math.round((samples.length * to) / from))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = (i * from) / to
    const left = Math.floor(position)
    const right = Math.min(left + 1, samples.length - 1)
    const mix = position - left
    out[i] = (samples[left] ?? 0) + ((samples[right] ?? 0) - (samples[left] ?? 0)) * mix
  }
  return out
}

function main(): void {
  const native = loadNative()
  const engine = native ? new Engine(native) : undefined
  if (!engine) emit({ type: 'mic', open: false })

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message: { type?: string, mode?: ListenMode, seedMs?: number, id?: string, settings?: VoiceSettings, paths?: ConfigureMessage['paths'] }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    try {
      if (message.type === 'configure') {
        engine?.configure(message as ConfigureMessage)
        return
      }
      if (message.type === 'listen' && (message.mode === 'off' || message.mode === 'wake' || message.mode === 'command' || message.mode === 'interject')) {
        const device = (message as { device?: unknown }).device
        engine?.listen(message.mode, message.seedMs ?? 0, device === false ? false : true)
        return
      }
      if (message.type === 'speak' && typeof message.id === 'string') {
        const spoken = typeof (message as { text?: unknown }).text === 'string' ? (message as { text: string }).text : ''
        debug(`stdin speak id=${message.id} chars=${spoken.length}`)
        if (engine) engine.speak(message.id, spoken)
        else {
          emit({ type: 'playback', id: message.id, phase: 'start' })
          emit({ type: 'playback', id: message.id, phase: 'end' })
        }
        return
      }
      if (message.type === 'stop-speak') engine?.stopSpeak()
    } catch (error) {
      // One bad command must not take the microphone down for the rest of the session.
      fail(error)
      // A play request that never started still needs its end, or the host queue waits forever.
      if (message.type === 'speak' && typeof message.id === 'string') {
        emit({ type: 'playback', id: message.id, phase: 'end' })
      }
    }
  })
  lines.on('close', () => {
    try { engine?.close() } catch { /* native streams may already be gone */ }
    process.exit(0)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Closing the microphone from a signal handler throws inside the native addon
    // and aborts the process. Exiting lets the operating system release the device.
    process.on(signal, () => { process.exit(0) })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
