/**
 * Cursor-driven hover for the fixed-size ball window.
 *
 * The window keeps FIXED_WINDOW_SIZE (592x792) in both states so that expand and
 * collapse never move its origin — a moved origin is the expand flicker. The price is
 * that the page can no longer see the pointer leave the ball: the cursor stays inside
 * the window, `pointerleave` never fires, and the renderer cannot tell a hover from a
 * resting pointer. The main process has to answer that question itself, from the OS
 * cursor and the geometry it already owns.
 *
 * Everything here is pure, so the four directions and the docked tab are testable
 * without Electron. Points and rectangles are always compared in the same units:
 * Electron hands out dip on every platform.
 */

import {
  BALL_ANCHOR,
  BALL_SIZE,
  CHROME_INSET,
  PANEL_INSET,
  PANEL_SIZE,
  STRIP_TUCK,
  type Direction,
  type Rect,
} from './geometry.ts'

export interface HoverState {
  /** The OS cursor, in the same units as `window`. */
  readonly cursor: { readonly x: number; readonly y: number }
  /** The ball window as the OS has it, docked tab included. */
  readonly window: Rect
  /** The expansion direction: it moves the panel, never the ball. */
  readonly direction: Direction
  /** True while the renderer is showing the panel. */
  readonly expanded: boolean
  /** True while the ball rides a display edge as a narrow tab. */
  readonly docked: boolean
  /** Reserved bookmark-strip width; 0 when no strip is showing. */
  readonly strip: number
  /**
   * True while the page is dragging the ball.
   *
   * A drag has to stay interactive wherever the cursor is: the page moves the window
   * through the same async channel this poll reads, so the rectangle below is one
   * round-trip behind a fast drag. Testing it against a moving cursor would turn the
   * window click-through mid-drag, which stops the pointer events the drag is made of
   * and drops the ball out of the hand.
   */
  readonly dragging: boolean
}

export interface HoverDecision {
  /** What the renderer should be asked for, or `undefined` to leave it alone. */
  readonly request: 'expand' | 'collapse' | undefined
  /** Whether the window has to stay interactive, i.e. swallow clicks itself. */
  readonly interactive: boolean
}

/**
 * The ball's rectangle inside the window.
 *
 * The ball sits at BALL_ANCHOR in every direction, and `ballOriginFromWindow` recovers
 * that same screen origin from the window alone, so the two cannot disagree about where
 * the ball is. Nothing here is reported by the renderer: a wedged page must not be able
 * to move the rectangle the cursor is tested against.
 *
 * A docked window is the exception. It is 34px of tab, not a panel with an anchor in it,
 * and its ball origin follows the tab rather than the free window's anchor, so the
 * whole strip answers for the ball. That is also what the renderer does with its own
 * region report while docked, and the strip is what slides the ball back in.
 */
export function ballRectInWindow(state: HoverState): Rect {
  const bounds = state.window
  if (state.docked) return { ...bounds }
  return {
    x: bounds.x + BALL_ANCHOR.x,
    y: bounds.y + BALL_ANCHOR.y,
    width: BALL_SIZE,
    height: BALL_SIZE,
  }
}

/**
 * The panel's rectangle inside the window: it moves with `direction`, panel-sized.
 *
 * Unclipped on purpose — {@link decideHover} clips it to the window, because a ball held
 * against a work-area edge opens a panel the window cuts short and the clipped part is
 * not hit-testable.
 */
export function panelRectInWindow(state: HoverState): Rect {
  const bounds = state.window
  return {
    x: bounds.x + (state.direction.horizontal === 'left' ? PANEL_INSET : BALL_ANCHOR.x),
    y: bounds.y + (state.direction.vertical === 'up' ? CHROME_INSET : BALL_ANCHOR.y),
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
  }
}

/**
 * The bookmark strip's band, on the same window edge as the panel's far side.
 *
 * The chips have to keep the panel open. They sit OUTSIDE the panel's own rectangle, so
 * without this the cursor reaching for a chip reads as a leave and folds the panel away
 * exactly when the user is aiming at it. Only the reserved width plus the chrome and the
 * tuck is claimed: the rest of the far side stays chrome, so the window can still be
 * click-through past the strip.
 */
export function stripRectInWindow(state: HoverState): Rect | undefined {
  if (state.strip <= 0) return undefined
  const bounds = state.window
  const width = state.strip + CHROME_INSET + STRIP_TUCK
  return {
    x: state.direction.horizontal === 'left' ? bounds.x : bounds.x + bounds.width - width,
    y: bounds.y,
    width,
    height: bounds.height,
  }
}

/** The part of `rect` that still sits inside `bounds`; never negative. */
export function clipRect(rect: Rect, bounds: Rect): Rect {
  const x = Math.max(rect.x, bounds.x)
  const y = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width)
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/** True when the point is inside the rectangle, edges included. */
export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/**
 * One cursor tick: what the renderer should be told, and whether the window has to
 * swallow clicks itself.
 *
 * - a cursor on the ball with the panel closed asks for the panel to open
 * - a cursor off both the ball and the open panel asks for it to close, and that is also
 *   the leave signal the renderer used to get from `pointerleave`: it has to arrive while
 *   the panel is already folded too, or state that only a leave clears — the suppression a
 *   dock slide leaves behind — would never clear again inside a permanently fixed-size
 *   window
 * - a docked tab is never asked to expand: hovering it means the slide back in, which
 *   the renderer runs from the pointer events the 34px window really delivers
 *
 * While the panel is open the whole window stays interactive. The ball, the panel and any
 * bookmark strip are the drawn chrome, but the pointer has to be able to cross the 12px
 * of transparent margin around them without falling through to the desktop, and a
 * pointer inside the window is one the renderer can still resolve on its own.
 *
 * A request is only a request: pinned, running, asking, dragging and microphone state all
 * stay with the renderer, which is free to refuse.
 */
export function decideHover(state: HoverState): HoverDecision {
  if (state.docked) return { request: undefined, interactive: true }
  // A drag owns the window: no click-through, no expand, no collapse.
  if (state.dragging) return { request: undefined, interactive: true }
  const { x, y } = state.cursor
  const onBall = containsPoint(ballRectInWindow(state), x, y)
  const onPanel = state.expanded && containsPoint(clipRect(panelRectInWindow(state), state.window), x, y)
  const strip = stripRectInWindow(state)
  const onStrip = strip !== undefined && containsPoint(clipRect(strip, state.window), x, y)
  const interactive = onBall || state.expanded
  if (onBall && !state.expanded) return { request: 'expand', interactive }
  if (!onBall && !onPanel && !onStrip) return { request: 'collapse', interactive }
  return { request: undefined, interactive }
}