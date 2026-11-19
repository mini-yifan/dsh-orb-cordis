/**
 * Typing text into whatever has keyboard focus, plus accessibility-first text
 * entry (`typeByRef`) across macOS and Windows.
 *
 * - When a window exposes an addressable text field, `typeByRef` tries semantic
 *   `set-value --stdin` first (headless on both macOS and Windows, no clipboard),
 *   falling back to `type --stdin` (with `--headed` on Windows, where strict
 *   headless `type` always returns `POLICY_DENIED`).
 * - When a window exposes NO accessibility tree (Canvas / custom Electron),
 *   `typeAtFocus` pastes through the clipboard and restores every saved format
 *   afterwards: `NSPasteboard` + JXA `Cmd+V` on macOS, Win32 `koffi` clipboard
 *   snapshot + `agent-desktop press --headed ctrl+v` on Windows.
 * @module @dsh-orb/desktop/src/hid
 */

import { execFile } from 'node:child_process'
import { runCli, type Envelope } from './vision.ts'
import {
  restoreWindowsClipboard,
  saveWindowsClipboard,
  setWindowsClipboardText,
  type WindowsClipboardSnapshot,
} from './win-clipboard.ts'

/** Where the platform's scripting host lives. */
const OSASCRIPT = '/usr/bin/osascript'

/** One keystroke script may run this long before it is killed. */
const HID_TIMEOUT_MS = 15_000

/** Pause after Ctrl+V before restoring the clipboard so slow apps consume the paste. */
const WIN_PASTE_SETTLE_MS = 120

/**
 * JXA preamble: key events, and a clipboard round trip that keeps every type.
 *
 * `CGEventCreateKeyboardEvent` plus flags is how a real paste is delivered;
 * `tapKey`/`chord` mirror what a person's fingers do, release order included.
 */
const RUNTIME = `
ObjC.import('Cocoa')
const HID = 0
const SRC = $.CGEventSourceCreate(1)
const FLAG_SHIFT = 0x00020000
const FLAG_CMD = 0x00100000
const KEY_CMD = 55
const KEY_SHIFT = 56
const KEY_A = 0
const KEY_V = 9
const KEY_ENTER = 36
function sleep(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000)
}
function postKey(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent(SRC, code, down)
  $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}
function tapKey(code, flags) {
  postKey(code, true, flags)
  sleep(20)
  postKey(code, false, flags)
  sleep(15)
}
function modifierFlag(code) {
  if (code === KEY_CMD) return FLAG_CMD
  if (code === KEY_SHIFT) return FLAG_SHIFT
  return 0
}
function chord(codes) {
  var flags = 0
  var mods = []
  var keys = []
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i]
    if (code === KEY_CMD) { flags |= FLAG_CMD; mods.push(code) }
    else if (code === KEY_SHIFT) { flags |= FLAG_SHIFT; mods.push(code) }
    else keys.push(code)
  }
  for (var m = 0; m < mods.length; m++) postKey(mods[m], true, flags)
  sleep(20)
  for (var k = 0; k < keys.length; k++) tapKey(keys[k], flags)
  for (var r = mods.length - 1; r >= 0; r--) {
    var remaining = 0
    for (var j = 0; j < r; j++) remaining |= modifierFlag(mods[j])
    postKey(mods[r], false, remaining)
  }
  sleep(20)
}
function clearPasteboard(pb) {
  // JXA invokes no-argument ObjC methods on property access; calling this as a
  // JS function would invoke the NSInteger return value instead.
  var discarded = pb.clearContents
}
// Every type of every item, kept as NSData in this process: saving only the
// string would drop a copied image or file list, and the paste then destroys it.
function clipboardSnapshot(pb) {
  var items = []
  var entries = pb.pasteboardItems
  if (!entries) return items
  for (var i = 0; i < entries.count; i++) {
    var source = entries.objectAtIndex(i)
    var types = source.types
    var item = []
    for (var t = 0; t < types.count; t++) {
      var type = types.objectAtIndex(t)
      var data = source.dataForType(type)
      if (data) item.push({ type: type, data: data })
    }
    if (item.length > 0) items.push(item)
  }
  return items
}
function restoreClipboard(pb, items) {
  clearPasteboard(pb)
  for (var i = 0; i < items.length; i++) {
    var item = $.NSPasteboardItem.alloc.init
    for (var t = 0; t < items[i].length; t++) {
      item.setDataForType(items[i][t].data, items[i][t].type)
    }
    pb.writeObjects($([item]))
  }
}
`

/**
 * Build the JXA body for one macOS text delivery.
 * @param text - characters to deliver.
 * @param options - select-all first, Return afterwards.
 * @returns the script to hand `osascript`.
 */
export function pasteScript(
  text: string,
  options: { replace?: boolean, enter?: boolean } = {},
): string {
  const lines = [
    RUNTIME,
    'var pb = $.NSPasteboard.generalPasteboard',
    'var previous = clipboardSnapshot(pb)',
    'clearPasteboard(pb)',
    `pb.setStringForType($.NSString.stringWithString(${JSON.stringify(text)}), $.NSPasteboardTypeString)`,
  ]
  if (options.replace === true) lines.push('chord([KEY_CMD, KEY_A])', 'sleep(40)')
  lines.push(
    'chord([KEY_CMD, KEY_V])',
    // Give the target a moment to take the paste before restoring: a slow app
    // reads the pasteboard lazily on its next run-loop turn.
    'sleep(120)',
    'restoreClipboard(pb, previous)',
  )
  if (options.enter === true) lines.push('tapKey(KEY_ENTER, 0)', 'sleep(60)')
  return lines.join('\n')
}

/**
 * Whether this platform can deliver text without an accessibility ref.
 * @returns true on macOS (JXA paste) and Windows (Win32 clipboard + Ctrl+V).
 */
export function canPasteAtFocus(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

export interface WindowsPasteDependencies {
  readonly saveClipboard?: () => WindowsClipboardSnapshot
  readonly setClipboardText?: (text: string) => void
  readonly restoreClipboard?: (snapshot: WindowsClipboardSnapshot) => void
  readonly runCli?: <T>(args: readonly string[], signal: AbortSignal, stdin?: string) => Promise<Envelope<T>>
  readonly settleMs?: number
}

/**
 * Paste text at keyboard focus on Windows while preserving every clipboard format.
 */
export async function pasteAtFocusWindows(
  text: string,
  options: { replace?: boolean; enter?: boolean; windowId?: string } = {},
  signal: AbortSignal,
  deps: WindowsPasteDependencies = {},
): Promise<void> {
  const save = deps.saveClipboard ?? saveWindowsClipboard
  const writeText = deps.setClipboardText ?? setWindowsClipboardText
  const restore = deps.restoreClipboard ?? restoreWindowsClipboard
  const cli = deps.runCli ?? runCli
  const settleMs = deps.settleMs ?? WIN_PASTE_SETTLE_MS
  const target = options.windowId !== undefined && options.windowId !== ''
    ? ['--window-id', options.windowId]
    : []

  const previous = save()
  try {
    writeText(text)
    if (options.replace === true) {
      const sel = await cli<unknown>(['press', '--headed', ...target, 'ctrl+a'], signal)
      if (!sel.ok) throw new Error(sel.error?.message ?? 'ctrl+a failed')
    }
    const pasted = await cli<unknown>(['press', '--headed', ...target, 'ctrl+v'], signal)
    if (!pasted.ok) throw new Error(pasted.error?.message ?? 'ctrl+v failed')
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
  } finally {
    restore(previous)
  }
  if (options.enter === true) {
    const submitted = await cli<unknown>(['press', '--headed', ...target, 'return'], signal)
    if (!submitted.ok) throw new Error(submitted.error?.message ?? 'return failed after paste')
  }
}

/**
 * Paste text into whatever holds keyboard focus, then restore the clipboard.
 *
 * Works on both macOS (JXA `NSPasteboard` + `Cmd+V`) and Windows (Win32
 * multi-format clipboard snapshot + `agent-desktop press --headed ctrl+v`).
 */
export async function typeAtFocus(
  text: string,
  options: { replace?: boolean; enter?: boolean; windowId?: string } = {},
  signal: AbortSignal,
): Promise<void> {
  if (!canPasteAtFocus()) {
    throw new Error('typing into a window without an accessibility tree is not supported on this platform')
  }
  if (process.platform === 'win32') {
    await pasteAtFocusWindows(text, options, signal)
    return
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      OSASCRIPT,
      ['-l', 'JavaScript', '-e', pasteScript(text, options)],
      { timeout: HID_TIMEOUT_MS, signal },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }
        const detail = (stderr ?? '').trim()
        reject(new Error(
          detail === ''
            ? `keyboard input failed: ${error.message}`
            : `keyboard input failed (Accessibility permission is required): ${detail}`,
        ))
      },
    )
  })
}

/** Roles that accept typed text, most specific first. */
const TEXT_ROLES = ['textfield', 'textarea', 'text area', 'combobox', 'searchfield']

/**
 * One `find` result. The CLI answers `{ match }` when asked for `--first` and
 * `{ matches }` when not; reading only one of the two silently turns every
 * lookup into a miss, which then falls through five sequential probes.
 */
interface FoundElement {
  readonly match?: { readonly ref_id?: string, readonly role?: string }
  readonly matches?: readonly { readonly ref_id?: string, readonly role?: string }[]
}

/** The ref of whichever shape the CLI answered with. */
export function refOf(found: FoundElement | undefined): string | undefined {
  return found?.match?.ref_id ?? found?.matches?.[0]?.ref_id
}

export interface TypeByRefDependencies {
  readonly runCli?: <T>(args: readonly string[], signal: AbortSignal, stdin?: string) => Promise<Envelope<T>>
  readonly platform?: NodeJS.Platform
}

export async function typeByRef(
  text: string,
  options: { windowId: string, session?: string, replace?: boolean, enter?: boolean },
  signal: AbortSignal,
  deps: TypeByRefDependencies = {},
): Promise<string> {
  const cli = deps.runCli ?? runCli
  const platform = deps.platform ?? process.platform
  const scope = options.session === undefined || options.session === '' ? [] : ['--session', options.session]
  const window = ['--window-id', options.windowId]
  // One probe first: if the click already focused the field, this is the whole
  // lookup. Each `find` traverses the window, so they run in parallel below
  // rather than one after another.
  const focused = await cli<FoundElement>(
    ['find', ...window, ...scope, '--state', 'focused=true', '--first'],
    signal,
  )
  let ref = refOf(focused.ok === true ? focused.data : undefined)
  let role = focused.ok === true ? focused.data?.match?.role : undefined
  if (ref !== undefined && !TEXT_ROLES.includes((role ?? '').toLowerCase())) ref = undefined
  if (ref === undefined) {
    const probes = await Promise.all(TEXT_ROLES.map(async candidate => {
      const found = await cli<FoundElement>(
        ['find', ...window, ...scope, '--role', candidate, '--first'],
        signal,
      )
      return { candidate, ref: found.ok === true ? refOf(found.data) : undefined }
    }))
    const hit = probes.find(probe => probe.ref !== undefined)
    if (hit !== undefined) {
      ref = hit.ref
      role = hit.candidate
    }
  }
  if (ref === undefined) {
    throw new Error(
      `no text field could be found in ${options.windowId}: the window exposes no addressable input, `
      + 'so this text cannot be inserted through the accessibility tree',
    )
  }

  // Prefer semantic `set-value` when replacing (or on Windows where strict-headless
  // `type` always returns POLICY_DENIED). It never touches the clipboard.
  let inserted = false
  if (options.replace === true || platform === 'win32') {
    const setRes = await cli<unknown>(['set-value', ref, ...scope, '--stdin'], signal, text)
    if (setRes.ok) inserted = true
  }

  if (!inserted) {
    if (options.replace === true) {
      await cli<unknown>(['clear', ref, ...scope], signal)
    }
    // On Windows, `agent-desktop type` requires `--headed` (SendInput); headless always refuses.
    const typeArgs = platform === 'win32'
      ? ['--headed', 'type', ref, ...scope, '--stdin']
      : ['type', ref, ...scope, '--stdin']
    let typed = await cli<unknown>(typeArgs, signal, text)
    if (!typed.ok && typed.error?.code === 'POLICY_DENIED' && platform !== 'win32') {
      typed = await cli<unknown>(['--headed', 'type', ref, ...scope, '--stdin'], signal, text)
    }
    if (!typed.ok) {
      const detail = typed.error?.message ?? 'type failed'
      throw new Error(`typing into ${ref} (${role ?? 'element'}) failed: ${detail}`)
    }
  }

  if (options.enter === true) {
    const pressArgs = platform === 'win32'
      ? ['press', '--headed', ...window, ...scope, 'return']
      : ['press', ...window, ...scope, 'return']
    let submitted = await cli<unknown>(pressArgs, signal)
    if (!submitted.ok && submitted.error?.code === 'POLICY_DENIED' && platform !== 'win32') {
      submitted = await cli<unknown>(['press', '--headed', ...window, ...scope, 'return'], signal)
    }
    if (!submitted.ok) {
      throw new Error(`the text was inserted but Return failed: ${submitted.error?.message ?? 'press failed'}`)
    }
  }
  return ref
}
