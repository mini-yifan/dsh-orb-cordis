import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAgentCloak,
  OVERLAY_GUARD_INPUT_APPLY_MS,
  scheduleCloakAck,
  type CloakWindow,
} from '../src/cloak.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface FakeWindow extends CloakWindow {
  destroyed: boolean
  protection: boolean | undefined
  ignoreMouse: boolean | undefined
  blurred: number
}

function fakeWindow(): FakeWindow {
  return {
    destroyed: false,
    protection: undefined,
    ignoreMouse: undefined,
    blurred: 0,
    isDestroyed() {
      return this.destroyed
    },
    setContentProtection(active: boolean) {
      this.protection = active
    },
    setIgnoreMouseEvents(active: boolean) {
      this.ignoreMouse = active
    },
    blur() {
      this.blurred += 1
    },
  }
}

describe('agent cloak', () => {
  it('keeps chrome captureable at rest and hides it during capture intervals', () => {
    const ball = fakeWindow()
    const toolbar = fakeWindow()
    const frame = fakeWindow()
    const cloak = createAgentCloak([
      { window: () => ball, resting: false },
      { window: () => toolbar, resting: false },
      { window: () => frame, resting: true },
    ], () => ball)

    cloak.begin('capture')
    assert.equal(ball.protection, true)
    assert.equal(toolbar.protection, true)
    assert.equal(frame.protection, true)
    assert.equal(ball.ignoreMouse, undefined)

    cloak.end('capture')
    assert.equal(ball.protection, false)
    assert.equal(toolbar.protection, false)
    assert.equal(frame.protection, true, 'resting window keeps its protection')
    assert.equal(ball.ignoreMouse, undefined)
  })

  it('turns the ball click-through and blurred for input intervals, then restores it', () => {
    const ball = fakeWindow()
    const frame = fakeWindow()
    const cloak = createAgentCloak([
      { window: () => ball, resting: false },
      { window: () => frame, resting: true },
    ], () => ball)

    cloak.begin('input')
    assert.equal(ball.ignoreMouse, true)
    assert.equal(ball.blurred, 1)
    assert.equal(ball.protection, true)

    cloak.end('input')
    assert.equal(ball.ignoreMouse, false)
    assert.equal(ball.protection, false)
    assert.equal(ball.blurred, 1, 'no refocus on restore')
  })

  it('refcounts overlapping intervals and clamps surplus ends', () => {
    const ball = fakeWindow()
    const cloak = createAgentCloak([{ window: () => ball, resting: false }], () => ball)

    cloak.begin('capture')
    cloak.begin('input')
    cloak.end('capture')
    assert.equal(ball.protection, true, 'input interval still holds the cloak')
    assert.equal(ball.ignoreMouse, true)

    cloak.end('input')
    assert.equal(ball.protection, false)
    assert.equal(ball.ignoreMouse, false)

    cloak.end('capture')
    cloak.end('capture')
    assert.equal(ball.protection, false)
    assert.equal(ball.ignoreMouse, false)
  })

  it('survives destroyed windows and a missing ball', () => {
    const ball = fakeWindow()
    const gone = fakeWindow()
    gone.destroyed = true
    const cloak = createAgentCloak([
      { window: () => gone, resting: false },
      { window: () => undefined, resting: false },
    ], () => ball)

    cloak.begin('capture')
    assert.equal(ball.protection, undefined, 'ball is click-through target only, not chrome here')
    cloak.end('capture')

    const lonely = createAgentCloak([{ window: () => ball, resting: false }])
    lonely.begin('input')
    assert.equal(ball.protection, true)
    assert.equal(ball.ignoreMouse, undefined, 'no click-through window wired')
    lonely.end('input')
    assert.equal(ball.protection, false)
  })

  it('reset drops every interval and restores resting chrome', () => {
    const ball = fakeWindow()
    const frame = fakeWindow()
    const cloak = createAgentCloak([
      { window: () => ball, resting: false },
      { window: () => frame, resting: true },
    ], () => ball)

    cloak.begin('capture')
    cloak.begin('input')
    cloak.reset()
    assert.equal(ball.protection, false)
    assert.equal(frame.protection, true)
    assert.equal(ball.ignoreMouse, false)
  })
})

describe('cloak ack scheduling', () => {
  it('acks capture intervals and input end immediately', () => {
    let count = 0
    const ack = () => { count += 1 }
    scheduleCloakAck(ack, 'capture', 'begin')
    scheduleCloakAck(ack, 'capture', 'end')
    scheduleCloakAck(ack, 'input', 'end')
    assert.equal(count, 3)
  })

  it('holds the input-begin ack until WindowServer hit-testing has committed', async () => {
    let acked = false
    scheduleCloakAck(() => { acked = true }, 'input', 'begin')
    assert.equal(acked, false, 'ack must not fire before the apply margin')
    await sleep(OVERLAY_GUARD_INPUT_APPLY_MS + 50)
    assert.equal(acked, true)
  })
})
