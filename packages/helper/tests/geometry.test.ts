import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement, type Rect } from '../src/geometry.ts'

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
  return new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next } },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
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
