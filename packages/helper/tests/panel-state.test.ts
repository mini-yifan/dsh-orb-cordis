import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canAutoCollapse, panelControlAction } from '../assets/panel-state.js'

const idle = { expanded: true, pinned: false, running: false, asking: false, dragging: false, pointerInside: false }

describe('floating panel view policy', () => {
  it('collapses an idle, unpinned panel only after the pointer leaves', () => {
    assert.equal(canAutoCollapse(idle), true)
    assert.equal(canAutoCollapse({ ...idle, pointerInside: true }), false)
    assert.equal(canAutoCollapse({ ...idle, expanded: false }), false)
  })

  it('keeps explicit pin, active tasks, questions and dragging open', () => {
    for (const key of ['pinned', 'running', 'asking', 'dragging']) {
      assert.equal(canAutoCollapse({ ...idle, [key]: true }), false, key)
    }
  })

  it('rechecks policy when a task starts or the pointer returns before collapse', () => {
    assert.equal(canAutoCollapse(idle), true)
    assert.equal(canAutoCollapse({ ...idle, running: true }), false)
    assert.equal(canAutoCollapse({ ...idle, pointerInside: true }), false)
  })

  it('restores idle collapse after task completion while preserving pin', () => {
    assert.equal(canAutoCollapse({ ...idle, running: false }), true)
    assert.equal(canAutoCollapse({ ...idle, pinned: true, running: false }), false)
  })

  it('keeps IME composition open while selecting a candidate outside the panel', () => {
    assert.equal(canAutoCollapse({ ...idle, composing: true }), false)
    assert.equal(canAutoCollapse({ ...idle, composing: false }), true)
  })

  it('shares one control between pin and minimize, including waiting for answers', () => {
    assert.equal(panelControlAction(idle), 'pin')
    assert.equal(panelControlAction({ ...idle, pinned: true }), 'pin')
    assert.equal(panelControlAction({ ...idle, running: true }), 'minimize')
    assert.equal(panelControlAction({ ...idle, asking: true }), 'minimize')
    assert.equal(panelControlAction({ ...idle, pinned: true, running: true }), 'minimize')
  })
})
