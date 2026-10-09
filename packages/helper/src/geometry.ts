/**
 * Floating-ball window geometry.
 * Sizes match the fork overlay exactly: a 72px ball, 12px of transparent chrome, and a 320×420 panel.
 */

export const BALL_SIZE = 72
export const PANEL_SIZE = { width: 320, height: 420 } as const
export const CHROME_INSET = 12
export const BALL_WINDOW_SIZE = BALL_SIZE + 2 * CHROME_INSET
export const PANEL_WINDOW_SIZE = {
  width: PANEL_SIZE.width + 2 * CHROME_INSET,
  height: PANEL_SIZE.height + 2 * CHROME_INSET,
} as const
/**
 * Transparent reserve on the panel's far edge for the bookmark strip.
 * Sized for the fully hover-expanded chip row; collapsed chips sit at the
 * panel-side edge inside it.
 */
export const AGENT_STRIP_WIDTH = 208
export const BELOW_CENTER = 0.08
/**
 * Any contact with the display edge docks on release, plus a hair of tolerance.
 * Windows quantizes window bounds to whole device pixels, so a ball placed flush
 * against the edge can read back a pixel or two short when
 * `physicalWidth / scaleFactor` is not an integer (1920/1.5, 2560/1.25, 3840/1.75).
 * The drag itself no longer depends on that read-back; this only absorbs the
 * rounding of the final placement. A ball stopped clearly short of the edge
 * still stays free.
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
}

export interface DisplayPair {
  readonly bounds: Rect
  readonly workArea: Rect
}

/** A point in the same DIP space as window bounds (screen coordinates). */
export interface Point {
  readonly x: number
  readonly y: number
}

interface Direction {
  horizontal: HorizontalExpand
  vertical: VerticalExpand
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function collapsedWindowBounds(ball: { readonly x: number; readonly y: number }): Rect {
  return {
    x: ball.x - CHROME_INSET,
    y: ball.y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
}

/**
 * Chromium turns a DIP window size into device pixels with an enclosing rect, then
 * converts back the same way. Whenever `size * scaleFactor` is not an integer
 * (120% is 115.2), a 96px ball window reads back 97. The panel is hundreds of
 * pixels larger, so a few DIP still cannot be the panel. 150% keeps 96 exactly
 * (`96 * 1.5 = 144`) but still pulls a window that would hang past the screen
 * back inside, which the dock decision handles separately.
 */
const BALL_WINDOW_SLOP = 4

function isCollapsed(bounds: Rect): boolean {
  return bounds.width <= BALL_WINDOW_SIZE + BALL_WINDOW_SLOP && bounds.height <= BALL_WINDOW_SIZE + BALL_WINDOW_SLOP
}

/** The full ball window, as drawn by a collapsed ball or a slide still in flight. */
function drawsBall(bounds: Rect): boolean {
  return Math.abs(bounds.width - BALL_WINDOW_SIZE) <= BALL_WINDOW_SLOP
    && Math.abs(bounds.height - BALL_WINDOW_SIZE) <= BALL_WINDOW_SLOP
}

function clampWindowOrigin(value: number, workOrigin: number, workSize: number, windowSize: number): number {
  return clamp(value, workOrigin - CHROME_INSET, workOrigin + workSize - windowSize + CHROME_INSET)
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

/** Ball top-left recovered from an expanded window and its growth direction. */
export function ballOriginFromWindow(bounds: Rect, direction: Direction): { x: number; y: number } {
  return {
    x: direction.horizontal === 'left'
      ? bounds.x + bounds.width - CHROME_INSET - BALL_SIZE
      : bounds.x + CHROME_INSET,
    y: direction.vertical === 'up'
      ? bounds.y + bounds.height - CHROME_INSET - BALL_SIZE
      : bounds.y + CHROME_INSET,
  }
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

function overlayBoundsFromBall(
  ball: { readonly x: number; readonly y: number },
  direction: Direction,
  stripWidth = 0,
): Rect {
  return {
    // The strip widens the far edge only; the ball-anchored near edge is untouched,
    // so ballOriginFromWindow needs no strip awareness.
    x: direction.horizontal === 'left'
      ? ball.x - (PANEL_SIZE.width - BALL_SIZE) - CHROME_INSET - stripWidth
      : ball.x - CHROME_INSET,
    y: direction.vertical === 'up'
      ? ball.y - (PANEL_SIZE.height - BALL_SIZE) - CHROME_INSET
      : ball.y - CHROME_INSET,
    width: PANEL_WINDOW_SIZE.width + stripWidth,
    height: PANEL_WINDOW_SIZE.height,
  }
}

function expandedOverlayBounds(
  ball: { readonly x: number; readonly y: number },
  workArea: Rect,
  stripWidth = 0,
): Rect & Direction {
  const direction = expandDirection(ball, workArea)
  const unclamped = overlayBoundsFromBall(ball, direction, stripWidth)
  return {
    x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
    y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
    width: unclamped.width,
    height: unclamped.height,
    ...direction,
  }
}

function clampBallY(ballY: number, bounds: Rect): number {
  return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - BALL_SIZE)
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

/** Initial collapsed window, including the transparent chrome around the ball. */
export function initialWindowBounds(workArea: Rect): Rect {
  return collapsedWindowBounds(defaultFloatingBallOrigin(workArea))
}

/**
 * Owns expand direction and dock state for one overlay window.
 * Dock is committed on pointer-up, not while the ball is still moving.
 */
export class FloatingPlacement {
  private direction: Direction = { horizontal: 'left', vertical: 'up' }
  private docked: { side: DockSide; y: number } | undefined
  private stripWidth = 0
  private anim = 0
  /** Cursor offset inside the ball, recorded at press and kept for the whole gesture. */
  private grab: Point | undefined
  /** Set once the renderer reports that the gesture passed the drag threshold. */
  private dragging = false
  /**
   * Ball origin last requested. The OS read-back is not a safe dock input on
   * Windows once the scale is above 100%: the window is kept inside the monitor,
   * so the 12px transparent chrome leaves the ball a chrome-width short of the
   * edge it was aimed at.
   */
  private placedOrigin: Point | undefined

  constructor(private readonly window: {
    getBounds(): Rect
    setBounds(bounds: Rect): void
  }, private readonly displayAt: (point: { x: number; y: number }) => DisplayPair, private readonly displayBounds: () => readonly Rect[] = () => []) {}

  /** Ball origin of a collapsed window, from the window bounds the OS applied. */
  private collapsedBallOrigin(): Point {
    const bounds = this.window.getBounds()
    return { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET }
  }

  /** Resize between the ball and the panel while keeping the ball origin fixed. */
  setExpanded(expanded: boolean): ExpandState {
    // Any explicit placement stops a slide still in flight, or its frames would
    // overwrite the window this call just set.
    this.anim += 1
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (expanded) {
      const origin = this.currentBallOrigin()
      this.docked = undefined
      const next = expandedOverlayBounds(origin, display.workArea, this.stripWidth)
      this.direction = { horizontal: next.horizontal, vertical: next.vertical }
      this.window.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height })
      return { expanded: true, ...this.direction, docked: undefined, strip: this.stripWidth }
    }
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { expanded: false, ...this.direction, docked: this.docked.side, strip: this.stripWidth }
    }
    const origin = clampedBallOrigin(this.currentBallOrigin(), display.workArea)
    this.window.setBounds(collapsedWindowBounds(origin))
    return { expanded: false, ...this.direction, docked: undefined, strip: this.stripWidth }
  }

  /**
   * Reserve (or free) bookmark-strip width on the far edge. While expanded the
   * window re-bounds immediately around the fixed ball origin; while collapsed
   * the value is stored for the next expand.
   */
  setStrip(width: number): ExpandState {
    const next = Math.max(0, Math.round(width))
    if (next === this.stripWidth) {
      return { expanded: !isCollapsed(this.window.getBounds()) && !this.docked, ...this.direction, docked: this.docked?.side, strip: this.stripWidth }
    }
    this.stripWidth = next
    const bounds = this.window.getBounds()
    if (!isCollapsed(bounds) && !this.docked) {
      const display = this.displayAt(center(bounds))
      const origin = this.currentBallOrigin()
      const nextBounds = expandedOverlayBounds(origin, display.workArea, this.stripWidth)
      this.direction = { horizontal: nextBounds.horizontal, vertical: nextBounds.vertical }
      this.window.setBounds({ x: nextBounds.x, y: nextBounds.y, width: nextBounds.width, height: nextBounds.height })
    }
    return { expanded: !isCollapsed(this.window.getBounds()) && !this.docked, ...this.direction, docked: this.docked?.side, strip: this.stripWidth }
  }

  /**
   * Move so the 72px ball origin follows `(x, y)`.
   * A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
   */
  move(x: number, y: number, canDock = true): DockState {
    const origin = { x: Math.round(x), y: Math.round(y) }
    this.placedOrigin = origin
    const bounds = this.window.getBounds()
    if (!isCollapsed(bounds) && this.docked === undefined) {
      const direction = this.direction
      this.window.setBounds(overlayBoundsFromBall(origin, direction, this.stripWidth))
      return { docked: undefined }
    }
    if (!canDock) {
      this.docked = undefined
      this.anim += 1
      this.window.setBounds(collapsedWindowBounds(origin))
      return { docked: undefined }
    }
    const display = this.displayAt(origin)
    if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side }
    }
    this.docked = undefined
    this.anim += 1
    this.window.setBounds(collapsedWindowBounds(origin))
    return { docked: undefined }
  }

  /**
   * Pointer pressed on the ball. The grab offset comes from the OS cursor and the
   * ball origin the window really has, both in the DIP space `setBounds` uses, so
   * the drag never reads a renderer-side window position.
   */
  press(cursor: Point): void {
    // A slide-off still in flight is taken over: the ball stops where it is drawn and
    // is free, so the grab and the drag both read the place the ball is actually at.
    this.stopSlideOff()
    const origin = this.currentBallOrigin()
    this.grab = { x: cursor.x - origin.x, y: cursor.y - origin.y }
    this.dragging = false
  }

  /** The gesture passed the drag threshold; from here the ball follows the cursor. */
  beginDrag(): void {
    this.dragging = this.grab !== undefined
  }

  /**
   * Follow the cursor. Stateless on purpose: the target is always cursor minus grab,
   * so the window moving cannot feed back into the next target.
   */
  dragTo(cursor: Point, canDock = true): DockState {
    if (!this.dragging || this.grab === undefined) return { docked: this.docked?.side }
    return this.move(cursor.x - this.grab.x, cursor.y - this.grab.y, canDock)
  }

  /**
   * Release. The ball is placed under the cursor, then docked on a side edge or
   * pulled back into the work area. The result is the full layout the page must
   * show, including the panel direction when a running panel re-anchored.
   */
  async endDrag(cursor: Point, canDock = true): Promise<ExpandState> {
    const grab = this.grab
    const dragging = this.dragging
    this.grab = undefined
    this.dragging = false
    if (grab === undefined || !dragging) return this.expandState()
    this.move(cursor.x - grab.x, cursor.y - grab.y, canDock)
    return this.clamp(canDock)
  }

  /**
   * Pull a free ball inside the work area, or dock it when it reaches a side edge.
   * The decision uses the origin the drag requested. The window the OS actually
   * applied can sit short of that on a scaled Windows display.
   */
  async clamp(canDock = true): Promise<ExpandState> {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return this.expandState()
    }
    if (isCollapsed(bounds)) {
      const origin = this.placedOrigin ?? this.collapsedBallOrigin()
      if (canDock) {
        const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds())
        if (side) return this.snap(side, origin.y, display.bounds)
      }
      this.window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)))
      return this.expandState()
    }
    // A release with the panel still open (drag while the agent runs, or a release
    // that lands mid-collapse) must be able to dock too (#62): judge from the ball
    // origin the expanded window grew around, on the display that origin sits on,
    // then run the same slide-off a collapsed release would. The drag's requested
    // origin outranks what the window shows when they disagree.
    const origin = this.placedOrigin ?? ballOriginFromWindow(bounds, this.direction)
    if (canDock) {
      const originDisplay = this.displayAt(origin)
      const side = dockSideForBallOrigin(origin, originDisplay.bounds, this.displayBounds())
      if (side) {
        this.window.setBounds(collapsedWindowBounds(origin))
        return this.snap(side, origin.y, originDisplay.bounds)
      }
    }
    // An open panel (running or asking) re-anchors toward the side with room now.
    // The new direction goes back with the result; the page cannot infer it.
    return this.setExpanded(true)
  }

  /** Slide the ball back on screen from a docked tab. */
  async unsnap(): Promise<DockState> {
    if (!this.docked) return { docked: undefined }
    const display = this.displayAt(center(this.window.getBounds()))
    const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds)
    const end = insideBallOrigin(this.docked.side, this.docked.y, display)
    this.docked = undefined
    this.window.setBounds(collapsedWindowBounds(start))
    await this.animate(collapsedWindowBounds(end), DOCK_SLIDE_IN_MS, easeOutCubic)
    return { docked: undefined }
  }

  /** Stop a slide-off that still draws the ball window; the ball stays free where it is. */
  private stopSlideOff(): void {
    if (this.docked && drawsBall(this.window.getBounds())) {
      this.docked = undefined
      this.anim += 1
    }
  }

  private currentBallOrigin(): Point {
    const bounds = this.window.getBounds()
    // A docked window at rest is the thin tab. While the slide-off still draws the
    // full ball window, the ball is wherever that window is, not at its docked pose.
    if (this.docked && !drawsBall(bounds)) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)))
    if (isCollapsed(bounds)) return this.collapsedBallOrigin()
    return ballOriginFromWindow(bounds, this.direction)
  }

  private applyTab(side: DockSide, ballY: number, bounds: Rect): void {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    this.anim += 1
    this.window.setBounds(dockedTabBounds(side, y, bounds))
  }

  private async snap(side: DockSide, ballY: number, bounds: Rect): Promise<ExpandState> {
    const y = clampBallY(ballY, bounds)
    this.docked = { side, y }
    await this.animate(
      collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)),
      DOCK_SLIDE_OFF_MS,
      easeInOutCubic,
    )
    if (!this.docked || this.docked.side !== side) return this.expandState()
    this.window.setBounds(dockedTabBounds(side, y, bounds))
    return this.expandState()
  }

  /** The layout as the window stands now, in the shape the page applies. */
  private expandState(): ExpandState {
    const expanded = !isCollapsed(this.window.getBounds()) && this.docked === undefined
    return { expanded, ...this.direction, docked: this.docked?.side, strip: this.stripWidth }
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
