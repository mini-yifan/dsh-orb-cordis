/**
 * Optional speech-to-text bridge for the ball's composer.
 *
 * The helper process holds no official credentials, so the ball posts its
 * recording here over the authenticated loopback prefix and this module hands
 * it to the injected `ctx.speechToText` service. The service belongs to the
 * voice-input bundle, which the profile may not have loaded at all — every
 * entry point here treats it as optional and degrades to a stable error code
 * instead of throwing at the caller.
 */

/** Canonical wire format accepted by the official API layer. */
export const WAVE_SAMPLE_RATE = 16_000
export const WAVE_BYTES_PER_SECOND = WAVE_SAMPLE_RATE * 2
export const WAVE_HEADER_BYTES = 44

/** Defaults mirror `@deepseek-ai/dsh-experimental-api-speech-to-text`. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
export const MAX_AUDIO_SECONDS = 120

/** How far the client-reported duration may drift from the encoded WAV. */
const SECONDS_TOLERANCE = 0.5

/** Stable codes the ball turns into localized copy. */
export type SpeechFailureCode =
  | 'voice-unavailable'
  | 'voice-not-ready'
  | 'invalid-audio'
  | 'voice-failed'

/** One provider fact as `SpeechToText#listProviders` reports it. */
export interface SpeechProviderInfo {
  readonly id?: unknown
  readonly name?: unknown
  readonly languages?: unknown
}

/** The subset of the official `SpeechToText` service this plugin uses. */
export interface SpeechToTextLike {
  listProviders(): readonly SpeechProviderInfo[]
  resolve(request: { readonly audio: Buffer; readonly providerId?: string; readonly language?: string }): unknown
  transcribe(spec: unknown, signal: AbortSignal): Promise<{ readonly text?: unknown }>
}

/** A failure the route answers with a specific status and code. */
export class SpeechRequestError extends Error {
  readonly code: SpeechFailureCode
  readonly status: number

  constructor(code: SpeechFailureCode, status: number, message: string) {
    super(message)
    this.name = 'SpeechRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * Read the injected service without requiring it.
 * @param get - the plugin context's service lookup.
 * @returns the service when the voice bundle is mounted and shaped as expected.
 */
export function speechToTextOf(get: ((name: string) => unknown) | undefined): SpeechToTextLike | undefined {
  if (typeof get !== 'function') return undefined
  let value: unknown
  try {
    value = get('speechToText')
  } catch {
    return undefined
  }
  return isSpeechToText(value) ? value : undefined
}

/** Duck-type the service so a partial or foreign implementation is ignored. */
export function isSpeechToText(value: unknown): value is SpeechToTextLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SpeechToTextLike>
  return typeof candidate.resolve === 'function'
    && typeof candidate.transcribe === 'function'
    && typeof candidate.listProviders === 'function'
}

/**
 * Read a canonical 16 kHz mono PCM16 WAV, rejecting inconsistent lengths.
 * Mirrors `@deepseek-ai/dsh-experimental-speech-to-text/wave` so the ball's
 * recording is refused here instead of inside the provider.
 * @param audio - decoded wire bytes.
 * @param maxSeconds - maximum admitted recording duration.
 * @returns the recording duration in seconds.
 */
export function validateWave(audio: Buffer, maxSeconds: number = MAX_AUDIO_SECONDS): number {
  if (audio.length < 46 || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.toString('ascii', 12, 16) !== 'fmt '
    || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1
    || audio.readUInt32LE(24) !== WAVE_SAMPLE_RATE || audio.readUInt32LE(28) !== WAVE_BYTES_PER_SECOND
    || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(4) !== audio.length - 8
    || audio.readUInt32LE(40) !== audio.length - WAVE_HEADER_BYTES
    || (audio.length - WAVE_HEADER_BYTES) % 2 !== 0) {
    throw new SpeechRequestError('invalid-audio', 400, 'Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  }
  const seconds = (audio.length - WAVE_HEADER_BYTES) / WAVE_BYTES_PER_SECOND
  if (seconds > maxSeconds) {
    throw new SpeechRequestError('invalid-audio', 413, `Audio exceeds ${maxSeconds} seconds`)
  }
  return seconds
}

/** One decoded transcription request. */
export interface TranscribeRequest {
  readonly audio: Buffer
  readonly audioSeconds: number
  readonly language?: string
}

/**
 * Decode and validate the JSON body the helper posts.
 * @param body - parsed request body.
 * @param options - size and duration limits.
 * @returns the decoded recording.
 */
export function readTranscribeRequest(
  body: unknown,
  options: { readonly maxAudioBytes?: number; readonly maxDurationSeconds?: number } = {},
): TranscribeRequest {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined
  const encoded = record?.audioBase64
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new SpeechRequestError('invalid-audio', 400, 'audioBase64 is required')
  }
  const maxBytes = options.maxAudioBytes ?? MAX_AUDIO_BYTES
  // base64 inflates by 4/3; reject oversized payloads before decoding them.
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
    throw new SpeechRequestError('invalid-audio', 413, 'Audio exceeds the configured byte limit')
  }
  const audio = Buffer.from(encoded, 'base64')
  if (audio.length === 0 || audio.toString('base64') !== encoded) {
    throw new SpeechRequestError('invalid-audio', 400, 'Audio must use canonical base64 encoding')
  }
  if (audio.length > maxBytes) {
    throw new SpeechRequestError('invalid-audio', 413, 'Audio exceeds the configured byte limit')
  }
  const reported = record?.audioSeconds
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
    throw new SpeechRequestError('invalid-audio', 400, 'audioSeconds is required')
  }
  const seconds = validateWave(audio, options.maxDurationSeconds ?? MAX_AUDIO_SECONDS)
  if (Math.abs(seconds - reported) > SECONDS_TOLERANCE) {
    throw new SpeechRequestError('invalid-audio', 400, 'audioSeconds does not match the recording')
  }
  const language = typeof record?.language === 'string' && record.language.length > 0 && record.language.length <= 35
    ? record.language
    : undefined
  return { audio, audioSeconds: seconds, ...(language === undefined ? {} : { language }) }
}

/** A transcript plus the provider facts worth reporting back. */
export interface TranscriptResult {
  readonly text: string
  readonly providerId: string
  readonly audioSeconds: number
}

/**
 * Route one recording through the injected service.
 * @param speech - the optional service; absent means the bundle is not mounted.
 * @param request - validated recording.
 * @param signal - caller cancellation.
 * @returns the recognized text.
 */
export async function transcribeWithSpeech(
  speech: SpeechToTextLike | undefined,
  request: TranscribeRequest,
  signal: AbortSignal,
): Promise<TranscriptResult> {
  if (speech === undefined) {
    throw new SpeechRequestError('voice-unavailable', 503, 'Speech recognition is not available')
  }
  let spec: unknown
  try {
    spec = speech.resolve({
      audio: request.audio,
      ...(request.language === undefined ? {} : { language: request.language }),
    })
  } catch (error) {
    throw speechFailure(error)
  }
  let result: { readonly text?: unknown }
  try {
    result = await speech.transcribe(spec, signal)
  } catch (error) {
    throw speechFailure(error)
  }
  const text = typeof result?.text === 'string' ? result.text : ''
  return { text, providerId: providerIdOf(spec, speech), audioSeconds: request.audioSeconds }
}

/** The provider identity pinned by `resolve`, for the ball's status line. */
function providerIdOf(spec: unknown, speech: SpeechToTextLike): string {
  const pinned = spec as { readonly provider?: { readonly info?: { readonly id?: unknown } } }
  const id = pinned?.provider?.info?.id
  if (typeof id === 'string' && id.length > 0) return id
  const [first] = speech.listProviders()
  return typeof first?.id === 'string' ? first.id : ''
}

/**
 * Map a provider/service failure onto the ball's localized copy.
 * A missing or unprepared recognizer is expected when the voice bundle is
 * mounted but its model has never been downloaded, so it is not an error 500.
 */
export function speechFailure(error: unknown): SpeechRequestError {
  if (error instanceof SpeechRequestError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/unavailable|no longer registered/i.test(message)) {
    return new SpeechRequestError('voice-unavailable', 503, message)
  }
  if (/prepare|not ready|standby|failed to load|download/i.test(message)) {
    return new SpeechRequestError('voice-not-ready', 503, message)
  }
  return new SpeechRequestError('voice-failed', 502, message)
}
