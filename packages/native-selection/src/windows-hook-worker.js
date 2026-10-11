/**
 * Win32 low-level hooks need the thread that installed them to pump messages.
 * The official host's Node thread does not, so the hooks live here.
 */

import { parentPort } from 'node:worker_threads'
import { requireKoffi } from './koffi.js'

const WH_KEYBOARD_LL = 13
const WH_MOUSE_LL = 14
const WM_KEYDOWN = 0x0100
const WM_SYSKEYDOWN = 0x0104
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_MBUTTONDOWN = 0x0207
const WM_MBUTTONUP = 0x0208
const WM_MOUSEWHEEL = 0x020A
const MONITOR_DEFAULTTONEAREST = 2

const lib = requireKoffi()
lib.struct('DSH_ORB_SEL_POINT', { x: 'int32', y: 'int32' })
lib.struct('DSH_ORB_SEL_MSLL', {
  pt: 'DSH_ORB_SEL_POINT',
  mouseData: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
})
lib.struct('DSH_ORB_SEL_MSG', {
  hwnd: 'void *',
  message: 'uint32',
  wParam: 'uintptr',
  lParam: 'intptr',
  time: 'uint32',
  pt: 'DSH_ORB_SEL_POINT',
})
lib.proto('intptr __stdcall DshOrbSelHookProc(int nCode, uintptr wParam, intptr lParam)')

const user32 = lib.load('user32.dll')
const shcore = lib.load('shcore.dll')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, intptr lParam)')
const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, DshOrbSelHookProc *lpfn, void *hMod, uint32 dwThreadId)')
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)')
const GetMessageW = user32.func('int __stdcall GetMessageW(_Out_ DSH_ORB_SEL_MSG *msg, void *hwnd, uint32 min, uint32 max)')
const TranslateMessage = user32.func('int __stdcall TranslateMessage(DSH_ORB_SEL_MSG *msg)')
const DispatchMessageW = user32.func('intptr __stdcall DispatchMessageW(DSH_ORB_SEL_MSG *msg)')
const GetCurrentThreadId = lib.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()')

parentPort.postMessage({ type: 'ready', threadId: GetCurrentThreadId() })

function dip(x, y) {
  const monitorFromPoint = user32.func('void * __stdcall MonitorFromPoint(DSH_ORB_SEL_POINT pt, uint32 dwFlags)')
  const monitor = monitorFromPoint({ x, y }, MONITOR_DEFAULTTONEAREST)
  const dpiX = [0]
  const dpiY = [0]
  const dpiForMonitor = shcore.func(
    'int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)',
  )
  if (dpiForMonitor(monitor, 0, dpiX, dpiY) !== 0) return { x, y }
  const scale = (dpiX[0] ?? 96) / 96
  if (!Number.isFinite(scale) || scale <= 0) return { x, y }
  return { x: x / scale, y: y / scale }
}

const hooks = []
const callbacks = []
const mouse = lib.register((code, wParam, lParam) => {
  try {
    if (code >= 0) {
      const info = lib.decode(lParam, 'DSH_ORB_SEL_MSLL')
      const pointDip = dip(info.pt.x, info.pt.y)
      const kind = Number(wParam)
      if (kind === WM_MOUSEWHEEL) parentPort.postMessage({ type: 'wheel' })
      else if (kind === WM_LBUTTONDOWN) parentPort.postMessage({ type: 'mouse-down', ...pointDip, button: 'left' })
      else if (kind === WM_LBUTTONUP) parentPort.postMessage({ type: 'mouse-up', ...pointDip, button: 'left' })
      else if (kind === WM_RBUTTONDOWN || kind === WM_RBUTTONUP) parentPort.postMessage({ type: 'mouse-down', ...pointDip, button: 'right' })
      else if (kind === WM_MBUTTONDOWN || kind === WM_MBUTTONUP) parentPort.postMessage({ type: 'mouse-down', ...pointDip, button: 'middle' })
    }
  } catch {
    // A hook fault must not swallow the rest of the mouse chain.
  }
  return CallNextHookEx(null, code, wParam, lParam)
}, lib.pointer('DshOrbSelHookProc'))
callbacks.push(mouse)
hooks.push(SetWindowsHookExW(WH_MOUSE_LL, mouse, null, 0))

const keyboard = lib.register((code, wParam, lParam) => {
  try {
    if (code >= 0) {
      const kind = Number(wParam)
      if (kind === WM_KEYDOWN || kind === WM_SYSKEYDOWN) parentPort.postMessage({ type: 'key' })
    }
  } catch {
    // A hook fault must not swallow the rest of the keyboard chain.
  }
  return CallNextHookEx(null, code, wParam, lParam)
}, lib.pointer('DshOrbSelHookProc'))
callbacks.push(keyboard)
hooks.push(SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, null, 0))

const msg = [{}]
while (GetMessageW(msg, null, 0, 0) > 0) {
  TranslateMessage(msg)
  DispatchMessageW(msg)
}

for (const hook of hooks) {
  if (hook !== null && hook !== undefined) UnhookWindowsHookEx(hook)
}
for (const callback of callbacks) lib.unregister(callback)
