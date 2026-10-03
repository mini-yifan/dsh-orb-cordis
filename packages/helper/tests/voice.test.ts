import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeWave,
  meterLevel,
  MicrophoneCapture,
  rms,
  VoiceCaptureError,
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  waveBase64,
} from '../assets/voice.js'

/** Read the little-endian WAV fields the host's validator checks. */
function fields(bytes: Uint8Array): Record<string, number | string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
  return {
    riff: text(0, 4),
    riffSize: view.getUint32(4, true),
    wave: text(8, 4),
    fmt: text(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36, 4),
    dataSize: view.getUint32(40, true),
  }
}

describe('voice wave encoding', () => {
  it('emits exactly the canonical 16 kHz mono PCM16 header', () => {
    const bytes = encodeWave(new Float32Array([0, 0.5, -0.5]))
    const f = fields(bytes)
    assert.equal(f.riff, 'RIFF')
    assert.equal(f.wave, 'WAVE')
    assert.equal(f.fmt, 'fmt ')
    assert.equal(f.fmtSize, 16)
    assert.equal(f.format, 1)
    assert.equal(f.channels, 1)
    assert.equal(f.sampleRate, VOICE_SAMPLE_RATE)
    assert.equal(f.byteRate, 32_000)
    assert.equal(f.blockAlign, 2)
    assert.equal(f.bits, 16)
    assert.equal(f.data, 'data')
    assert.equal(bytes.length, 44 + 3 * 2)
    assert.equal(f.riffSize, bytes.length - 8)
    assert.equal(f.dataSize, bytes.length - 44)
  })

  it('writes symmetric little-endian samples and clamps out-of-range input', () => {
    const bytes = encodeWave(new Float32Array([0, 1, -1, 2, -2]))
    const view = new DataView(bytes.buffer)
    assert.equal(view.getInt16(44, true), 0)
    assert.equal(view.getInt16(46, true), 32767)
    assert.equal(view.getInt16(48, true), -32768)
    assert.equal(view.getInt16(50, true), 32767)
    assert.equal(view.getInt16(52, true), -32768)
  })

  it('produces an even payload so the host validator accepts it', () => {
    for (const count of [0, 1, 2, 7, 1001]) {
      const bytes = encodeWave(new Float32Array(count))
      assert.equal((bytes.length - 44) % 2, 0)
    }
  })

  it('encodes canonical base64 without a data URL prefix', () => {
    const bytes = encodeWave(new Float32Array([0.25, -0.25]))
    const encoded = waveBase64(bytes)
    assert.equal(encoded.startsWith('data:'), false)
    assert.equal(Buffer.from(encoded, 'base64').equals(Buffer.from(bytes)), true)
  })

  it('round-trips a payload larger than the chunk size', () => {
    const samples = new Float32Array(20_000)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 40) * 0.6
    const bytes = encodeWave(samples)
    const encoded = waveBase64(bytes)
    assert.equal(Buffer.from(encoded, 'base64').equals(Buffer.from(bytes)), true)
  })
})

describe('voice level metering', () => {
  it('reports silence as zero', () => {
    assert.equal(rms(new Float32Array(0)), 0)
    assert.equal(rms(new Float32Array([0, 0, 0, 0])), 0)
    assert.equal(meterLevel(0), 0)
    assert.equal(meterLevel(Number.NaN), 0)
    assert.equal(meterLevel(-1), 0)
  })

  it('grows with amplitude and stays inside the meter range', () => {
    const quiet = rms(new Float32Array([0.05, -0.05]))
    const loud = rms(new Float32Array([0.5, -0.5]))
    assert.ok(quiet < loud)
    assert.ok(meterLevel(quiet) < meterLevel(loud))
    assert.ok(meterLevel(loud) <= 1)
    assert.equal(meterLevel(1), 1)
  })

  it('keeps the meter monotonic across the whole range', () => {
    let previous = -1
    for (let level = 0; level <= 1; level += 0.02) {
      const value = meterLevel(level)
      assert.ok(value >= previous)
      assert.ok(value >= 0 && value <= 1)
      previous = value
    }
  })
})

describe('voice capture lifecycle', () => {
  it('fails as unavailable without a mediaDevices implementation', async () => {
    const capture = new MicrophoneCapture()
    await assert.rejects(capture.start(), (error: unknown) => {
      assert.ok(error instanceof VoiceCaptureError)
      assert.equal(error.kind, 'unavailable')
      return true
    })
    await capture.dispose()
  })

  it('reports the canonical duration limit', () => {
    assert.equal(VOICE_MAX_SECONDS, 120)
    assert.equal(VOICE_SAMPLE_RATE, 16_000)
  })
})
