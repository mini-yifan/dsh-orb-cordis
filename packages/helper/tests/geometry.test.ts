import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_STRIP_WIDTH,
  BALL_WINDOW_SIZE,
  CHROME_INSET,
  FloatingPlacement,
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
    const placed = placement(displays, 1367, 400)
    placed.move(1367, 400)
    const state = await placed.clamp()
    assert.equal(state.docked, undefined)
    assert.equal(lastBounds.get(placed)?.x, 1367 - CHROME_INSET)
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

describe('bookmark strip geometry', () => {
  it('widens the expanded window on the far edge and keeps the ball origin', () => {
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
    assert.equal(bounds.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
    const origin = ballOriginFromWindow(bounds, state)
    assert.equal(origin.x, ball.x)
    assert.equal(origin.y, ball.y)
  })

  it('re-bounds live when the strip appears while expanded and shrinks back when it clears', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const ball = { x: 1600, y: 400 }
    const placed = placement(displays, ball.x, ball.y)
    const expanded = placed.setExpanded(true)
    assert.equal(expanded.strip, 0)
    const before = lastBounds.get(placed)
    assert.ok(before)
    assert.equal(before.width, PANEL_WINDOW_SIZE.width)

    const appeared = placed.setStrip(AGENT_STRIP_WIDTH)
    assert.equal(appeared.strip, AGENT_STRIP_WIDTH)
    assert.equal(appeared.expanded, true)
    const widened = lastBounds.get(placed)
    assert.ok(widened)
    assert.equal(widened.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
    const origin = ballOriginFromWindow(widened, appeared)
    assert.deepEqual(origin, ballOriginFromWindow(before, expanded))

    const cleared = placed.setStrip(0)
    assert.equal(cleared.strip, 0)
    assert.equal(lastBounds.get(placed)?.width, PANEL_WINDOW_SIZE.width)
  })

  it('keeps the collapsed window ball-sized regardless of the strip reserve', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 400)
    placed.setStrip(AGENT_STRIP_WIDTH)
    const state = placed.setExpanded(false)
    assert.equal(state.strip, AGENT_STRIP_WIDTH)
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.width, BALL_WINDOW_SIZE)
    assert.equal(bounds.height, BALL_WINDOW_SIZE)
  })

  it('keeps dragging expanded with the strip reserved', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 400)
    placed.setStrip(AGENT_STRIP_WIDTH)
    placed.setExpanded(true)
    placed.move(1500, 500)
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
    // The drag moves the ball origin; the recovered origin must match the requested one.
    const origin = ballOriginFromWindow(bounds, { horizontal: 'left', vertical: 'up' })
    assert.equal(origin.x, 1500)
    assert.equal(origin.y, 500)
  })
})

const lastBounds = new WeakMap<FloatingPlacement, Rect>()

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function placement(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number): FloatingPlacement {
  let bounds: Rect = {
    x: x - CHROME_INSET,
    y: y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  const placed = new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next }; lastBounds.set(placed, { ...next }) },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
  return placed
}

function nearest(displays: { bounds: Rect; workArea: Rect }[], point: { x: number; y: number }) {
  for (const display of displays) {
    if (point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width
      && point.y >= display.bounds.y && point.y < display.bounds.y + display.bounds.height) {
      return display
    }
  }
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

describe('collapsing an expanded panel that spans a display seam', () => {
  // The reporter's layout: a smaller display left of the primary, top-aligned.
  const displays = [
    pair(-1463, 0, 1463, 914),
    pair(0, 0, 1920, 1080),
  ]

  function placedAt(x: number, y: number) {
    let bounds: Rect = {
      x: x - CHROME_INSET,
      y: y - CHROME_INSET,
      width: BALL_WINDOW_SIZE,
      height: BALL_WINDOW_SIZE,
    }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next) { bounds = { ...next } },
    }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
    return { placed, bounds: () => bounds }
  }

  it('keeps the ball on its own display while collapsing a seam-spanning panel', () => {
    // Expand on the primary's left half (panel grows right), then drag the panel
    // across the seam so the ball rests on the secondary while the panel — and its
    // center — still sit on the primary.
    const { placed, bounds } = placedAt(300, 400)
    placed.setExpanded(true)
    placed.move(-100, 400)
    const state = placed.setExpanded(false)
    assert.equal(state.expanded, false)
    const origin = { x: bounds().x + CHROME_INSET, y: bounds().y + CHROME_INSET }
    // The ball must stay on the secondary (x < 0), not snap to the primary's edge.
    assert.ok(origin.x < 0, `ball origin x=${origin.x}, expected on the secondary`)
  })

  it('re-expands around the anchored ball after a seam-spanning drop', async () => {
    const { placed, bounds } = placedAt(300, 400)
    placed.setExpanded(true)
    placed.move(-100, 400)
    await placed.clamp()
    placed.setExpanded(false)
    const origin = { x: bounds().x + CHROME_INSET, y: bounds().y + CHROME_INSET }
    assert.ok(origin.x < 0, `ball origin x=${origin.x}, expected on the secondary`)
  })

  it('keeps an expanded drag clamped on the ball display and stable at release', async () => {
    // Agent-running drags move the EXPANDED panel. The panel must follow the
    // ball's display — clamped, growth side re-derived — instead of flying
    // off-screen with a stale direction, and the release re-expand must not
    // flip it to the other side of the ball (the reported teleport).
    const { placed, bounds } = placedAt(1848, 563)
    placed.setExpanded(true)
    placed.move(-821, 168)
    const during = { ...bounds() }
    assert.ok(during.y >= -12, `panel y=${during.y} left the secondary work area`)
    assert.ok(during.x + during.width <= 12, `panel right edge=${during.x + during.width} crossed the seam`)
    assert.ok(during.x >= -1463, `panel x=${during.x} left the secondary`)
    await placed.clamp()
    const released = { ...bounds() }
    assert.deepEqual(released, during)
  })
})
