/**
 * Software acoustic echo cancellation for the orb's own TTS.
 *
 * The playback path feeds the exact PCM it sends to the speaker as the far-end
 * reference. The microphone path runs a short NLMS adaptive filter against that
 * reference, so our own voice is subtracted without touching the system output
 * volume. Other applications' audio is not in the reference and is left alone.
 *
 * Both rings use one frame clock: the microphone's 16 kHz sample count. When a
 * sentence starts, the reference is anchored at the current microphone frame.
 * That avoids `performance.now()` jitter from the JS audio callbacks, which made
 * the first live build lock onto the wrong delay. A coarse normalized
 * cross-correlation picks the bulk delay; the adaptive filter models the rest.
 * The text echo filter in `echo.ts` stays as the last line of defence.
 */

const DEFAULT_RATE = 16_000
const RING_SECONDS = 2
const SEARCH_WINDOW = DEFAULT_RATE / 2
const SEARCH_INTERVAL = DEFAULT_RATE / 2
const SEARCH_DOWNSAMPLE = 8
const MIN_DELAY_MS = 0
const MAX_DELAY_MS = 400
const LEAK = 0.9999

export interface EchoCancellerOptions {
  readonly sampleRate?: number
  /** Adaptive filter taps after the bulk delay. 512 ≈ 32 ms at 16 kHz. */
  readonly filterLength?: number
  /** NLMS step size. */
  readonly stepSize?: number
}

/** A ring keyed by the capture's 16 kHz frame count. */
class FrameRing {
  private readonly data: Float32Array
  private readonly capacity: number
  private minFrame = Number.POSITIVE_INFINITY
  private maxFrame = Number.NEGATIVE_INFINITY

  constructor(capacity: number) {
    this.capacity = capacity
    this.data = new Float32Array(capacity)
  }

  push(block: Float32Array, startFrame: number): void {
    const length = block.length
    if (length === 0) return
    if (!Number.isFinite(this.minFrame)) {
      this.minFrame = startFrame
      this.maxFrame = startFrame + length
    }
    if (startFrame > this.maxFrame) {
      // Fill the gap so a read cannot see stale samples from the previous wrap.
      let gap = startFrame - this.maxFrame
      if (gap >= this.capacity) {
        this.data.fill(0)
      } else {
        while (gap > 0) {
          const at = (this.maxFrame + gap - 1) % this.capacity
          this.data[at < 0 ? at + this.capacity : at] = 0
          gap -= 1
        }
      }
    }
    for (let i = 0; i < length; i += 1) {
      const at = (startFrame + i) % this.capacity
      this.data[at < 0 ? at + this.capacity : at] = block[i] ?? 0
    }
    this.minFrame = Math.max(this.minFrame, startFrame + length - this.capacity)
    this.maxFrame = Math.max(this.maxFrame, startFrame + length)
  }

  /** Read `count` frames beginning at `startFrame`; outside the valid span is silence. */
  read(startFrame: number, out: Float32Array, count = out.length): void {
    for (let i = 0; i < count; i += 1) {
      const frame = startFrame + i
      if (frame < this.minFrame || frame >= this.maxFrame) {
        out[i] = 0
        continue
      }
      const at = frame % this.capacity
      out[i] = this.data[at < 0 ? at + this.capacity : at] ?? 0
    }
  }

  clear(): void {
    this.data.fill(0)
    this.minFrame = Number.POSITIVE_INFINITY
    this.maxFrame = Number.NEGATIVE_INFINITY
  }
}

export class EchoCanceller {
  private readonly rate: number
  private readonly filterLength: number
  private readonly stepSize: number
  private readonly reference: FrameRing
  private readonly microphone: FrameRing
  private readonly weights: Float32Array
  private readonly window: Float32Array
  private readonly micWindow: Float32Array
  private readonly micDown: Float32Array
  private readonly refDown: Float32Array
  private readonly residual: Float32Array
  private active = false
  private micFrames = 0
  private referenceFrames = 0
  private referenceBase = 0
  private delayFrames: number
  private sinceSearch = 0
  private blocks = 0
  private delayLocked = false

  constructor(options: EchoCancellerOptions = {}) {
    this.rate = options.sampleRate ?? DEFAULT_RATE
    this.filterLength = options.filterLength ?? 512
    this.stepSize = options.stepSize ?? 0.2
    this.reference = new FrameRing(Math.ceil(this.rate * RING_SECONDS))
    this.microphone = new FrameRing(Math.ceil(this.rate * RING_SECONDS))
    this.weights = new Float32Array(this.filterLength)
    this.window = new Float32Array(this.filterLength + 8192)
    this.micWindow = new Float32Array(SEARCH_WINDOW)
    this.micDown = new Float32Array(Math.ceil(SEARCH_WINDOW / SEARCH_DOWNSAMPLE))
    this.refDown = new Float32Array(this.micDown.length)
    this.residual = new Float32Array(8192)
    this.delayFrames = Math.round(0.08 * this.rate)
  }

  /** The output callback calls this with exactly what it sent to the speaker. */
  pushReference(block: Float32Array): void {
    if (!this.active || block.length === 0) return
    this.reference.push(block, this.referenceBase + this.referenceFrames)
    this.referenceFrames += block.length
  }

  /** A sentence starts or finishes. The filter itself survives across sentences. */
  setActive(active: boolean, anchorFrame = this.micFrames): void {
    if (active && !this.active) {
      // Anchor the reference at the capture frame where playback starts.
      // Everything the speaker emits from now on lines up with this clock.
      this.referenceBase = Math.max(0, anchorFrame)
      this.referenceFrames = 0
      this.reference.clear()
      this.sinceSearch = SEARCH_INTERVAL
      this.blocks = 0
      this.delayLocked = false
    }
    this.active = active
    if (!active) this.sinceSearch = SEARCH_INTERVAL
  }

  get enabled(): boolean {
    return this.referenceFrames > 0
  }

  get delayMs(): number {
    return (this.delayFrames / this.rate) * 1000
  }

  reset(): void {
    this.reference.clear()
    this.microphone.clear()
    this.weights.fill(0)
    this.active = false
    this.micFrames = 0
    this.referenceFrames = 0
    this.referenceBase = 0
    this.sinceSearch = 0
    this.blocks = 0
    this.delayLocked = false
    this.delayFrames = Math.round(0.08 * this.rate)
  }

  /** Process one microphone block and return the cleaned copy. */
  process(samples: Float32Array, startFrame = this.micFrames): Float32Array {
    const blockStart = Math.max(0, startFrame)
    this.microphone.push(samples, blockStart)
    this.micFrames = Math.max(this.micFrames, blockStart + samples.length)
    if (!this.active) return samples

    this.sinceSearch += samples.length
    if (this.sinceSearch >= SEARCH_INTERVAL) {
      this.sinceSearch = 0
      this.estimateDelay()
    }

    const length = samples.length
    const needed = length + this.filterLength - 1
    if (this.window.length < needed) {
      const output = new Float32Array(length)
      for (let offset = 0; offset < length; offset += 2048) {
        const part = samples.subarray(offset, Math.min(length, offset + 2048))
        const cleaned = this.processChunk(part, blockStart + offset)
        output.set(cleaned, offset)
      }
      return output
    }

    const windowStart = blockStart - this.delayFrames - (this.filterLength - 1)
    this.reference.read(windowStart, this.window, needed)
    // The VAD keeps references to the blocks it receives, so every cleaned
    // block must own its storage.
    const cleaned = new Float32Array(length)
    this.filter(samples, cleaned, this.window, length)
    return cleaned
  }

  private processChunk(samples: Float32Array, blockStart: number): Float32Array {
    const needed = samples.length + this.filterLength - 1
    const window = new Float32Array(needed)
    this.reference.read(blockStart - this.delayFrames - (this.filterLength - 1), window, needed)
    const cleaned = new Float32Array(samples.length)
    this.filter(samples, cleaned, window, samples.length)
    return cleaned
  }

  private filter(mic: Float32Array, out: Float32Array, window: Float32Array, length: number): void {
    const taps = this.filterLength
    const weights = this.weights
    const residual = length <= this.residual.length ? this.residual : new Float32Array(length)
    let micEnergy = 0
    let echoEnergy = 0
    let residualEnergy = 0
    for (let i = 0; i < length; i += 1) {
      let echo = 0
      for (let k = 0; k < taps; k += 1) echo += weights[k]! * window[i + k]!
      const sample = mic[i] ?? 0
      const error = sample - echo
      residual[i] = error
      echoEnergy += echo * echo
      micEnergy += sample * sample
      residualEnergy += error * error
      // Never let a mis-converged tap make the signal louder than the mic.
      const limit = Math.abs(sample) * 1.2 + 0.005
      out[i] = error > limit ? limit : error < -limit ? -limit : error
    }

    // Double talk: freeze only after a warm-up, and only when the microphone is
    // far louder than the filter's current echo estimate. Freezing on the first
    // block (estimate still zero) stopped the taps from ever converging.
    const freeze = this.blocks > 60 && echoEnergy > 1e-6 && micEnergy > 20 * echoEnergy
    this.blocks += 1
    if (freeze) return

    // If the residual is already much louder than the input, the taps are
    // modelling something other than the echo path (a misaligned reference, an
    // acoustic glitch, a double-talk burst). Decay instead of chasing it.
    if (residualEnergy > micEnergy * 2) {
      for (let k = 0; k < taps; k += 1) weights[k] *= 0.98
      return
    }

    for (let i = 0; i < length; i += 1) {
      let energy = 0
      for (let k = 0; k < taps; k += 1) {
        const x = window[i + k]!
        energy += x * x
      }
      // Recompute against the taps as they are now: the sample-by-sample update
      // is what converges on speech; using the block's stale residual diverges.
      const error = (mic[i] ?? 0) - dot(weights, window, i, taps)
      const gain = (this.stepSize * error) / (energy + 1e-3)
      for (let k = 0; k < taps; k += 1) {
        const next = weights[k]! + gain * window[i + k]!
        weights[k] = next > 4 ? 4 : next < -4 ? -4 : next
      }
    }
    for (let k = 0; k < taps; k += 1) weights[k] *= LEAK
  }

  private estimateDelay(): void {
    // The acoustic path is stable for a sentence. Estimate it once, early,
    // before the user starts talking; re-estimating on speech windows made the
    // delay drift by tens of milliseconds and pushed the echo out of the filter.
    if (this.delayLocked) return
    const micStart = this.micFrames - SEARCH_WINDOW
    if (micStart < 0) return
    const downLength = this.micDown.length
    this.microphone.read(micStart, this.micWindow, SEARCH_WINDOW)
    for (let i = 0; i < downLength; i += 1) {
      let sum = 0
      for (let k = 0; k < SEARCH_DOWNSAMPLE; k += 1) sum += this.micWindow[i * SEARCH_DOWNSAMPLE + k] ?? 0
      this.micDown[i] = sum / SEARCH_DOWNSAMPLE
    }
    let micEnergy = 0
    for (let i = 0; i < downLength; i += 1) micEnergy += this.micDown[i]! * this.micDown[i]!
    if (micEnergy < 1e-6) return

    const minLag = Math.round((MIN_DELAY_MS / 1000) * this.rate)
    const maxLag = Math.round((MAX_DELAY_MS / 1000) * this.rate)
    const step = SEARCH_DOWNSAMPLE * 4
    let bestLag = this.delayFrames
    let bestScore = 0
    for (let lag = minLag; lag <= maxLag; lag += step) {
      const start = micStart - lag
      if (start + SEARCH_WINDOW <= this.referenceBase) continue
      this.reference.read(start, this.micWindow, SEARCH_WINDOW)
      for (let i = 0; i < downLength; i += 1) {
        let sum = 0
        for (let k = 0; k < SEARCH_DOWNSAMPLE; k += 1) sum += this.micWindow[i * SEARCH_DOWNSAMPLE + k] ?? 0
        this.refDown[i] = sum / SEARCH_DOWNSAMPLE
      }
      let dotProduct = 0
      let refEnergy = 0
      for (let i = 0; i < downLength; i += 1) {
        const ref = this.refDown[i]!
        dotProduct += this.micDown[i]! * ref
        refEnergy += ref * ref
      }
      if (refEnergy < 1e-7) continue
      // A speaker/microphone path can invert polarity; the filter can learn a
      // negative gain, so the delay search must accept the absolute correlation.
      const score = Math.abs(dotProduct) / Math.sqrt(micEnergy * refEnergy)
      if (score > bestScore) {
        bestScore = score
        bestLag = lag
      }
    }
    if (bestScore < 0.3) return
    this.delayFrames = Math.max(minLag, Math.min(maxLag, bestLag))
    this.delayLocked = true
  }
}

function dot(weights: Float32Array, window: Float32Array, offset: number, taps: number): number {
  let sum = 0
  for (let k = 0; k < taps; k += 1) sum += weights[k]! * window[offset + k]!
  return sum
}
