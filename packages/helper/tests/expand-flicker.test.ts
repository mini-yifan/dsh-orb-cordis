import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALL_ANCHOR,
  BALL_SIZE,
  CHROME_INSET,
  DOCK_HIT_WIDTH,
  FIXED_WINDOW_SIZE,
  FloatingPlacement,
  PANEL_SIZE,
  ballOriginFromWindow,
  defaultFloatingBallOrigin,
  expandDirection,
  initialExpandDirection,
  initialWindowBounds,
  type Direction,
  type Rect,
} from '../src/geometry.ts'

const WORK_AREA: Rect = { x: 0, y: 0, width: 1440, height: 900 }

/**
 * The anti-flicker regression: the window origin must not depend on the expand
 * direction, and must not move on expand, collapse or a repeated move.
 *
 * The old model swapped a 96x96 ball window for a 344x444 panel window anchored in a
 * corner, so `left`+`up` and `right`+`down` produced rectangles ~600px apart. Windows
 * `SetWindowPos` copies the previous client bitmap to a moved origin, so every such
 * move paints one stale frame - the flash the user saw. The window is now one fixed
 * 592x792 rectangle that parks the ball at BALL_ANCHOR in every direction; only the
 * panel moves, and it moves inside the window without moving the window.
 */
describe('the window origin never moves', () => {
  const directions: readonly Direction[] = [
    { horizontal: 'left', vertical: 'up' },
    { horizontal: 'right', vertical: 'up' },
    { horizontal: 'left', vertical: 'down' },
    { horizontal: 'right', vertical: 'down' },
  ]

  // One ball position per screen quadrant. `expandDirection` only picks which side the
  // panel opens on, which is a work-area fact, so each spot exercises a real direction.
  const spots = [
    { name: 'top right', x: 1340, y: 20 },
    { name: 'top left', x: 20, y: 20 },
    { name: 'bottom right', x: 1340, y: 800 },
    { name: 'bottom left', x: 20, y: 800 },
    { name: 'center', x: 680, y: 400 },
  ]

  for (const spot of spots) {
    it(`is identical in all four directions for a ball at ${spot.name}`, () => {
      const expected = { x: spot.x - BALL_ANCHOR.x, y: spot.y - BALL_ANCHOR.y }

      const seen = new Set<string>()
      for (const direction of directions) {
        const placed = placeBall(spot.x, spot.y, direction)
        const bounds = placed.bounds()
        assert.deepEqual(
          { x: bounds.x, y: bounds.y },
          expected,
          `${direction.horizontal}+${direction.vertical} placed the window elsewhere`,
        )
        assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
        assert.equal(bounds.height, FIXED_WINDOW_SIZE.height)
        seen.add(`${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
      }
      // The whole point: one rectangle, whichever way the panel grows.
      assert.equal(seen.size, 1, 'the window rectangle varied with the direction')
    })

    it(`does not move on expand, collapse or repeated move at ${spot.name}`, () => {
      const placed = placeBall(spot.x, spot.y)
      const collapsed = placed.bounds()

      const state = placed.placement.setExpanded(true)
      assert.deepEqual(placed.bounds(), collapsed, 'expand moved the window origin')

      placed.placement.setExpanded(false)
      assert.deepEqual(placed.bounds(), collapsed, 'collapse moved the window origin')

      // Re-asserting the same ball is what a real drag does on every pointermove.
      // A direction-dependent rect would jitter here as the cursor crossed a midline.
      for (let i = 0; i < 4; i += 1) placed.placement.move(spot.x, spot.y)
      assert.deepEqual(placed.bounds(), collapsed, 'a repeated move moved the window origin')

      const spot2 = ballOriginFromWindow(placed.bounds())
      assert.deepEqual(spot2, { x: spot.x, y: spot.y })
      assert.equal(state.expanded, true)
    })

    it(`keeps the window centred on the ball at ${spot.name}`, () => {
      const placed = placeBall(spot.x, spot.y)
      const bounds = placed.bounds()
      // 592/2 = 296 = BALL_ANCHOR.x + BALL_SIZE/2, and 792/2 = 396 likewise.
      assert.equal(bounds.x + FIXED_WINDOW_SIZE.width / 2, spot.x + BALL_SIZE / 2)
      assert.equal(bounds.y + FIXED_WINDOW_SIZE.height / 2, spot.y + BALL_SIZE / 2)
      assert.equal(FIXED_WINDOW_SIZE.width / 2, BALL_ANCHOR.x + BALL_SIZE / 2)
      assert.equal(FIXED_WINDOW_SIZE.height / 2, BALL_ANCHOR.y + BALL_SIZE / 2)
    })
  }

  it('parks the ball at BALL_ANCHOR in the window it is opened with', () => {
    const bounds = initialWindowBounds(WORK_AREA)
    assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
    assert.equal(bounds.height, FIXED_WINDOW_SIZE.height)
    assert.deepEqual(ballOriginFromWindow(bounds), defaultSpot())
  })
})

describe('the panel abuts the ball on the side it opens', () => {
  const directions: readonly Direction[] = [
    { horizontal: 'left', vertical: 'up' },
    { horizontal: 'right', vertical: 'up' },
    { horizontal: 'left', vertical: 'down' },
    { horizontal: 'right', vertical: 'down' },
  ]

  for (const direction of directions) {
    const name = `${direction.horizontal}+${direction.vertical}`

    it(`touches the ball with no gap and no overlap in ${name}`, () => {
      // The panel is placed relative to the ball, NOT at a window corner: the ball sits
      // at dead centre now, so a panel anchored to the window would land on top of it.
      const panel = panelRectInWindow(WORK_AREA, direction)
      const ball = ballBoxInWindow()

      // The ball sits at one corner of the panel and is drawn over it (#ball has
      // z-index 1), so "abuts" means the two edges COINCIDE: the panel must neither
      // stop short of the ball nor run past it, or the ball would float off the panel.
      if (direction.horizontal === 'left') {
        assert.equal(
          panel.x + panel.width,
          ball.x + BALL_SIZE,
          'the panel must end exactly on the ball right edge',
        )
        assert.equal(panel.x, CHROME_INSET, 'an opening-left panel starts at the chrome inset')
      } else {
        assert.equal(panel.x, ball.x, 'the panel must start exactly on the ball left edge')
        assert.equal(panel.x, BALL_ANCHOR.x)
      }

      if (direction.vertical === 'up') {
        assert.equal(
          panel.y + panel.height,
          ball.y + BALL_SIZE,
          'the panel must end exactly on the ball bottom edge',
        )
        assert.equal(panel.y, CHROME_INSET, 'an opening-up panel starts at the chrome inset')
      } else {
        assert.equal(panel.y, ball.y, 'the panel must start exactly on the ball top edge')
        assert.equal(panel.y, BALL_ANCHOR.y)
      }

      assert.equal(panel.width, PANEL_SIZE.width)
      assert.equal(panel.height, PANEL_SIZE.height)
    })
  }

  it('resolves the two offsets the CSS has to declare', () => {
    // The horizontal offset only ever takes these two values, and the vertical one only
    // these two: that is what makes "exactly one property per direction rule" checkable.
    const offsets = new Set<string>()
    for (const horizontal of ['left', 'right'] as const) {
      for (const vertical of ['up', 'down'] as const) {
        const panel = panelRectInWindow(WORK_AREA, { horizontal, vertical })
        offsets.add(`${panel.x - WORK_AREA.x},${panel.y - WORK_AREA.y}`)
      }
    }
    assert.deepEqual([...offsets].sort(), [
      `${CHROME_INSET},${CHROME_INSET}`,
      `${CHROME_INSET},${BALL_ANCHOR.y}`,
      `${BALL_ANCHOR.x},${CHROME_INSET}`,
      `${BALL_ANCHOR.x},${BALL_ANCHOR.y}`,
    ])
    // Anchor the constants the CSS hardcodes, so a geometry change cannot silently
    // leave floating.css declaring the old offsets.
    assert.equal(CHROME_INSET, 12)
    assert.equal(BALL_ANCHOR.x, 260)
    assert.equal(BALL_ANCHOR.y, 360)
  })
})

describe('a work area too short for the panel above the ball', () => {
  const short: Rect = { x: 0, y: 0, width: 1280, height: 600 }

  it('still opens the panel downward without moving the origin', () => {
    const direction = initialExpandDirection(short)
    assert.equal(direction.vertical, 'down')

    const placed = placeBallAt(short, defaultFloatingBallOrigin(short))
    const collapsed = placed.bounds()
    placed.placement.setExpanded(true)
    assert.deepEqual(placed.bounds(), collapsed, 'expand moved the window origin')
    placed.placement.setExpanded(false)
    assert.deepEqual(placed.bounds(), collapsed, 'collapse moved the window origin')
  })

  it('keeps the ball centred on a short work area too', () => {
    const spot = defaultFloatingBallOrigin(short)
    const placed = placeBallAt(short, spot)
    const bounds = placed.bounds()
    assert.equal(bounds.x + FIXED_WINDOW_SIZE.width / 2, spot.x + BALL_SIZE / 2)
    assert.equal(bounds.y + FIXED_WINDOW_SIZE.height / 2, spot.y + BALL_SIZE / 2)
  })
})

describe('a docked tab still narrows the window', () => {
  it('folds the window to the 34px tab after a dock', async () => {
    const placed = placeBall(-20, 400)
    const state = await placed.placement.clamp()
    assert.equal(state.docked, 'left')
    const tab = placed.bounds()
    assert.equal(tab.x, WORK_AREA.x)
    assert.equal(tab.width, DOCK_HIT_WIDTH)
  })

  it('restores the full window when a docked ball is unsnapped', async () => {
    const placed = placeBall(-20, 400)
    await placed.placement.clamp()
    await placed.placement.unsnap()
    const bounds = placed.bounds()
    assert.equal(bounds.width, FIXED_WINDOW_SIZE.width)
    assert.equal(bounds.height, FIXED_WINDOW_SIZE.height)
  })
})


/**
 * Where the panel sits inside the window, in the same space the CSS declares.
 *
 * Pixel coordinates would be useless here: a `--panel-left` is an offset from the window
 * origin, not a screen position. Uses the default resting ball so the numbers are stable.
 */
function panelRectInWindow(workArea: Rect, direction: Direction): Rect {
  const ball = defaultFloatingBallOrigin(workArea)
  return {
    x: direction.horizontal === 'left' ? CHROME_INSET : BALL_ANCHOR.x,
    y: direction.vertical === 'up' ? CHROME_INSET : BALL_ANCHOR.y,
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
  }
}

/** The ball's rectangle inside the window, in the same space as `panelRectInWindow`. */
function ballBoxInWindow(): Rect {
  return { x: BALL_ANCHOR.x, y: BALL_ANCHOR.y, width: BALL_SIZE, height: BALL_SIZE }
}

function defaultSpot(): { x: number; y: number } {
  return defaultFloatingBallOrigin(WORK_AREA)
}

function placeBall(x: number, y: number, direction?: Direction): Placed {
  return placeBallAt(WORK_AREA, { x, y }, direction)
}

interface Placed {
  placement: FloatingPlacement
  bounds: () => Rect
}

function placeBallAt(workArea: Rect, ball: { x: number; y: number }, direction?: Direction): Placed {
  let bounds: Rect = initialWindowBounds(workArea)
  const chosen = direction ?? expandDirection(ball, workArea)
  const placement = new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next } },
  }, () => ({ bounds: workArea, workArea }), () => [workArea], chosen)
  placement.move(ball.x, ball.y)
  return { placement, bounds: () => ({ ...bounds }) }
}