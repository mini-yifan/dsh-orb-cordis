/**
 * Floating-ball window geometry.
 *
 * A 72px ball, 12px of transparent chrome, a 320x420 panel, and one bookmark-strip
 * reserve. The window is one fixed 1008x792 rectangle with the ball at dead centre:
 * expanding, collapsing and a bookmark appearing all leave its origin untouched.
 */

export const BALL_SIZE = 72
export const PANEL_SIZE = { width: 320, height: 420 } as const
export const CHROME_INSET = 12
/** The panel's own corner radius; mirrored by `--panel-radius` in floating.css. */
export const PANEL_RADIUS = 36
/**
 * The panel-sized window of the older corner model, where the ball sat in a corner so the
 * window spanned only the panel plus its chrome. Kept as the "too small to be a panel"
 * threshold for the dock path.
 */
export const PANEL_WINDOW_SIZE = {
  width: PANEL_SIZE.width + 2 * CHROME_INSET,
  height: PANEL_SIZE.height + 2 * CHROME_INSET,
} as const
/**
 * Transparent reserve for the bookmark strip, on the panel's far edge. Sized for the fully
 * hover-expanded chip row; collapsed chips sit at the panel-side edge inside it.
 */
export const AGENT_STRIP_WIDTH = 208
/** How far the strip's chips slide under the panel's edge; mirrored by `--strip-tuck`. */
export const STRIP_TUCK = 12
/**
 * The panel's near edge, as an offset from the window edge on the panel's own side: one
 * chrome inset plus one strip reserve, so that side holds the panel and a strip slot
 * together. It is the same number on both sides because the ball is at dead centre.
 */
export const PANEL_INSET = CHROME_INSET + AGENT_STRIP_WIDTH
/**
 * The one window rectangle that holds the ball in every state: chrome + strip + panel on
 * one side of the ball, mirrored on the other, so the ball sits at dead centre with a panel
 * and a strip slot to either side. 2 * (208 + 12 + 320) - 72 by 344 + 348.
 *
 * Both strip slots are part of the constant rectangle rather than width the strip adds when
 * bookmarks appear. A window that grew for the strip would move its origin (the expand
 * flicker) and would shift the panel out from under a pointer that is already on it. The
 * panel only ever uses one side, so the free side is where a strip is drawn.
 */
export const FIXED_WINDOW_SIZE = {
  width: 2 * (PANEL_SIZE.width + PANEL_INSET) - BALL_SIZE,
  height: PANEL_WINDOW_SIZE.height + PANEL_SIZE.height - BALL_SIZE,
} as const
/** Distance from the window origin to the ball top-left corner: dead centre. */
export const BALL_ANCHOR = {
  x: FIXED_WINDOW_SIZE.width / 2 - BALL_SIZE / 2,
  y: FIXED_WINDOW_SIZE.height / 2 - BALL_SIZE / 2,
} as const

export const BELOW_CENTER = 0.08
/**
 * Any contact with the display edge docks on release, plus a hair of tolerance.
 * The window bounds and the renderer drag coordinates are both DIPs, but Windows
 * quantizes each to whole device pixels on the way in and out, so a ball pushed
 * flush against the edge lands a pixel or two short exactly when
 * `physicalWidth / scaleFactor` is not an integer (1920/1.5, 2560/1.25, 3840/1.75).
 * A strict `>=` comparison made docking work on 100%/200% machines and fail on
 * those, which reads as "works for me, not for other users". Contact is
 * forgiving; a ball stopped clearly short of the edge still stays free.
 */
export const DOCK_OVERLAP = 3
export const DOCK_DRAG_OFF = Math.round(BALL_SIZE / 3)
export const DOCK_TAB_WIDTH = 6
export const DOCK_GLOW = 8
export const DOCK_HOVER_MARGIN = 20
export const DOCK_HIT_WIDTH = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN
export const DOCK_HIT_HEIGHT = BALL_SIZE + 2 * DOCK_GLOW
export const DOCK_OFF_GAP = 2
export const DOCK_IN_PAD = 5
export const DOCK_SLIDE_OFF_MS = 250
export const DOCK_SLIDE_IN_MS = 300

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type HorizontalExpand = 'left' | 'right'
export type VerticalExpand = 'up' | 'down'
export type DockSide = 'left' | 'right'

export interface ExpandState {
  readonly expanded: boolean
  readonly horizontal: HorizontalExpand
  readonly vertical: VerticalExpand
  readonly docked: DockSide | undefined
  /** Reserved bookmark-strip width on the far edge; 0 when there is nothing to show. */
  readonly strip: number
}

export interface DockState {
  readonly docked: DockSide | undefined
  readonly horizontal: HorizontalExpand
  readonly vertical: VerticalExpand
  /**
   * The strip reserve, echoed for the same reason {@link ExpandState} carries it: the
   * renderer repaints its strip classes from every placement answer, so an answer that
   * omitted the field would read as "no strip" and hide the bookmarks on any drag.
   */
  readonly strip: number
}

export interface DisplayPair {
  readonly bounds: Rect
  readonly workArea: Rect
}

export interface Direction {
  horizontal: HorizontalExpand
  vertical: VerticalExpand
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}


/**
 * Which outer display edge the ball reaches on release; contact within
 * {@link DOCK_OVERLAP} docks. An edge that touches another display is a seam,
 * not a place to dock.
 */
export function dockSideForBallOrigin(
  ball: { readonly x: number; readonly y: number },
  bounds: Rect,
  displays: readonly Rect[] = [],
): DockSide | undefined {
  const leftGap = bounds.x - ball.x
  const rightGap = ball.x + BALL_SIZE - (bounds.x + bounds.width)
  // The nearer edge wins, so a display narrower than the ball cannot dock both ways.
  let side: DockSide | undefined
  if (leftGap >= rightGap && leftGap >= -DOCK_OVERLAP) side = 'left'
  else if (rightGap > leftGap && rightGap >= -DOCK_OVERLAP) side = 'right'
  if (side === undefined || edgeTouchesDisplay(side, bounds, displays)) return undefined
  return side
}

function edgeTouchesDisplay(side: DockSide, bounds: Rect, displays: readonly Rect[]): boolean {
  const edge = side === 'left' ? bounds.x : bounds.x + bounds.width
  for (const other of displays) {
    if (sameRect(other, bounds)) continue
    const otherEdge = side === 'left' ? other.x + other.width : other.x
    if (Math.abs(otherEdge - edge) > 8) continue
    const top = Math.max(bounds.y, other.y)
    const bottom = Math.min(bounds.y + bounds.height, other.y + other.height)
    if (bottom > top) return true
  }
  return false
}

function sameRect(left: Rect, right: Rect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

/** Hittable strip for a docked tab, flush with a display edge. */
export function dockedTabBounds(side: DockSide, ballY: number, bounds: Rect): Rect {
  const y = clamp(Math.round(ballY - DOCK_GLOW), bounds.y, bounds.y + bounds.height - DOCK_HIT_HEIGHT)
  return {
    x: side === 'left' ? bounds.x : bounds.x + bounds.width - DOCK_HIT_WIDTH,
    y,
    width: DOCK_HIT_WIDTH,
    height: DOCK_HIT_HEIGHT,
  }
}

/** Panel growth that keeps the expanded overlay on the open side of the ball. */
export function expandDirection(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): Direction {
  const centerX = ball.x + BALL_SIZE / 2
  const horizontal: HorizontalExpand = centerX - workArea.x > workArea.width / 2 ? 'left' : 'right'
  const vertical: VerticalExpand = ball.y - workArea.y < PANEL_SIZE.height - BALL_SIZE ? 'down' : 'up'
  return { horizontal, vertical }
}

/**
 * Ball top-left recovered from the window that holds it.
 *
 * The window is one fixed rectangle in every state and parks the ball at
 * `BALL_ANCHOR`, so its origin no longer depends on the expand direction.
 */
export function ballOriginFromWindow(bounds: Rect): { x: number; y: number } {
  return { x: bounds.x + BALL_ANCHOR.x, y: bounds.y + BALL_ANCHOR.y }
}

/** Keep a 72px ball fully inside a work area. */
export function clampedBallOrigin(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
): { x: number; y: number } {
  return {
    x: clamp(ball.x, workArea.x, workArea.x + workArea.width - BALL_SIZE),
    y: clamp(ball.y, workArea.y, workArea.y + workArea.height - BALL_SIZE),
  }
}

/** Collapsed origin on the work-area right edge, slightly below vertical center. */
export function defaultFloatingBallOrigin(workArea: Rect): { x: number; y: number } {
  const x = workArea.x + workArea.width - BALL_SIZE
  const centerY = workArea.y + (workArea.height - BALL_SIZE) / 2
  const y = centerY + workArea.height * BELOW_CENTER
  return clampedBallOrigin({ x: Math.round(x), y: Math.round(y) }, workArea)
}

/**
 * The one window rectangle that holds the ball in every state.
 *
 * Collapsed and expanded share this rectangle, so showing the panel never moves the
 * window origin - only the panel opacity and scale change. Windows `SetWindowPos`
 * copies the old client bitmap to a moved origin, which paints one stale frame; the
 * fixed origin is what removes the expand flicker. The ball sits at `BALL_ANCHOR`
 * inside it, so the rectangle is identical for every expand direction; only the panel
 * placement varies with the direction, mirrored by the `expand-*` CSS classes, and the
 * bookmark strip lives in the half the panel leaves free.
 */
function overlayBoundsFromBall(ball: { readonly x: number; readonly y: number }): Rect {
  return {
    x: ball.x - BALL_ANCHOR.x,
    y: ball.y - BALL_ANCHOR.y,
    width: FIXED_WINDOW_SIZE.width,
    height: FIXED_WINDOW_SIZE.height,
  }
}

function expandedOverlayBounds(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
  stripWidth = 0,
): Rect & Direction {
  const direction = expandDirection(ball, workArea)
  // Only the direction still varies with the work area: the rectangle is
  // direction-independent, so the window origin never moves on expand/collapse and no
  // stale frame is copied. A bookmark strip appearing does not re-bound it either: the
  // strip occupies the half of the constant rectangle the panel leaves free. The
  // renderer keeps the ball under the cursor through the `expand-*` classes and clips
  // the panel to the work area.
  return { ...overlayBoundsFromBall(ball), ...direction }
}

/**
 * The four window fields of a placement result.
 *
 * `expandedOverlayBounds` carries the direction alongside the rectangle for its
 * caller's convenience; the window must not be handed those extra keys.
 */
function windowRect(bounds: Rect): Rect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

function clampBallY(ballY: number, bounds: Rect): number {
  return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - BALL_SIZE)
}

/** Renderer-supplied drag origin, rounded and bounds-checked like `isMove` inputs.
 * Negative coordinates are legitimate: a drag that ran past the left edge of the
 * primary display reports them, and that ball must still be allowed to dock. */
function inputBallOrigin(origin?: { x: number; y: number }): { x: number; y: number } | undefined {
  if (origin === undefined) return undefined
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return undefined
  if (Math.abs(origin.x) > 100_000 || Math.abs(origin.y) > 100_000) return undefined
  return { x: Math.round(origin.x), y: Math.round(origin.y) }
}

function offScreenBallOrigin(side: DockSide, ballY: number, bounds: Rect): { x: number; y: number } {
  const y = clampBallY(ballY, bounds)
  return {
    x: side === 'left'
      ? bounds.x - BALL_SIZE - DOCK_OFF_GAP
      : bounds.x + bounds.width + DOCK_OFF_GAP,
    y,
  }
}

function insideBallOrigin(
  side: DockSide,
  ballY: number,
  display: DisplayPair,
): { x: number; y: number } {
  return {
    x: side === 'left'
      ? display.bounds.x + DOCK_IN_PAD
      : display.bounds.x + display.bounds.width - BALL_SIZE - DOCK_IN_PAD,
    y: clamp(
      Math.round(ballY),
      display.workArea.y,
      display.workArea.y + display.workArea.height - BALL_SIZE,
    ),
  }
}

function staysDocked(side: DockSide, cursorX: number, bounds: Rect): boolean {
  if (side === 'right') return cursorX >= bounds.x + bounds.width - DOCK_DRAG_OFF
  return cursorX <= bounds.x + DOCK_DRAG_OFF
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function lerpRect(start: Rect, end: Rect, t: number): Rect {
  return {
    x: Math.round(start.x + (end.x - start.x) * t),
    y: Math.round(start.y + (end.y - start.y) * t),
    width: Math.round(start.width + (end.width - start.width) * t),
    height: Math.round(start.height + (end.height - start.height) * t),
  }
}

/**
 * The corner a dock slide parks the ball in. An undock lands the ball back inside the
 * display, and this is the corner the slide starts from, so the ball does not jump
 * across the window body on the way in.
 */
const TAB_CORNER: Direction = { horizontal: 'right', vertical: 'down' }

/** Expand direction of the ball's default resting place; the window is placed for it. */
export function initialExpandDirection(workArea: Rect): Direction {
  return expandDirection(defaultFloatingBallOrigin(workArea), workArea)
}

/**
 * Initial window: the fixed {@link FIXED_WINDOW_SIZE} rectangle with the ball parked at
 * {@link BALL_ANCHOR}, so the first expand cannot move the origin.
 *
 * The dock slide runs at this same fixed size too: parking the ball at
 * `ball - CHROME_INSET` for the slide would need a 96x96 window, which would clip a ball
 * anchored at {@link BALL_ANCHOR} away for the whole animation.
 *
 * It has to start at the full size, or the first expand would move the origin (the
 * flicker) and the renderer would have to guess a corner.
 */
export function initialWindowBounds(workArea: Rect): Rect {
  return overlayBoundsFromBall(defaultFloatingBallOrigin(workArea))
}

/**
 * Owns expand direction and dock state for one overlay window.
 * Dock is committed on pointer-up, not while the ball is still moving.
 */
export class FloatingPlacement {
  private direction: Direction
  private docked: { side: DockSide; y: number } | undefined
  private stripWidth = 0
  private anim = 0
  private expanded = false

  /**
   * `initialDirection` must be the one the window was opened for, i.e.
   * {@link initialExpandDirection} of the same work area. It is not always the default
   * `left`/`up`: a short work area puts the resting ball above the panel threshold, and
   * a stale guess would place the ball one panel-height away from where it is drawn.
   */
  constructor(
    private readonly window: {
      getBounds(): Rect
      setBounds(bounds: Rect): void
    },
    private readonly displayAt: (point: { x: number; y: number }) => DisplayPair,
    private readonly displayBounds: () => readonly Rect[] = () => [],
    initialDirection: Direction = { horizontal: 'left', vertical: 'up' },
    /**
     * Called with the new direction immediately BEFORE the window is re-anchored for it.
     * A different direction puts the ball in a different corner of the same rectangle,
     * so the renderer's corner classes have to land first: it is a separate process, and
     * a reposition it has not been told about paints one frame in the old corner.
     */
    private readonly announceDirection: (direction: Direction) => void = () => {},
  ) {
    this.direction = { ...initialDirection }
  }
  /**
   * Show or hide the panel.
   *
   * Both states keep the same panel-sized window: collapsing only scales the panel
   * down over the ball. The window origin therefore never moves on expand/collapse,
   * which is what removes the one stale frame Windows would copy from the old origin.
   * A docked ball still folds the window down to its tab.
   */
  /**
   * Adopt a new corner for the ball, announcing it BEFORE anything moves.
   *
   * A reposition that changes the corner must be announced first: the page paints the
   * ball from its own classes, so a window moved ahead of them shows the ball in the old
   * corner for one frame and leaves the cursor poll aiming at the wrong rectangle. That
   * pair is what a drag across the screen centre used to look like: a flash towards the
   * old side, then a ball that can be neither hovered nor clicked.
   */
  private adoptDirection(next: Direction): void {
    if (next.horizontal === this.direction.horizontal && next.vertical === this.direction.vertical) return
    this.direction = { horizontal: next.horizontal, vertical: next.vertical }
    this.announceDirection({ ...this.direction })
  }

  /**
   * Screen origin of the window as the OS applied it. The renderer offsets its pointer
   * coordinates by this instead of trusting `event.screenX`, which Chromium derives
   * from the window origin it has cached and therefore reports stale (jumpy) values
   * while the window is being moved under the cursor. It is the raw window origin, not
   * the ball: the renderer's grab offset already carries `BALL_ANCHOR`.
   */
  screenOrigin(): { x: number; y: number } {
    const bounds = this.window.getBounds()
    return { x: bounds.x, y: bounds.y }
  }

  setExpanded(expanded: boolean): ExpandState {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    this.expanded = expanded
    if (expanded) {
      const origin = this.currentBallOrigin(display.workArea)
      this.docked = undefined
      const next = expandedOverlayBounds(origin, display.workArea)
      this.adoptDirection(next)
      this.window.setBounds(windowRect(next))
      return { expanded: true, ...this.direction, docked: undefined, strip: this.stripWidth }
    }
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { expanded: false, ...this.direction, docked: this.docked.side, strip: this.stripWidth }
    }
    const origin = clampedBallOrigin(this.currentBallOrigin(display.workArea), display.workArea)
    const next = expandedOverlayBounds(origin, display.workArea)
    this.adoptDirection(next)
    this.window.setBounds(windowRect(next))
    return { expanded: false, ...this.direction, docked: undefined, strip: this.stripWidth }
  }

  /**
   * Remember whether a bookmark strip is showing.
   *
   * The reserve is baked into {@link FIXED_WINDOW_SIZE}, so this never re-bounds the
   * window: the strip lives in the half of the constant rectangle the panel leaves
   * free, the ball keeps its anchor and the panel does not move under an open pointer.
   * Nothing here may resize the window, or a bookmark arriving would move the origin
   * (the flicker) and shift the panel out from under the pointer.
   */
  setStrip(width: number): ExpandState {
    this.stripWidth = Math.max(0, Math.round(width))
    return {
      expanded: this.expanded && this.docked === undefined,
      ...this.direction,
      docked: this.docked?.side,
      strip: this.stripWidth,
    }
  }

  /**
   * Move so the 72px ball origin follows `(x, y)`.
   * A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
   */
  move(x: number, y: number, canDock = true): DockState {
    const origin = { x: Math.round(x), y: Math.round(y) }
    const display = this.displayAt(origin)
    // A free ball always drags the whole panel-sized window, so only a docked tab
    // narrows it: a width test cannot tell an expanded window from a collapsed one.
    if (this.docked === undefined) {
      const next = expandedOverlayBounds(origin, display.workArea)
      this.adoptDirection(next)
      this.anim += 1
      this.window.setBounds(windowRect(next))
      return { docked: undefined, ...this.direction, strip: this.stripWidth }
    }
    if (!canDock) {
      const side = this.docked.side
      this.docked = undefined
      this.anim += 1
      this.window.setBounds(windowRect(overlayBoundsFromBall(origin)))
      return { docked: undefined, ...this.direction, strip: this.stripWidth }
    }
    if (staysDocked(this.docked.side, origin.x, display.bounds)) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side, ...this.direction, strip: this.stripWidth }
    }
    this.docked = undefined
    this.anim += 1
    this.window.setBounds(windowRect(overlayBoundsFromBall(origin)))
    return { docked: undefined, ...this.direction, strip: this.stripWidth }
  }

  /**
   * Pull a free ball inside the work area, or dock it when it reaches a side edge.
   * `remoteOrigin` is the renderer's input-side ball origin (drag coordinates).
   * On Windows the window bounds can come back mis-scaled (per-display DPI,
   * electron#10862), so either signal docking is enough.
   */
  async clamp(canDock = true, remoteOrigin?: { x: number; y: number }): Promise<DockState> {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side, ...this.direction, strip: this.stripWidth }
    }
    if (this.expanded) {
      this.setExpanded(true)
      return { docked: undefined, ...this.direction, strip: this.stripWidth }
    }
    // A dock slide leaves a tab-sized window whose ball origin follows the tab, not the
    // free window's anchor; `isTabSized` is what tells the two apart now that the free
    // window is one constant size.
    const origin = this.isTabSized(bounds) ? this.screenOrigin() : ballOriginFromWindow(bounds)
    if (canDock) {
      const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds())
      if (side) return this.snap(side, origin.y, display.bounds)
      // Windows can report bounds mis-scaled per display (electron#10862), so a ball
      // pushed flush to the edge can read a pixel or two short here. The renderer's own
      // reading of the same drag is the second signal, and either one may dock.
      const remote = inputBallOrigin(remoteOrigin)
      if (remote) {
        const remoteDisplay = this.displayAt(remote)
        const remoteSide = dockSideForBallOrigin(remote, remoteDisplay.bounds, this.displayBounds())
        if (remoteSide) return this.snap(remoteSide, remote.y, remoteDisplay.bounds)
      }
    }
    this.window.setBounds(windowRect(overlayBoundsFromBall(clampedBallOrigin(origin, display.workArea))))
    return { docked: undefined, ...this.direction, strip: this.stripWidth }
  }

  /**
   * Slide the ball back on screen from a docked tab.
   *
   * The slide runs at {@link FIXED_WINDOW_SIZE}, with the ball in the tab corner that
   * `TAB_CORNER` names, so it ends on the very rectangle the next expand would use:
   * no second resize and no origin move. Dock *commit* is untouched — `snap` and
   * `applyTab` still fold the window down to the tab.
   */
  async unsnap(): Promise<DockState> {
    if (!this.docked) return { docked: undefined, ...this.direction, strip: this.stripWidth }
    const display = this.displayAt(center(this.window.getBounds()))
    const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds)
    const end = insideBallOrigin(this.docked.side, this.docked.y, display)
    this.docked = undefined
    this.adoptDirection(TAB_CORNER)
    this.window.setBounds(windowRect(overlayBoundsFromBall(start)))
    await this.animate(windowRect(overlayBoundsFromBall(end)), DOCK_SLIDE_IN_MS, easeOutCubic)
    return { docked: undefined, ...this.direction, strip: this.stripWidth }
  }

  private currentBallOrigin(workArea: Rect): { x: number; y: number } {
    const bounds = this.window.getBounds()
    if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)))
    if (this.isTabSized(bounds)) {
      // First expand after a dock slide: the window is still a small bar, so it is the
      // ball box, not a panel with a corner. Place the ball from this direction, then
      // let setExpanded re-place the window for whichever direction it grows in.
      const ball = { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET }
      const direction = expandDirection(ball, workArea)
      this.adoptDirection(direction)
      return ball
    }
    return ballOriginFromWindow(bounds)
  }

  /** True while the window is too small to be a panel, i.e. a dock slide or tab. */
  private isTabSized(bounds: Rect): boolean {
    return bounds.width < PANEL_WINDOW_SIZE.width || bounds.height < PANEL_WINDOW_SIZE.height
  }

  private applyTab(side: DockSide, ballY: number, bounds: Rect): void {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    this.anim += 1
    this.window.setBounds(dockedTabBounds(side, y, bounds))
  }

  private async snap(side: DockSide, ballY: number, bounds: Rect): Promise<DockState> {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    // Carried at the fixed size, not down to a 96x96 ball box: the ball now sits at
    // BALL_ANCHOR, so a 96x96 window would clip it away (overflow:hidden) for the whole
    // slide. The ball reaching the screen edge is what this animates; the window only
    // narrows to the tab afterwards.
    await this.animate(
      windowRect(overlayBoundsFromBall(offScreenBallOrigin(side, y, bounds))),
      DOCK_SLIDE_OFF_MS,
      easeInOutCubic,
    )
    if (!this.docked || this.docked.side !== side) {
      return { docked: this.docked?.side, ...this.direction, strip: this.stripWidth }
    }
    this.window.setBounds(dockedTabBounds(side, y, bounds))
    return { docked: side, ...this.direction, strip: this.stripWidth }
  }

  private animate(end: Rect, durationMs: number, ease: (t: number) => number): Promise<void> {
    const generation = ++this.anim
    const start = this.window.getBounds()
    if (durationMs <= 0) {
      this.window.setBounds(end)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = (): void => {
        if (generation !== this.anim) {
          resolve()
          return
        }
        const t = Math.min(1, (Date.now() - t0) / durationMs)
        this.window.setBounds(lerpRect(start, end, ease(t)))
        if (t < 1) {
          setTimeout(tick, 16)
          return
        }
        resolve()
      }
      setTimeout(tick, 16)
    })
  }
}

function center(bounds: Rect): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}
