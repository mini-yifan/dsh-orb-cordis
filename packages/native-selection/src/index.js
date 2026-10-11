/** Selection monitor. Darwin uses the prebuilt dylib; Windows uses koffi hooks. */

import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSelectionHelperLine } from './protocol.js'
import { startWindowsSelectionMonitor } from './windows-dispatch.js'
import { installWindowsSelectionHooks, productionSelectionProbe } from './windows-native.js'
import { requireKoffi } from './koffi.js'

const here = dirname(fileURLToPath(import.meta.url))

export { MIN_DRAG_PX, draggedFarEnough, parseSelectionHelperLine } from './protocol.js'
export { dispatchWindowsSelectionMessage } from './windows-dispatch.js'

export function startSelectionMonitor(handlers) {
  if (process.platform === 'darwin') return startDarwin(handlers)
  if (process.platform === 'win32') return startWindows(handlers)
  return undefined
}

/** False when this platform has no monitor, or the prebuilt dylib did not load. */
export function selectionRuntimeAvailable() {
  if (process.platform === 'linux') return false
  if (process.platform === 'win32') return true
  if (process.platform !== 'darwin') return false
  return loadDarwin() !== undefined
}

export function promptAccessibility() {
  if (process.platform !== 'darwin') return false
  const binding = loadDarwin()
  if (binding === undefined) return false
  try {
    return binding.prompt() === 1
  } catch {
    return false
  }
}

export function accessibilityTrusted() {
  if (process.platform !== 'darwin') return true
  const binding = loadDarwin()
  if (binding === undefined) return false
  try {
    return binding.trusted() === 1
  } catch {
    return false
  }
}

let darwin

function loadDarwin() {
  if (darwin !== undefined) return darwin || undefined
  try {
    const koffi = requireKoffi()
    const dylib = darwinLibrary()
    const lib = koffi.load(dylib)
    darwin = {
      start: lib.func('int32 dsh_macos_selection_start(void *callback, void *context)'),
      readFd: lib.func('int32 dsh_macos_selection_read_fd()'),
      stop: lib.func('void dsh_macos_selection_stop()'),
      exclude: lib.func('void dsh_macos_selection_exclude_pids(const char *pids)'),
      activate: lib.func('void dsh_macos_selection_activate_pid(int32 pid)'),
      lastFront: lib.func('int32 dsh_macos_selection_last_front_pid()'),
      prompt: lib.func('int32 dsh_macos_selection_prompt()'),
      trusted: lib.func('int32 dsh_macos_selection_trusted()'),
    }
    return darwin
  } catch (error) {
    darwin = null
    console.error(`dsh-orb: selection monitor did not load: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function darwinLibrary() {
  return join(here, '..', 'prebuilds', 'darwin-universal', 'libmacos-selection.dylib')
}

function startDarwin(handlers) {
  const binding = loadDarwin()
  if (binding === undefined) return undefined
  try {
    binding.start(null, null)
    const fd = binding.readFd()
    if (typeof fd !== 'number' || fd < 0) return undefined
    const stream = createReadStream('/dev/null', { fd, encoding: 'utf8', autoClose: true })
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = parseSelectionHelperLine(part)
        if (event !== undefined) handlers.onEvent(event)
      }
    })
    stream.on('error', () => {
      // The monitor closed the write end.
    })
    return {
      stop() {
        stream.destroy()
        try { binding.stop() } catch { /* already stopped */ }
      },
      setExcludePids(pids) {
        try { binding.exclude(pids.map(String).join(',')) } catch { /* monitor gone */ }
      },
      activatePid(pid) {
        try { binding.activate(pid) } catch { /* monitor gone */ }
      },
      lastFrontPid() {
        try {
          const pid = binding.lastFront()
          return typeof pid === 'number' && pid > 0 ? pid : undefined
        } catch {
          return undefined
        }
      },
    }
  } catch (error) {
    console.error(`dsh-orb: selection monitor did not start: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function startWindows(handlers) {
  return startWindowsSelectionMonitor(handlers, productionSelectionProbe(), installWindowsSelectionHooks)
}
