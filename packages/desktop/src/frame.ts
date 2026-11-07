/**
 * Which window the ribbon should wrap.
 *
 * A display name is not a window: an app like WeChat owns a document window, a
 * preview, hidden helper windows, and a stack of menu-bar strips that are all
 * 1470×33. The snapshot records the identity of the window it read; fall back to
 * the title, then to the largest plausible window.
 * @module @dsh-orb/desktop/src/frame
 */

import type { WindowInfo } from './protocol.ts'

/** Smallest window worth framing; filters menu-bar strips and tooltips. */
const MIN_WIDTH = 160
const MIN_HEIGHT = 100

function area(window: WindowInfo): number {
  return (window.bounds?.width ?? 0) * (window.bounds?.height ?? 0)
}

/**
 * Pick the window one action belongs to.
 * @param windows - every window the library reported for the app.
 * @param target - identity recorded by the snapshot that produced the ref.
 * @returns the window to frame, or undefined when none is plausible.
 */
export function chooseWindow(
  windows: readonly WindowInfo[],
  target: { readonly windowId?: string; readonly windowTitle?: string },
): WindowInfo | undefined {
  const usable = windows.filter(window => window.bounds !== undefined
    && window.bounds.width >= MIN_WIDTH
    && window.bounds.height >= MIN_HEIGHT)
  if (usable.length === 0) return undefined
  if (target.windowId !== undefined) {
    const exact = usable.find(window => window.id === target.windowId)
    if (exact !== undefined) return exact
  }
  if (target.windowTitle !== undefined && target.windowTitle !== '') {
    const titled = usable.find(window => window.title === target.windowTitle)
    if (titled !== undefined) return titled
  }
  return usable.reduce((best, window) => (area(window) > area(best) ? window : best))
}
