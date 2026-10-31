import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createIdle, stepIdle, type IdleClock, type IdleSample } from '../src/idle.ts'

const idleMs = 30_000

function sample(now: number, patch: Partial<IdleSample> = {}): IdleSample {
  return {
    now,
    pinned: true,
    agentBusy: false,
    questionOpen: false,
    playbackBusy: false,
    speechOpen: false,
    idleMs,
    ...patch,
  }
}

function at(clock: IdleClock, now: number, patch: Partial<IdleSample> = {}) {
  return stepIdle(clock, sample(now, patch))
}

describe('idle unpin', () => {
  it('unpins after the configured span without waiting on a wall clock', () => {
    let clock = createIdle()
    const started = at(clock, 0)
    assert.equal(started.unpin, false)
    clock = started.clock
    const early = at(clock, idleMs - 1)
    assert.equal(early.unpin, false)
    const due = at(early.clock, idleMs)
    assert.equal(due.unpin, true)
  })

  it('pauses for speech, work, a question card, and playback, then restarts from zero', () => {
    const pauses: Partial<IdleSample>[] = [
      { speechOpen: true },
      { agentBusy: true },
      { translationBusy: true },
      { questionOpen: true },
      { playbackBusy: true },
    ]
    for (const pause of pauses) {
      let clock = at(createIdle(), 0).clock
      clock = at(clock, 20_000).clock
      const frozen = at(clock, 25_000, pause)
      assert.equal(frozen.unpin, false)
      const still = at(frozen.clock, 60_000, pause)
      assert.equal(still.unpin, false, 'paused time does not accumulate')
      const resumed = at(still.clock, 60_000)
      assert.equal(resumed.unpin, false)
      const early = at(resumed.clock, 89_999)
      assert.equal(early.unpin, false)
      const due = at(early.clock, 90_000)
      assert.equal(due.unpin, true)
    }
  })

  it('restarts immediately on a keystroke or a sent command', () => {
    let clock = at(createIdle(), 0).clock
    clock = at(clock, 20_000, { activity: true }).clock
    assert.equal(at(clock, 49_999).unpin, false)
    assert.equal(at(clock, 50_000).unpin, true)
  })

  it('does not unpin while the ball is already unpinned, and does not read the pointer', () => {
    let clock = at(createIdle(), 0).clock
    const away = at(clock, 40_000, { pinned: false })
    assert.equal(away.unpin, false)
    const again = at(away.clock, 40_000, { pinned: true })
    assert.equal(again.unpin, false)
    assert.equal(at(again.clock, 70_000).unpin, true)
    const fields = Object.keys(sample(0))
    assert.equal(fields.includes('pointerInside'), false)
  })
})
