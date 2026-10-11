/**
 * Bookmark registry for `code_agent` background sessions, provided as the
 * app-level `codeAgentRegistry` service for the orb host's bookmark strip.
 * Lifetime is the host process: the strip shows what this process knows,
 * nothing older.
 * The provide lives in {@link apply} on purpose: `cordis.patch.yml` inserts
 * this module at the top level, outside every agent preset. A provide from a
 * preset-internal plugin lands in the root realm and the official preset-mount
 * audit rejects it ("Preset services require isolate realms").
 * @module @dsh-orb/computer-use/src/code-agent-registry
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { holdsPrompt, lastAssistantText, lastTurnEndedUserAborted } from './code-agent-completion.ts'

/** Cordis service name the orb host polls the bookmarks from. */
export const CODE_AGENT_REGISTRY = 'codeAgentRegistry'

/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
export const name = 'computer-use-code-agent-registry'

/** A finished stretch either delivered its outcome or was cancelled. */
export type CodeAgentBookmarkState = 'running' | 'completed' | 'stopped'

/** One background Code session as the ball's bookmark strip shows it. */
export interface CodeAgentBookmark {
  readonly sessionId: SessionId
  readonly callerId: SessionId
  readonly task: string
  readonly cwd: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly state: CodeAgentBookmarkState
  readonly outcome?: string
}

/** Cap on the outcome summary one bookmark carries; the full text lives in the session. */
export const BOOKMARK_OUTCOME_MAX_CHARS = 200

interface BookmarkRecord {
  readonly sessionId: SessionId
  callerId: SessionId
  task: string
  cwd: string
  requestId: SessionRequestId
  watch: AbortController | undefined
  agent: Agent | undefined
  startedAt: number
  endedAt: number | undefined
  state: CodeAgentBookmarkState
  outcome: string | undefined
  detach: (() => void) | undefined
}

export interface CodeAgentBookmarkRegistry {
  record(entry: {
    readonly sessionId: SessionId
    readonly callerId: SessionId
    readonly task: string
    readonly cwd: string
    readonly requestId: SessionRequestId
    readonly watch?: AbortController
    readonly agent?: Agent
  }): void
  dropCaller(callerId: SessionId): void
  markStopped(sessionId: SessionId): void
  list(): readonly CodeAgentBookmark[]
}

/**
 * One registry per host process. `code_agent`'s apply may run again (plugin
 * re-apply, tests); every caller records into the same instance so the host
 * always reads the live set.
 */
let shared: CodeAgentBookmarkRegistry | undefined

export function sharedCodeAgentRegistry(): CodeAgentBookmarkRegistry {
  shared ??= createCodeAgentRegistry()
  return shared
}

/**
 * Publish the process-wide registry as an app-level service.
 * Inserted at the top level of the patch (never inside a preset) so the orb
 * host — also top level — can read it across the preset boundary.
 */
export function apply(ctx: Context): void {
  ctx.provide(CODE_AGENT_REGISTRY, sharedCodeAgentRegistry())
}

export function createCodeAgentRegistry(): CodeAgentBookmarkRegistry {
  const records = new Map<SessionId, BookmarkRecord>()
  return {
    record(entry) {
      const previous = records.get(entry.sessionId)
      if (previous !== undefined) detachRecord(previous)
      const record: BookmarkRecord = {
        sessionId: entry.sessionId,
        callerId: entry.callerId,
        task: entry.task,
        cwd: entry.cwd,
        requestId: entry.requestId,
        watch: entry.watch,
        agent: entry.agent,
        startedAt: Date.now(),
        endedAt: undefined,
        state: 'running',
        outcome: undefined,
        detach: undefined,
      }
      records.set(entry.sessionId, record)
      subscribe(record)
      // The stretch may have started (or even finished) between the accepted
      // prompt and this record; one immediate pass avoids a missed transition.
      evaluate(record)
    },
    dropCaller(callerId) {
      for (const [sessionId, record] of records) {
        if (record.callerId !== callerId) continue
        detachRecord(record)
        records.delete(sessionId)
      }
    },
    markStopped(sessionId) {
      const record = records.get(sessionId)
      if (record !== undefined) stopRecord(record)
    },
    list() {
      const items: CodeAgentBookmark[] = []
      for (const record of records.values()) {
        // Re-derive on every read so a missed event heals at the next poll.
        evaluate(record)
        items.push({
          sessionId: record.sessionId,
          callerId: record.callerId,
          task: record.task,
          cwd: record.cwd,
          startedAt: record.startedAt,
          state: record.state,
          ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
          ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
        })
      }
      return items
    },
  }
}

/** Fold one live status into the record's state. Queued prompts are still running. */
function evaluate(record: BookmarkRecord): void {
  if (record.state === 'stopped') return
  if (record.watch?.signal.aborted === true) {
    stopRecord(record)
    return
  }
  const agent = record.agent
  if (agent === undefined) return
  if (agent.status === 'running') {
    record.state = 'running'
    return
  }
  if (holdsPrompt(agent, record.requestId)) return
  completeRecord(record, agent)
}

function stopRecord(record: BookmarkRecord): void {
  record.state = 'stopped'
  record.endedAt ??= Date.now()
  detachRecord(record)
}

function completeRecord(record: BookmarkRecord, agent: Agent): void {
  if (lastTurnEndedUserAborted(agent)) {
    // The user stopped this stretch from the main window: same surface as
    // code_agent_stop, and the caller's notice says not to relaunch.
    stopRecord(record)
    return
  }
  record.state = 'completed'
  record.endedAt ??= Date.now()
  record.outcome = capOutcome(lastAssistantText(agent))
  detachRecord(record)
}

function detachRecord(record: BookmarkRecord): void {
  record.detach?.()
  record.detach = undefined
}

function subscribe(record: BookmarkRecord): void {
  detachRecord(record)
  const agent = record.agent
  if (agent === undefined) return
  const disposers: (() => void)[] = []
  try {
    const off = agent.ctx.on('agent/status', () => evaluate(record))
    if (typeof off === 'function') disposers.push(off)
  } catch {
    // Test fakes may not carry the status event.
  }
  try {
    const off = agent.ctx.on('agent/disposed', () => {
      if (record.state === 'stopped') return
      record.state = 'completed'
      record.endedAt ??= Date.now()
      try {
        record.outcome = capOutcome(lastAssistantText(agent))
      } catch {
        // A disposed agent may no longer expose its messages.
      }
      detachRecord(record)
    })
    if (typeof off === 'function') disposers.push(off)
  } catch {
    // Test fakes may not carry the disposal event.
  }
  record.detach = () => {
    for (const off of disposers.splice(0)) off()
  }
}

function capOutcome(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.length <= BOOKMARK_OUTCOME_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, BOOKMARK_OUTCOME_MAX_CHARS - 1)}…`
}
