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

    // Docking needs half the ball past the edge, so this has to be a real push.
    const outer = placement(displays, 3330, 400)
    outer.move(3330, 400)
    const docked = await outer.clamp()
    assert.equal(docked.docked, 'right')
  })
})

describe('dragging the ball', () => {
  const displays = [pair(0, 0, 1440, 900)]

  it('leaves a grazed edge undocked on release', async () => {
    const placed = placement(displays, 700, 400)
    placed.move(700, 400)
    assert.equal((await placed.clamp()).docked, undefined)
    // The ball's left edge is 20px past the screen; half of it is still on screen.
    placed.move(-20, 400)
    assert.equal((await placed.clamp()).docked, undefined, 'a graze is not a push off the screen')
  })

  it('docks once half the ball is past the edge', async () => {
    const placed = placement(displays, 700, 400)
    placed.move(700, 400)
    await placed.clamp()
    placed.move(-40, 400)
    assert.equal((await placed.clamp()).docked, 'left')
  })
})

describe('previewing an expansion', () => {
  it('reports the ball corner the page must move to before the window grows', () => {
    const display = pair(0, 0, 1440, 900)
    const box = windowStub(1200, 700)
    const placed = new FloatingPlacement(box.window, () => display, () => [display.bounds])
    const before = box.bounds()
    const preview = placed.previewExpand()
    assert.equal(preview.horizontal, 'left')
    assert.equal(preview.vertical, 'up')
    assert.deepEqual(box.bounds(), before, 'previewing must not resize the window')
  })

  it('agrees with the direction the expansion then applies', () => {
    const display = pair(0, 0, 1440, 900)
    const box = windowStub(140, 120)
    const placed = new FloatingPlacement(box.window, () => display, () => [display.bounds])
    const preview = placed.previewExpand()
    const applied = placed.setExpanded(true)
    assert.equal(applied.horizontal, preview.horizontal)
    assert.equal(applied.vertical, preview.vertical)
  })
})

describe('dragging a ball', () => {
  it('moves the window with a position-only request while the size is fixed', () => {
    const display = pair(0, 0, 1440, 900)
    const moves: [number, number][] = []
    let resizes = 0
    let bounds: Rect = { x: 688, y: 388, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { resizes += 1; bounds = { ...next }; moves.push([next.x, next.y]) },
    }, () => display, () => [display.bounds])

    placed.move(700, 400, false)
    placed.move(701, 401, false)
    assert.equal(moves.length, 2, 'each drag step moves the window')
    assert.equal(resizes, 2, 'the size is restated so it can never drift')
    assert.deepEqual(moves[1], [689, 389])
  })

  it('falls back to a full geometry change when the window cannot move alone', () => {
    const display = pair(0, 0, 1440, 900)
    const box = windowStub(700, 400)
    const placed = new FloatingPlacement(box.window, () => display, () => [display.bounds])
    const before = box.bounds()
    placed.move(720, 420, false)
    const after = box.bounds()
    assert.equal(after.width, before.width)
    assert.equal(after.height, before.height)
    assert.notDeepEqual([after.x, after.y], [before.x, before.y], 'the stub still follows the pointer')
  })
})

describe('recognising a collapsed window', () => {
  const display = pair(0, 0, 1440, 900)

  it('treats a rounded ball window as collapsed, not as an open panel', () => {
    // 96 * 2.25 = 216 physical pixels; the compositor rounds, so the window
    // reads back a pixel over and used to take the expanded code path.
    const moves: [number, number][] = []
    let bounds: Rect = { x: 758, y: 458, width: BALL_WINDOW_SIZE + 1, height: BALL_WINDOW_SIZE + 2 }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { bounds = { ...next }; moves.push([next.x, next.y]) },
    }, () => display, () => [display.bounds])

    placed.move(770, 470, false)
    // Collapsed: the window origin tracks the ball directly (origin - chrome).
    assert.deepEqual(moves[moves.length - 1], [770 - CHROME_INSET, 470 - CHROME_INSET])
  })

  it('still uses the panel corner offset for a genuinely open panel', () => {
    const moves: [number, number][] = []
    let bounds: Rect = { x: 700, y: 300, width: 344, height: 444 }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { bounds = { ...next }; moves.push([next.x, next.y]) },
    }, () => display, () => [display.bounds])

    placed.move(770, 470, false)
    const [x, y] = moves[moves.length - 1]
    assert.notEqual(x, 770 - CHROME_INSET, 'an open panel keeps the ball inside its own frame')
    assert.notEqual(y, 470 - CHROME_INSET)
  })
})

describe('relative drags', () => {
  const display = pair(0, 0, 1440, 900)

  it('applies a pointer delta to the window it actually has', () => {
    const moves: [number, number][] = []
    let bounds: Rect = { x: 700, y: 300, width: BALL_WINDOW_SIZE + 1, height: BALL_WINDOW_SIZE + 1 }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { bounds = { ...next }; moves.push([next.x, next.y]) },
    }, () => display, () => [display.bounds])

    // Ball origin is bounds + chrome. A delta of 30/40 must land 30/40 away.
    placed.moveBy(30, 40)
    assert.deepEqual(moves[moves.length - 1], [700 + 30, 300 + 40])
  })

  it('does not drift when the compositor rounds the geometry it reports back', () => {
    const display = pair(0, 0, 1440, 900)
    // The compositor reports whole pixels; the ball's true origin keeps its fraction.
    let truth = { x: 700, y: 400 }
    let last: Rect | undefined
    const placed = new FloatingPlacement({
      getBounds: () => ({
        x: Math.floor(truth.x - CHROME_INSET),
        y: Math.floor(truth.y - CHROME_INSET),
        width: BALL_WINDOW_SIZE,
        height: BALL_WINDOW_SIZE,
      }),
      setBounds(next: Rect) {
        truth = { x: next.x + CHROME_INSET, y: next.y + CHROME_INSET }
        last = { ...next }
      },
    }, () => display, () => [display.bounds])

    // 200 steps of -3.5 must move the ball exactly 700, not a rounded fraction less.
    for (let i = 0; i < 200; i += 1) placed.moveBy(-3.5, -2.5)
    assert.equal(last?.x, Math.round(700 - 700 - CHROME_INSET))
    assert.equal(last?.y, Math.round(400 - 500 - CHROME_INSET))
  })

  it('carries the same delta to the ball whether the panel is open or not', () => {
    const moves: [number, number][] = []
    let bounds: Rect = { x: 500, y: 200, width: 344, height: 444 }
    const placed = new FloatingPlacement({
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { bounds = { ...next }; moves.push([next.x, next.y]) },
    }, () => display, () => [display.bounds])

    placed.moveBy(10, 10)
    // The ball sits in a corner of an open panel, so the window lands one panel
    // offset in — and the ball itself still moves by exactly the delta.
    assert.deepEqual(moves[moves.length - 1], [500 + 10, 200 + 10])
    assert.equal(bounds.width, 344, 'a relative drag never resizes')
  })
})

/** A window stub whose bounds the test can read back. */
function windowStub(x: number, y: number) {
  let bounds: Rect = {
    x: x - CHROME_INSET,
    y: y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  return {
    bounds: () => ({ ...bounds }),
    window: {
      getBounds: () => ({ ...bounds }),
      setBounds(next: Rect) { bounds = { ...next } },
    },
  }
}

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
