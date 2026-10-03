import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALL_ANCHOR,
  BALL_SIZE,
  CHROME_INSET,
  FIXED_WINDOW_SIZE,
  PANEL_SIZE,
  ballOriginFromWindow,
  type Direction,
  type Rect,
} from '../src/geometry.ts'
import { ballRectInWindow, decideHover, panelRectInWindow, type HoverState } from '../src/hover.ts'

/**
 * The OS cursor, polled against the helper's own picture of the window.
 *
 * The window is one fixed FIXED_WINDOW_SIZE rectangle, so the page can never see the
 * cursor leave the ball and `pointerleave` never fires. The main process has to answer
 * hover itself from the cursor and the geometry it owns; these are those rectangles and
 * decisions, kept pure so all four directions and the docked tab are testable.
 *
 * Under the fixed-origin model the BALL is direction-independent (it always sits at
 * `BALL_ANCHOR`) and the PANEL is what moves. The old model was the exact inverse, so a
 * test written against it passes while the poll aims at the wrong rectangle.
 */

/** Where the window sits while these run; deliberately not at the origin. */
const WINDOW: Rect = { x: 1000, y: 220, width: FIXED_WINDOW_SIZE.width, height: FIXED_WINDOW_SIZE.height }

const DIRECTIONS: readonly Direction[] = [
  { horizontal: 'right', vertical: 'down' },
  { horizontal: 'right', vertical: 'up' },
  { horizontal: 'left', vertical: 'down' },
  { horizontal: 'left', vertical: 'up' },
]

function state(overrides: Partial<HoverState> = {}): HoverState {
  return {
    cursor: { x: 0, y: 0 },
    window: { ...WINDOW },
    direction: DIRECTIONS[0],
    expanded: false,
    docked: false,
    dragging: false,
    ...overrides,
  }
}

function ballCenter(next: HoverState): { x: number; y: number } {
  const ball = ballRectInWindow(next)
  return { x: ball.x + BALL_SIZE / 2, y: ball.y + BALL_SIZE / 2 }
}

describe('the ball rectangle the cursor is tested against', () => {
  it('is the same screen rectangle in all four directions', () => {
    const rects = DIRECTIONS.map((direction) => ballRectInWindow(state({ direction })))
    for (const rect of rects) {
      assert.deepEqual(rect, rects[0], 'the ball rectangle varied with the direction')
    }
    // And it is the anchor inside the window, in screen units.
    assert.deepEqual(rects[0], {
      x: WINDOW.x + BALL_ANCHOR.x,
      y: WINDOW.y + BALL_ANCHOR.y,
      width: BALL_SIZE,
      height: BALL_SIZE,
    })
    // geometry.ts recovers the same screen origin from the window alone, so the poll
    // and the page cannot disagree about where the ball is.
    const origin = ballOriginFromWindow(WINDOW)
    assert.deepEqual({ x: rects[0].x, y: rects[0].y }, origin)
  })

  for (const direction of DIRECTIONS) {
    const name = `${direction.horizontal}+${direction.vertical}`

    it(`keeps the ball on the same screen pixel when the panel opens in ${name}`, () => {
      const collapsed = state({ direction })
      const expanded = state({ direction, expanded: true })
      assert.deepEqual(ballRectInWindow(expanded), ballRectInWindow(collapsed))
    })

    it(`moves only the panel in ${name}`, () => {
      // The panel is what follows the direction, and it abuts the ball on the side it
      // opens towards, in window coordinates.
      const panel = panelRectInWindow(state({ direction }))
      const ball = ballRectInWindow(state({ direction }))
      const relative = { x: panel.x - WINDOW.x, y: panel.y - WINDOW.y }
      assert.equal(relative.x, direction.horizontal === 'left' ? CHROME_INSET : BALL_ANCHOR.x)
      assert.equal(relative.y, direction.vertical === 'up' ? CHROME_INSET : BALL_ANCHOR.y)
      assert.equal(panel.width, PANEL_SIZE.width)
      assert.equal(panel.height, PANEL_SIZE.height)
      if (direction.horizontal === 'left') {
        assert.equal(panel.x + panel.width, ball.x + BALL_SIZE)
      } else {
        assert.equal(panel.x, ball.x)
      }
      if (direction.vertical === 'up') {
        assert.equal(panel.y + panel.height, ball.y + BALL_SIZE)
      } else {
        assert.equal(panel.y, ball.y)
      }
    })
  }

  it('answers with the whole tab rectangle while docked', () => {
    // A docked window is 34px of tab, not a panel with a corner in it: the ball origin
    // follows the tab, so the tab is what the cursor is tested against.
    const tab: Rect = { x: 0, y: 400, width: 34, height: 88 }
    assert.deepEqual(ballRectInWindow(state({ window: tab, docked: true })), tab)
  })
})

describe('a cursor on the ball asks for the panel', () => {
  it('requests an expand on a collapsed ball', () => {
    const next = state()
    assert.deepEqual(decideHover({ ...next, cursor: ballCenter(next) }), { request: 'expand', interactive: true })
  })

  it('requests nothing when the panel is already open', () => {
    const next = state({ expanded: true })
    assert.deepEqual(decideHover({ ...next, cursor: ballCenter(next) }), { request: undefined, interactive: true })
  })

  it('asks for the leave one pixel off the ball', () => {
    // This is the `pointerleave` of a window that is always full-sized, so it has to
    // arrive while the panel is already folded too: the suppression a dock slide leaves
    // behind is cleared by a leave, and nothing else in such a window would clear it.
    const next = state()
    const ball = ballRectInWindow(next)
    const off = { x: ball.x - 1, y: ball.y + BALL_SIZE / 2 }
    assert.deepEqual(decideHover({ ...next, cursor: off }), { request: 'collapse', interactive: false })
  })

  it('accepts the edges of the ball itself', () => {
    const next = state()
    const ball = ballRectInWindow(next)
    for (const cursor of [
      { x: ball.x, y: ball.y },
      { x: ball.x + BALL_SIZE, y: ball.y + BALL_SIZE },
    ]) {
      assert.equal(decideHover({ ...next, cursor }).interactive, true)
    }
  })
})

describe('a cursor off the ball and the panel asks for the collapse', () => {
  it('requests a collapse from the chrome margin of the open panel', () => {
    // Still inside the window, which is exactly why the page cannot tell: the pointer
    // never left the window, only the ball.
    const next = state({ expanded: true })
    const cursor = { x: WINDOW.x + 2, y: WINDOW.y + 2 }
    assert.deepEqual(decideHover({ ...next, cursor }), { request: 'collapse', interactive: true })
  })

  it('keeps the panel for a cursor inside it', () => {
    const next = state({ expanded: true })
    const panel = panelRectInWindow(next)
    const cursor = { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 }
    assert.deepEqual(decideHover({ ...next, cursor }), { request: undefined, interactive: true })
  })

  it('repeats the same leave while collapsed off the ball', () => {
    // Steady state: the helper sends this once and then stops, because the answer stops
    // changing. The renderer's collapse is already a no-op there.
    const next = state()
    const cursor = { x: WINDOW.x + 200, y: WINDOW.y + 200 }
    assert.deepEqual(decideHover({ ...next, cursor }), { request: 'collapse', interactive: false })
    assert.deepEqual(decideHover({ ...next, cursor }), decideHover({ ...next, cursor }))
  })

  it('is stable: the same cursor and window always give the same answer', () => {
    const next = state({ expanded: true })
    const cursor = { x: WINDOW.x + 300, y: WINDOW.y + 400 }
    assert.deepEqual(decideHover({ ...next, cursor }), decideHover({ ...next, cursor }))
  })

  it('walks one hover from the ball out to the desktop', () => {
    // The whole cycle the poll has to drive, in order: open on the ball, hold while the
    // pointer stays on the panel, close once it is off both.
    const collapsed = state()
    const ball = ballRectInWindow(collapsed)
    const onBall = { x: ball.x + BALL_SIZE / 2, y: ball.y + BALL_SIZE / 2 }
    assert.equal(decideHover({ ...collapsed, cursor: onBall }).request, 'expand')

    const open = state({ expanded: true })
    const panel = panelRectInWindow(open)
    // Chosen away from the ball's own corner, which the panel overlaps while open.
    const onPanel = { x: panel.x + panel.width - 20, y: panel.y + 120 }
    assert.equal(decideHover({ ...open, cursor: onPanel }).request, undefined)
    assert.equal(decideHover({ ...open, cursor: onPanel }).interactive, true)

    // A cursor far outside the window still leaves the window interactive while the panel
    // is open: upstream kept the whole panel window interactive, and a click here lands
    // outside the window anyway.
    const away = { x: WINDOW.x - 500, y: WINDOW.y - 500 }
    assert.deepEqual(decideHover({ ...open, cursor: away }), { request: 'collapse', interactive: true })
  })
})

describe('the docked tab', () => {
  it('stays interactive and never asks the page to expand', () => {
    // Hovering a docked ball means the slide back in, which the renderer runs from the
    // pointer events the 34px window really delivers. The poll must not race it.
    const tab: Rect = { x: 0, y: 400, width: 34, height: 88 }
    const next = state({ window: tab, docked: true, cursor: { x: 10, y: 440 } })
    assert.deepEqual(decideHover(next), { request: undefined, interactive: true })
    assert.deepEqual(decideHover({ ...next, cursor: { x: 900, y: 900 } }), { request: undefined, interactive: true })
  })
})

describe('a drag owns the window', () => {
  it('stays interactive and asks for nothing, wherever the cursor is', () => {
    // The page moves the window through the same async channel this poll reads, so the
    // rectangle is one round-trip behind a fast drag. Testing it against the cursor
    // would turn the window click-through mid-drag and drop the ball out of the hand.
    const onBall = { ...ballCenter(state()), }
    assert.deepEqual(decideHover({ ...state(), cursor: onBall, dragging: true }), {
      request: undefined,
      interactive: true,
    })
    assert.deepEqual(decideHover({ ...state({ expanded: true }), cursor: onBall, dragging: true }), {
      request: undefined,
      interactive: true,
    })
    // Even a cursor far off the window stays interactive while the page holds the ball.
    assert.deepEqual(decideHover({ ...state(), cursor: { x: 0, y: 0 }, dragging: true }), {
      request: undefined,
      interactive: true,
    })
  })

  it('is not asked to expand or collapse while dragging', () => {
    const next = state({ dragging: true, cursor: ballCenter(state()) })
    assert.equal(decideHover(next).request, undefined)
  })
})

describe('interactivity follows the ball, not the window', () => {
  it('drops it for a resting cursor in the transparent chrome', () => {
    const next = state()
    assert.equal(decideHover({ ...next, cursor: { x: WINDOW.x + 300, y: WINDOW.y + 300 } }).interactive, false)
  })

  it('keeps the whole window interactive while the panel is open', () => {
    // The cursor has to be able to cross the margin around the ball and the panel
    // without falling through to the desktop, and a cursor inside the window is one the
    // renderer can still resolve.
    const next = state({ expanded: true })
    for (const cursor of [
      { x: WINDOW.x + 1, y: WINDOW.y + 1 },
      { x: WINDOW.x + WINDOW.width - 1, y: WINDOW.y + WINDOW.height - 1 },
      { x: WINDOW.x + WINDOW.width + 40, y: WINDOW.y + WINDOW.height + 40 },
    ]) {
      assert.equal(decideHover({ ...next, cursor }).interactive, true)
    }
  })
})

describe('the poll compares the cursor in the same space as the rectangles', () => {
  it('takes a screen-space cursor, not a window-relative one', () => {
    // Regression: `pollCursor` used to subtract the window origin from the cursor
    // while `ballRectInWindow`/`panelRectInWindow` already return SCREEN rectangles
    // (they add `bounds.x`/`bounds.y` back). The two then differed by the whole
    // window origin, so a hover could never be detected and the panel never opened.
    // A window parked away from (0,0) is what makes that mistake visible.
    const next = state({ direction: { horizontal: 'right', vertical: 'down' } })
    const ball = ballRectInWindow(next)
    const centre = { x: ball.x + BALL_SIZE / 2, y: ball.y + BALL_SIZE / 2 }
    // The rectangles live at WINDOW.x/WINDOW.y, far from the origin.
    assert.ok(ball.x >= WINDOW.x, 'the ball rectangle is a screen rectangle')
    assert.deepEqual(decideHover({ ...next, cursor: centre }), { request: 'expand', interactive: true })
    // The window-relative form of the same physical point must NOT be accepted.
    const relative = { x: centre.x - WINDOW.x, y: centre.y - WINDOW.y }
    assert.equal(decideHover({ ...next, cursor: relative }).interactive, false)
  })
})