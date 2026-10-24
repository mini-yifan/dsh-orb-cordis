/**
 * Microphone capture for the voice child.
 * A native helper supplies echo-cancelled PCM when it is installed. Otherwise
 * node-cpal opens the default input and the host turns listening off while
 * our own speech is playing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TARGET_RATE = 16000
const READY_MS = 5000

export type CaptureFailure = 'mic-denied' | 'no-device' | 'unavailable' | 'failed' | 'crashed'

export interface CaptureHandlers {
  onPcm(samples: Float32Array): void
  onReady(info: { aec: boolean }): void
  onFailure(reason: CaptureFailure, detail: string): void
}

export interface CaptureSource {
  start(handlers: CaptureHandlers): void
  close(): void
}

export interface CpalNative {
  cpal: any
  sherpa: { LinearResampler: new (from: number, to: number) => { resample(samples: Float32Array): Float32Array } }
}

/** The helper named by the test env, or the prebuild next to this file. */
export function captureBinary(): string | undefined {
  const fromEnv = process.env.DSH_ORB_CAPTURE_BIN
  if (fromEnv) return fromEnv
  const name = process.platform === 'win32'
    ? 'win32-x64/dsh-orb-voice-capture.exe'
    : 'darwin-universal/dsh-orb-voice-capture'
  for (const url of [new URL(`./prebuilds/${name}`, import.meta.url), new URL(`../prebuilds/${name}`, import.meta.url)]) {
    const path = fileURLToPath(url)
    if (existsSync(path)) return path
  }
  return undefined
}

export class NativeCapture implements CaptureSource {
  private child: ChildProcessWithoutNullStreams | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private settled = false
  private reportedError = false

  constructor(private readonly binary: string) {}

  start(handlers: CaptureHandlers): void {
    const script = /\.(?:mjs|cjs|js)$/.test(this.binary)
    const child = spawn(script ? process.execPath : this.binary, script ? [this.binary] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.timer = setTimeout(() => {
      this.fail(handlers, 'unavailable', 'capture ready timed out')
      child.kill()
    }, READY_MS)
    let pending = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.settled) return
      pending = Buffer.concat([pending, chunk])
      const usable = pending.length - (pending.length % 4)
      if (usable < 4) return
      const slice = Buffer.from(pending.subarray(0, usable))
      pending = Buffer.from(pending.subarray(usable))
      const samples = new Float32Array(slice.buffer, slice.byteOffset, usable / 4)
      handlers.onPcm(new Float32Array(samples))
    })
    const lines = createInterface({ input: child.stderr })
    lines.on('line', (line) => {
      let message: { event?: string, aec?: unknown, code?: unknown, message?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        process.stderr.write(`${line}\n`)
        return
      }
      if (message.event === 'ready') {
        if (this.settled) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        handlers.onReady({ aec: message.aec === true })
        return
      }
      if (message.event === 'error') {
        const code = message.code
        const reason: CaptureFailure = code === 'mic-denied' || code === 'no-device' || code === 'unavailable' || code === 'failed'
          ? code
          : 'failed'
        this.reportedError = true
        this.fail(handlers, reason, typeof message.message === 'string' ? message.message : reason)
      }
    })
    child.on('error', (error) => {
      this.fail(handlers, 'failed', error.message)
    })
    child.on('exit', () => {
      if (this.settled || this.reportedError) return
      this.fail(handlers, 'crashed', 'capture exited before ready')
    })
  }

  close(): void {
    this.settled = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
  }

  private fail(handlers: CaptureHandlers, reason: CaptureFailure, detail: string): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    handlers.onFailure(reason, detail)
  }
}

/** The previous node-cpal input. It does not cancel echo. */
export class CpalCapture implements CaptureSource {
  private stream: { close(): void, play(): void } | undefined
  private closed = false

  constructor(private readonly native: CpalNative) {}

  start(handlers: CaptureHandlers): void {
    try {
      const { cpal, sherpa } = this.native
      const device = cpal.defaultHost().defaultInputDevice()
      if (!device) {
        handlers.onFailure('no-device', 'no input device')
        return
      }
      const capture = pickCapture(cpal, device)
      const resampler = capture.needsResample ? new sherpa.LinearResampler(capture.rate, TARGET_RATE) : undefined
      const stream = device.buildInputStream(
        capture.config,
        cpal.SampleFormat.F32,
        (data: Float32Array) => {
          if (this.closed) return
          let mono = toMono(data, capture.channels)
          if (resampler) mono = resampler.resample(mono)
          handlers.onPcm(mono)
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('underrun') || message.includes('overrun')) {
            try { stream.play() } catch { /* the next error reports the real failure */ }
            return
          }
          handlers.onFailure('failed', message)
        },
      )
      handlers.onReady({ aec: false })
      stream.play()
      this.stream = stream
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      handlers.onFailure('failed', message)
    }
  }

  close(): void {
    this.closed = true
    const stream = this.stream
    this.stream = undefined
    try { stream?.close() } catch { /* the device may already be gone */ }
  }
}

function toMono(data: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return data
  const frames = Math.floor(data.length / channels)
  const out = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += data[frame * channels + channel] ?? 0
    out[frame] = sum / channels
  }
  return out
}

function pickCapture(cpal: any, device: any): { config: unknown, channels: number, rate: number, needsResample: boolean } {
  const ranges = [...device.supportedInputConfigs()]
  const f32 = ranges.filter((range: any) => range.sampleFormat() === cpal.SampleFormat.F32)
  const exact = f32.find((range: any) => range.channels() === 1 && range.containsRate(TARGET_RATE))
    ?? f32.find((range: any) => range.containsRate(TARGET_RATE))
  if (exact) {
    return {
      config: new cpal.StreamConfig({ channels: exact.channels(), sampleRate: TARGET_RATE, bufferSize: cpal.BufferSize.Default }),
      channels: exact.channels(),
      rate: TARGET_RATE,
      needsResample: false,
    }
  }
  const fallback = device.defaultInputConfig()
  const config = fallback.config()
  return { config, channels: config.channels, rate: config.sampleRate, needsResample: config.sampleRate !== TARGET_RATE }
}

/** The system-output tap helper (48 kHz mono Float32 on stdout). */
export function systemAudioBinary(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  const fromEnv = process.env.DSH_ORB_SYSTEM_AUDIO_BIN
  if (fromEnv) return fromEnv
  for (const url of [
    new URL('./prebuilds/darwin-universal/dsh-orb-system-audio', import.meta.url),
    new URL('../prebuilds/darwin-universal/dsh-orb-system-audio', import.meta.url),
  ]) {
    const path = fileURLToPath(url)
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Live system-output reference for the software AEC. The helper wraps a
 * CoreAudio process tap; its stdout is 48 kHz mono Float32, resampled here to
 * the canceller's 16 kHz clock. It does not change the default output device.
 */
export class SystemTapCapture {
  private child: ChildProcessWithoutNullStreams | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private settled = false
  private reportedError = false
  private ready = false
  private resampler: { resample(samples: Float32Array): Float32Array } | undefined
  private pending = Buffer.alloc(0)
  private rate = 48_000

  constructor(private readonly binary: string, private readonly native: CpalNative) {}

  start(handlers: {
    onPcm(samples: Float32Array): void
    onReady(info: { rate: number }): void
    onFailure(reason: CaptureFailure, detail: string): void
  }): void {
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.timer = setTimeout(() => {
      this.fail(handlers, 'unavailable', 'system audio ready timed out')
      child.kill()
    }, READY_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.settled) return
      this.pending = Buffer.concat([this.pending, chunk])
      if (this.ready) this.drain(handlers)
    })
    const lines = createInterface({ input: child.stderr })
    lines.on('line', (line) => {
      let message: { event?: string, rate?: unknown, code?: unknown, message?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        process.stderr.write(`${line}\n`)
        return
      }
      if (message.event === 'ready') {
        if (this.settled) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        this.rate = typeof message.rate === 'number' && message.rate > 0 ? message.rate : 48_000
        this.resampler = this.rate === TARGET_RATE
          ? undefined
          : new this.native.sherpa.LinearResampler(this.rate, TARGET_RATE)
        this.ready = true
        handlers.onReady({ rate: this.rate })
        this.drain(handlers)
        return
      }
      if (message.event === 'error') {
        const code = message.code
        const reason: CaptureFailure = code === 'unavailable' || code === 'no-device' || code === 'failed'
          ? code
          : 'failed'
        this.reportedError = true
        this.fail(handlers, reason, typeof message.message === 'string' ? message.message : reason)
      }
    })
    child.on('error', (error) => {
      this.fail(handlers, 'failed', error.message)
    })
    child.on('exit', () => {
      if (this.settled || this.reportedError) return
      this.fail(handlers, 'crashed', 'system audio exited before ready')
    })
  }

  close(): void {
    this.settled = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
    setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 500).unref()
  }

  private drain(handlers: { onPcm(samples: Float32Array): void }): void {
    const usable = this.pending.length - (this.pending.length % Float32Array.BYTES_PER_ELEMENT)
    if (usable < Float32Array.BYTES_PER_ELEMENT) return
    const slice = Buffer.from(this.pending.subarray(0, usable))
    this.pending = Buffer.from(this.pending.subarray(usable))
    const samples = new Float32Array(slice.buffer, slice.byteOffset, usable / Float32Array.BYTES_PER_ELEMENT)
    handlers.onPcm(this.resampler ? this.resampler.resample(samples) : samples)
  }

  private fail(handlers: { onFailure(reason: CaptureFailure, detail: string): void }, reason: CaptureFailure, detail: string): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    handlers.onFailure(reason, detail)
  }
}
