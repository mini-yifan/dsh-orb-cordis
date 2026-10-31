import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVATION_FRAME_OUTSET,
  observationFramePlacement,
  pointInRect,
  selectionToolbarBounds,

  selectionToolbarMenuLayout,
  SELECTION_TOOLBAR_SIZE,
} from '../src/overlay-geometry.ts'

const work = { x: 0, y: 0, width: 1000, height: 800 }

describe('overlay geometry', () => {
  it('centres the toolbar under a selection rectangle and clamps it to the work area', () => {
    const placed = selectionToolbarBounds({ x: 440, y: 200, width: 120, height: 20 }, SELECTION_TOOLBAR_SIZE, work)
    assert.deepEqual(placed, {
      x: 360,
      y: 228,
      width: 280,
      height: 46,
    })
    const edge = selectionToolbarBounds({ x: 900, y: 40, width: 90, height: 20 }, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(edge.x + edge.width <= work.width, true)
    assert.equal(edge.x, 720)
    // A bare point behaves like an empty rectangle: the bar hangs just below it.
    assert.deepEqual(selectionToolbarBounds({ x: 100, y: 200 }, SELECTION_TOOLBAR_SIZE, work), {
      x: 0,
      y: 208,
      width: 280,
      height: 46,
    })
  })

  it('flips above the selection rather than covering it', () => {
    // A word low on the screen: 8px below the rectangle would leave the work area.
    const rect = { x: 480, y: 760, width: 40, height: 18 }
    const placed = selectionToolbarBounds(rect, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(placed.y + placed.height <= rect.y, true, 'the bar sits entirely above the word')
    assert.equal(placed.x + placed.width / 2, rect.x + rect.width / 2)
  })

  it('opens the language menu sideways, fully inside the window, when no vertical room is left', () => {
    // A selection near the bottom: no room below for the menu, and the bar sits under the text
    // so unfolding upward would cover it.
    const selection = { x: 480, y: 720, width: 40, height: 20 }
    const bar = selectionToolbarBounds(selection, SELECTION_TOOLBAR_SIZE, work)
    const menuSize = { width: 70, height: 108 }
    const layout = selectionToolbarMenuLayout(bar, menuSize, work, true)
    assert.equal(layout.side, 'right')

    // The whole menu fits inside the window — this is the assertion the earlier version was
    // missing, and why a menu that rendered entirely outside the window still passed.
    const menu = layout.menu
    assert.ok(menu !== null)
    assert.equal(menu.left >= 0, true, 'the menu starts inside the window')
    assert.equal(menu.left + menuSize.width <= layout.window.width, true, 'and ends inside it')
    assert.equal(menu.top >= 0 && menu.top + menuSize.height <= layout.window.height, true)

    // The bar keeps its exact screen position, so it cannot creep over the selection.
    assert.equal(layout.window.y + layout.bar.top, bar.y)
    assert.equal(layout.window.x + layout.bar.left, bar.x)
    // And nothing leaves the work area.
    assert.equal(layout.window.x >= work.x && layout.window.x + layout.window.width <= work.x + work.width, true)
    assert.equal(layout.window.y >= work.y && layout.window.y + layout.window.height <= work.y + work.height, true)
  })

  it('picks the side that has room when the bar hugs a screen edge', () => {
    // A selection at the very end of a line: no room to the right at all.
    const bar = { x: work.width - 100, y: 700 }
    const layout = selectionToolbarMenuLayout(bar, { width: 70, height: 108 }, work, true)
    assert.equal(layout.side, 'left', 'the roomier side wins')
    assert.ok(layout.menu !== null)
    assert.equal(layout.menu.left, 0)
    assert.equal(layout.menu.left + 70 <= layout.window.width, true, 'the menu fits inside the window')
    // The bar keeps its screen position even though the window grew to the left of it.
    assert.equal(layout.window.x + layout.bar.left, bar.x)
    assert.equal(layout.window.x >= work.x, true, 'and the window does not leave the screen')
  })

  it('opens the language menu upward when the bar is above the selection', () => {
    const selection = { x: 480, y: 760, width: 40, height: 18 }
    const bar = selectionToolbarBounds(selection, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(bar.y + bar.height <= selection.y, true, 'the bar is above the text here')
    const layout = selectionToolbarMenuLayout(bar, { width: 70, height: 108 }, work, false)
    assert.equal(layout.side, 'above')
    assert.equal(layout.window.y >= work.y, true)
    assert.equal(layout.window.y + layout.window.height <= work.y + work.height, true)
  })

  it('keeps an ordinary menu below the bar without growing sideways', () => {
    const layout = selectionToolbarMenuLayout({ x: 20, y: 40 }, { width: 70, height: 108 }, work, true)
    assert.equal(layout.side, 'below')
    assert.equal(layout.window.y, 40)
    assert.equal(layout.window.width, SELECTION_TOOLBAR_SIZE.width)
    assert.ok(layout.menu !== null)
    assert.equal(layout.menu.top, SELECTION_TOOLBAR_SIZE.height)
  })

  it('keeps the observation hole on the rectangle and clips a flush edge', () => {
    assert.equal(OBSERVATION_FRAME_OUTSET, 36)
    const placed = observationFramePlacement({ x: 100, y: 80, width: 200, height: 150 }, work)
    assert.deepEqual(placed.bounds, { x: 64, y: 44, width: 272, height: 222 })
    assert.deepEqual(placed.glow, { top: 28, right: 28, bottom: 28, left: 28 })
    assert.deepEqual(placed.stroke, { top: 8, right: 8, bottom: 8, left: 8 })
    const clipped = observationFramePlacement({ x: 0, y: 10, width: 40, height: 40 }, work)
    assert.equal(clipped.bounds.x, 0)
    assert.equal(clipped.glow.left, 0)
    assert.equal(clipped.stroke.left, 8)
    assert.equal(pointInRect({ x: 64, y: 44 }, placed.bounds), true)
    assert.equal(pointInRect({ x: 64 + 272, y: 44 }, placed.bounds), false)
  })
})
