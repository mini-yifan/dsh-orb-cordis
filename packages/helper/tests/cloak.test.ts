import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOAK_TAIL_MS,
  createAgentCloak,
  cloakConceal,
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
  opacity: number | undefined
}

function fakeWindow(): FakeWindow {
  return {
    destroyed: false,
    protection: undefined,
    ignoreMouse: undefined,
    blurred: 0,
    opacity: undefined,
    isDestroyed() {
      return this.destroyed
    },
    setContentProtection(active: boolean) {
      this.protection = active
    },
    setIgnoreMouseEvents(active: boolean) {
      this.ignoreMouse = active
    },
    setOpacity(value: number) {
      this.opacity = value
    },
    blur() {
      this.blurred += 1
    },
  }
}

/** The Windows/macOS conceal strategy; the Linux one has its own suite below. */
function cloakFor(
  entries: Parameters<typeof createAgentCloak>[0],
  clickThroughWindow?: Parameters<typeof createAgentCloak>[1],
) {
  return createAgentCloak(entries, clickThroughWindow, 'content-protection')
}

describe('agent cloak', () => {
  it('keeps chrome captureable at rest and conceals it during capture intervals', async () => {
    const ball = fakeWindow()
    const toolbar = fakeWindow()
    const frame = fakeWindow()
    const cloak = cloakFor([
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
    // The tail hold keeps the chrome concealed across the gap between two
    // captures, so a turn does not blink once per tool call.
    assert.equal(ball.protection, true, 'the capture tail still holds the cloak')
    await sleep(CLOAK_TAIL_MS + 60)
    assert.equal(ball.protection, false)
    assert.equal(toolbar.protection, false)
    assert.equal(frame.protection, true, 'resting window keeps its protection')
    assert.equal(ball.ignoreMouse, undefined)
  })

  it('turns the ball click-through for input intervals without concealing it', () => {
    const ball = fakeWindow()
    const frame = fakeWindow()
    const cloak = cloakFor([
      { window: () => ball, resting: false },
      { window: () => frame, resting: true },
    ], () => ball)

    cloak.begin('input')
    assert.equal(ball.ignoreMouse, true)
    assert.equal(ball.blurred, 1)
    // Posted clicks land underneath through click-through alone; hiding the ball
    // as well made every typed tool call flash it off screen and back.
    assert.equal(ball.protection, undefined, 'input does not conceal')

    cloak.end('input')
    assert.equal(ball.ignoreMouse, false)
    assert.equal(ball.protection, undefined)
    assert.equal(ball.blurred, 1, 'no refocus on restore')
  })

  it('refcounts overlapping intervals and clamps surplus ends', async () => {
    const ball = fakeWindow()
    const cloak = cloakFor([{ window: () => ball, resting: false }], () => ball)

    cloak.begin('capture')
    cloak.begin('input')
    cloak.end('input')
    assert.equal(ball.protection, true, 'the capture is still open')
    assert.equal(ball.ignoreMouse, false)

    cloak.end('capture')
    assert.equal(ball.protection, true, 'the tail hold outlives the last interval')
    await sleep(CLOAK_TAIL_MS + 60)
    assert.equal(ball.protection, false)

    cloak.end('capture')
    cloak.end('capture')
    assert.equal(ball.protection, false, 'surplus ends do not go negative')
    assert.equal(ball.ignoreMouse, false)
  })

  it('survives destroyed windows and a missing ball', () => {
    const ball = fakeWindow()
    const gone = fakeWindow()
    gone.destroyed = true
    const cloak = cloakFor([
      { window: () => gone, resting: false },
      { window: () => undefined, resting: false },
    ], () => ball)

    cloak.begin('capture')
    assert.equal(ball.protection, undefined, 'ball is click-through target only, not chrome here')
    cloak.end('capture')

    const lonely = cloakFor([{ window: () => ball, resting: false }])
    lonely.begin('input')
    assert.equal(lonely !== undefined, true)
    assert.equal(ball.ignoreMouse, undefined, 'no click-through window wired')
    lonely.end('input')
  })

  it('reset drops every interval and restores resting chrome', () => {
    const ball = fakeWindow()
    const frame = fakeWindow()
    const cloak = cloakFor([
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

describe('linux conceal', () => {
  it('fades the chrome so a capture never remaps or blinks it', async () => {
    assert.equal(cloakConceal('linux'), 'opacity')
    assert.equal(cloakConceal('darwin'), 'content-protection')
    assert.equal(cloakConceal('win32'), 'content-protection')

    const ball = fakeWindow()
    const frame = fakeWindow()
    const cloak = createAgentCloak([
      { window: () => ball, resting: false },
      { window: () => frame, resting: true },
    ], () => ball, 'opacity')

    cloak.begin('capture')
    assert.equal(ball.opacity, 0, 'the ball goes transparent for the capture')
    assert.equal(ball.protection, undefined, 'no content protection is claimed where none exists')
    cloak.begin('capture')
    assert.equal(ball.opacity, 0, 'a nested interval does not toggle a second time')

    cloak.end('capture')
    assert.equal(ball.opacity, 0, 'the tail hold keeps it transparent across the gap')
    cloak.end('capture')
    await sleep(CLOAK_TAIL_MS + 60)
    assert.equal(ball.opacity, 1, 'the ball comes back once the tail expires')
    assert.equal(frame.opacity, 0, 'the observation frame rests concealed and is toggled once')
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
