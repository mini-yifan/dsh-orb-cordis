import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_WINDOW_SIZE, FloatingPlacement, type Rect } from '../src/geometry.ts'

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
  // The free window is one fixed size now, with the ball at BALL_ANCHOR. Straddle the
  // anchor here so the window really is centred on (x, y), which is what `nearest`
  // and the seam check below are reading.
  let bounds: Rect = {
    x: x - FIXED_WINDOW_SIZE.width / 2,
    y: y - FIXED_WINDOW_SIZE.height / 2,
    width: FIXED_WINDOW_SIZE.width,
    height: FIXED_WINDOW_SIZE.height,
  }
  return new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next } },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
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
