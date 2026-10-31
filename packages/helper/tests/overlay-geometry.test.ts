import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVATION_FRAME_OUTSET,
  observationFramePlacement,
  pointInRect,
  selectionToolbarBounds,
  selectionToolbarMenuBounds,
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

  it('grows the language menu down, and up when it would leave the work area', () => {
    const below = selectionToolbarMenuBounds({ x: 20, y: 40 }, { width: 280, height: 120 }, work)
    assert.equal(below.y, 40)
    assert.equal(below.height, 120)
    const above = selectionToolbarMenuBounds({ x: 20, y: 760 }, { width: 280, height: 120 }, work)
    assert.equal(above.y < 760, true)
    assert.equal(above.y + above.height <= work.height, true)
  })

  it('does not unfold the language menu into the selection it was moved clear of', () => {
    // A bar under a low selection has no room below for the whole menu. Opening upward would
    // cover the words the toolbar was deliberately placed clear of, so the window stays
    // anchored on the bar and is clipped instead.
    const selection = { x: 480, y: 700, width: 40, height: 20 }
    const bar = selectionToolbarBounds(selection, SELECTION_TOOLBAR_SIZE, work)
    assert.equal(bar.y >= selection.y + selection.height, true, 'the bar is below the text')
    const menu = selectionToolbarMenuBounds(bar, { width: 280, height: 100 }, work, true)
    assert.equal(menu.y, bar.y, 'the window stays where the bar is')
    assert.equal(menu.y >= selection.y + selection.height, true, 'so the bar itself never covers the text')
    assert.equal(menu.y + menu.height <= work.y + work.height, true)
    assert.equal(menu.y + menu.height, work.y + work.height, 'the menu takes what room is left')
    // A bar above the text may open upward freely: there is nothing under it to cover.
    const up = selectionToolbarMenuBounds({ x: 20, y: 760 }, { width: 280, height: 120 }, work, false)
    assert.equal(up.y < 760, true)
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
