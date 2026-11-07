/**
 * One child process per chat session, plus the ref book that keeps the model
 * honest.
 *
 * Refs are snapshot-qualified (`@<snapshotId>:eN`), but they are only meaningful
 * to a model that has seen them. The book records exactly what each snapshot
 * rendered, so a ref the model never received is refused instead of being sent
 * to the library on a guess.
 * @module @dsh-orb/desktop/src/sessions
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { activateApp } from './activate.ts'
import { DesktopClient } from './client.ts'
import type { ResolvedConfig } from './config.ts'
import { clearRaised, raisedApp, type RaisedApp } from './guard.ts'
import { nativeKey, packagedNativeDir, stageNative } from './native-paths.ts'
import type { SnapshotData } from './protocol.ts'

/** Snapshots remembered per session. Older refs are refused. */
const REMEMBERED_SNAPSHOTS = 8

/** How often the maintenance tick runs. */
const TICK_MS = 5000

interface Remembered {
  readonly app: string
  readonly refs: ReadonlySet<string>
  readonly at: number
}

/** What one session may address, and which app each ref belongs to. */
export class RefBook {
  private readonly bySnapshot = new Map<string, Remembered>()

  /**
   * Remember the refs one snapshot put in front of the model.
   * @param snapshot - the observation.
   * @param refs - refs the renderer emitted.
   */
  remember(snapshot: SnapshotData, refs: readonly string[]): void {
    if (snapshot.snapshotId === '' || refs.length === 0) return
    this.bySnapshot.set(snapshot.snapshotId, {
      app: snapshot.app,
      refs: new Set(refs),
      at: Date.now(),
    })
    while (this.bySnapshot.size > REMEMBERED_SNAPSHOTS) {
      const oldest = this.bySnapshot.keys().next().value
      if (oldest === undefined) break
      this.bySnapshot.delete(oldest)
    }
  }

  /**
   * Resolve one ref to its app.
   * @param ref - qualified ref.
   * @returns the app and whether the model was shown this exact ref.
   */
  lookup(ref: string): { app: string; known: boolean } | undefined {
    const match = /^@([^:]+):/.exec(ref)
    if (match === null) return undefined
    const snapshotId = match[1]
    if (snapshotId === undefined) return undefined
    const entry = this.bySnapshot.get(snapshotId)
    if (entry === undefined) return undefined
    return { app: entry.app, known: entry.refs.has(ref) }
  }

  /** Drop every remembered snapshot. */
  clear(): void {
    this.bySnapshot.clear()
  }
}

/** One live session. */
export interface SessionEntry {
  readonly client: DesktopClient
  readonly refs: RefBook
  lastUsed: number
}

export interface SessionOptions {
  /** Entry script of the child host. Defaults to the sibling `host.js`. */
  readonly hostEntry?: string
  /** Node/Electron binary for the child. */
  readonly execPath?: string
  /** Extra child environment. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Owns every live child process.
 */
export class DesktopSessions {
  private readonly entries = new Map<string, SessionEntry>()
  private readonly config: ResolvedConfig
  private readonly options: SessionOptions
  private readonly timer: NodeJS.Timeout
  private disposed = false
  private libraryDir: string | undefined
  private libraryError: Error | undefined

  constructor(config: ResolvedConfig, options: SessionOptions = {}) {
    this.config = config
    this.options = options
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  /**
   * The child for one chat session, started on first use.
   * @param sessionId - DSH session id.
   * @returns the live entry.
   * @throws when the platform has no bundled library, or the child cannot start.
   */
  async entry(sessionId: string): Promise<SessionEntry> {
    const existing = this.entries.get(sessionId)
    if (existing !== undefined && existing.client.alive) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing !== undefined) this.entries.delete(sessionId)
    const libraryDir = this.library()
    const client = new DesktopClient({
      libraryDir,
      session: agentSessionId(sessionId),
      hostEntry: this.options.hostEntry ?? defaultHostEntry(),
      ...this.options.execPath !== undefined ? { execPath: this.options.execPath } : {},
      ...this.options.env !== undefined ? { env: this.options.env } : {},
      timeoutMs: 45_000,
    })
    const entry: SessionEntry = { client, refs: new RefBook(), lastUsed: Date.now() }
    this.entries.set(sessionId, entry)
    return entry
  }

  /** Live sessions, for the maintenance tick. */
  list(): readonly [string, SessionEntry][] {
    return [...this.entries.entries()]
  }

  /**
   * Give the foreground back if this session borrowed it.
   * @param sessionId - DSH session id.
   */
  async releaseForeground(sessionId: string): Promise<void> {
    const raised = raisedApp()
    if (raised === undefined || raised.owner !== sessionId) return
    clearRaised()
    await restore(raised)
  }

  /** Stop every child. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    const raised = raisedApp()
    if (raised !== undefined) {
      clearRaised()
      await restore(raised).catch(() => {})
    }
    await Promise.all([...this.entries.values()].map(entry => entry.client.close()))
    this.entries.clear()
  }

  /**
   * Stop children that have been idle too long, and return a borrowed
   * foreground after its deadline or the moment the user touches anything.
   */
  private async tick(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastUsed > this.config.idleCloseMs) {
        this.entries.delete(sessionId)
        await entry.client.close().catch(() => {})
        entry.refs.clear()
      }
    }
    const raised = raisedApp()
    if (raised === undefined) return
    if (now > raised.deadline) {
      clearRaised()
      await restore(raised)
      return
    }
    const entry = this.entries.get(raised.owner)
    if (entry === undefined) {
      clearRaised()
      await restore(raised)
      return
    }
    try {
      const presence = await entry.client.request<{ idleMs: number | null }>({ op: 'presence' }, 3000)
      const idle = presence?.idleMs ?? null
      if (idle !== null && idle < this.config.raiseIdleMs) {
        clearRaised()
        await restore(raised)
      }
    } catch {
      // A child that stopped answering is cleaned up by the idle sweep.
    }
  }

  private library(): string {
    if (this.libraryDir !== undefined) return this.libraryDir
    if (this.libraryError !== undefined) throw this.libraryError
    const key = nativeKey(process.platform, process.arch)
    if (key === undefined) {
      this.libraryError = new Error(
        `background desktop control is not available on ${process.platform}-${process.arch}`,
      )
      throw this.libraryError
    }
    const packaged = packagedNativeDir(key)
    if (packaged === undefined) {
      this.libraryError = new Error(
        'the bundled desktop library is missing. Run `pnpm --filter @dsh-orb/desktop fetch-native` and rebuild.',
      )
      throw this.libraryError
    }
    this.libraryDir = stageNative(packaged, key)
    return this.libraryDir
  }
}

/** agent-desktop accepts 1–64 alphanumerics, `-`, and `_`. */
export function agentSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
  return `dsh_${safe === '' ? 'session' : safe}`
}

function defaultHostEntry(): string {
  const url = new URL('./host.js', import.meta.url)
  if (!existsSync(fileURLToPath(url))) {
    throw new Error('desktop host entry is missing; run `pnpm build` for @dsh-orb/desktop')
  }
  return fileURLToPath(url)
}

async function restore(raised: RaisedApp): Promise<void> {
  if (raised.previous === undefined || raised.previous === '') return
  try {
    await activateApp(raised.previous)
  } catch {
    // The previous app is gone or refuses the foreground: nothing left to do.
  }
}