import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALL_WINDOW_SIZE,
  CHROME_INSET,
  FloatingPlacement,
  PANEL_WINDOW_SIZE,
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

describe('expanding during a dock slide', () => {
  it('keeps the bounds setExpanded chose instead of letting the slide overwrite them', async () => {
    const displays = [pair(0, 0, 1440, 900)]
    const { placed, read } = tracked(displays, 1388, 400)
    placed.move(1388, 400)
    // clamp() starts the 250ms slide towards the edge. Opening the panel has to win over it,
    // otherwise the animation keeps writing the off-screen ball rect and the ball is lost.
    const docking = placed.clamp()
    await new Promise((resolve) => setTimeout(resolve, 40))

    const state = placed.setExpanded(true)
    const opened = read()
    assert.equal(state.expanded, true)
    assert.equal(opened.width, PANEL_WINDOW_SIZE.width)
    assert.equal(opened.height, PANEL_WINDOW_SIZE.height)

    await docking
    assert.deepEqual(read(), opened)
    assert.notDeepEqual(read(), { ...opened, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE })
  })
})

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function tracked(
  displays: { bounds: Rect; workArea: Rect }[],
  x: number,
  y: number,
): { placed: FloatingPlacement; read: () => Rect } {
  let bounds: Rect = {
    x: x - CHROME_INSET,
    y: y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  return {
    placed: new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next) { bounds = { ...next } },
    }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds)),
    read: () => ({ ...bounds }),
  }
}

function placement(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number): FloatingPlacement {
  return tracked(displays, x, y).placed
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
