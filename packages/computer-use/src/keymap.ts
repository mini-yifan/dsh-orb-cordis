/**
 * Key names to Linux evdev key codes.
 *
 * The model names keys the way the macOS backend documents them, so the same
 * tool calls have to keep meaning the same thing here. `cmd` therefore maps to
 * Control: an agent asking for `cmd+c` wants a copy, and Control is what copies
 * on Linux. Keys that only exist to name the Windows/Super modifier (`win`,
 * `super`, `meta`) map to Meta instead.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/keymap
 */

/** Linux `input-event-codes.h` values addressed by the names the tools accept. */
export const KEY_NAMES: Readonly<Record<string, number>> = {
  escape: 1, esc: 1,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, '-': 12, equal: 13, '=': 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  '[': 26, ']': 27, enter: 28, return: 28, control: 29, ctrl: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  ';': 39, "'": 40, '`': 41, shift: 42, '\\': 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  ',': 51, '.': 52, '/': 53,
  capslock: 58, space: 57,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88, f13: 183, f14: 184, f15: 185, f16: 186, f17: 187, f18: 188, f19: 189, f20: 190,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  insert: 110, delete: 111, forwarddelete: 111,
  mute: 113, volumedown: 114, volumeup: 115, pause: 119,
  // `cmd` is the macOS action modifier; on Linux the equivalent chord is Control.
  cmd: 29, command: 29,
  // Naming the platform key itself keeps the real Meta modifier reachable.
  meta: 125, win: 125, windows: 125, super: 125,
  // `option` is the macOS Alt.
  option: 56, alt: 56,
  // `fn` has no Linux equivalent and is accepted as a no-op token.
  fn: 0,
}

/** Modifier tokens that must be held down rather than tapped. */
const MODIFIER_CODES = new Set([29, 56, 42, 125, 97, 100, 54, 126])

/**
 * Resolve one key token.
 * @param token - key name as the model wrote it.
 * @returns the evdev key code.
 * @throws when the name is not in {@link KEY_NAMES}.
 */
export function keyCode(token: string): number {
  const name = token.trim().toLowerCase()
  const code = KEY_NAMES[name]
  if (code === undefined) throw new Error(`computer-use: unknown key "${token}"`)
  return code
}

/**
 * True when a code is a modifier that a chord should hold rather than tap.
 * @param code - evdev key code.
 * @returns whether the code is Control, Shift, Alt, or Meta.
 */
export function isModifier(code: number): boolean {
  return MODIFIER_CODES.has(code)
}
