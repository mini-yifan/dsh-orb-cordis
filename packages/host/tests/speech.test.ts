import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSpeechToText,
  MAX_AUDIO_SECONDS,
  readTranscribeRequest,
  SpeechRequestError,
  speechFailure,
  speechToTextOf,
  transcribeWithSpeech,
  validateWave,
  WAVE_HEADER_BYTES,
  type SpeechToTextLike,
} from '../src/speech.ts'

/** One canonical 16 kHz mono PCM16 WAV with `seconds` of silence. */
function wave(seconds: number): Buffer {
  const samples = Math.round(seconds * 16_000)
  const bytes = Buffer.alloc(WAVE_HEADER_BYTES + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

/** A service that reports one provider and echoes a fixed transcript. */
function service(overrides: Partial<SpeechToTextLike> = {}): SpeechToTextLike {
  return {
    listProviders: () => [{ id: 'sensevoice-local', name: 'SenseVoice', languages: ['auto'] }],
    resolve: () => ({ provider: { info: { id: 'sensevoice-local' } }, audio: Buffer.alloc(0), language: 'auto' }),
    transcribe: async () => ({ text: 'hello there', audioSeconds: 1 }),
    ...overrides,
  }
}

describe('speech wave validation', () => {
  it('accepts a canonical 16 kHz mono PCM16 recording', () => {
    assert.equal(validateWave(wave(1)), 1)
    assert.equal(validateWave(wave(0.5)), 0.5)
  })

  it('rejects anything the official validator rejects', () => {
    const bad = [
      Buffer.alloc(0),
      Buffer.alloc(45),
      (() => { const b = wave(0.1); b.writeUInt32LE(8000, 24); return b })(),
      (() => { const b = wave(0.1); b.writeUInt16LE(2, 22); return b })(),
      (() => { const b = wave(0.1); b.writeUInt16LE(8, 34); return b })(),
      (() => { const b = wave(0.1); b.write('datA', 36, 'ascii'); return b })(),
      (() => { const b = wave(0.1); b.writeUInt32LE(0, 4); return b })(),
      (() => { const b = wave(0.1); b.writeUInt32LE(0, 40); return b })(),
      (() => { const b = wave(0.1); return b.subarray(0, b.length - 1) })(),
    ]
    for (const bytes of bad) {
      assert.throws(() => validateWave(bytes), (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        assert.equal(error.code, 'invalid-audio')
        return true
      })
    }
  })

  it('rejects a recording past the duration limit', () => {
    assert.throws(() => validateWave(wave(3), 2), /exceeds 2 seconds/)
    assert.equal(MAX_AUDIO_SECONDS, 120)
  })
})

describe('speech request decoding', () => {
  it('decodes canonical base64 plus a matching duration', () => {
    const bytes = wave(1)
    const request = readTranscribeRequest({ audioBase64: bytes.toString('base64'), audioSeconds: 1 })
    assert.equal(request.audioSeconds, 1)
    assert.equal(request.audio.equals(bytes), true)
  })

  it('carries an optional language and ignores junk', () => {
    const bytes = wave(1).toString('base64')
    assert.equal(readTranscribeRequest({ audioBase64: bytes, audioSeconds: 1, language: 'zh' }).language, 'zh')
    assert.equal(readTranscribeRequest({ audioBase64: bytes, audioSeconds: 1, language: '' }).language, undefined)
    assert.equal(readTranscribeRequest({ audioBase64: bytes, audioSeconds: 1, language: 'x'.repeat(40) }).language, undefined)
  })

  it('rejects malformed envelopes without decoding them', () => {
    const bytes = wave(1).toString('base64')
    const cases: unknown[] = [
      undefined,
      {},
      { audioBase64: '' },
      { audioBase64: 5, audioSeconds: 1 },
      { audioBase64: bytes },
      { audioBase64: bytes, audioSeconds: -1 },
      { audioBase64: bytes, audioSeconds: '1' },
      { audioBase64: `${bytes}!!`, audioSeconds: 1 },
      { audioBase64: bytes, audioSeconds: 9 },
    ]
    for (const body of cases) {
      assert.throws(() => readTranscribeRequest(body), (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        return true
      })
    }
  })

  it('rejects an oversized payload before decoding it', () => {
    const huge = 'A'.repeat(20_000)
    assert.throws(() => readTranscribeRequest({ audioBase64: huge, audioSeconds: 1 }, { maxAudioBytes: 1024 }), (error: unknown) => {
      assert.ok(error instanceof SpeechRequestError)
      assert.equal(error.status, 413)
      return true
    })
  })
})

describe('speech service lookup', () => {
  it('accepts the official shape and ignores partial objects', () => {
    assert.equal(isSpeechToText(service()), true)
    assert.equal(isSpeechToText({ resolve() {}, transcribe() {} }), false)
    assert.equal(isSpeechToText(undefined), false)
    assert.equal(isSpeechToText(null), false)
  })

  it('survives a context without the voice bundle', () => {
    assert.equal(speechToTextOf(undefined), undefined)
    assert.equal(speechToTextOf(() => undefined), undefined)
    assert.equal(speechToTextOf(() => { throw new Error('no service') }), undefined)
    assert.equal(speechToTextOf(() => ({})), undefined)
    assert.ok(speechToTextOf(() => service()))
  })
})

describe('speech transcription', () => {
  it('returns the transcript and the pinned provider', async () => {
    const result = await transcribeWithSpeech(service(), { audio: wave(1), audioSeconds: 1 }, new AbortController().signal)
    assert.equal(result.text, 'hello there')
    assert.equal(result.providerId, 'sensevoice-local')
    assert.equal(result.audioSeconds, 1)
  })

  it('reports an absent voice bundle instead of throwing a host error', async () => {
    await assert.rejects(
      transcribeWithSpeech(undefined, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        assert.equal(error.code, 'voice-unavailable')
        assert.equal(error.status, 503)
        return true
      },
    )
  })

  it('separates an unprepared provider from a hard failure', async () => {
    const notReady = service({ resolve: () => { throw new Error('Prepare the local speech provider before recording') } })
    await assert.rejects(
      transcribeWithSpeech(notReady, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        assert.equal(error.code, 'voice-not-ready')
        return true
      },
    )
    const broken = service({ transcribe: async () => { throw new Error('model exploded') } })
    await assert.rejects(
      transcribeWithSpeech(broken, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        assert.equal(error.code, 'voice-failed')
        assert.equal(error.status, 502)
        return true
      },
    )
  })

  it('maps a withdrawn provider to voice-unavailable', async () => {
    const withdrawn = service({ transcribe: async () => { throw new Error('Resolved speech provider is no longer registered') } })
    await assert.rejects(
      transcribeWithSpeech(withdrawn, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof SpeechRequestError)
        assert.equal(error.code, 'voice-unavailable')
        return true
      },
    )
  })

  it('keeps an empty transcript as an empty string', async () => {
    const silent = service({ transcribe: async () => ({ text: '' }) })
    const result = await transcribeWithSpeech(silent, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal)
    assert.equal(result.text, '')
  })

  it('passes a missing transcript shape through as empty', async () => {
    const odd = service({ transcribe: async () => ({}) })
    const result = await transcribeWithSpeech(odd, { audio: wave(1), audioSeconds: 1 }, new AbortController().signal)
    assert.equal(result.text, '')
  })
})

describe('speech failure mapping', () => {
  it('passes a known failure through unchanged', () => {
    const original = new SpeechRequestError('invalid-audio', 400, 'nope')
    assert.equal(speechFailure(original), original)
  })

  it('classifies unknown errors as voice-failed', () => {
    const failure = speechFailure(new Error('kaboom'))
    assert.equal(failure.code, 'voice-failed')
    assert.equal(failure.message, 'kaboom')
    assert.equal(speechFailure('string error').code, 'voice-failed')
  })
})
