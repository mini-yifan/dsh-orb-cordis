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
export const BELOW_CENTER = 0.08
export const DOCK_OVERLAP = Math.round(BALL_SIZE / 5)
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
}

export interface DockState {
  readonly docked: DockSide | undefined
}

export interface DisplayPair {
  readonly bounds: Rect
  readonly workArea: Rect
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

function isCollapsed(bounds: Rect): boolean {
  return bounds.width <= BALL_WINDOW_SIZE && bounds.height <= BALL_WINDOW_SIZE
}

function clampWindowOrigin(value: number, workOrigin: number, workSize: number, windowSize: number): number {
  return clamp(value, workOrigin - CHROME_INSET, workOrigin + workSize - windowSize + CHROME_INSET)
}

/**
 * Which outer display edge the ball already overlaps by about one fifth of its width.
 * An edge that touches another display is a seam, not a place to dock.
 */
export function dockSideForBallOrigin(
  ball: { readonly x: number; readonly y: number },
  bounds: Rect,
  displays: readonly Rect[] = [],
): DockSide | undefined {
  const leftOverlap = bounds.x - ball.x
  const rightOverlap = ball.x + BALL_SIZE - (bounds.x + bounds.width)
  let side: DockSide | undefined
  if (leftOverlap >= DOCK_OVERLAP && leftOverlap >= rightOverlap) side = 'left'
  else if (rightOverlap >= DOCK_OVERLAP) side = 'right'
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

function overlayBoundsFromBall(ball: { readonly x: number; readonly y: number }, direction: Direction): Rect {
  return {
    x: direction.horizontal === 'left'
      ? ball.x - (PANEL_SIZE.width - BALL_SIZE) - CHROME_INSET
      : ball.x - CHROME_INSET,
    y: direction.vertical === 'up'
      ? ball.y - (PANEL_SIZE.height - BALL_SIZE) - CHROME_INSET
      : ball.y - CHROME_INSET,
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
  }
}

function expandedOverlayBounds(ball: { readonly x: number; readonly y: number }, workArea: Rect): Rect & Direction {
  const direction = expandDirection(ball, workArea)
  const unclamped = overlayBoundsFromBall(ball, direction)
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
  private anim = 0

  constructor(private readonly window: {
    getBounds(): Rect
    setBounds(bounds: Rect): void
  }, private readonly displayAt: (point: { x: number; y: number }) => DisplayPair, private readonly displayBounds: () => readonly Rect[] = () => []) {}

  /** Resize between the ball and the panel while keeping the ball origin fixed. */
  setExpanded(expanded: boolean): ExpandState {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (expanded) {
      const origin = this.currentBallOrigin(display.workArea)
      this.docked = undefined
      const next = expandedOverlayBounds(origin, display.workArea)
      this.direction = { horizontal: next.horizontal, vertical: next.vertical }
      // A dock slide may still be animating towards the off-screen origin; invalidate it the way
      // `move` and `applyTab` do, or it keeps overwriting these bounds every 16ms until it lands
      // and the ball ends up parked outside the work area with no tab to fall back to.
      this.anim += 1
      this.window.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height })
      return { expanded: true, ...this.direction, docked: undefined }
    }
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { expanded: false, ...this.direction, docked: this.docked.side }
    }
    const origin = clampedBallOrigin(this.currentBallOrigin(display.workArea), display.workArea)
    this.anim += 1
    this.window.setBounds(collapsedWindowBounds(origin))
    return { expanded: false, ...this.direction, docked: undefined }
  }

  /**
   * Move so the 72px ball origin follows `(x, y)`.
   * A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
   */
  move(x: number, y: number, canDock = true): DockState {
    const origin = { x: Math.round(x), y: Math.round(y) }
    const bounds = this.window.getBounds()
    if (!isCollapsed(bounds) && this.docked === undefined) {
      const direction = this.direction
      this.window.setBounds(overlayBoundsFromBall(origin, direction))
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

  /** Pull a free ball inside the work area, or dock it when it already overlaps a side edge. */
  async clamp(canDock = true): Promise<DockState> {
    const bounds = this.window.getBounds()
    const display = this.displayAt(center(bounds))
    if (this.docked) {
      this.applyTab(this.docked.side, this.docked.y, display.bounds)
      return { docked: this.docked.side }
    }
    if (isCollapsed(bounds)) {
      const origin = { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET }
      if (canDock) {
        const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds())
        if (side) return this.snap(side, origin.y, display.bounds)
      }
      this.window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)))
      return { docked: undefined }
    }
    this.setExpanded(true)
    return { docked: undefined }
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

  private currentBallOrigin(workArea: Rect): { x: number; y: number } {
    const bounds = this.window.getBounds()
    if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)))
    if (isCollapsed(bounds)) return { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET }
    return ballOriginFromWindow(bounds, this.direction)
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
    await this.animate(
      collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)),
      DOCK_SLIDE_OFF_MS,
      easeInOutCubic,
    )
    if (!this.docked || this.docked.side !== side) return { docked: this.docked?.side }
    this.window.setBounds(dockedTabBounds(side, y, bounds))
    return { docked: side }
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
