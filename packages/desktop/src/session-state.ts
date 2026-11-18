/**
 * Whether the graphical session can be operated at all.
 *
 * A locked screen makes every window query fail: macOS stops answering window
 * inventory, so `list-windows`, `screenshot` and any ref action time out no
 * matter how often they are retried. Name that state once, up front, so the
 * agent stops instead of spending a dozen turns discovering it with shell
 * probes — which is exactly what happened in the first real measurement run.
 * @module @dsh-orb/desktop/src/session-state
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** What the desktop session currently allows. */
export interface SessionState {
  /** True only when the screen is known to be locked. */
  readonly locked: boolean
  /** True when the probe could not decide; callers must not treat it as unlocked. */
  readonly unknown: boolean
}

/** Reports from `CGSessionCopyCurrentDictionary` that mean "locked". */
function readsLocked(output: string): boolean {
  return /CGSSessionScreenIsLocked"?\s*=\s*(1|true|YES)/i.test(output)
}

/**
 * Ask the window server whether the console session is locked.
 *
 * Uses `CGSessionCopyCurrentDictionary` through Python's Quartz bridge, which is
 * present on every macOS with the developer command line tools. Any failure is
 * reported as `unknown` rather than `unlocked`: a wrong "unlocked" would send the
 * model into a long loop of doomed window calls.
 * @returns the session state, never throwing.
 */
export async function sessionState(): Promise<SessionState> {
  if (process.platform !== 'darwin') return { locked: false, unknown: false }
  try {
    const { stdout } = await run('python3', ['-c', [
      'import Quartz',
      'd = Quartz.CGSessionCopyCurrentDictionary() or {}',
      'print("CGSSessionScreenIsLocked=%s" % d.get("CGSSessionScreenIsLocked", 0))',
    ].join('\n')], { timeout: 5_000 })
    return { locked: readsLocked(stdout), unknown: false }
  } catch {
    return { locked: false, unknown: true }
  }
}
