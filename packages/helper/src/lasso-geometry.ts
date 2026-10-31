/**
 * Freehand lasso geometry.
 *
 * A stroke closes either by crossing itself (the largest self-intersection loop wins)
 * or by ending near where it began. The result is always the axis-aligned bounds of
 * that loop; the confirm frame starts from these bounds and the user adjusts them.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export interface LassoRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ClosedRegion {
  readonly bounds: LassoRect
  readonly area: number
}

export interface LassoOptions {
  /** Smallest loop area that counts; keeps a scribble from becoming a capture. */
  readonly minAreaPx2?: number
  /** Points closer than this are dropped while thinning the stroke. */
  readonly minStepPx?: number
  readonly endpointCloseMinPx?: number
  readonly endpointCloseMaxPx?: number
  readonly endpointCloseFrac?: number
}

const MIN_NEAR_CLOSE_POINTS = 8

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function simplifyStroke(points: readonly Point[], minStepPx = 2): Point[] {
  if (points.length === 0) return []
  const step = Math.max(0, minStepPx)
  const out: Point[] = [{ x: points[0]!.x, y: points[0]!.y }]
  for (const point of points.slice(1)) {
    const last = out[out.length - 1]!
    if (Math.hypot(point.x - last.x, point.y - last.y) >= step) out.push({ x: point.x, y: point.y })
  }
  const lastRaw = points[points.length - 1]!
  const lastOut = out[out.length - 1]!
  if (points.length >= 2 && (lastOut.x !== lastRaw.x || lastOut.y !== lastRaw.y)) {
    out.push({ x: lastRaw.x, y: lastRaw.y })
  }
  return out
}

/**
 * Proper intersection of two segments.
 * @returns the hit point and the parameter along each segment, or undefined.
 */
export function segmentIntersection(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): { point: Point; t: number; u: number } | undefined {
  const denominator = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x)
  if (Math.abs(denominator) < 1e-12) return undefined
  const t = ((a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x)) / denominator
  const u = ((a1.x - b1.x) * (a1.y - a2.y) - (a1.y - b1.y) * (a1.x - a2.x)) / denominator
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined
  if (Math.min(t, 1 - t, u, 1 - u) < 1e-4) return undefined
  return {
    point: { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) },
    t,
    u,
  }
}

export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0
  let total = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    total += a.x * b.y - b.x * a.y
  }
  return Math.abs(total) / 2
}

export function boundsOf(points: readonly Point[]): LassoRect {
  if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  let minX = points[0]!.x
  let maxX = points[0]!.x
  let minY = points[0]!.y
  let maxY = points[0]!.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

export function pathLength(points: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1]!, points[i]!)
  return total
}

function loopFromIntersection(points: readonly Point[], i: number, j: number, hit: Point): Point[] {
  const loop: Point[] = [hit]
  for (let index = i + 1; index <= j; index += 1) loop.push(points[index]!)
  loop.push(hit)
  return loop
}

function largestSelfIntersection(
  points: readonly Point[],
  minAreaPx2: number,
): ClosedRegion | undefined {
  if (points.length < 4) return undefined
  let best: ClosedRegion | undefined
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 2; j < points.length - 1; j += 1) {
      const hit = segmentIntersection(points[i]!, points[i + 1]!, points[j]!, points[j + 1]!)
      if (hit === undefined) continue
      const loop = loopFromIntersection(points, i, j, hit.point)
      const body = loop.length > 1 ? loop.slice(0, -1) : loop
      const area = polygonArea(body)
      if (area < minAreaPx2) continue
      if (best === undefined || area > best.area) best = { bounds: boundsOf(body), area }
    }
  }
  return best
}

function nearClosedStroke(
  points: readonly Point[],
  minAreaPx2: number,
  minPx: number,
  maxPx: number,
  frac: number,
): ClosedRegion | undefined {
  if (points.length < MIN_NEAR_CLOSE_POINTS) return undefined
  const length = pathLength(points)
  if (length <= 0) return undefined
  const floor = Math.max(0, minPx)
  const ceiling = Math.max(floor, maxPx)
  const closeMax = Math.min(ceiling, Math.max(floor, Math.max(0, frac) * length))
  if (distance(points[0]!, points[points.length - 1]!) > closeMax) return undefined
  const area = polygonArea(points)
  if (area < minAreaPx2) return undefined
  return { bounds: boundsOf(points), area }
}

/**
 * Find the region a freehand stroke encloses.
 * @param points - global screen points captured during the drag.
 * @param options - area and near-close thresholds.
 * @returns the largest qualifying loop's bounds, or undefined when the stroke does not close.
 */
export function findLargestClosedRegion(
  points: readonly Point[],
  options: LassoOptions = {},
): ClosedRegion | undefined {
  const simplified = simplifyStroke(points, options.minStepPx ?? 2)
  if (simplified.length < 4) return undefined
  const minArea = options.minAreaPx2 ?? 4000
  const selfIntersection = largestSelfIntersection(simplified, minArea)
  if (selfIntersection !== undefined) return selfIntersection
  return nearClosedStroke(
    simplified,
    minArea,
    options.endpointCloseMinPx ?? 40,
    options.endpointCloseMaxPx ?? 120,
    options.endpointCloseFrac ?? 0.08,
  )
}

/** Clamp a rect into a display, keeping at least one pixel of area. */
export function clampRect(rect: LassoRect, display: LassoRect): LassoRect {
  const width = Math.max(1, Math.min(rect.width, display.width))
  const height = Math.max(1, Math.min(rect.height, display.height))
  return {
    x: Math.min(Math.max(rect.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(rect.y, display.y), display.y + display.height - height),
    width,
    height,
  }
}

/** Move a rect by a delta and keep it inside the display. */
export function moveRect(rect: LassoRect, dx: number, dy: number, display: LassoRect): LassoRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, display)
}

/** Resize one corner, keeping the opposite corner fixed and enforcing a minimum side. */
export function resizeRect(
  rect: LassoRect,
  corner: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  display: LassoRect,
  minSide = 48,
): LassoRect {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height
  if (corner === 'nw' || corner === 'sw') left = Math.min(left + dx, right - minSide)
  if (corner === 'ne' || corner === 'se') right = Math.max(right + dx, left + minSide)
  if (corner === 'nw' || corner === 'ne') top = Math.min(top + dy, bottom - minSide)
  if (corner === 'sw' || corner === 'se') bottom = Math.max(bottom + dy, top + minSide)
  return clampRect(
    { x: left, y: top, width: Math.max(minSide, right - left), height: Math.max(minSide, bottom - top) },
    display,
  )
}
