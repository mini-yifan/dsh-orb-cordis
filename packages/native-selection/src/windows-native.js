/** Low-level Win32 mouse and keyboard hooks plus UI Automation selection reads. */

import { execFile } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { requireKoffi } from './koffi.js'

const SELECTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { return }
$pattern = $null
if (-not $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return }
$ranges = @($pattern.GetSelection())
if ($ranges.Length -lt 1) { return }
$text = $ranges[0].GetText(4000)
if ([string]::IsNullOrWhiteSpace($text)) { return }
$rects = @($ranges[0].GetBoundingRectangles())
$out = @{ text = $text; pid = $focused.Current.ProcessId }
# No usable rectangle means no coordinates at all: 0 is a real screen position, not "missing".
if ($rects.Length -ge 4) {
  $out.x = $rects[0]; $out.y = $rects[1]; $out.width = $rects[2]; $out.height = $rects[3]
}
$out | ConvertTo-Json -Compress
`

function koffi() {
  return requireKoffi()
}

let prepared = false
let activationApi

function prepareKoffi() {
  const lib = koffi()
  if (prepared) return lib
  lib.struct('DSH_ORB_SEL_POINT', { x: 'int32', y: 'int32' })
  lib.struct('DSH_ORB_SEL_MSLL', {
    pt: 'DSH_ORB_SEL_POINT',
    mouseData: 'uint32',
    flags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr',
  })
  lib.proto('int __stdcall DshOrbSelEnumProc(void *hwnd, intptr lParam)')
  lib.proto('intptr __stdcall DshOrbSelHookProc(int nCode, uintptr wParam, intptr lParam)')
  prepared = true
  return lib
}

function windowsActivationApi() {
  if (activationApi !== undefined) return activationApi
  const lib = prepareKoffi()
  const user32 = lib.load('user32.dll')
  activationApi = {
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(void *hWnd)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
    EnumWindows: user32.func('int __stdcall EnumWindows(DshOrbSelEnumProc *cb, intptr lParam)'),
  }
  return activationApi
}

/**
 * Display scale of the monitor containing a physical point. The mouse hook reports DIP, so a
 * UIA rectangle (physical pixels) must go through the same probe before the two are compared.
 */
function monitorScale(x, y) {
  const lib = prepareKoffi()
  const monitor = lib.load('user32.dll')
    .func('void * __stdcall MonitorFromPoint(DSH_ORB_SEL_POINT pt, uint32 dwFlags)')({ x, y }, 2)
  const dpiX = [0]
  const dpiY = [0]
  const status = lib.load('shcore.dll')
    .func('int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)')(
      monitor,
      0,
      dpiX,
      dpiY,
    )
  if (status !== 0) return 1
  const scale = (dpiX[0] ?? 96) / 96
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** A physical-pixel rectangle in the DIP space the mouse hook uses. */
function dipRect(x, y, width, height) {
  const scale = monitorScale(x, y)
  return {
    x: x / scale,
    y: y / scale,
    ...typeof width === 'number' ? { width: width / scale } : {},
    ...typeof height === 'number' ? { height: height / scale } : {},
  }
}

export function readWindowsSelection() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', SELECTION_SCRIPT], {
      timeout: 1500,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof parsed.text !== 'string') {
          resolve(undefined)
          return
        }
        const rect = typeof parsed.x === 'number' && typeof parsed.y === 'number'
          ? dipRect(parsed.x, parsed.y, parsed.width, parsed.height)
          : {}
        resolve({
          text: parsed.text,
          ...typeof parsed.pid === 'number' ? { pid: parsed.pid } : {},
          ...rect,
        })
      } catch {
        resolve(undefined)
      }
    })
  })
}

export function activateWindowsPid(pid) {
  const lib = prepareKoffi()
  const api = windowsActivationApi()
  let found = false
  const callback = lib.register((hwnd) => {
    if (found || api.IsWindowVisible(hwnd) === 0) return 1
    const slot = [0]
    api.GetWindowThreadProcessId(hwnd, slot)
    if (slot[0] === pid) {
      api.SetForegroundWindow(hwnd)
      found = true
    }
    return 1
  }, lib.pointer('DshOrbSelEnumProc'))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    lib.unregister(callback)
  }
}

const WM_QUIT = 0x0012

/** Hooks run on a worker that owns a Win32 message loop. The host thread does not. */
export function installWindowsSelectionHooks(dispatch) {
  const worker = new Worker(new URL('./windows-hook-worker.js', import.meta.url), { type: 'module' })
  let threadId = 0
  worker.on('message', (event) => {
    if (event !== null && typeof event === 'object' && event.type === 'ready' && typeof event.threadId === 'number') {
      threadId = event.threadId
      return
    }
    dispatch(event)
  })
  worker.on('error', (error) => {
    console.error(`dsh-orb selection: windows hook worker failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  return () => {
    if (threadId > 0) postQuit(threadId)
    const timer = setTimeout(() => { void worker.terminate() }, 500)
    timer.unref?.()
    worker.once('exit', () => clearTimeout(timer))
  }
}

function postQuit(threadId) {
  try {
    const lib = prepareKoffi()
    const user32 = lib.load('user32.dll')
    const post = user32.func('int __stdcall PostThreadMessageW(uint32 idThread, uint32 msg, uintptr wParam, intptr lParam)')
    post(threadId, WM_QUIT, 0, 0)
  } catch (error) {
    console.error(`dsh-orb selection: could not stop the windows hook worker: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function productionSelectionProbe() {
  return {
    readSelection: readWindowsSelection,
    activatePid: activateWindowsPid,
  }
}
