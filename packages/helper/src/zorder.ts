/**
 * Keep the floating ball below fullscreen windows that own the ball's display.
 *
 * The ball is an ordinary always-on-top window on Windows, so a fullscreen game, a
 * browser video or a borderless fullscreen app would otherwise be covered by it.
 * Every {@link ZORDER_POLL_MS} the guard samples the foreground window; when that
 * window fills the monitor the ball is on, the ball leaves the topmost band and is
 * sent to the bottom of the z-order, then the topmost band is restored as soon as
 * fullscreen ends.
 *
 * Inserting the ball below the fullscreen window is not used: placing a normal window
 * after another process's window can be refused (UIPI, anti-cheat drivers), which
 * leaves the ball at the top of the normal band and still over the game — measured on
 * Delta Force, ball z 64 vs game z 67. Sending our own window to `HWND_BOTTOM` needs
 * no reference to the other window and always lands under a monitor-covering window.
 *
 * `IsZoomed` must not be consulted: an F11 fullscreen entered from a maximized
 * browser keeps `WS_MAXIMIZE` (measured on Edge 140: `rect=0,0,2560,1440` while
 * `IsZoomed()` is true). Exact-edge matching against the monitor tells the two apart:
 * a merely maximized window stops at the work area, or keeps the ~8 px DWM invisible
 * border when the taskbar auto-hides.
 *
 * macOS deliberately keeps the ball visible on fullscreen spaces (`visibleOnFullScreen`
 * in `openWindow`), so the guard is Windows only. The selection toolbar and the
 * observation frame are not part of it.
 *
 * @module @dsh-orb/helper/src/zorder
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { windowIdFromHandle } from './chrome-windows.ts'

/** A rectangle in physical pixels, the space the Win32 calls below report. */
export interface WindowRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Edge tolerance, in physical pixels, when matching a window rect to its monitor. */
export const FULLSCREEN_TOLERANCE = 4

/** Sampling cadence. A fullscreen switch becomes visible within one interval. */
export const ZORDER_POLL_MS = 600

/**
 * Whether a window rect covers its monitor on all four edges.
 * @param window - the candidate window rect.
 * @param monitor - the monitor rect, `rcMonitor` (not `rcWork`).
 * @param tolerance - allowed edge difference; defaults to {@link FULLSCREEN_TOLERANCE}.
 */
export function rectFillsMonitor(
  window: WindowRect,
  monitor: WindowRect,
  tolerance: number = FULLSCREEN_TOLERANCE,
): boolean {
  const near = (value: number, edge: number): boolean => Math.abs(value - edge) <= tolerance
  return near(window.left, monitor.left)
    && near(window.top, monitor.top)
    && near(window.right, monitor.right)
    && near(window.bottom, monitor.bottom)
}

/** The foreground window, once it is known to fill a monitor. */
export interface FullscreenSample {
  /** The foreground window. */
  handle: bigint
  /** The monitor the foreground window fills. */
  monitor: bigint
}

/** Win32 work the guard needs; injectable so the guard itself stays testable. */
export interface ZOrderProbe {
  /**
   * The foreground window when it fills a monitor, otherwise undefined.
   * Must not report the helper's own windows.
   */
  foreground(): FullscreenSample | undefined
  /** The monitor a window is on. Throws when the handle has no monitor. */
  monitorOf(handle: bigint): bigint
  /** Send `handle` to the bottom of the z-order without moving, resizing or activating it. */
  sendToBottom(handle: bigint): void
}

/** The subset of `BrowserWindow` the guard reads. */
export interface ZOrderWindow {
  isDestroyed(): boolean
  isAlwaysOnTop(): boolean
  setAlwaysOnTop(flag: boolean, level?: string): void
  getNativeWindowHandle(): Buffer
}

export interface ZOrderGuard {
  /** Run one sample. Exported for tests; the production wiring polls it. */
  tick(): void
  /** Stop acting on the window. */
  stop(): void
}

/** The level the ball normally lives at; `openWindow` sets the same one. */
const TOPMOST_LEVEL = 'screen-saver'

const MONITOR_DEFAULTTONEAREST = 2
/** `HWND_BOTTOM`: the bottom of the whole z-order, no cross-process handle needed. */
const HWND_BOTTOM = 1n
/** `MONITORINFO` is 40 bytes; `rcMonitor` starts at byte 4 (after `cbSize`). */
const MONITORINFO_BYTES = 40
const MONITORINFO_CB_SIZE = 40
const RECT_BYTES = 16
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010

/** A window handle as a bigint; undefined for NULL. */
function asHandle(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value === 0n ? undefined : value
  if (typeof value === 'number') return value === 0 ? undefined : BigInt(value)
  return undefined
}

/** The ball's HWND, read from the buffer Electron returns. */
function windowHandle(window: ZOrderWindow): bigint | undefined {
  try {
    const id = windowIdFromHandle(window.getNativeWindowHandle())
    return id === undefined ? undefined : BigInt(id)
  } catch {
    // The window can be gone between the check and the call.
    return undefined
  }
}

/**
 * Watch the foreground window and keep the ball out of a fullscreen window's way.
 * @param window - the ball window.
 * @param probe - the platform half.
 */
export function createZOrderGuard(window: ZOrderWindow, probe: ZOrderProbe): ZOrderGuard {
  let stopped = false

  function tick(): void {
    if (stopped || window.isDestroyed()) return
    let sample: FullscreenSample | undefined
    try {
      sample = probe.foreground()
    } catch {
      return
    }
    const handle = windowHandle(window)
    if (handle === undefined) return

    if (sample !== undefined) {
      let sameDisplay = false
      try {
        sameDisplay = probe.monitorOf(handle) === sample.monitor
      } catch {
        sameDisplay = false
      }
      if (sameDisplay) {
        if (window.isAlwaysOnTop()) window.setAlwaysOnTop(false)
        // HWND_BOTTOM rather than "below the fullscreen window": a cross-process
        // SetWindowPos can be refused (UIPI / anti-cheat), which would leave the ball
        // at the top of the normal band, still over the game.
        try {
          probe.sendToBottom(handle)
        } catch {
          // The window can be gone by the time the call runs.
        }
        return
      }
    }

    if (!window.isAlwaysOnTop()) window.setAlwaysOnTop(true, TOPMOST_LEVEL)
  }

  return {
    tick,
    stop(): void {
      stopped = true
    },
  }
}

type Koffi = typeof import('koffi')

/** koffi from the host's copy outside the package, or the packaged one. */
function loadKoffi(): Koffi | undefined {
  const require = createRequire(import.meta.url)
  const staged = process.env.DSH_ORB_KOFFI_DIR
  try {
    if (staged !== undefined && staged !== '') return require(join(staged, 'node_modules', 'koffi')) as Koffi
  } catch {
    // The staged copy is unusable; the packaged one still works, it only blocks updates.
  }
  try {
    return require('koffi') as Koffi
  } catch {
    return undefined
  }
}

interface NativeRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Win32Bindings {
  GetForegroundWindow(): unknown
  GetWindowRect(window: unknown, rect: NativeRect): number
  GetMonitorInfoW(monitor: unknown, info: Buffer): number
  MonitorFromWindow(window: unknown, flags: number): unknown
  GetWindowThreadProcessId(window: unknown, pid: number[]): number
  IsWindowVisible(window: unknown): number
  SetWindowPos(window: unknown, insertAfter: unknown, x: number, y: number, cx: number, cy: number, flags: number): number
}

/** Win32 probe. Loaded only on Windows and only when the guard starts. */
function createWin32Probe(): ZOrderProbe | undefined {
  const koffi = loadKoffi()
  if (koffi === undefined) {
    console.error('dsh-orb helper: z-order guard disabled, koffi could not be loaded')
    return undefined
  }
  let api: Win32Bindings
  try {
    const user32 = koffi.load('user32.dll')
    koffi.struct('DSH_ORB_ZORDER_RECT', {
      left: 'int32',
      top: 'int32',
      right: 'int32',
      bottom: 'int32',
    })
    api = {
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetWindowRect: user32.func('int __stdcall GetWindowRect(void *hWnd, _Out_ DSH_ORB_ZORDER_RECT *lpRect)'),
      GetMonitorInfoW: user32.func('int __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)'),
      MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(void *hWnd, uint32 dwFlags)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'),
      IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
      SetWindowPos: user32.func('int __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`dsh-orb helper: z-order guard disabled, user32 is unavailable (${message})`)
    return undefined
  }

  function monitorRect(monitor: bigint): WindowRect | undefined {
    const info = Buffer.alloc(MONITORINFO_BYTES)
    info.writeUInt32LE(MONITORINFO_CB_SIZE, 0)
    if (api.GetMonitorInfoW(monitor, info) === 0) return undefined
    return {
      left: info.readInt32LE(4),
      top: info.readInt32LE(8),
      right: info.readInt32LE(12),
      bottom: info.readInt32LE(16),
    }
  }

  return {
    foreground(): FullscreenSample | undefined {
      const handle = asHandle(api.GetForegroundWindow())
      if (handle === undefined) return undefined
      if (api.IsWindowVisible(handle) === 0) return undefined
      const pid = [0]
      api.GetWindowThreadProcessId(handle, pid)
      // The ball itself (or any other helper chrome) can be the foreground window.
      if (pid[0] === process.pid) return undefined
      const rect = { left: 0, top: 0, right: 0, bottom: 0 }
      if (api.GetWindowRect(handle, rect) === 0) return undefined
      const monitor = asHandle(api.MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST))
      if (monitor === undefined) return undefined
      const bounds = monitorRect(monitor)
      if (bounds === undefined) return undefined
      if (!rectFillsMonitor({ ...rect }, bounds)) return undefined
      return { handle, monitor }
    },
    monitorOf(handle: bigint): bigint {
      const monitor = asHandle(api.MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST))
      if (monitor === undefined) throw new Error('z-order guard: the window has no monitor')
      return monitor
    },
    sendToBottom(handle: bigint): void {
      api.SetWindowPos(handle, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
    },
  }
}

let activeStop: (() => void) | undefined

/**
 * Start watching on Windows; a no-op on the other platforms.
 * @param window - the ball window.
 * @param platform - the helper's `process.platform`, injectable for tests.
 * @returns a stop function; calling it twice is harmless.
 */
export function startZOrderGuard(window: ZOrderWindow, platform: string = process.platform): () => void {
  if (platform !== 'win32') return () => undefined
  if (activeStop !== undefined) return activeStop
  const probe = createWin32Probe()
  if (probe === undefined) return () => undefined
  const guard = createZOrderGuard(window, probe)
  const timer = setInterval(() => { guard.tick() }, ZORDER_POLL_MS)
  timer.unref()
  activeStop = (): void => {
    clearInterval(timer)
    guard.stop()
    activeStop = undefined
  }
  return activeStop
}
