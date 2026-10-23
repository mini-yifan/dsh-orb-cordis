import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EchoCanceller } from '../src/aec.ts'

const RATE = 16_000
const BLOCK = 256
const SECONDS = 2

/** Deterministic white noise, so a failure reproduces. */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return (state / 0x1_0000_0000) * 2 - 1
  }
}

function referenceSignal(): Float32Array {
  const samples = new Float32Array(RATE * SECONDS)
  const random = noise(7)
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE
    samples[i] = 0.28 * Math.sin(2 * Math.PI * 440 * t)
      + 0.18 * Math.sin(2 * Math.PI * 880 * t)
      + 0.04 * random()
  }
  return samples
}

function delayedEcho(reference: Float32Array, delaySamples: number, taps: readonly number[]): Float32Array {
  const echo = new Float32Array(reference.length)
  for (let i = 0; i < reference.length; i += 1) {
    let sum = 0
    for (let k = 0; k < taps.length; k += 1) {
      const at = i - delaySamples - k
      if (at >= 0) sum += taps[k]! * reference[at]!
    }
    echo[i] = sum
  }
  return echo
}

function userSpeech(): Float32Array {
  const speech = new Float32Array(RATE * SECONDS)
  const random = noise(19)
  const from = Math.round(1.0 * RATE)
  const to = Math.round(1.35 * RATE)
  for (let i = from; i < to; i += 1) {
    const t = (i - from) / RATE
    const envelope = Math.sin((Math.PI * (i - from)) / (to - from)) ** 2
    speech[i] = envelope * (0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * random())
  }
  return speech
}

function energy(samples: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i += 1) sum += (samples[i] ?? 0) ** 2
  return sum / Math.max(1, to - from)
}

function correlation(left: Float32Array, right: Float32Array, from: number, to: number): number {
  let dot = 0
  let l = 0
  let r = 0
  for (let i = from; i < to; i += 1) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    dot += a * b
    l += a * a
    r += b * b
  }
  return dot / Math.sqrt(l * r + 1e-12)
}

describe('software echo cancellation', () => {
  it('removes the delayed speaker echo while keeping the user speech', () => {
    const reference = referenceSignal()
    const echo = delayedEcho(reference, Math.round(0.06 * RATE), [0.55, 0.24, -0.14, 0.07, -0.04])
    const user = userSpeech()
    const random = noise(31)
    const mic = new Float32Array(reference.length)
    for (let i = 0; i < mic.length; i += 1) {
      mic[i] = echo[i]! + user[i]! + 0.001 * random()
    }

    const canceller = new EchoCanceller({ filterLength: 256, stepSize: 0.02 })
    canceller.setActive(true)
    const cleaned = new Float32Array(mic.length)
    for (let start = 0; start < mic.length; start += BLOCK) {
      const end = Math.min(mic.length, start + BLOCK)
      canceller.pushReference(reference.subarray(start, end))
      cleaned.set(canceller.process(mic.subarray(start, end)), start)
    }

    const echoFrom = Math.round(0.45 * RATE)
    const echoTo = Math.round(0.95 * RATE)
    const before = energy(mic, echoFrom, echoTo)
    const after = energy(cleaned, echoFrom, echoTo)
    const reductionDb = 10 * Math.log10(before / Math.max(after, 1e-12))
    assert.ok(reductionDb > 6, `expected >6 dB echo reduction, got ${reductionDb.toFixed(1)} dB`)

    const speechFrom = Math.round(1.0 * RATE)
    const speechTo = Math.round(1.35 * RATE)
    const heard = correlation(cleaned, user, speechFrom, speechTo)
    assert.ok(heard > 0.35, `expected user speech to survive, correlation ${heard.toFixed(2)}`)
    assert.ok(energy(cleaned, speechFrom, speechTo) > 0.2 * energy(mic, speechFrom, speechTo))
  })

  it('passes the microphone through while no sentence is playing', () => {
    const mic = new Float32Array(BLOCK)
    mic[0] = 0.5
    const canceller = new EchoCanceller()
    canceller.pushReference(new Float32Array(BLOCK))
    assert.equal(canceller.process(mic), mic)
    assert.equal(canceller.delayMs > 0, true)
  })
})
