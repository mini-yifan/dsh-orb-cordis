/**
 * Microphone capture for the ball's composer.
 *
 * The ball is plain HTML/CSS/JS, not React and not the official slot system, so
 * it cannot reuse the official voice-input client component. This module
 * reproduces the exact wire contract that client produces — canonical 16 kHz
 * mono PCM16 WAV encoded as canonical base64 — because the host validates the
 * recording with the official `validateWave` before any provider sees it.
 *
 * `encodeWave` and `rms` are pure and unit-tested; `MicrophoneCapture` owns the
 * browser-only `getUserMedia`/`MediaRecorder`/Web Audio plumbing.
 */

/** Canonical recording format the host accepts. */
export const VOICE_SAMPLE_RATE = 16_000

/** Bytes of a canonical WAV header before the sample payload. */
const WAVE_HEADER_BYTES = 44

/** Cap the recording at the host's default provider limit. */
export const VOICE_MAX_SECONDS = 120

/**
 * Encode mono floating-point samples as canonical 16 kHz mono PCM16 WAV bytes.
 * @param samples - mono samples in [-1, 1] already at {@link VOICE_SAMPLE_RATE}.
 * @returns complete little-endian WAV bytes.
 */
export function encodeWave(samples) {
  const bytes = new Uint8Array(WAVE_HEADER_BYTES + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at, value) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, VOICE_SAMPLE_RATE, true)
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(WAVE_HEADER_BYTES + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/**
 * Root-mean-square level of a sample window.
 * @param samples - time-domain samples.
 * @returns the level in [0, 1].
 */
export function rms(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.min(1, Math.sqrt(sum / samples.length))
}

/**
 * Map a raw RMS level onto a 0..1 meter value.
 * Speech sits far below full scale, so the raw level is boosted and clamped;
 * the meter stays monotonic so it never lies about getting louder.
 * @param level - raw RMS level.
 * @returns the meter fill in [0, 1].
 */
export function meterLevel(level) {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.min(1, Math.sqrt(level) * 3)
}

/**
 * Encode bytes as canonical base64 for the JSON carrier.
 * Chunked so a long recording cannot blow the argument limit.
 * @param bytes - the WAV bytes.
 * @returns base64 with no data URL prefix.
 */
export function waveBase64(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(text)
}

/** Capture failure whose `kind` the page turns into localized copy. */
export class VoiceCaptureError extends Error {
  constructor(kind) {
    super(kind)
    this.name = 'VoiceCaptureError'
    this.kind = kind
  }
}

/**
 * One microphone acquisition.
 *
 * Mirrors the official client's lifecycle: the permission prompt may settle
 * after the user has already cancelled, so every path re-checks `lifetime`
 * before keeping the stream, and `dispose()` is idempotent and always releases
 * the tracks and the AudioContext.
 */
export class MicrophoneCapture {
  constructor() {
    this.stream = undefined
    this.recorder = undefined
    this.context = undefined
    this.analyser = undefined
    this.samples = new Float32Array(256)
    this.chunks = []
    this.lifetime = new AbortController()
    this.disposal = undefined
  }

  /**
   * Acquire the microphone and start recording.
   * @returns after capture starts.
   */
  async start() {
    const devices = navigator.mediaDevices
    if (!devices || typeof devices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
      throw new VoiceCaptureError('unavailable')
    }
    let stream
    try {
      stream = await devices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      })
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        throw new VoiceCaptureError('permission')
      }
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new VoiceCaptureError('unavailable')
      }
      throw error
    }
    if (this.lifetime.signal.aborted) {
      releaseTracks(stream)
      throw new VoiceCaptureError('cancelled')
    }
    this.stream = stream
    try {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = this.samples.length
      this.context.createMediaStreamSource(stream).connect(this.analyser)
      this.recorder = new MediaRecorder(stream)
      this.recorder.ondataavailable = (event) => {
        if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.start()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /**
   * Read the live microphone level.
   * @returns the meter fill in [0, 1], or 0 outside capture.
   */
  level() {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    return meterLevel(rms(this.samples))
  }

  /**
   * Finish capture and resample to the canonical format.
   * @param maxSeconds - truncate overshoot to the host's limit.
   * @returns canonical WAV bytes.
   */
  async stop(maxSeconds = VOICE_MAX_SECONDS) {
    const recorder = this.recorder
    const context = this.context
    if (!recorder || !context || recorder.state !== 'recording') {
      await this.dispose()
      throw new VoiceCaptureError('empty')
    }
    try {
      await new Promise((resolve, reject) => {
        recorder.onstop = () => { resolve() }
        recorder.onerror = () => { reject(new VoiceCaptureError('empty')) }
        recorder.stop()
      })
      releaseTracks(this.stream)
      this.lifetime.signal.throwIfAborted()
      const blob = new Blob(this.chunks, { type: recorder.mimeType })
      if (blob.size === 0) throw new VoiceCaptureError('empty')
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      this.lifetime.signal.throwIfAborted()
      const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxSeconds) * VOICE_SAMPLE_RATE))
      const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const resampled = await offline.startRendering()
      this.lifetime.signal.throwIfAborted()
      return encodeWave(resampled.getChannelData(0))
    } finally {
      await this.dispose()
    }
  }

  /**
   * Release the capture and invalidate a pending permission grant.
   * @returns the shared release promise.
   */
  dispose() {
    if (!this.disposal) {
      const closing = Promise.withResolvers()
      this.disposal = closing.promise
      this.release().then(closing.resolve, closing.reject)
    }
    return this.disposal
  }

  async release() {
    this.lifetime.abort(new VoiceCaptureError('cancelled'))
    if (this.recorder?.state === 'recording') this.recorder.stop()
    releaseTracks(this.stream)
    this.stream = undefined
    const context = this.context
    this.context = undefined
    this.analyser = undefined
    this.chunks = []
    if (context && context.state !== 'closed') await context.close()
  }
}

function releaseTracks(stream) {
  stream?.getTracks().forEach((track) => { track.stop() })
}
