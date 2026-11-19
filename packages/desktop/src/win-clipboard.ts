/**
 * Lossless multi-format Win32 clipboard snapshot and restore via `koffi`.
 *
 * Loaded only on Windows when `desktop_input_text` falls back to pasting into a
 * window that exposes no addressable UIA text field. Every global-memory format
 * up to 16 MiB (text, images, file drop lists) is copied before `Ctrl+V` and
 * written back afterwards, matching macOS's `NSPasteboard` round trip.
 * @module @dsh-orb/desktop/src/win-clipboard
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002
const CLIPBOARD_SNAPSHOT_LIMIT_BYTES = 16 * 1024 * 1024

export interface WindowsClipboardEntry {
  readonly format: number
  readonly bytes: Buffer
}

export interface WindowsClipboardSnapshot {
  readonly entries: readonly WindowsClipboardEntry[]
  readonly dropped: readonly number[]
}

interface ClipboardApi {
  OpenClipboard: (hwnd: unknown) => number
  EmptyClipboard: () => number
  SetClipboardData: (format: number, memory: unknown) => unknown
  CloseClipboard: () => number
  GetClipboardData: (format: number) => unknown
  EnumClipboardFormats: (format: number) => number
  GlobalAlloc: (flags: number, bytes: number) => unknown
  GlobalLock: (memory: unknown) => unknown
  GlobalUnlock: (memory: unknown) => number
  GlobalSize: (memory: unknown) => number | bigint
  GlobalFree: (memory: unknown) => unknown
  RtlMoveMemory: (dst: unknown, src: unknown, length: number) => void
}

let cachedApi: ClipboardApi | undefined

function isNullHandle(value: unknown): boolean {
  return value === null || value === undefined || value === 0 || value === 0n
}

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

function clipboardApi(): ClipboardApi {
  if (cachedApi !== undefined) return cachedApi
  if (process.platform !== 'win32') {
    throw new Error('Windows clipboard API is only available on win32')
  }
  const koffi = loadKoffi()
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  cachedApi = {
    OpenClipboard: user32.func('int __stdcall OpenClipboard(void *hWndNewOwner)'),
    EmptyClipboard: user32.func('int __stdcall EmptyClipboard()'),
    SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)'),
    CloseClipboard: user32.func('int __stdcall CloseClipboard()'),
    GetClipboardData: user32.func('void * __stdcall GetClipboardData(uint32 uFormat)'),
    EnumClipboardFormats: user32.func('uint32 __stdcall EnumClipboardFormats(uint32 format)'),
    GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32 uFlags, uintptr dwBytes)'),
    GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *hMem)'),
    GlobalUnlock: kernel32.func('int __stdcall GlobalUnlock(void *hMem)'),
    GlobalSize: kernel32.func('uintptr __stdcall GlobalSize(void *hMem)'),
    GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *hMem)'),
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *Destination, void *Source, uintptr Length)'),
  }
  return cachedApi
}

function withClipboard(api: ClipboardApi, fn: () => void): void {
  if (api.OpenClipboard(null) === 0) throw new Error('OpenClipboard failed')
  try {
    fn()
  } finally {
    api.CloseClipboard()
  }
}

/** Snapshot every lockable clipboard format up to 16 MiB (plain text first). */
export function saveWindowsClipboard(): WindowsClipboardSnapshot {
  const api = clipboardApi()
  const seen: { format: number; size: number }[] = []
  const bytes = new Map<number, Buffer>()
  withClipboard(api, () => {
    let format = 0
    for (;;) {
      format = api.EnumClipboardFormats(format)
      if (format === 0) break
      const handle = api.GetClipboardData(format)
      if (isNullHandle(handle)) continue
      const size = Number(api.GlobalSize(handle))
      if (!Number.isFinite(size) || size <= 0) continue
      seen.push({ format, size })
    }
    seen.sort((left, right) =>
      Number(right.format === CF_UNICODETEXT) - Number(left.format === CF_UNICODETEXT)
      || left.size - right.size,
    )
    let used = 0
    for (const entry of seen) {
      if (used + entry.size > CLIPBOARD_SNAPSHOT_LIMIT_BYTES) continue
      const handle = api.GetClipboardData(entry.format)
      if (isNullHandle(handle)) continue
      const locked = api.GlobalLock(handle)
      if (isNullHandle(locked)) continue
      try {
        const copy = Buffer.alloc(entry.size)
        api.RtlMoveMemory(copy, locked, entry.size)
        bytes.set(entry.format, copy)
        used += entry.size
      } finally {
        api.GlobalUnlock(handle)
      }
    }
  })
  const entries = seen.flatMap((entry) => {
    const copy = bytes.get(entry.format)
    return copy === undefined ? [] : [{ format: entry.format, bytes: copy }]
  })
  const copied = new Set(entries.map(entry => entry.format))
  return {
    entries,
    dropped: seen.filter(entry => !copied.has(entry.format)).map(entry => entry.format),
  }
}

/** Replace the clipboard with UTF-16LE text for `Ctrl+V`. */
export function setWindowsClipboardText(text: string): void {
  const api = clipboardApi()
  const bytes = Buffer.from(`${text}\0`, 'utf16le')
  const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length)
  if (isNullHandle(memory)) throw new Error('clipboard GlobalAlloc failed')
  const locked = api.GlobalLock(memory)
  if (isNullHandle(locked)) {
    api.GlobalFree(memory)
    throw new Error('clipboard GlobalLock failed')
  }
  api.RtlMoveMemory(locked, bytes, bytes.length)
  api.GlobalUnlock(memory)
  let ownedByOs = false
  try {
    withClipboard(api, () => {
      api.EmptyClipboard()
      if (isNullHandle(api.SetClipboardData(CF_UNICODETEXT, memory))) {
        throw new Error('SetClipboardData failed')
      }
      ownedByOs = true
    })
  } finally {
    if (!ownedByOs) api.GlobalFree(memory)
  }
}

/** Put every saved format back on the clipboard. */
export function restoreWindowsClipboard(snapshot: WindowsClipboardSnapshot): void {
  const api = clipboardApi()
  withClipboard(api, () => {
    api.EmptyClipboard()
    for (const entry of snapshot.entries) {
      const memory = api.GlobalAlloc(GMEM_MOVEABLE, entry.bytes.length)
      if (isNullHandle(memory)) continue
      const locked = api.GlobalLock(memory)
      if (isNullHandle(locked)) {
        api.GlobalFree(memory)
        continue
      }
      api.RtlMoveMemory(locked, entry.bytes, entry.bytes.length)
      api.GlobalUnlock(memory)
      if (isNullHandle(api.SetClipboardData(entry.format, memory))) {
        api.GlobalFree(memory)
      }
    }
  })
}
