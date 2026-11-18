/**
 * Typing text into whatever has keyboard focus.
 *
 * `agent-desktop type` goes through the accessibility tree and needs a ref, so a
 * window that exposes no tree — an Electron shell, a canvas UI, anything
 * `list-windows` marks `accessible: false` — cannot be typed into at all. That
 * is the one hole a point-based flow cannot close with the CLI.
 *
 * Computer Use closes it by pasting: put the text on the pasteboard, press
 * Cmd-V, then put every item of the user's clipboard back exactly as it was.
 * That is what this module does, on the same JXA `osascript` the foreground
 * tools already use, and it is why a point-based `type` needs no accessibility.
 *
 * The restore matters: a copied image or a file list is only one `NSData` per
 * type on the pasteboard, and leaving our text there destroys what the user had.
 * Windows has no equivalent that survives a medium-sized clipboard, so there we
 * paste through the CLI and say so in the tool text.
 * @module @dsh-orb/desktop/src/hid
 */

import { execFile } from 'node:child_process'
import { runCli } from './vision.ts'

/** Where the platform's scripting host lives. */
const OSASCRIPT = '/usr/bin/osascript'

/** One keystroke script may run this long before it is killed. */
const HID_TIMEOUT_MS = 15_000

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
 * Build the JXA body for one text delivery.
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
 * @returns true on macOS (JXA key events) and Windows (cut through the focused control).
 */
export function canPasteAtFocus(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Paste text into whatever holds keyboard focus, then restore the clipboard.
 *
 * The caller has already put the caret where the text belongs (a click, or an
 * earlier focus action). Nothing here reads the accessibility tree.
 * @param text - characters to deliver.
 * @param options - replace the focused field's content, and submit afterwards.
 * @param signal - cooperative cancellation.
 * @throws when the platform cannot post key events or the scripting host refuses.
 */
export async function typeAtFocus(
  text: string,
  options: { replace?: boolean, enter?: boolean } = {},
  signal: AbortSignal,
): Promise<void> {
  if (!canPasteAtFocus()) {
    throw new Error('typing into a window without an accessibility tree is not supported on this platform')
  }
  if (process.platform === 'win32') {
    throw new Error('windows typing goes through the accessibility tree; call typeTextByRef instead')
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

/** One element the CLI found, as `find` prints it. */
interface FoundElement {
  readonly match?: {
    readonly ref_id?: string
    readonly role?: string
    readonly states?: readonly string[]
  }
  readonly snapshot_id?: string
}

/**
 * Type through the accessibility tree, with no clipboard and no pointer.
 *
 * This is the Windows path, and the preferred path on any platform where the
 * target exposes a tree: `type` inserts into one element, so it cannot land in
 * the wrong field and it cannot destroy what the user had copied. The focused
 * element is tried first, then the first text field in the window — a click that
 * focused a container still lets the field be found.
 * @param text - characters to deliver.
 * @param options - window to type into, select-all first, submit afterwards.
 * @param signal - cooperative cancellation.
 * @returns the ref that received the text.
 * @throws when the window exposes no addressable text field.
 */
export async function typeByRef(
  text: string,
  options: { windowId: string, session?: string, replace?: boolean, enter?: boolean },
  signal: AbortSignal,
): Promise<string> {
  const scope = options.session === undefined || options.session === '' ? [] : ['--session', options.session]
  const window = ['--window-id', options.windowId]
  const focused = await runCli<FoundElement>(
    ['find', ...window, ...scope, '--state', 'focused=true', '--first'],
    signal,
  )
  let ref = focused.ok === true ? focused.data?.match?.ref_id : undefined
  let role = focused.ok === true ? focused.data?.match?.role : undefined
  if (ref === undefined || !TEXT_ROLES.includes((role ?? '').toLowerCase())) {
    ref = undefined
    for (const candidate of TEXT_ROLES) {
      const found = await runCli<{ matches?: readonly { ref_id?: string }[] }>(
        ['find', ...window, ...scope, '--role', candidate, '--first'],
        signal,
      )
      if (found.ok !== true) continue
      const first = found.data?.matches?.[0]?.ref_id
      if (first !== undefined) {
        ref = first
        role = candidate
        break
      }
    }
  }
  if (ref === undefined) {
    throw new Error(
      `no text field could be found in ${options.windowId}: the window exposes no addressable input, `
      + 'so this text cannot be inserted through the accessibility tree',
    )
  }
  if (options.replace === true) {
    await runCli<unknown>(['clear', ref, ...scope], signal)
  }
  const typed = await runCli<unknown>(['type', ref, ...scope, '--stdin'], signal, text)
  if (!typed.ok) {
    const detail = typed.error?.message ?? 'type failed'
    throw new Error(`typing into ${ref} (${role ?? 'element'}) failed: ${detail}`)
  }
  if (options.enter === true) {
    const submitted = await runCli<unknown>(['press', ...window, ...scope, 'return'], signal)
    if (!submitted.ok) {
      throw new Error(`the text was inserted but Return failed: ${submitted.error?.message ?? 'press failed'}`)
    }
  }
  return ref
}
