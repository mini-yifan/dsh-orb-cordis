import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_STRIP_WIDTH,
  BALL_WINDOW_SIZE,
  CHROME_INSET,
  DOCK_HIT_WIDTH,
  DOCK_IN_PAD,
  FloatingPlacement,
  PANEL_WINDOW_SIZE,
  ballOriginFromWindow,
  type Rect,
} from '../src/geometry.ts'

describe('docking beside a side taskbar', () => {
  it('keeps the tab and the slide-in inside the work area, not on the display bounds', async () => {
    // A 48px taskbar on the left: it is inside the display bounds and outside the work area.
    const displays = [{
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 48, y: 0, width: 1392, height: 900 },
    }]
    const placed = placement(displays, 10, 400)
    placed.press({ x: 60, y: 430 })
    placed.beginDrag()
    placed.dragTo({ x: 0, y: 430 })
    const state = await placed.endDrag({ x: 0, y: 430 })
    assert.equal(state.docked, 'left')
    const tab = lastBounds.get(placed)
    assert.ok(tab)
    assert.equal(tab.x, 48, 'the tab sits against the work area, not under the taskbar')
    assert.equal(tab.width, DOCK_HIT_WIDTH)

    await placed.unsnap()
    const ball = lastBounds.get(placed)
    assert.ok(ball)
    assert.equal(ball.x + CHROME_INSET, 48 + DOCK_IN_PAD, 'the slide-in stops clear of the taskbar')
  })
})

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
    assert.equal(lastBounds.get(placed)?.x, 1360 - CHROME_INSET)
  })

  it('docks at the edge the cursor reaches on release, whatever the grab offset', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    for (const grabX of [0, 36, 71]) {
      const right = placement(displays, 1000, 400)
      right.press({ x: 1000 + grabX, y: 430 })
      right.beginDrag()
      right.dragTo({ x: 1439, y: 430 })
      const docked = await right.endDrag({ x: 1439, y: 430 })
      assert.equal(docked.docked, 'right', `right edge, grab ${grabX}`)
      const bounds = lastBounds.get(right)
      assert.ok(bounds)
      assert.equal(bounds.x + bounds.width, 1440)

      const left = placement(displays, 1000, 400)
      left.press({ x: 1000 + grabX, y: 430 })
      left.beginDrag()
      left.dragTo({ x: 0, y: 430 })
      const leftDocked = await left.endDrag({ x: 0, y: 430 })
      assert.equal(leftDocked.docked, 'left', `left edge, grab ${grabX}`)
    }
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

  it('docks a ball that the drag pushed past the left edge of the primary display', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 20, 400)
    placed.press({ x: 30, y: 430 })
    placed.beginDrag()
    // The grab is (10, 30); a cursor at x = 4 puts the ball origin at x = -6.
    placed.dragTo({ x: 4, y: 430 })
    const state = await placed.endDrag({ x: 4, y: 430 })
    assert.equal(state.docked, 'left')
  })

  it('moves the ball by cursor minus the grab recorded at press', () => {
    const displays = [pair(0, 0, 1920, 1080)]
    const placed = placement(displays, 1600, 500)
    placed.press({ x: 1620, y: 530 })
    placed.beginDrag()
    placed.dragTo({ x: 920, y: 330 })
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    assert.equal(bounds.x + CHROME_INSET, 900)
    assert.equal(bounds.y + CHROME_INSET, 300)
  })
})

/**
 * Chromium's DIP conversion ceils sizes, and a scaled window is kept inside the
 * monitor. `enclose` is that ceil round-trip: 96 DIP becomes 97 at 120% and
 * stays 96 at 150%. Either way the window's right edge cannot pass the screen,
 * so the ball's read-back sits a chrome-width short of the edge.
 */
describe('docking on a scaled Windows display', () => {
  for (const [scale, width] of [[1.2, 1600], [1.5, 1280]] as const) {
    for (const side of ['right', 'left'] as const) {
      it(`docks on the ${side} at ${scale} even though the window reads back inside the screen`, async () => {
        const displays = [pair(0, 0, width, 900)]
        const placed = scaledPlacement(displays, scale, 400, 400)
        placed.press({ x: 430, y: 430 })
        placed.beginDrag()
        const cursorX = side === 'right' ? width - 1 : 0
        placed.dragTo({ x: cursorX, y: 430 })
        const state = await placed.endDrag({ x: cursorX, y: 430 })
        assert.equal(state.docked, side)
        assert.ok((lastBounds.get(placed)?.width ?? 0) < 200, 'release must not open the panel')
      })
    }
  }
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

describe('release layout', () => {
  it('reports the panel direction an open panel took when it re-anchors on release', async () => {
    const displays = [pair(0, 0, 1920, 1080)]
    // Opened from the right half, so the panel grows left.
    const placed = placement(displays, 1500, 400)
    assert.equal(placed.setExpanded(true).horizontal, 'left')
    // A running agent keeps the panel open while the ball is carried past the screen midline.
    placed.press({ x: 1530, y: 430 })
    placed.beginDrag()
    placed.dragTo({ x: 730, y: 430 }, false)
    const released = await placed.endDrag({ x: 730, y: 430 }, false)
    assert.equal(released.expanded, true)
    assert.equal(released.horizontal, 'right')
    const bounds = lastBounds.get(placed)
    assert.ok(bounds)
    // The window and the reported direction must agree on where the ball is.
    assert.deepEqual(ballOriginFromWindow(bounds, released), { x: 700, y: 400 })
  })

  it('grabs a press during the slide-off where the ball is drawn, not at its docked pose', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1368, 400)
    placed.move(1368, 400)
    const docking = placed.clamp()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const mid = lastBounds.get(placed)
    assert.ok(mid)
    const drawnAt = mid.x + CHROME_INSET
    assert.ok(drawnAt > 1368 && drawnAt < 1442, `still mid-slide at ${drawnAt}`)

    placed.press({ x: drawnAt + 30, y: 430 })
    placed.beginDrag()
    placed.dragTo({ x: drawnAt - 70, y: 430 })
    // The ball must move by exactly the cursor's travel from where it was drawn.
    assert.equal(lastBounds.get(placed)?.x, drawnAt - 70 - 30 - CHROME_INSET)
    const outcome = await docking
    assert.equal(outcome.docked, undefined)
  })

  it('keeps the ball whole when a taken slide-off is dragged back into the edge zone', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1368, 400)
    placed.move(1368, 400)
    const docking = placed.clamp()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const drawnAt = (lastBounds.get(placed)?.x ?? 0) + CHROME_INSET
    placed.press({ x: drawnAt + 30, y: 430 })
    placed.beginDrag()
    // The ball's origin lands at x = 1416, inside the zone where a docked tab would be kept.
    placed.dragTo({ x: 1446, y: 430 })
    assert.equal(lastBounds.get(placed)?.width, BALL_WINDOW_SIZE)
    await docking
  })

  it('stops an unfinished slide-off when the panel opens, so the slide cannot overwrite it', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const placed = placement(displays, 1368, 400)
    placed.move(1368, 400)
    const docking = placed.clamp()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const opened = placed.setExpanded(true)
    assert.equal(opened.expanded, true)
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.equal(lastBounds.get(placed)?.width, PANEL_WINDOW_SIZE.width)
    const outcome = await docking
    assert.equal(outcome.expanded, true)
  })
})

const lastBounds = new WeakMap<FloatingPlacement, Rect>()

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

/** DIP size after Chromium's enclosing-rect round trip through device pixels. */
function enclose(dip: number, scale: number): number {
  const physical = Math.ceil(dip * scale - 1e-9)
  return Math.ceil(physical / scale - 1e-9)
}

/**
 * A window whose applied bounds are what Windows gives back above 100% scale:
 * the size is ceiled, and the rectangle is pulled back inside the display.
 */
function scaledPlacement(
  displays: { bounds: Rect; workArea: Rect }[],
  scale: number,
  x: number,
  y: number,
): FloatingPlacement {
  const screen = displays[0]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  let bounds: Rect = {
    x: x - CHROME_INSET,
    y: y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  const placed = new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) {
      const width = enclose(next.width, scale)
      const height = enclose(next.height, scale)
      const minX = screen.x
      const maxX = Math.max(minX, screen.x + screen.width - width)
      const minY = screen.y
      const maxY = Math.max(minY, screen.y + screen.height - height)
      bounds = {
        x: Math.min(Math.max(next.x, minX), maxX),
        y: Math.min(Math.max(next.y, minY), maxY),
        width,
        height,
      }
      lastBounds.set(placed, { ...bounds })
    },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
  return placed
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
