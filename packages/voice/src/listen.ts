/**
 * Which decoder the one open microphone feeds.
 * Host computes this from the ball's pin, the turn, the question card, playback,
 * and whether each model is switched on and present. The child only applies it.
 */

import { hasWakeWord } from './settings.ts'

export type ListenMode = 'off' | 'wake' | 'command' | 'interject'

/** command 和 interject 都是「转写开着」。 */
export function transcribing(mode: ListenMode): boolean {
  return mode === 'command' || mode === 'interject'
}

export interface MicInput {
  /** Wake switch is on. */
  readonly wakeEnabled: boolean
  /** Wake words; an empty list means the column cannot run. */
  readonly wakeWords: readonly string[]
  /** The wake model files are complete. */
  readonly wakeModel: boolean
  /** Voice-input switch is on. */
  readonly commandEnabled: boolean
  /** The official ASR model files are complete. */
  readonly asrModel: boolean
}

/**
 * Whether the child must hold the microphone at all. TTS never needs it; only a
 * listening column that is switched on and has a complete model does. When both
 * columns are off or unready, the device is released so macOS stops showing the
 * microphone indicator.
 */
export function needsMicrophone(input: MicInput): boolean {
  return (input.wakeEnabled && hasWakeWord(input.wakeWords) && input.wakeModel)
    || (input.commandEnabled && input.asrModel)
}

export interface ListenInput {
  /** The panel is pinned. Hover-open does not count. */
  readonly pinned: boolean
  /** The floating-ball agent is in a turn. */
  readonly agentBusy: boolean
  /** A question card is waiting for a click. */
  readonly questionOpen: boolean
  /** queue.bodyBusy */
  readonly bodyBusy: boolean
  /** queue.localBusy */
  readonly localBusy: boolean
  /** 停止或退下已经发出、执行还没真正停下 */
  readonly stopping: boolean
  /** Wake switch is on, the wake word is not empty, and the wake model files are complete. */
  readonly wakeEnabled: boolean
  /** Voice-input switch is on and the official ASR model files are complete. */
  readonly commandEnabled: boolean
  /** commandEnabled, and the interject keyword is not empty. */
  readonly interjectEnabled: boolean
  /** This capture of the child process includes echo cancellation. */
  readonly echoCancel: boolean
  /** The child process has the microphone. */
  readonly micOpen: boolean
}

/**
 * `off`, `wake`, `command`, or `interject`.
 *
 * A question card, a local reply, a stop that has not settled, or a closed
 * microphone wins. A busy agent or agent body audio listens for an interjection
 * when that column is on and, while body audio is playing, echo cancellation is
 * present. Otherwise an unpinned ball listens for the wake word, and a pinned
 * ball listens for a command.
 */
export function listenMode(input: ListenInput): ListenMode {
  if (input.questionOpen || input.localBusy || input.stopping || !input.micOpen) return 'off'
  if (input.agentBusy || input.bodyBusy) {
    if (!input.interjectEnabled) return 'off'
    // 没有回声消除时，自己的播报会被转写进去。降级成正文播报期间不听。
    if (input.bodyBusy && !input.echoCancel) return 'off'
    return 'interject'
  }
  if (!input.pinned && input.wakeEnabled) return 'wake'
  if (input.pinned && input.commandEnabled) return 'command'
  return 'off'
}

export interface DeviceInput extends MicInput {
  /** The panel is pinned. Hover-open does not count. */
  readonly pinned: boolean
  /** The floating-ball agent is in a turn. */
  readonly agentBusy: boolean
  /** A question card is waiting for a click. */
  readonly questionOpen: boolean
  /** queue.bodyBusy */
  readonly bodyBusy: boolean
  /** commandEnabled, and the interject keyword is not empty. */
  readonly interjectEnabled: boolean
  /** This capture of the child process includes echo cancellation. */
  readonly echoCancel: boolean
}

/**
 * 子进程要不要占着麦克风设备。
 *
 * 光看“哪一列开着”不够：唤醒只在收起时可达，语音输入只在固定时可达。只开唤醒
 * 却把球固定，或只开语音输入却把球收起，当前固定状态没有任何解码器能跑，继续占
 * 着设备只会让系统麦克风指示白亮。提问卡仍然一律放开。
 *
 * 执行中和播报中不看固定状态：只要插话这一列能跑（有语音输入、有关键词，
 * 且正文播报时带回声消除），设备就要留着。回复、停止这类短暂的 off 不单独处理：
 * 按同一套“当前固定状态有没有可达的列”判断，能恢复的列在就保持，不能恢复的就放开。
 */
export function holdsDevice(input: DeviceInput): boolean {
  if (input.questionOpen) return false
  const wakeReady = input.wakeEnabled && hasWakeWord(input.wakeWords) && input.wakeModel
  const commandReady = input.commandEnabled && input.asrModel
  if (!wakeReady && !commandReady) return false
  if (input.agentBusy || input.bodyBusy) {
    if (!commandReady || !input.interjectEnabled) return false
    // 没有回声消除时，正文播报期间不听，设备也不必占着。
    if (input.bodyBusy && !input.echoCancel) return false
    return true
  }
  // 收起时只有唤醒可达，固定时只有语音输入可达。
  return input.pinned ? commandReady : wakeReady
}
