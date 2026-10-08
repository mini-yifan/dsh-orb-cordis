import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_STRIP_WIDTH,
  BALL_ANCHOR,
  BALL_SIZE,
  CHROME_INSET,
  FIXED_WINDOW_SIZE,
  PANEL_INSET,
  FloatingPlacement,
  PANEL_SIZE,
  PANEL_WINDOW_SIZE,
  ballOriginFromWindow,
  type Rect,
} from '../src/geometry.ts'

describe('docking on more than one display', () => {
  it('does not dock on the seam between two displays', async () => {
    const displays = [
      pair(0, 0, 1440, 900),
      pair(1440, 0, 1920, 1080),
    ]
    const placed = placement(displays, 1388, 400)
    placed.move(1388, 400)
    const seam = await placed.clamp()
    assert.equal(seam.docked, undefined)

    const outer = placement(displays, 3302, 400)
    outer.move(3302, 400)
    const docked = await outer.clamp()
    assert.equal(docked.docked, 'right')
  })
})

describe('edge-contact docking', () => {
  it('docks when the ball merely touches the right edge on release', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1368, 400)
    placed.move(1368, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, 'right')
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.x + bounds.width, 1440)
  })

  it('keeps a free ball flush inside the edge when it stops short', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1360, 400)
    placed.move(1360, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, undefined)
    assert.equal(lastBounds.get(placed)?.x, 1360 - BALL_ANCHOR.x)
  })

  it('docks from the renderer origin when the window bounds stay inside (DPI drift)', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1350, 400)
    placed.move(1350, 400)
    const state = await placed.clamp(true, { x: 1380, y: 410 })
    assert.equal(state.docked, 'right')
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.x + bounds.width, 1440)
  })

  it('docks on the left edge from the renderer origin alone', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 30, 400)
    placed.move(30, 400)
    const state = await placed.clamp(true, { x: 0, y: 420 })
    assert.equal(state.docked, 'left')
  })
})

/**
 * Windows quantizes window bounds to whole device pixels, so a ball pushed flush
 * against a scaled display reports one or two DIP short of the edge exactly when
 * `physicalWidth / scaleFactor` is fractional (1920/1.5 = 1280, 2560/1.25 = 2048).
 * These are the machines where docking used to fail while 100%/200% machines worked.
 */
describe('docking under DPI rounding', () => {
  it('docks when quantization leaves the ball a pixel short of the right edge', async () => {
    const displays = [pair(0, 0, 1280, 720)]
    const placed = placement(displays, 1206, 400)
    placed.move(1206, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, 'right')
  })

  it('docks when quantization leaves the ball a pixel short of the left edge', async () => {
    const displays = [pair(0, 0, 1280, 720)]
    const placed = placement(displays, 2, 400)
    placed.move(2, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, 'left')
  })

  it('still keeps a ball clearly short of the edge free', async () => {
    const displays = [pair(0, 0, 1280, 720)]
    const placed = placement(displays, 1198, 400)
    placed.move(1198, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, undefined)
  })

  it('accepts a renderer origin that ran past the left edge', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 20, 400)
    placed.move(20, 400)
    const state = await placed.clamp(true, { x: -6, y: 420 })
    assert.equal(state.docked, 'left')
  })

  it('reports the applied window origin for the renderer pointer offset', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 500)
    // The renderer composes its drag position as `origin + elementRect - grabOffset`. The
    // element is the ball, whose window-relative rect already carries BALL_ANCHOR, so this
    // has to be the raw WINDOW origin: returning the ball origin would double the anchor.
    const origin = placed.screenOrigin()
    assert.deepEqual(origin, { x: 1600 - BALL_ANCHOR.x, y: 500 - BALL_ANCHOR.y })
    assert.deepEqual({ x: origin.x + BALL_ANCHOR.x, y: origin.y + BALL_ANCHOR.y }, { x: 1600, y: 500 })
    placed.move(900, 300)
    const moved = placed.screenOrigin()
    assert.deepEqual(moved, { x: 900 - BALL_ANCHOR.x, y: 300 - BALL_ANCHOR.y })
    assert.deepEqual({ x: moved.x + BALL_ANCHOR.x, y: moved.y + BALL_ANCHOR.y }, { x: 900, y: 300 })
  })
})

describe('bookmark strip geometry', () => {
  it('keeps the window fixed when a strip is reserved, so the ball origin cannot move', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    // Right half of the screen: the panel expands left, so the strip rides the left edge.
    const ball = { x: 1600, y: 400 }
    const placed = placement(displays, ball.x, ball.y)
    placed.setStrip(AGENT_STRIP_WIDTH)
    const state = placed.setExpanded(true)
    assert.equal(state.strip, AGENT_STRIP_WIDTH)
    assert.equal(state.horizontal, 'left')
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    // The reserve is part of FIXED_WINDOW_SIZE: a bookmark must not re-bound the window,
    // or its origin would move (the flicker) and the panel would shift under the pointer.
    assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
    assert.equal(bounds.height, FIXED_WINDOW_SIZE.height)
    const origin = ballOriginFromWindow(bounds)
    assert.equal(origin.x, ball.x)
    assert.equal(origin.y, ball.y)
  })

  it('survives the strip appearing and clearing while expanded without moving anything', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const ball = { x: 1600, y: 400 }
    const placed = placement(displays, ball.x, ball.y)
    const expanded = placed.setExpanded(true)
    assert.equal(expanded.strip, 0)
    const before = lastBounds.get(placed)
    assert.ok(before)

    const appeared = placed.setStrip(AGENT_STRIP_WIDTH)
    assert.equal(appeared.strip, AGENT_STRIP_WIDTH)
    assert.equal(appeared.expanded, true)
    // The state change must be the only effect: the window is the very rectangle the
    // expand already placed, because the reserve was never added to it dynamically.
    assert.deepEqual(lastBounds.get(placed), before)
    assert.deepEqual(ballOriginFromWindow(before), ball)

    const cleared = placed.setStrip(0)
    assert.equal(cleared.strip, 0)
    assert.deepEqual(lastBounds.get(placed), before)
  })

  it('keeps the collapsed window at the fixed size regardless of the strip reserve', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 400)
    placed.setStrip(AGENT_STRIP_WIDTH)
    const state = placed.setExpanded(false)
    assert.equal(state.strip, AGENT_STRIP_WIDTH)
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    // Collapsing only scales the panel down over the ball: the window, and therefore its
    // origin, is the same rectangle the expand used. That is what removes the flicker.
    assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
    assert.equal(bounds.height, FIXED_WINDOW_SIZE.height)
    assert.deepEqual(ballOriginFromWindow(bounds), { x: 1600, y: 400 })
  })

  it('keeps dragging expanded with the strip reserved', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 400)
    placed.setStrip(AGENT_STRIP_WIDTH)
    placed.setExpanded(true)
    placed.move(1500, 500)
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
    // The drag moves the ball origin; the recovered origin must match the requested one.
    const origin = ballOriginFromWindow(bounds)
    assert.equal(origin.x, 1500)
    assert.equal(origin.y, 500)
  })

  it('parks the ball at dead centre so a panel and a strip fit on either side', () => {
    // Both a panel and a strip slot must fit to the left AND to the right of the ball, or
    // one direction would clip. That is what fixes BALL_ANCHOR, and why the window is
    // 2 * (panel + strip + chrome) - ball wide.
    assert.equal(PANEL_INSET, CHROME_INSET + AGENT_STRIP_WIDTH)
    assert.equal(BALL_ANCHOR.x, FIXED_WINDOW_SIZE.width / 2 - BALL_SIZE / 2)
    assert.equal(BALL_ANCHOR.y, FIXED_WINDOW_SIZE.height / 2 - BALL_SIZE / 2)
    const perSide = PANEL_SIZE.width + PANEL_INSET
    assert.equal(FIXED_WINDOW_SIZE.width, 2 * perSide - BALL_SIZE)
    // Room past the ball on each side, and the ball clear of the window edge.
    assert.ok(FIXED_WINDOW_SIZE.width - BALL_ANCHOR.x - BALL_SIZE >= perSide - BALL_SIZE)
    assert.ok(BALL_ANCHOR.x >= perSide - BALL_SIZE)
  })

  it('recovers the same ball origin from the window in every direction', () => {
    // The window is direction-independent now, so the recovery takes no direction and
    // cannot disagree with the renderer's fixed `#ball` placement.
    const displays = [pair(0, 0, 1920, 1080)]
    for (const [x, y] of [[100, 100], [1800, 100], [100, 900], [1800, 900]]) {
      const placed = placement(displays, x, y)
      const bounds = lastBounds.get(placed)
      assert.ok(bounds, `no bounds for ${x},${y}`)
      assert.deepEqual(ballOriginFromWindow(bounds), { x, y })
    }
  })
})

const lastBounds = new WeakMap<FloatingPlacement, Rect>()

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function placement(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number): FloatingPlacement {
  // The free window is one constant rectangle with the ball parked at BALL_ANCHOR, so a
  // placement for a ball at (x, y) starts from `ball - BALL_ANCHOR`. The window centre is
  // the ball centre, so `displayAt(center(bounds))` still resolves to the display the ball
  // sits on.
  let bounds: Rect = {
    x: x - BALL_ANCHOR.x,
    y: y - BALL_ANCHOR.y,
    width: FIXED_WINDOW_SIZE.width,
    height: FIXED_WINDOW_SIZE.height,
  }
  const placed = new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next }; lastBounds.set(placed, { ...next }) },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
  // Seed the record: the constructor places nothing, so a test that only reads back the
  // opening window would otherwise find no entry at all.
  lastBounds.set(placed, { ...bounds })
  return placed
}

function nearest(displays: { bounds: Rect; workArea: Rect }[], point: { x: number; y: number }) {
  let best = displays[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const cx = display.bounds.x + display.bounds.width / 2
    const cy = display.bounds.y + display.bounds.height / 2
    const distance = (cx - point.x) ** 2 + (cy - point.y) ** 2
    if (distance < bestDistance) {
      best = display
      bestDistance = distance
    }
  }
  if (best === undefined) throw new Error('no display')
  return best
}
