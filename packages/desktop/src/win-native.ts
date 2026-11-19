/**
 * In-process Win32 desktop primitives via `koffi`: DWM visible bounds, BitBlt
 * window capture, foreground/restore, and SendInput mouse/wheel/drag/hotkeys.
 *
 * Eliminates the ~0.9–1.2 s `agent-desktop.exe` cold-start tax paid 3–4 times
 * per gesture on Windows, and uses `DWMWA_EXTENDED_FRAME_BOUNDS` so screenshots
 * and clicks exclude the ~11 px invisible Windows 10/11 resize frame (0 px
 * coordinate offset).
 *
 * Pure helpers (`windowsVirtualKey`, `windowsKeyIsExtended`, `parseComboKeys`,
 * `encodeBgraPng`) have zero OS dependencies and are unit-tested on every OS.
 * @module @dsh-orb/desktop/src/win-native
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { WindowInfo } from './protocol.ts'

const SRCCOPY = 0x00cc0020
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x01000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const SW_RESTORE = 9
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const VK_MENU = 0x12
const DPI_PER_MONITOR_V2 = -4
const DPI_PER_MONITOR = -3
const WHEEL_DELTA = 120
const FOREGROUND_RETRY_MS = 40

/** Named keys mapped to Win32 Virtual-Key codes. */
const KEY_NAMES: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  return: 0x0d,
  enter: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  option: 0x12,
  pause: 0x13,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
  super: 0x5b,
  ';': 0xba,
  semicolon: 0xba,
  '=': 0xbb,
  equal: 0xbb,
  ',': 0xbc,
  comma: 0xbc,
  '-': 0xbd,
  minus: 0xbd,
  '.': 0xbe,
  period: 0xbe,
  '/': 0xbf,
  slash: 0xbf,
  '`': 0xc0,
  grave: 0xc0,
  '[': 0xdb,
  leftbracket: 0xdb,
  '\\': 0xdc,
  backslash: 0xdc,
  ']': 0xdd,
  rightbracket: 0xdd,
  '\'': 0xde,
  quote: 0xde,
}

const EXTENDED_KEY_NAMES = new Set([
  'insert', 'delete', 'del', 'home', 'end', 'pageup', 'pagedown',
  'left', 'up', 'right', 'down', 'win', 'meta', 'cmd', 'command', 'super',
])

/** Map one key token to its Win32 Virtual-Key code, or undefined if unknown. */
export function windowsVirtualKey(key: string): number | undefined {
  const token = key.trim().toLowerCase()
  const named = KEY_NAMES[token]
  if (named !== undefined) return named
  if (/^[a-z]$/.test(token)) return token.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(token)) return token.charCodeAt(0)
  const fn = /^f([1-9]|1[0-2])$/.exec(token)
  if (fn !== null) return 0x70 + Number(fn[1]) - 1
  return undefined
}

/** Whether a key token requires `KEYEVENTF_EXTENDEDKEY`. */
export function windowsKeyIsExtended(key: string): boolean {
  return EXTENDED_KEY_NAMES.has(key.trim().toLowerCase())
}

/** Parse a combo string (`ctrl+shift+v`) or key list (`['ctrl', 'v']`) into VK descriptors. */
export function parseComboKeys(
  combo: string | readonly string[],
): readonly { readonly vk: number; readonly extended: boolean }[] | undefined {
  const parts = (typeof combo === 'string' ? combo.split('+') : [...combo])
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length === 0) return undefined
  const out: { vk: number; extended: boolean }[] = []
  for (const part of parts) {
    const vk = windowsVirtualKey(part)
    if (vk === undefined) return undefined
    out.push({ vk, extended: windowsKeyIsExtended(part) })
  }
  return out
}

/** Encode tightly packed 32-bit BGRA pixels into a valid PNG buffer. */
export function encodeBgraPng(width: number, height: number, bgra: Buffer, bottomUp: boolean): Buffer {
  const rowBytes = width * 4
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const sourceY = bottomUp ? height - 1 - y : y
    const dest = y * (rowBytes + 1)
    raw[dest] = 0
    for (let x = 0; x < width; x += 1) {
      const source = sourceY * rowBytes + x * 4
      const pixel = dest + 1 + x * 4
      raw[pixel] = bgra[source + 2] ?? 0
      raw[pixel + 1] = bgra[source + 1] ?? 0
      raw[pixel + 2] = bgra[source] ?? 0
      raw[pixel + 3] = 255
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0, 0)
  return Buffer.concat([length, name, data, crc])
}

export interface WinRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface NativeRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface WinApi {
  readonly inputSize: number
  GetForegroundWindow: () => number | bigint
  GetWindowRect: (hwnd: number | bigint, rect: NativeRect) => number
  IsWindowVisible: (hwnd: number | bigint) => number
  IsIconic: (hwnd: number | bigint) => number
  ShowWindow: (hwnd: number | bigint, cmd: number) => number
  SetForegroundWindow: (hwnd: number | bigint) => number
  GetSystemMetrics: (index: number) => number
  SetThreadDpiAwarenessContext?: (ctx: number | bigint) => number | bigint
  GetDC: (hwnd: number | bigint) => number | bigint
  ReleaseDC: (hwnd: number | bigint, hdc: number | bigint) => number
  CreateCompatibleDC: (hdc: number | bigint) => number | bigint
  CreateCompatibleBitmap: (hdc: number | bigint, cx: number, cy: number) => number | bigint
  SelectObject: (hdc: number | bigint, h: number | bigint) => number | bigint
  BitBlt: (hdc: number | bigint, x: number, y: number, cx: number, cy: number, src: number | bigint, x1: number, y1: number, rop: number) => number
  GetDIBits: (hdc: number | bigint, hbm: number | bigint, start: number, lines: number, bits: Buffer, bmi: Record<string, number>, usage: number) => number
  DeleteObject: (ho: number | bigint) => number
  DeleteDC: (hdc: number | bigint) => number
  SendInput: (count: number, inputs: unknown[], size: number) => number
  DwmGetWindowAttribute: (hwnd: number | bigint, attr: number, out: Buffer, size: number) => number
}

let cachedApi: WinApi | null | undefined

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

function winApi(): WinApi | null {
  if (cachedApi !== undefined) return cachedApi
  if (process.platform !== 'win32') {
    cachedApi = null
    return null
  }
  try {
    const koffi = loadKoffi()
    const RECT = koffi.struct('DSH_DESK_RECT', {
      left: 'int32',
      top: 'int32',
      right: 'int32',
      bottom: 'int32',
    })
    const BITMAPINFOHEADER = koffi.struct('DSH_DESK_BITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    })
    const MOUSEINPUT = koffi.struct('DSH_DESK_MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr',
    })
    const KEYBDINPUT = koffi.struct('DSH_DESK_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr',
    })
    const INPUT_UNION = koffi.union('DSH_DESK_INPUT_UNION', {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
    })
    const INPUT = koffi.struct('DSH_DESK_INPUT', {
      type: 'uint32',
      u: INPUT_UNION,
    })
    void RECT
    void BITMAPINFOHEADER

    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    const dwmapi = koffi.load('dwmapi.dll')

    let setThreadDpi: WinApi['SetThreadDpiAwarenessContext']
    try {
      setThreadDpi = user32.func('intptr __stdcall SetThreadDpiAwarenessContext(intptr dpiContext)')
    } catch {
      setThreadDpi = undefined
    }

    cachedApi = {
      inputSize: koffi.sizeof(INPUT),
      GetForegroundWindow: user32.func('uintptr __stdcall GetForegroundWindow()'),
      GetWindowRect: user32.func('int __stdcall GetWindowRect(uintptr hWnd, _Out_ DSH_DESK_RECT *lpRect)'),
      IsWindowVisible: user32.func('int __stdcall IsWindowVisible(uintptr hWnd)'),
      IsIconic: user32.func('int __stdcall IsIconic(uintptr hWnd)'),
      ShowWindow: user32.func('int __stdcall ShowWindow(uintptr hWnd, int nCmdShow)'),
      SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(uintptr hWnd)'),
      GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
      ...setThreadDpi !== undefined ? { SetThreadDpiAwarenessContext: setThreadDpi } : {},
      GetDC: user32.func('uintptr __stdcall GetDC(uintptr hWnd)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(uintptr hWnd, uintptr hDC)'),
      CreateCompatibleDC: gdi32.func('uintptr __stdcall CreateCompatibleDC(uintptr hdc)'),
      CreateCompatibleBitmap: gdi32.func('uintptr __stdcall CreateCompatibleBitmap(uintptr hdc, int cx, int cy)'),
      SelectObject: gdi32.func('uintptr __stdcall SelectObject(uintptr hdc, uintptr h)'),
      BitBlt: gdi32.func(
        'int __stdcall BitBlt(uintptr hdc, int x, int y, int cx, int cy, uintptr hdcSrc, int x1, int y1, uint32 rop)',
      ),
      GetDIBits: gdi32.func(
        'int __stdcall GetDIBits(uintptr hdc, uintptr hbm, uint32 start, uint32 cLines, '
        + '_Out_ uint8_t *lpvBits, _Inout_ DSH_DESK_BITMAPINFOHEADER *lpbmi, uint32 usage)',
      ),
      DeleteObject: gdi32.func('int __stdcall DeleteObject(uintptr ho)'),
      DeleteDC: gdi32.func('int __stdcall DeleteDC(uintptr hdc)'),
      SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, DSH_DESK_INPUT *pInputs, int cbSize)'),
      DwmGetWindowAttribute: dwmapi.func(
        'int __stdcall DwmGetWindowAttribute(uintptr hwnd, uint32 dwAttribute, _Out_ uint8_t *pvAttribute, uint32 cbAttribute)',
      ),
    }
  } catch {
    cachedApi = null
  }
  return cachedApi
}

function isZeroHandle(handle: number | bigint): boolean {
  return handle === 0 || handle === 0n
}

function parseHwnd(windowId: string): bigint | undefined {
  const match = /^(?:w-)?(\d+)$/.exec(windowId.trim())
  if (match?.[1] === undefined) return undefined
  const value = BigInt(match[1])
  return value > 0n ? value : undefined
}

function perMonitor<T>(api: WinApi, fn: () => T): T {
  const setDpi = api.SetThreadDpiAwarenessContext
  if (setDpi === undefined) return fn()
  let previous = setDpi(DPI_PER_MONITOR_V2)
  if (isZeroHandle(previous)) previous = setDpi(DPI_PER_MONITOR)
  try {
    return fn()
  } finally {
    if (!isZeroHandle(previous)) setDpi(previous)
  }
}

function sendMouse(api: WinApi, flags: number, x: number, y: number, data = 0): boolean {
  const absolute = (flags & MOUSEEVENTF_ABSOLUTE) !== 0
  const left = api.GetSystemMetrics(SM_XVIRTUALSCREEN)
  const top = api.GetSystemMetrics(SM_YVIRTUALSCREEN)
  const width = Math.max(1, api.GetSystemMetrics(SM_CXVIRTUALSCREEN))
  const height = Math.max(1, api.GetSystemMetrics(SM_CYVIRTUALSCREEN))
  const input = {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx: absolute ? Math.round(((x - left) * 65535) / Math.max(1, width - 1)) : x,
        dy: absolute ? Math.round(((y - top) * 65535) / Math.max(1, height - 1)) : y,
        mouseData: data >>> 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
  return api.SendInput(1, [input], api.inputSize) === 1
}

function sendKey(api: WinApi, vk: number, down: boolean, extended: boolean): boolean {
  const input = {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: 0,
        dwFlags: (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
        time: 0,
        dwExtraInfo: 0,
      },
    },
  }
  return api.SendInput(1, [input], api.inputSize) === 1
}

function dwmOrWindowRect(api: WinApi, hwnd: bigint): WinRect | undefined {
  const raw = Buffer.alloc(16)
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, raw, 16) === 0) {
    const left = raw.readInt32LE(0)
    const top = raw.readInt32LE(4)
    const right = raw.readInt32LE(8)
    const bottom = raw.readInt32LE(12)
    if (right > left && bottom > top) {
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  const rect: NativeRect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (api.GetWindowRect(hwnd, rect) !== 0 && rect.right > rect.left && rect.bottom > rect.top) {
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
  }
  return undefined
}

/** Whether in-process Win32 native operations are available on this host. */
export function hasWinNative(): boolean {
  return winApi() !== null
}

/**
 * Read a Windows window's true visible rectangle (excluding the ~11 px invisible
 * DWM resize frame), visibility, and minimized state in < 1 ms.
 */
export function winVisibleBounds(windowId: string): {
  readonly bounds?: WinRect
  readonly visible: boolean
  readonly minimized: boolean
  readonly focused: boolean
} | undefined {
  const api = winApi()
  if (api === null) return undefined
  const hwnd = parseHwnd(windowId)
  if (hwnd === undefined) return undefined
  return perMonitor(api, () => {
    const visible = api.IsWindowVisible(hwnd) !== 0
    const minimized = api.IsIconic(hwnd) !== 0
    const fg = BigInt(api.GetForegroundWindow())
    const focused = fg === hwnd
    const bounds = minimized ? undefined : dwmOrWindowRect(api, hwnd)
    return {
      ...bounds !== undefined ? { bounds } : {},
      visible: visible && !minimized,
      minimized,
      focused,
    }
  })
}

/**
 * Enrich an FFI window list with DWM visible bounds (no 11 px invisible border),
 * accurate visibility/minimized state, and live focus state.
 */
export function enrichWindowsOnWin32(windows: readonly WindowInfo[]): readonly WindowInfo[] {
  if (process.platform !== 'win32' || !hasWinNative()) return windows
  return windows.map((window) => {
    const info = winVisibleBounds(window.id)
    if (info === undefined) return window
    return {
      ...window,
      focused: info.focused || window.focused,
      visible: info.visible,
      ...info.bounds !== undefined ? { bounds: info.bounds } : {},
    }
  })
}

/**
 * Restore (if minimized) and bring a Windows window to the foreground in ~20 ms
 * using the proven Alt-tap + `SetForegroundWindow` sequence.
 */
export async function winFocusWindow(windowId: string): Promise<boolean> {
  const api = winApi()
  if (api === null) return false
  const hwnd = parseHwnd(windowId)
  if (hwnd === undefined) return false
  if (api.IsIconic(hwnd) !== 0) {
    api.ShowWindow(hwnd, SW_RESTORE)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  if (BigInt(api.GetForegroundWindow()) === hwnd) return true
  sendKey(api, VK_MENU, true, false)
  try {
    api.SetForegroundWindow(hwnd)
  } finally {
    sendKey(api, VK_MENU, false, false)
  }
  if (BigInt(api.GetForegroundWindow()) === hwnd) return true
  await new Promise(resolve => setTimeout(resolve, FOREGROUND_RETRY_MS))
  return BigInt(api.GetForegroundWindow()) === hwnd
}

/** Restore a minimized Windows window without spawning `agent-desktop.exe`. */
export function winRestoreWindow(windowId: string): boolean {
  const api = winApi()
  if (api === null) return false
  const hwnd = parseHwnd(windowId)
  if (hwnd === undefined) return false
  return api.ShowWindow(hwnd, SW_RESTORE) !== 0
}

/**
 * Capture a Windows window's exact DWM visible rectangle via `BitBlt` (~25 ms,
 * zero subprocesses, zero invisible resize border).
 */
export function winCaptureWindow(
  windowId: string,
  fallbackBounds?: WinRect,
): { readonly png: Buffer; readonly width: number; readonly height: number; readonly bounds: WinRect } | undefined {
  const api = winApi()
  if (api === null) return undefined
  const hwnd = parseHwnd(windowId)
  const bounds = perMonitor(api, () => (hwnd !== undefined ? dwmOrWindowRect(api, hwnd) : undefined)) ?? fallbackBounds
  if (bounds === undefined || bounds.width < 1 || bounds.height < 1) return undefined
  return perMonitor(api, () => {
    const width = Math.max(1, Math.round(bounds.width))
    const height = Math.max(1, Math.round(bounds.height))
    const originX = Math.round(bounds.x)
    const originY = Math.round(bounds.y)
    const screenDc = api.GetDC(0)
    if (isZeroHandle(screenDc)) return undefined
    const memory = api.CreateCompatibleDC(screenDc)
    const bitmap = api.CreateCompatibleBitmap(screenDc, width, height)
    const previous = api.SelectObject(memory, bitmap)
    try {
      if (api.BitBlt(memory, 0, 0, width, height, screenDc, originX, originY, SRCCOPY) === 0) {
        return undefined
      }
      const header = {
        biSize: 40,
        biWidth: width,
        biHeight: height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: width * height * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      }
      const pixels = Buffer.alloc(width * height * 4)
      if (api.GetDIBits(memory, bitmap, 0, height, pixels, header, 0) === 0) {
        return undefined
      }
      const png = encodeBgraPng(width, height, pixels, true)
      return { png, width, height, bounds: { x: originX, y: originY, width, height } }
    } finally {
      api.SelectObject(memory, previous)
      api.DeleteObject(bitmap)
      api.DeleteDC(memory)
      api.ReleaseDC(0, screenDc)
    }
  })
}

/** Click at absolute physical screen coordinates via `SendInput` (~10 ms). */
export async function winMouseClick(
  x: number,
  y: number,
  options: { button?: string; count?: number; modifiers?: readonly string[] } = {},
): Promise<boolean> {
  const api = winApi()
  if (api === null) return false
  const button = options.button ?? 'left'
  const count = Math.max(1, options.count ?? 1)
  const mods = options.modifiers !== undefined && options.modifiers.length > 0
    ? parseComboKeys(options.modifiers)
    : []
  if (mods === undefined) return false

  const downFlag = button === 'right'
    ? MOUSEEVENTF_RIGHTDOWN
    : button === 'middle' ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN
  const upFlag = button === 'right'
    ? MOUSEEVENTF_RIGHTUP
    : button === 'middle' ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP

  const moveOk = perMonitor(api, () =>
    sendMouse(api, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y),
  )
  if (!moveOk) return false
  for (const mod of mods) sendKey(api, mod.vk, true, mod.extended)
  try {
    for (let i = 0; i < count; i += 1) {
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 40))
      const downOk = perMonitor(api, () => sendMouse(api, downFlag, 0, 0))
      if (!downOk) return false
      await new Promise(resolve => setTimeout(resolve, 15))
      const upOk = perMonitor(api, () => sendMouse(api, upFlag, 0, 0))
      if (!upOk) return false
    }
    return true
  } finally {
    for (let i = mods.length - 1; i >= 0; i -= 1) {
      const mod = mods[i]
      if (mod !== undefined) sendKey(api, mod.vk, false, mod.extended)
    }
  }
}

/** Scroll the mouse wheel at absolute screen coordinates via `SendInput` (~10 ms). */
export function winMouseWheel(x: number, y: number, dx: number, dy: number): boolean {
  const api = winApi()
  if (api === null) return false
  return perMonitor(api, () => {
    if (!sendMouse(api, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y)) {
      return false
    }
    if (dy !== 0 && !sendMouse(api, MOUSEEVENTF_WHEEL, 0, 0, dy * WHEEL_DELTA)) return false
    if (dx !== 0 && !sendMouse(api, MOUSEEVENTF_HWHEEL, 0, 0, dx * WHEEL_DELTA)) return false
    return true
  })
}

/** Drag smoothly between two absolute screen points via `SendInput`. */
export async function winDrag(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<boolean> {
  const api = winApi()
  if (api === null) return false
  const move = (x: number, y: number): boolean =>
    perMonitor(api, () => sendMouse(api, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, x, y))
  if (!move(from.x, from.y)) return false
  await new Promise(resolve => setTimeout(resolve, 25))
  if (!perMonitor(api, () => sendMouse(api, MOUSEEVENTF_LEFTDOWN, 0, 0))) return false
  try {
    await new Promise(resolve => setTimeout(resolve, 40))
    const steps = 10
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      move(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t))
      await new Promise(resolve => setTimeout(resolve, 12))
    }
    return true
  } finally {
    perMonitor(api, () => sendMouse(api, MOUSEEVENTF_LEFTUP, 0, 0))
  }
}

/** Press a key or chord (e.g. `ctrl+v`, `return`, `['ctrl','a']`) via `SendInput` (~15 ms). */
export async function winPressCombo(combo: string | readonly string[]): Promise<boolean> {
  const api = winApi()
  if (api === null) return false
  const keys = parseComboKeys(combo)
  if (keys === undefined || keys.length === 0) return false
  for (const key of keys) {
    if (!sendKey(api, key.vk, true, key.extended)) return false
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i]
    if (key !== undefined) sendKey(api, key.vk, false, key.extended)
  }
  return true
}
