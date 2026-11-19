/**
 * Whether the graphical session can be operated at all.
 *
 * A locked screen (or Windows UAC secure desktop / Session 0) makes every
 * window query fail: `list-windows`, `screenshot`, and ref actions time out or
 * return empty no matter how often they are retried. Detecting it up front
 * stops the agent immediately instead of wasting turns probing.
 *
 * - macOS: reads `CGSessionCopyCurrentDictionary` via Python's Quartz bridge.
 * - Windows: calls `user32.dll` `OpenInputDesktop(0, 0, DESKTOP_READOBJECTS)`
 *   through `koffi` (< 2 ms, zero subprocess spawn). A NULL handle means the
 *   desktop is locked, on the secure desktop, or running in Session 0.
 * @module @dsh-orb/desktop/src/session-state
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** DESKTOP_READOBJECTS access right for `OpenInputDesktop`. */
const DESKTOP_READOBJECTS = 0x0001

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

interface WinDesktopApi {
  OpenInputDesktop: (flags: number, inherit: number, desiredAccess: number) => unknown
  CloseDesktop: (handle: unknown) => number
}

let cachedWinDesktop: WinDesktopApi | null | undefined

function loadKoffi(): typeof import('koffi') {
  const dir = process.env.DSH_ORB_KOFFI_DIR
  if (dir !== undefined && dir !== '') {
    try {
      return createRequire(join(dir, 'index.js'))('koffi') as typeof import('koffi')
    } catch {
      // Fall back to packaged koffi.
    }
  }
  return createRequire(import.meta.url)('koffi') as typeof import('koffi')
}

function winDesktopApi(): WinDesktopApi | null {
  if (cachedWinDesktop !== undefined) return cachedWinDesktop
  try {
    const koffi = loadKoffi()
    const user32 = koffi.load('user32.dll')
    cachedWinDesktop = {
      OpenInputDesktop: user32.func('void * __stdcall OpenInputDesktop(uint32 dwFlags, int fInherit, uint32 dwDesiredAccess)'),
      CloseDesktop: user32.func('int __stdcall CloseDesktop(void *hDesktop)'),
    }
  } catch {
    cachedWinDesktop = null
  }
  return cachedWinDesktop
}

/** Probe Windows desktop availability via `OpenInputDesktop` (NULL = locked/secure/session 0). */
export function probeWindowsSessionState(apiOverride?: WinDesktopApi | null): SessionState {
  const api = apiOverride !== undefined ? apiOverride : winDesktopApi()
  if (api === null) return { locked: false, unknown: true }
  try {
    const handle = api.OpenInputDesktop(0, 0, DESKTOP_READOBJECTS)
    const isNull = handle === null || handle === undefined || handle === 0 || handle === 0n
    if (isNull) return { locked: true, unknown: false }
    api.CloseDesktop(handle)
    return { locked: false, unknown: false }
  } catch {
    return { locked: false, unknown: true }
  }
}

/**
 * Ask the OS whether the interactive desktop session is locked.
 * @returns the session state, never throwing.
 */
export async function sessionState(): Promise<SessionState> {
  if (process.platform === 'win32') return probeWindowsSessionState()
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
