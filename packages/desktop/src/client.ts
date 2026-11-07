/**
 * Parent side of the child-process protocol.
 *
 * One client owns one child and one agent-desktop session. Requests are
 * sequential per client (the guard serializes callers); the promise resolves on
 * the matching response line or rejects on timeout, child exit, or a startup
 * failure the child reported before any request was sent.
 * @module @dsh-orb/desktop/src/client
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { HostError, HostRequest, HostResponse } from './protocol.ts'

/** Default per-request budget. A cold Chromium tree can take 10–25 s. */
export const DEFAULT_TIMEOUT_MS = 45_000

/** How much stderr is kept for a failure report. */
const STDERR_TAIL_BYTES = 4000

export interface ClientOptions {
  /** Folder holding the staged library and its helper. */
  readonly libraryDir: string
  /** agent-desktop session id. */
  readonly session: string
  /** Entry script of the child host. */
  readonly hostEntry: string
  /** Node or Electron binary used for the child. */
  readonly execPath?: string
  /** Extra environment (the koffi copy directory, a home override). */
  readonly env?: Readonly<Record<string, string>>
  /** Per-request budget. */
  readonly timeoutMs?: number
}

/** A failure that already carries a model-facing code. */
export class DesktopClientError extends Error {
  readonly code: string
  readonly suggestion?: string

  constructor(error: HostError) {
    super(error.message)
    this.name = 'DesktopClientError'
    this.code = error.code
    if (error.suggestion !== undefined) this.suggestion = error.suggestion
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/** One child process speaking NDJSON. */
export class DesktopClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly startup: { error?: Error } = {}
  private nextId = 1
  private closed = false
  private stderrTail = ''
  private readonly timeoutMs: number

  constructor(options: ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.child = spawn(options.execPath ?? process.execPath, [options.hostEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_ORB_DESKTOP_LIB: options.libraryDir,
        DSH_ORB_DESKTOP_SESSION: options.session,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => this.onLine(line))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES)
    })
    this.child.on('error', (error) => this.failAll(error))
    this.child.on('exit', (code, signal) => {
      const detail = this.stderrTail.trim()
      const suffix = detail === '' ? '' : `: ${detail.split('\n').slice(-3).join(' | ')}`
      this.failAll(new Error(`desktop host exited (${code ?? signal ?? 'unknown'})${suffix}`))
    })
  }

  /** Whether the child can still take requests. */
  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * Send one request and wait for its response.
   * @param request - op and arguments.
   * @param timeoutMs - override for this request (waits use their own budget).
   * @returns the response payload.
   * @throws {DesktopClientError} when the host reports a coded failure.
   */
  request<T = unknown>(request: HostRequest, timeoutMs?: number): Promise<T> {
    if (!this.alive) {
      const startupError = this.startup.error
      return Promise.reject(startupError ?? new Error('desktop host is not running'))
    }
    const id = this.nextId++
    const budget = timeoutMs ?? this.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DesktopClientError({
          code: 'TIMEOUT',
          message: `desktop host did not answer ${String(request.op)} within ${budget} ms`,
          suggestion: 'The target app may be busy. Retry once, or report that it is unresponsive.',
          resultCode: -9,
        }))
      }, budget)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      })
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (error === null || error === undefined) return
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(error)
      })
    })
  }

  /**
   * Ask the host to tear down its adapter and exit.
   * Safe to call twice; the second call resolves immediately.
   */
  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.request({ op: 'shutdown' }, 2000)
    } catch {
      // A child that will not answer is killed below.
    }
    this.closed = true
    this.failAll(new Error('desktop host closed'))
    this.child.kill('SIGTERM')
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill('SIGKILL')
    }, 2000).unref()
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (text === '') return
    let message: (HostResponse & { id?: number }) | { ok: false; error: HostError }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (!('id' in message) || typeof message.id !== 'number') {
      // Startup failure: the child reports before any request can be matched.
      const error = 'error' in message ? message.error : undefined
      if (error !== undefined) this.startup.error = new DesktopClientError(error)
      return
    }
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.data)
    else entry.reject(new DesktopClientError(message.error))
  }

  private failAll(error: Error): void {
    if (this.pending.size === 0) return
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}