import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampRect,
  findLargestClosedRegion,
  moveRect,
  resizeRect,
  simplifyStroke,
} from '../src/lasso-geometry.ts'

describe('freehand lasso closure', () => {
  it('finds the largest self-intersection loop and returns its bounds', () => {
    // Draw a rectangle, then leave through its top edge and loop back: the
    // rectangle plus the little tail is the largest closed region.
    const stroke = [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 110 },
      { x: 10, y: 110 },
      { x: 10, y: 10 },
      { x: 60, y: 60 },
      { x: 60, y: -10 },
    ]
    const result = findLargestClosedRegion(stroke, { minAreaPx2: 100 })
    assert.ok(result)
    assert.equal(result.bounds.x, 10)
    assert.equal(result.bounds.width, 100)
    assert.ok(result.area > 8_000)
  })

  it('falls back to joining endpoints when the stroke almost closes', () => {
    const stroke = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
      { x: 12, y: 12 },
      { x: 14, y: 14 },
      { x: 16, y: 16 },
      { x: 18, y: 18 },
      { x: 15, y: 15 },
    ]
    const result = findLargestClosedRegion(stroke, { minAreaPx2: 100 })
    assert.ok(result)
    assert.ok(result.bounds.width > 70)
    assert.ok(result.bounds.height > 70)
  })

  it('rejects an open stroke that is too short to close', () => {
    const stroke = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 80, y: 0 },
      { x: 120, y: 0 },
      { x: 160, y: 0 },
      { x: 200, y: 0 },
      { x: 240, y: 0 },
      { x: 280, y: 0 },
    ]
    assert.equal(findLargestClosedRegion(stroke, { minAreaPx2: 100 }), undefined)
  })

  it('rejects a closed loop below the minimum area', () => {
    const stroke = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
      { x: 10, y: 10 },
    ]
    assert.equal(findLargestClosedRegion(stroke, { minAreaPx2: 4000 }), undefined)
  })

  it('thins points before finding the loop but keeps the last point', () => {
    const points = simplifyStroke([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ], 2)
    assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])
  })
})

describe('confirm frame geometry', () => {
  const display = { x: 0, y: 0, width: 1000, height: 800 }

  it('clamps a moved rect inside the display', () => {
    assert.deepEqual(
      moveRect({ x: 10, y: 10, width: 100, height: 80 }, 950, -30, display),
      { x: 900, y: 0, width: 100, height: 80 },
    )
  })

  it('resizes from a corner and keeps the opposite corner fixed', () => {
    assert.deepEqual(
      resizeRect({ x: 100, y: 100, width: 200, height: 150 }, 'se', 50, 30, display, 48),
      { x: 100, y: 100, width: 250, height: 180 },
    )
  })

  it('does not let a corner cross the minimum side', () => {
    const result = resizeRect({ x: 100, y: 100, width: 200, height: 150 }, 'nw', 500, 500, display, 48)
    assert.equal(result.width, 48)
    assert.equal(result.height, 48)
    assert.equal(result.x, 252)
    assert.equal(result.y, 202)
  })

  it('clamps a rect larger than the display', () => {
    assert.deepEqual(
      clampRect({ x: -50, y: -50, width: 2000, height: 2000 }, display),
      { x: 0, y: 0, width: 1000, height: 800 },
    )
  })
})
