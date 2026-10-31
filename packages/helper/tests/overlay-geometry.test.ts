import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVATION_FRAME_OUTSET,
  observationFramePlacement,
  pointInRect,
  selectionToolbarBounds,
  selectionToolbarMenuBounds,
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

  it('opens the language menu sideways when neither vertical side has room', () => {
    // A selection near the bottom: no room below for the menu, and the bar sits under the
    // text so unfolding upward would cover it. The menu must still be fully usable.
    const selection = { x: 480, y: 720, width: 40, height: 20 }
    const bar = selectionToolbarBounds(selection, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(bar.y >= selection.y + selection.height, true, 'the bar is below the text')
    const layout = selectionToolbarMenuLayout(bar, { width: 280, height: 108 }, work, true)
    assert.equal(layout.side, 'right')
    // The whole menu fits: both language rows stay reachable instead of being clipped away.
    assert.equal(layout.height >= 108, true, 'the window is tall enough for the whole menu')
    assert.equal(layout.width >= 280, true, 'and wide enough')
    assert.equal(layout.y >= work.y && layout.y + layout.height <= work.y + work.height, true)
    // The window may grow upward to make that room, but the bar must not move with it.
    assert.equal(layout.y + layout.barOffsetY, bar.y, 'the bar stays exactly where it was')
    assert.equal(bar.y >= selection.y + selection.height, true, 'so it never creeps over the text')
  })

  it('opens the language menu upward when the bar is above the selection', () => {
    const selection = { x: 480, y: 760, width: 40, height: 18 }
    const bar = selectionToolbarBounds(selection, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(bar.y + bar.height <= selection.y, true, 'the bar is above the text here')
    const layout = selectionToolbarMenuLayout(bar, { width: 280, height: 108 }, work, false)
    assert.equal(layout.side, 'above')
    assert.equal(layout.y >= work.y, true)
    assert.equal(layout.height, 108, 'the menu keeps its full height')
  })

  it('keeps an ordinary menu below the bar without growing sideways', () => {
    const layout = selectionToolbarMenuLayout({ x: 20, y: 40 }, { width: 280, height: 120 }, work, true)
    assert.equal(layout.side, 'below')
    assert.equal(layout.y, 40)
    assert.equal(layout.height, 120)
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
