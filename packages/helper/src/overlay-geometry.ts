/** Toolbar and observation-frame placement. No Electron import, so tests can run the same math. */

export const SELECTION_TOOLBAR_SIZE = { width: 280, height: 46 } as const

export const OBSERVATION_FRAME_STROKE_PX = 8
export const OBSERVATION_FRAME_GLOW_PX = 28
export const OBSERVATION_FRAME_OUTSET = OBSERVATION_FRAME_STROKE_PX + OBSERVATION_FRAME_GLOW_PX

export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface EdgePadding {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface ObservationFramePlacement {
  readonly bounds: OverlayRect
  readonly glow: EdgePadding
  readonly stroke: EdgePadding
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Where the toolbar lands, given the selection rectangle (or a bare point when the
 * platform could not report one). It hangs clear of the selection instead of covering it:
 * below the rectangle when there is room, above it otherwise.
 */
export interface ToolbarAnchor {
  readonly x: number
  readonly y: number
  /** Selection width. Absent means `x` is a point, not the left edge of a rectangle. */
  readonly width?: number
  /** Selection height. Absent means `y` is a point, not the top edge of a rectangle. */
  readonly height?: number
}

/** Toolbar sits clear of the selection rectangle and stays inside the work area. */
export function selectionToolbarBounds(
  anchor: ToolbarAnchor,
  size: { readonly width: number; readonly height: number } = SELECTION_TOOLBAR_SIZE,
  workArea: OverlayRect,
): OverlayRect {
  const gap = 8
  const height = Math.max(1, Math.round(size.height))
  const width = Math.max(1, Math.round(size.width))
  // A rectangle anchors on its own edges; a bare point is both edges at once.
  const left = anchor.x
  const top = anchor.y
  const right = anchor.x + Math.max(0, anchor.width ?? 0)
  const bottom = anchor.y + Math.max(0, anchor.height ?? 0)
  const centre = (left + right) / 2

  const below = bottom + gap
  const above = top - gap - height
  const fitsBelow = below + height <= workArea.y + workArea.height
  const fitsAbove = above >= workArea.y
  // Prefer below (the reading direction), fall back to above, and only then overlap.
  const y = fitsBelow ? below : fitsAbove ? above : clamp(below, workArea.y, workArea.y + workArea.height - height)

  return {
    x: clamp(centre - width / 2, workArea.x, workArea.x + workArea.width - width),
    y,
    width,
    height,
  }
}

/**
 * Grow the toolbar window for the language menu.
 *
 * Below the screen there is often no room for a menu, and above it the menu would cover the
 * selection the bar was deliberately moved clear of. So when neither vertical side has room,
 * the menu opens to the *side* of the bar instead: the window grows sideways, where a screen
 * edge is far less likely and nothing it covers was just selected.
 */
export interface ToolbarMenuBounds extends OverlayRect {
  /** Which way the menu opened, so the page can lay the menu out on the same side. */
  readonly side: 'below' | 'above' | 'right' | 'left'
  /**
   * Where the bar sits inside the returned window. A sideways menu often has to grow the
   * window upward past the bar, and this is what tells the page not to move the bar with it.
   */
  readonly barOffsetY: number
}

export function selectionToolbarMenuLayout(
  barOrigin: { readonly x: number; readonly y: number },
  contentSize: { readonly width: number; readonly height: number },
  workArea: OverlayRect,
  barBelowSelection = false,
): ToolbarMenuBounds {
  const width = Math.max(1, Math.round(contentSize.width))
  const height = Math.max(1, Math.round(contentSize.height))
  const barHeight = SELECTION_TOOLBAR_SIZE.height
  const barWidth = SELECTION_TOOLBAR_SIZE.width
  const workBottom = workArea.y + workArea.height
  const workRight = workArea.x + workArea.width
  const x = clamp(barOrigin.x, workArea.x, workRight - width)

  // Straight down, when it fits: the natural direction.
  if (barOrigin.y + height <= workBottom) {
    const y = clamp(barOrigin.y, workArea.y, workBottom - height)
    return { x, y, width, height, side: 'below', barOffsetY: barOrigin.y - y }
  }
  // Straight up, when that fits *and* the bar is not under the selection — otherwise the menu
  // would unfold into the very words the bar was moved clear of.
  if (!barBelowSelection && barOrigin.y + barHeight - height >= workArea.y) {
    const y = clamp(barOrigin.y + barHeight - height, workArea.y, workBottom - height)
    return {
      x,
      y,
      width,
      height,
      side: 'above',
      barOffsetY: barOrigin.y - y,
    }
  }
  // Neither vertical side has room for a stacked menu. Open sideways: the window grows away
  // from the bar horizontally, and upward just enough to give the menu its full height. The
  // page pushes the bar down by `barOffsetY`, which is what keeps the bar itself from moving
  // even though the window grew above it.
  const windowH = Math.max(height, barHeight)
  // Start high enough that the menu fits above the bar's row, but never above the work area.
  const y = Math.max(workArea.y, Math.min(barOrigin.y + barHeight - windowH, workBottom - windowH))
  const rightRoom = workRight - (barOrigin.x + barWidth)
  const leftRoom = barOrigin.x - workArea.x
  const barOffsetY = barOrigin.y - y
  if (rightRoom >= width || rightRoom >= leftRoom) {
    const w = Math.min(width, Math.max(barWidth, rightRoom))
    return { x: barOrigin.x, y, width: w, height: windowH, side: 'right', barOffsetY }
  }
  const w = Math.min(width, Math.max(barWidth, leftRoom))
  return {
    x: Math.max(workArea.x, barOrigin.x + barWidth - w),
    y,
    width: w,
    height: windowH,
    side: 'left',
    barOffsetY,
  }
}

/** The rectangle alone, for callers that do not need the side. */
export function selectionToolbarMenuBounds(
  barOrigin: { readonly x: number; readonly y: number },
  contentSize: { readonly width: number; readonly height: number },
  workArea: OverlayRect,
  barBelowSelection = false,
): OverlayRect {
  const { side: _side, ...rect } = selectionToolbarMenuLayout(barOrigin, contentSize, workArea, barBelowSelection)
  return rect
}

function intersectRects(area: OverlayRect, clip: OverlayRect): OverlayRect {
  const x = Math.max(area.x, clip.x)
  const y = Math.max(area.y, clip.y)
  const right = Math.min(area.x + area.width, clip.x + clip.width)
  const bottom = Math.min(area.y + area.height, clip.y + clip.height)
  const width = right - x
  const height = bottom - y
  if (width >= 1 && height >= 1) return { x, y, width, height }
  return {
    x: clamp(area.x, clip.x, clip.x + clip.width - 1),
    y: clamp(area.y, clip.y, clip.y + clip.height - 1),
    width: 1,
    height: 1,
  }
}

function edgePadding(inset: number): { readonly glow: number; readonly stroke: number } {
  const leftover = Math.max(0, Math.round(inset))
  return {
    glow: Math.max(0, leftover - OBSERVATION_FRAME_STROKE_PX),
    stroke: OBSERVATION_FRAME_STROKE_PX,
  }
}

/** Body glow and frame stroke that keep the inner hole on the observation rectangle. */
export function observationFramePadding(
  region: OverlayRect,
  bounds: OverlayRect,
): { readonly glow: EdgePadding; readonly stroke: EdgePadding } {
  const left = edgePadding(region.x - bounds.x)
  const top = edgePadding(region.y - bounds.y)
  const right = edgePadding(bounds.x + bounds.width - (region.x + region.width))
  const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height))
  return {
    glow: { top: top.glow, right: right.glow, bottom: bottom.glow, left: left.glow },
    stroke: { top: top.stroke, right: right.stroke, bottom: bottom.stroke, left: left.stroke },
  }
}

/** Inflate the observation rectangle by the stroke and glow, then clip to the work area. */
export function observationFramePlacement(
  region: OverlayRect,
  workArea: OverlayRect,
): ObservationFramePlacement {
  const inflated = {
    x: Math.round(region.x - OBSERVATION_FRAME_OUTSET),
    y: Math.round(region.y - OBSERVATION_FRAME_OUTSET),
    width: Math.max(1, Math.round(region.width + OBSERVATION_FRAME_OUTSET * 2)),
    height: Math.max(1, Math.round(region.height + OBSERVATION_FRAME_OUTSET * 2)),
  }
  const bounds = intersectRects(inflated, workArea)
  const padding = observationFramePadding(region, bounds)
  return { bounds, glow: padding.glow, stroke: padding.stroke }
}

export function observationFrameCssScript(
  glow: EdgePadding,
  stroke: EdgePadding,
): string {
  const vars: ReadonlyArray<readonly [string, number]> = [
    ['--glow-top', glow.top],
    ['--glow-right', glow.right],
    ['--glow-bottom', glow.bottom],
    ['--glow-left', glow.left],
    ['--stroke-top', stroke.top],
    ['--stroke-right', stroke.right],
    ['--stroke-bottom', stroke.bottom],
    ['--stroke-left', stroke.left],
  ]
  const assignments = vars.map(([name, value]) =>
    `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`,
  ).join('')
  return `(() => { const root = document.documentElement.style; ${assignments} })()`
}

export function pointInRect(
  point: { readonly x: number; readonly y: number },
  bounds: OverlayRect,
): boolean {
  return point.x >= bounds.x && point.y >= bounds.y
    && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
}
