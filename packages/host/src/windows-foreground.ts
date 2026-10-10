/**
 * Remembers the window the user was working in, so the ball can hand the foreground back.
 * Windows makes the ball an ordinary activatable window: clicking it moves the system
 * foreground onto the ball, and the agent's first capture would then read the ball as the
 * user's app. The helper's chrome handles tell the ball apart from the user's windows while
 * this module samples `GetForegroundWindow`.
 * Windows only: every entry point is inert on other platforms.
 */

import { requireKoffi } from './native-images.ts'

/** How often the foreground window is sampled. */
export const FOREGROUND_SAMPLE_MS = 250
/** `SetForegroundWindow` is ignored unless this process received the last input; a posted Alt satisfies that. */
const VK_MENU = 0x12
const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
/** `sizeof(INPUT)` on 64-bit Windows. */
const INPUT_SIZE = 40
const FOREGROUND_RETRY_MS = 50

/** The native calls this module needs. Tests inject a fake. */
export interface ForegroundNative {
  /** HWND of the current foreground window, or `0`. */
  foreground(): number
  /** Bring `target` forward. */
  focus(target: number): boolean
}

export interface ForegroundMemoryOptions {
  /** Handles of the helper's own windows. The user is never working in one of those. */
  chromeWindowIds(): readonly number[]
  /** Sampling interval in milliseconds. */
  intervalMs?: number
  /** Injected native layer. Production loads Win32 on Windows. */
  native?: ForegroundNative | undefined
}

export interface ForegroundMemory {
  /** Begin sampling while a helper is connected. No-op without a native layer. */
  start(): void
  stop(): void
  /** Bring the remembered window back to the foreground. */
  restore(): void
}

/**
 * Track the last foreground window that is not the helper's own chrome.
 * @param options - chrome handles, interval, and an optional native layer.
 * @returns the sampler.
 */
export function createForegroundMemory(options: ForegroundMemoryOptions): ForegroundMemory {
  const intervalMs = options.intervalMs ?? FOREGROUND_SAMPLE_MS
  let native = options.native
  let loaded = options.native !== undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let remembered = 0

  function api(): ForegroundNative | undefined {
    if (loaded) return native
    loaded = true
    if (process.platform !== 'win32') return undefined
    try {
      native = loadWindowsForeground()
    } catch (error) {
      console.error(`dsh-orb: foreground memory unavailable: ${error instanceof Error ? error.message : String(error)}`)
      native = undefined
    }
    return native
  }

  function sample(): void {
    const host = api()
    if (host === undefined) return
    let foreground = 0
    try {
      foreground = host.foreground()
    } catch {
      return
    }
    if (foreground <= 0) return
    const chrome = options.chromeWindowIds()
    // Until the helper reports its chrome handles there is no way to tell the ball from
    // the user's window, and the ball is the foreground right after it was clicked. Wait
    // for the first report; the sampler keeps ticking on its own.
    if (chrome.length === 0) return
    if (chrome.includes(foreground)) {
      // The remembered window turned out to be the ball itself; it must never be handed back.
      if (remembered === foreground) remembered = 0
      return
    }
    remembered = foreground
  }

  return {
    start(): void {
      if (timer !== undefined || api() === undefined) return
      sample()
      const created = setInterval(sample, intervalMs)
      created.unref()
      timer = created
    },
    stop(): void {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    restore(): void {
      const host = api()
      if (host === undefined || remembered <= 0) return
      try {
        if (host.foreground() === remembered) return
        host.focus(remembered)
      } catch {
        // A window that closed between sampling and restore keeps whatever focus it has.
      }
    },
  }
}

function handleValue(value: unknown): number {
  const id = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** One `KEYBDINPUT` inside an `INPUT`, laid out for 64-bit Windows. */
function keyboardInput(virtualKey: number, down: boolean): Buffer {
  const input = Buffer.alloc(INPUT_SIZE)
  input.writeUInt32LE(INPUT_KEYBOARD, 0)
  input.writeUInt16LE(virtualKey, 8)
  input.writeUInt32LE(down ? 0 : KEYEVENTF_KEYUP, 12)
  return input
}

function loadWindowsForeground(): ForegroundNative {
  const koffi = requireKoffi<{ load(path: string): { func(signature: string): (...args: unknown[]) => unknown } }>(import.meta.url)
  const user32 = koffi.load('user32.dll')
  const getForeground = user32.func('void * __stdcall GetForegroundWindow()')
  const setForeground = user32.func('int __stdcall SetForegroundWindow(void *hWnd)')
  const isWindow = user32.func('int __stdcall IsWindow(void *hWnd)')
  const sendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)')

  function foreground(): number {
    return handleValue(getForeground())
  }

  function postKey(virtualKey: number, down: boolean): void {
    sendInput(1, keyboardInput(virtualKey, down), INPUT_SIZE)
  }

  return {
    foreground,
    focus(target) {
      if (isWindow(target) === 0) return false
      postKey(VK_MENU, true)
      try {
        setForeground(target)
        if (foreground() === target) return true
        sleepSync(FOREGROUND_RETRY_MS)
        return foreground() === target
      } finally {
        postKey(VK_MENU, false)
      }
    },
  }
}
