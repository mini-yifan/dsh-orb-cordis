/**
 * `open_app` name matching.
 * Exact process base names win over titles, and a title only matches whole or from a
 * word boundary: a substring match would activate an unrelated window ("source code"
 * for "code").
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/app-match
 */

/** One visible top-level window, front to back, as `activateApp` sees it. */
export interface AppMatchWindow {
  /** Process base name without `.exe`, any case. */
  readonly appName: string
  readonly title: string
}

/**
 * Pick the window `wanted` refers to, in z-order.
 * @param windows - visible top-level windows, front to back.
 * @param wanted - model-supplied app name.
 * @returns the index of the match, or undefined when nothing matches.
 */
export function selectAppWindow(windows: readonly AppMatchWindow[], wanted: string): number | undefined {
  const name = wanted.trim().toLowerCase()
  if (name === '') return undefined
  // Process names are what the model means when it names an app; a title match only
  // stands in when no process answers to `name`.
  const exact = windows.findIndex((window) => window.appName.toLowerCase() === name)
  if (exact >= 0) return exact
  const titled = windows.findIndex((window) => titleMatches(window.title.toLowerCase(), name))
  return titled >= 0 ? titled : undefined
}

/** Title equals `wanted`, or starts with it followed by a word boundary ("Code - main.rs" matches "code", "Codex" does not). */
function titleMatches(title: string, wanted: string): boolean {
  if (title === wanted) return true
  if (!title.startsWith(wanted)) return false
  return !/[a-z0-9_]/u.test(title.charAt(wanted.length))
}
