/**
 * The process-global GUI mutex, from the desktop worker's side.
 *
 * Computer Use owns the same lock under `Symbol.for('dsh-orb.gui-lock')`: it holds
 * it while it moves the pointer and takes its post-action screenshot. The
 * background worker clicking through `--headed` touches the very same screen, so
 * a click that ignores this lock can land on top of the foreground agent's work —
 * or under the user's hand. Reading the same symbol is what makes the two
 * mutually exclusive without either one importing the other.
 *
 * Contention fails fast, matching Computer Use: a queued click would fire long
 * after the moment it was aimed at.
 * @module @dsh-orb/desktop/src/gui-lock
 */

/** Tool-visible failure text, mirroring Computer Use so both sides read alike. */
export const SCREEN_BUSY_MESSAGE =
  'Another session is operating the screen right now. '
  + 'Do not retry this click; report the conflict and continue with work that needs no screen.'

interface ScreenLockState {
  readonly held: boolean
  readonly owner: unknown
}

const SCREEN_LOCK = Symbol.for('dsh-orb.gui-lock')

/** Read the shared lock state without creating it. */
function lockState(): { held: boolean, owner: unknown } {
  const holder = globalThis as { [SCREEN_LOCK]?: ScreenLockState }
  return holder[SCREEN_LOCK] ?? { held: false, owner: undefined }
}

/**
 * Whether some session currently controls the screen.
 * @returns the holding agent id, or undefined when the screen is free.
 */
export function screenLockOwner(): unknown {
  const state = lockState()
  return state.held ? state.owner : undefined
}

/**
 * Run one physical input under the shared GUI lock.
 *
 * Unlike Computer Use this does not create the lock when absent: the desktop
 * worker is a background path, so it joins the existing discipline rather than
 * establishing it.
 * @param owner - calling agent id.
 * @param run - the input to deliver.
 * @returns what `run` resolves to.
 * @throws {@link SCREEN_BUSY_MESSAGE} when another session holds the screen.
 */
export async function withScreenLock<T>(owner: string | undefined, run: () => Promise<T>): Promise<T> {
  const holder = globalThis as {
    [SCREEN_LOCK]?: { held: boolean, owner: unknown }
  }
  const state = holder[SCREEN_LOCK]
  const key = owner ?? Symbol('dsh-orb.gui-lock.anonymous')
  if (state !== undefined && state.held && state.owner !== key) throw new Error(SCREEN_BUSY_MESSAGE)
  const nested = state?.held === true
  if (!nested) {
    // Create or take over the record so a concurrent Computer Use action sees it.
    holder[SCREEN_LOCK] = { held: true, owner: key }
  }
  try {
    return await run()
  } finally {
    if (!nested) {
      holder[SCREEN_LOCK] = { held: false, owner: undefined }
    }
  }
}
