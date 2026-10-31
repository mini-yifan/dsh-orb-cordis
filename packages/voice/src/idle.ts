/**
 * When a pinned, idle ball should unpin.
 * The pointer is not an input: hovering does not pause or cancel this clock.
 * Time is injected, so a test can cross 30 seconds without waiting.
 */

export interface IdleClock {
  /** When the current run started. Null while the clock is paused or disarmed. */
  readonly startedAt: number | null
}

export interface IdleSample {
  readonly now: number
  readonly pinned: boolean
  /** Agent turn in progress. */
  readonly agentBusy: boolean
  /** A selection-toolbar translation is streaming: it holds the ball the same way. */
  readonly translationBusy?: boolean
  /** Question card waiting for a click. */
  readonly questionOpen: boolean
  /** Speaker or queue still holds a closing line, a prompt, or a local reply. */
  readonly playbackBusy: boolean
  /** A voice utterance has started and has not been sent yet. */
  readonly speechOpen: boolean
  readonly idleMs: number
  /**
   * A keystroke, a sent text command, or a voice command that was just dispatched.
   * Restarts the clock from zero. A pause already restarts from zero when it lifts.
   */
  readonly activity?: boolean
}

export function createIdle(): IdleClock {
  return { startedAt: null }
}

/**
 * Advance the clock. `unpin` means the idle span elapsed; the caller only
 * clears the pin. Collapse of the panel is a separate, pointer-based rule.
 */
export function stepIdle(clock: IdleClock, sample: IdleSample): { clock: IdleClock, unpin: boolean } {
  const running = sample.pinned
    && !sample.agentBusy
    && sample.translationBusy !== true
    && !sample.questionOpen
    && !sample.playbackBusy
    && !sample.speechOpen
  if (!running) return { clock: { startedAt: null }, unpin: false }
  const startedAt = sample.activity || clock.startedAt === null ? sample.now : clock.startedAt
  if (sample.now - startedAt >= sample.idleMs) return { clock: { startedAt: null }, unpin: true }
  return { clock: { startedAt }, unpin: false }
}
