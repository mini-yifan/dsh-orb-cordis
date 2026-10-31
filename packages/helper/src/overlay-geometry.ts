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
 * Where the toolbar window and its two contents go, in one calculation.
 *
 * Below the screen there is often no room for the menu, and above it the menu would cover the
 * selection the bar was deliberately moved clear of. So when neither vertical side has room,
 * the menu opens to the *side* of the bar: the window grows sideways, where a screen edge is
 * far less likely and nothing it covers was just selected.
 *
 * The two child boxes are returned as offsets rather than left to the page's own layout: the
 * page cannot see the screen edges, and an absolutely-positioned menu that the stylesheet
 * forgot to re-place lands outside the window. One calculation, three boxes, no guesswork.
 */
export interface ToolbarMenuLayout {
  /** The window, in screen coordinates. */
  readonly window: OverlayRect
  /** Where the bar sits inside the window. */
  readonly bar: { readonly left: number; readonly top: number }
  /** Where the menu sits inside the window, or null when it is not shown. */
  readonly menu: { readonly left: number; readonly top: number } | null
  readonly side: 'below' | 'above' | 'right' | 'left'
}

export function selectionToolbarMenuLayout(
  barOrigin: { readonly x: number; readonly y: number },
  contentSize: { readonly width: number; readonly height: number },
  workArea: OverlayRect,
  barBelowSelection = false,
): ToolbarMenuLayout {
  const menuW = Math.max(1, Math.round(contentSize.width))
  const menuH = Math.max(1, Math.round(contentSize.height))
  const barHeight = SELECTION_TOOLBAR_SIZE.height
  const barWidth = SELECTION_TOOLBAR_SIZE.width
  const workBottom = workArea.y + workArea.height
  const workRight = workArea.x + workArea.width
  // A stacked window has to hold both boxes, so it is as wide as the wider one.
  const stackedW = Math.max(barWidth, menuW)
  const x = clamp(barOrigin.x, workArea.x, workRight - stackedW)
  // The menu is centred on the bar within whatever room the window gives it.
  const menuLeftStacked = clamp((stackedW - menuW) / 2, 0, Math.max(0, stackedW - menuW))

  // Straight down, when it fits: the natural direction.
  if (barOrigin.y + barHeight + menuH <= workBottom) {
    const y = clamp(barOrigin.y, workArea.y, workBottom - (barHeight + menuH))
    const windowH = barHeight + menuH
    return {
      window: { x, y, width: stackedW, height: windowH },
      bar: { left: clamp(barOrigin.x - x, 0, stackedW - barWidth), top: barOrigin.y - y },
      menu: { left: menuLeftStacked, top: barHeight },
      side: 'below',
    }
  }
  // Straight up, when that fits *and* the bar is not under the selection — otherwise the menu
  // would unfold into the very words the bar was moved clear of.
  if (!barBelowSelection && barOrigin.y + barHeight - menuH >= workArea.y) {
    const y = clamp(barOrigin.y + barHeight - menuH, workArea.y, workBottom - (menuH + barHeight))
    return {
      window: { x, y, width: stackedW, height: barHeight + menuH },
      bar: { left: clamp(barOrigin.x - x, 0, stackedW - barWidth), top: barOrigin.y - y },
      menu: { left: menuLeftStacked, top: 0 },
      side: 'above',
    }
  }
  // Neither vertical side has room. Put the menu beside the bar and grow the window to hold
  // both, keeping the bar exactly where the user saw it.
  const rightRoom = workRight - (barOrigin.x + barWidth)
  const leftRoom = barOrigin.x - workArea.x
  const goRight = rightRoom >= menuW || rightRoom >= leftRoom
  const room = goRight ? rightRoom : leftRoom
  const roomForMenu = Math.min(menuW, Math.max(menuW, room))
  const windowW = barWidth + roomForMenu
  const windowX = goRight
    ? barOrigin.x
    : Math.max(workArea.x, barOrigin.x + barWidth - windowW)
  const windowH = Math.max(menuH, barHeight)
  const windowY = Math.max(workArea.y, Math.min(barOrigin.y + barHeight - windowH, workBottom - windowH))
  const barLeft = barOrigin.x - windowX
  return {
    window: { x: windowX, y: windowY, width: windowW, height: windowH },
    bar: { left: clamp(barLeft, 0, Math.max(0, windowW - barWidth)), top: barOrigin.y - windowY },
    menu: goRight
      ? { left: barLeft + barWidth, top: 0 }
      : { left: 0, top: 0 },
    side: goRight ? 'right' : 'left',
  }
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
