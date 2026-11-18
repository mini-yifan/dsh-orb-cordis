import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  IMAGE_TTL_MS,
  pictureBlocker,
  pictureGeometry,
  picturePadding,
  picturePointToScreen,
  pictureViewportMatches,
} from '../src/vision.ts'

// Measured on this machine: an QQ window of 1470x846 points at 2x captures
// 3076x1828, i.e. 68 physical pixels of drop shadow on every side.
const bounds = { x: 0, y: 33, width: 1470, height: 846 }
const captured = { width: 3076, height: 1828 }
const shadow = picturePadding(captured.width, captured.height, bounds, 2)

test('a picture is spent by one click', () => {
  assert.equal(pictureBlocker({ spent: true, capturedAt: Date.now() }, Date.now()), 'OBSERVATION_SPENT')
  assert.equal(pictureBlocker({ spent: false, capturedAt: Date.now() }, Date.now()), undefined)
})

test('a picture older than the TTL cannot be spent', () => {
  const now = 1_000_000
  assert.equal(pictureBlocker({ spent: false, capturedAt: now - IMAGE_TTL_MS }, now), undefined)
  assert.equal(pictureBlocker({ spent: false, capturedAt: now - IMAGE_TTL_MS - 1 }, now), 'OBSERVATION_STALE')
})

test('the shadow padding is measured from the raster and bounds', () => {
  // 3076 - 1470*2 = 136, halved = 68 physical pixels per side.
  assert.deepEqual(shadow, { x: 68, y: 68 })
})

test('a borderless raster reports no padding', () => {
  // An Electron window measured 1000x1000 for 500x500 points at 2x.
  assert.deepEqual(picturePadding(1000, 1000, { width: 500, height: 500 }, 2), { x: 0, y: 0 })
})

test('padding never goes negative when the raster is smaller than the window', () => {
  assert.deepEqual(picturePadding(900, 800, { width: 500, height: 500 }, 2), { x: 0, y: 0 })
})

test('the picture centre maps to the window centre', () => {
  const geometry = pictureGeometry({ width: captured.width, height: captured.height }, shadow, 2, bounds)
  const point = picturePointToScreen(geometry, captured.width / 2, captured.height / 2)
  assert.equal(point.x, bounds.x + bounds.width / 2)
  assert.equal(point.y, bounds.y + bounds.height / 2)
})

test('a downscaled picture still maps to the same screen point', () => {
  // The attachment store halved the raster; geometry must compensate.
  const full = pictureGeometry({ width: captured.width, height: captured.height }, shadow, 2, bounds)
  const half = pictureGeometry({ width: captured.width / 2, height: captured.height / 2 }, shadow, 2, bounds)
  const a = picturePointToScreen(full, captured.width / 2, captured.height / 2)
  const b = picturePointToScreen(half, captured.width / 4, captured.height / 4)
  assert.deepEqual(b, a)
})

test('the picture top-left lands one shadow outside the window', () => {
  const geometry = pictureGeometry({ width: captured.width, height: captured.height }, shadow, 2, bounds)
  // 68 physical px / 2 = 34 points of shadow above and left of the window.
  assert.deepEqual(picturePointToScreen(geometry, 0, 0), { x: bounds.x - 34, y: bounds.y - 34 })
})

test('a picture pixel maps without shadow on a 1x display', () => {
  const flatBounds = { x: -218, y: -1080, width: 1920, height: 1080 }
  const flatCaptured = { width: 1920, height: 1080 }
  const flatShadow = picturePadding(flatCaptured.width, flatCaptured.height, flatBounds, 1)
  assert.deepEqual(flatShadow, { x: 0, y: 0 })
  const geometry = pictureGeometry(flatCaptured, flatShadow, 1, flatBounds)
  assert.deepEqual(picturePointToScreen(geometry, 40, 60), { x: -178, y: -1020 })
})

test('a degenerate raster never divides by zero', () => {
  const geometry = pictureGeometry({ width: 0, height: 0 }, { x: 0, y: 0 }, 2, bounds)
  assert.equal(Number.isFinite(geometry.pointsPerPixelX), true)
  assert.equal(Number.isFinite(geometry.pointsPerPixelY), true)
})

test('the picture stays valid while the window keeps its rectangle', () => {
  const held = { originX: 0, originY: 33, boundsWidth: 1470, boundsHeight: 923 }
  assert.equal(pictureViewportMatches(held, { x: 0, y: 33, width: 1470, height: 923 }), true)
})

test('a moved, resized, closed, or bound-less window invalidates the picture', () => {
  const held = { originX: 0, originY: 33, boundsWidth: 1470, boundsHeight: 923 }
  assert.equal(pictureViewportMatches(held, { x: 4, y: 33, width: 1470, height: 923 }), false)
  assert.equal(pictureViewportMatches(held, { x: 0, y: 40, width: 1470, height: 923 }), false)
  assert.equal(pictureViewportMatches(held, { x: 0, y: 33, width: 1400, height: 923 }), false)
  assert.equal(pictureViewportMatches(held, { x: 0, y: 33, width: 1470, height: 800 }), false)
  assert.equal(pictureViewportMatches(held, undefined), false)
})

test('a CLI tree node becomes a protocol node, ref and actions intact', async () => {
  const { normalizeRawNode } = await import('../src/vision.ts')
  // The CLI prints snake_case and `ref_id`; the renderer and ref book expect
  // `ref` and `actions`. Getting this wrong yields a tree with no usable refs.
  const node = normalizeRawNode({
    role: 'button',
    name: '发送',
    ref_id: '@s1:e7',
    available_actions: ['Click'],
    states: ['enabled'],
    children_count: 2,
  }, 4)
  assert.equal(node.role, 'button')
  assert.equal(node.name, '发送')
  assert.equal(node.ref, '@s1:e7')
  assert.deepEqual(node.actions, ['Click'])
  assert.deepEqual(node.states, ['enabled'])
  assert.equal(node.childrenCount, 2)
})

test('a window-id read keeps nesting and drops levels past the depth limit', async () => {
  const { normalizeRawNode } = await import('../src/vision.ts')
  const raw = {
    role: 'window',
    children: [{ role: 'group', children: [{ role: 'button', name: 'ok', ref_id: '@s2:e1' }] }],
  }
  const kept = normalizeRawNode(raw, 4)
  assert.equal(kept.children?.[0]?.children?.[0]?.ref, '@s2:e1')
  // Depth 1 keeps only the first level; deeper children are cut, not flattened.
  const cut = normalizeRawNode(raw, 1)
  assert.equal(cut.children?.[0]?.children, undefined)
})

test('an unknown node still gets a role so the tree never has holes', async () => {
  const { normalizeRawNode } = await import('../src/vision.ts')
  assert.equal(normalizeRawNode({}, 2).role, 'element')
})
