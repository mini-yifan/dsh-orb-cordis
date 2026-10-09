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
$x = 0; $y = 0; $width = 0; $height = 0
if ($rects.Length -ge 4) { $x = $rects[0]; $y = $rects[1]; $width = $rects[2]; $height = $rects[3] }
[pscustomobject]@{
  text = $text; x = $x; y = $y; width = $width; height = $height; pid = $focused.Current.ProcessId
} | ConvertTo-Json -Compress
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
        resolve({
          text: parsed.text,
          ...typeof parsed.pid === 'number' ? { pid: parsed.pid } : {},
          ...typeof parsed.x === 'number' ? { x: parsed.x } : {},
          ...typeof parsed.y === 'number' ? { y: parsed.y } : {},
          ...typeof parsed.width === 'number' ? { width: parsed.width } : {},
          ...typeof parsed.height === 'number' ? { height: parsed.height } : {},
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
