import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderSnapshot } from '../src/render.ts'
import type { DesktopNode, SnapshotData } from '../src/protocol.ts'

function snapshot(tree: DesktopNode, overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    app: 'Notes',
    windowTitle: 'Untitled',
    snapshotId: 's1',
    refCount: 1,
    complete: true,
    tree,
    ...overrides,
  }
}

test('collapses anonymous single-child wrappers', () => {
  const rendered = renderSnapshot(snapshot({
    role: 'window',
    name: 'Untitled',
    children: [{
      role: 'group',
      actions: ['SetFocus'],
      children: [{ role: 'button', name: 'Save', ref: '@s1:e2', actions: ['Click'] }],
    }],
  }))
  assert.match(rendered.text, /button "Save"/)
  assert.doesNotMatch(rendered.text, /group/)
  assert.deepEqual(rendered.refs, ['@s1:e2'])
})

test('keeps a named container even with one child', () => {
  const rendered = renderSnapshot(snapshot({
    role: 'window',
    name: 'Untitled',
    children: [{
      role: 'toolbar',
      name: 'Format',
      children: [{ role: 'button', name: 'Bold', ref: '@s1:e3' }],
    }],
  }))
  assert.match(rendered.text, /toolbar "Format"/)
  assert.match(rendered.text, /button "Bold"/)
})

test('drops the SetFocus-only action hint but keeps real actions', () => {
  const rendered = renderSnapshot(snapshot({
    role: 'window',
    children: [{
      role: 'textfield',
      name: 'Title',
      ref: '@s1:e4',
      actions: ['SetFocus', 'SetValue'],
      value: 'Quarterly',
    }],
  }))
  assert.match(rendered.text, /\[SetValue\]/)
  assert.match(rendered.text, /= "Quarterly"/)
})

test('marks depth-cut children instead of silently dropping them', () => {
  const rendered = renderSnapshot(snapshot({
    role: 'window',
    children: [{ role: 'list', name: 'Files', ref: '@s1:e5', childrenCount: 42 }],
  }))
  assert.match(rendered.text, /42 hidden by depth/)
})

test('stops at the node budget and says so', () => {
  const many: DesktopNode[] = Array.from({ length: 50 }, (_, index) => ({
    role: 'button',
    name: `b${index}`,
    ref: `@s1:e${index}`,
  }))
  const rendered = renderSnapshot(snapshot({ role: 'window', children: many }), { maxNodes: 5 })
  assert.equal(rendered.truncated, true)
  assert.ok(rendered.nodes <= 5)
  assert.match(rendered.text, /node budget/)
})

test('reports an incomplete observation', () => {
  const rendered = renderSnapshot(snapshot({ role: 'window', name: 'W' }, { complete: false }))
  assert.match(rendered.text, /INCOMPLETE/)
  assert.match(rendered.text, /observation budget ran out/)
})

test('never emits a ref the model cannot address', () => {
  const rendered = renderSnapshot(snapshot({
    role: 'window',
    children: [{ role: 'button', name: 'OK', ref: '@s9:e1' }],
  }))
  for (const ref of rendered.refs) assert.match(ref, /^@[^:]+:e\d+$/)
})
test('a character cut says so, and does not send the model to max_nodes', () => {
  // The QQ run failed four times looking for an input box because the message
  // list exhausted a 6000-character budget and the note only mentioned nodes.
  const wide = {
    app: 'QQ', snapshotId: 's1', refCount: 40, complete: true,
    tree: {
      role: 'window',
      children: Array.from({ length: 40 }, (_, i) => ({
        role: 'button', name: `message ${String(i)} `.repeat(8), ref: `@s1:e${String(i)}`, actions: ['Click'],
      })),
    },
  }
  const rendered = renderSnapshot(wide, { maxNodes: 500, maxChars: 1200 })
  assert.equal(rendered.truncated, true)
  assert.match(rendered.text, /character budget, not by node count/)
  assert.match(rendered.text, /Raising max_nodes will not help/)
})

test('a node cut still points at max_nodes', () => {
  const many = {
    app: 'Notes', snapshotId: 's1', refCount: 80, complete: true,
    tree: {
      role: 'window',
      children: Array.from({ length: 80 }, (_, i) => ({
        role: 'button', name: `b${String(i)}`, ref: `@s1:e${String(i)}`, actions: ['Click'],
      })),
    },
  }
  const rendered = renderSnapshot(many, { maxNodes: 5, maxChars: 100_000 })
  assert.equal(rendered.truncated, true)
  assert.match(rendered.text, /node budget/)
  assert.doesNotMatch(rendered.text, /character budget, not by node count/)
})
