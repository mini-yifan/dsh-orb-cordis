import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeRawNode, picturePadding } from '../src/vision.ts'

// Measured on this machine: a QQ window of 1470x846 points at 2x captures
// 3076x1828, i.e. 68 physical pixels of drop shadow on every side.
const bounds = { x: 0, y: 33, width: 1470, height: 846 }

test('the shadow padding is measured from the raster and bounds', () => {
  // 3076 - 1470*2 = 136, halved = 68 physical pixels per side.
  assert.deepEqual(picturePadding(3076, 1828, bounds, 2), { x: 68, y: 68 })
})

test('a borderless raster reports no padding', () => {
  // An Electron window measured 1000x1000 for 500x500 points at 2x.
  assert.deepEqual(picturePadding(1000, 1000, { width: 500, height: 500 }, 2), { x: 0, y: 0 })
})

test('padding never goes negative when the raster is smaller than the window', () => {
  assert.deepEqual(picturePadding(900, 800, { width: 500, height: 500 }, 2), { x: 0, y: 0 })
})

test('a CLI tree node becomes a protocol node, ref and actions intact', () => {
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

test('a window-id read keeps nesting and drops levels past the depth limit', () => {
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

test('an unknown node still gets a role so the tree never has holes', () => {
  assert.equal(normalizeRawNode({}, 2).role, 'element')
})
