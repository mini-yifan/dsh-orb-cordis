/**
 * Park a plugin followup on the Computer Use caller until both the delegated
 * Code session and the caller are idle.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/code-agent-completion
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': { kind: 'computer-use' } & ContextFormed
  }
}
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'

/** Plugin id recorded on the parked completion notice. */
export const COMPLETION_PLUGIN = 'tool-code-agent'

/** Model-facing body cap for one completion notice. */
export const COMPLETION_BODY_MAX_CHARS = 4000

const NO_ASSISTANT = 'The Code agent session ended without a final assistant message.'

/**
 * Appended when another Computer Use session holds a turn at delivery time. Without it the woken
 * caller would resume GUI work — possibly on a chat the user abandoned — and fight the session the
 * user is watching for the mouse and keyboard.
 */
const SCREEN_BUSY_SUFFIX =
  'Another Computer Use chat is operating the screen right now. '
  + 'Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.'

/**
 * Host agent registry methods the watch uses after `session.prompt` accepts. `list` and
 * `isOwnedBy` exist on the live `AgentRegistry`; test fakes may omit them.
 */
export interface CodeAgentLookup {
  get(id: SessionId): Agent | undefined
  withoutInitiator<T>(operation: () => T): T
  list?(): readonly Agent[]
}

/** One accepted `code_agent` prompt and the two live Agents that own its interval. */
export interface CodeAgentCompletionWatch {
  readonly caller: Agent
  readonly code: Agent
  readonly agents: CodeAgentLookup
  readonly task: string
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
}

/**
 * Start a caller-owned watch that delivers one plugin notice after the Code
 * session's next idle and the Computer Use caller is idle. Does not throw;
 * missing context or a disposed caller drops the notice.
 * @param watch - live caller, live Code agent, and the accepted prompt.
 * @returns the abort controller for this interval, or undefined when the
 *   watch could not be owned.
 */
export function watchCodeAgentCompletion(watch: CodeAgentCompletionWatch): AbortController | undefined {
  const abort = new AbortController()
  try {
    watch.caller.ctx.effect(() => {
      return () => {
        abort.abort()
      }
    })
  } catch {
    // Computer Use agent context already disposed; no owner for the watch.
    return undefined
  }
  try {
    watch.agents.withoutInitiator(() => {
      void runWatch(watch, abort.signal)
    })
  } catch {
    // Agent initiator scope is closing; a watch would outlive its owner.
    abort.abort()
    return undefined
  }
  return abort
}

async function runWatch(watch: CodeAgentCompletionWatch, signal: AbortSignal): Promise<void> {
  try {
    if (await raceAbort(signal, waitUntilIntervalStarts(watch.code, watch.requestId, signal)) === 'aborted') {
      return
    }
    if (await raceAbort(signal, watch.code.whenIdle()) === 'aborted') return
    const userStopped = lastTurnEndedUserAborted(watch.code)
    const outcome = lastAssistantText(watch.code) ?? NO_ASSISTANT
    if (await raceAbort(signal, watch.caller.whenIdle()) === 'aborted') return
    if (watch.agents.get(watch.caller.id) !== watch.caller) return
    watch.caller.followup(createUserMessage({
      content: [{
        type: 'text',
        text: completionNoticeText(watch.sessionId, watch.task, outcome, anotherComputerUseRunning(watch), userStopped),
      }],
      source: {
        kind: 'computer-use',
        form: 'notice',
        summary: boundContextSummary(userStopped
          ? `Code agent ${watch.sessionId} stopped by the user`
          : `Code agent ${watch.sessionId} finished`),
      },
    }))
  } catch (error) {
    if (signal.aborted) return
    try {
      watch.caller.ctx.logger.warn(`code_agent: completion watch failed: ${String(error)}`)
    } catch {
      // Test fakes and disposed contexts may have no logger.
    }
  }
}

/**
 * The Code interval has started once this request's prompt is no longer queued. A running
 * status is not enough: a follow-up prompt can sit in the inbox while the previous stretch
 * still runs, and watching for idle then would end in the gap before it starts.
 */
function intervalHasStarted(code: Agent, requestId: SessionRequestId): boolean {
  return !holdsPrompt(code, requestId)
}

/** Whether the accepted prompt is still parked in the inbox (queued, not started or finished). */
export function holdsPrompt(code: Agent, requestId: SessionRequestId): boolean {
  return messageHasRpc(code.inbox.nextTurn, requestId) || messageHasRpc(code.inbox.nextStep, requestId)
}

function messageHasRpc(messages: readonly UserMessage[], requestId: SessionRequestId): boolean {
  return messages.some(message => (
    message.source.kind === 'user'
    && 'rpcId' in message.source
    && message.source.rpcId === requestId
  ))
}

async function waitUntilIntervalStarts(
  code: Agent,
  requestId: SessionRequestId,
  signal: AbortSignal,
): Promise<void> {
  if (intervalHasStarted(code, requestId) || signal.aborted) return
  await new Promise<void>((resolve) => {
    let done = false
    let disposeStatus = (): void => {}
    let disposeDisposed = (): void => {}
    const finish = (): void => {
      if (done) return
      done = true
      disposeStatus()
      disposeDisposed()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    disposeStatus = code.ctx.on('agent/status', () => {
      if (intervalHasStarted(code, requestId)) finish()
    })
    disposeDisposed = code.ctx.on('agent/disposed', finish)
    signal.addEventListener('abort', finish, { once: true })
    if (intervalHasStarted(code, requestId) || signal.aborted) finish()
  })
}

async function raceAbort(signal: AbortSignal, work: Promise<void>): Promise<'aborted' | 'done'> {
  if (signal.aborted) return 'aborted'
  const abort = Promise.withResolvers<'aborted'>()
  const onAbort = (): void => {
    abort.resolve('aborted')
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([work.then(() => 'done' as const), abort.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Newest non-empty assistant text of the session, or undefined when none exists. */
export function lastAssistantText(code: Agent): string | undefined {
  const messages = code.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Whether the session's last closed turn was aborted by a user cancellation.
 * The main window's stop button cancels with cause 'user' and the durable
 * turn/end record carries that cause; repair-synthesized closers flatten it,
 * which reads as not-user.
 */
export function lastTurnEndedUserAborted(agent: Agent): boolean {
  try {
    const events = (agent.session as {
      snapshotEvents?: () => readonly unknown[]
    }).snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = asRecord(events[index])
      if (event?.type !== 'turn/end') continue
      const reason = asRecord(event.data)?.reason
      if (asRecord(reason)?.kind !== 'aborted') return false
      return asRecord(asRecord(reason)?.reason)?.kind === 'user'
    }
    return false
  } catch {
    // Test fakes and odd sessions may not expose the event log.
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Whether a Computer Use session other than the caller currently holds a turn.
 * The caller's own background Code sessions are standard-preset, so they never
 * count; a registry without `list` (test fakes) reads as an empty screen.
 */
function anotherComputerUseRunning(watch: CodeAgentCompletionWatch): boolean {
  const agents = watch.agents.list?.() ?? []
  return agents.some(other => (
    other.id !== watch.caller.id
    && other.status === 'running'
    && presetOf(other) === 'computer-use'
  ))
}

/** Session preset of a live agent, tolerant of test fakes that carry no header. */
function presetOf(agent: Agent): string | undefined {
  const session = agent.session as Session | undefined
  return session?.header?.agentPreset
}

function completionNoticeText(
  sessionId: SessionId,
  task: string,
  outcome: string,
  screenBusy: boolean,
  userStopped: boolean,
): string {
  const body = userStopped
    ? `The user stopped background Code agent session ${sessionId} from the main window:\n${task}\n\nLast output before it stopped:\n${outcome}`
    : `Background Code agent session ${sessionId} finished this task:\n${task}\n\n${outcome}`
  const capped = body.length <= COMPLETION_BODY_MAX_CHARS
    ? body
    : `${body.slice(0, COMPLETION_BODY_MAX_CHARS - 1)}…`
  // Appended after the cap so the instructions survive a truncated outcome.
  const guard = userStopped
    ? '\n\nDo not restart this task and do not call code_agent for it again unless the user asks.'
    : ''
  return `${capped}${guard}${screenBusy ? `\n\n${SCREEN_BUSY_SUFFIX}` : ''}`
}
