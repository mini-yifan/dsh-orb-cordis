/**
 * Model-facing tools for silent desktop control.
 *
 * Every tool follows the same shape: read the OS state once, ask the ownership
 * guard, then act. Nothing here moves the mouse or takes keyboard focus; the
 * only foreground change the agent can request is the explicit `desktop_raise`
 * borrow, and even that is refused while the user is active.
 * @module @dsh-orb/desktop/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { DesktopClient } from './client.ts'
import type { ResolvedConfig } from './config.ts'
import { actionText, denialText, failureText } from './errors.ts'
import {
  acquireLease,
  decideMutation,
  decideRaise,
  leaseOwner,
  markRaised,
  raisedApp,
  refreshLease,
  releaseLease,
  screenLockOwner,
} from './guard.ts'
import { chooseWindow } from './frame.ts'
import { POLICY } from './ffi.ts'
import { renderSnapshot } from './render.ts'
import type { ActionKind, ActionRequest, AppInfo, HostError, SnapshotData } from './protocol.ts'
import type { DesktopSessions, SessionEntry } from './sessions.ts'
import { activateApp } from './activate.ts'

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

interface Call {
  readonly sessionId: string
  readonly entry: SessionEntry
  readonly client: DesktopClient
}

interface OsState {
  readonly idleMs: number | null
  readonly app: string | null
}

function agentId(exec: { agent?: { id?: string } }): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id === '') {
    throw new Error('these tools only work from a chat session')
  }
  return id
}

async function callOf(exec: { agent?: { id?: string } }, sessions: DesktopSessions): Promise<Call> {
  const sessionId = agentId(exec)
  const entry = await sessions.entry(sessionId)
  return { sessionId, entry, client: entry.client }
}

async function osState(client: DesktopClient): Promise<OsState> {
  const value = await client.request<{ idleMs?: number | null; app?: string | null }>({ op: 'state' })
  return { idleMs: value.idleMs ?? null, app: value.app ?? null }
}

function asHostError(error: unknown): HostError {
  const value = error as { code?: string; message?: string }
  return { code: value.code ?? 'INTERNAL', message: value.message ?? String(error), resultCode: 0 }
}

/**
 * Check ownership before a mutation, then take the app lease.
 * @param call - calling session.
 * @param app - target application.
 * @param config - tunables.
 */
async function gate(call: Call, app: string, config: ResolvedConfig): Promise<void> {
  const decision = decideMutation({
    app,
    owner: call.sessionId,
    leaseHolder: leaseOwner(app, config),
    screenLockOwner: screenLockOwner(),
  })
  if (!decision.allow) throw new Error(denialText(decision))
  if (!acquireLease(app, call.sessionId, config)) {
    throw new Error(denialText({
      code: 'APP_BUSY',
      message: `Another background task is operating ${app}.`,
      suggestion: 'Leave this app alone for now and do something else, or finish without it.',
    }))
  }
}

/** The library names keys in lower case; models write `Return` and `Escape`. */
const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  tab: 'tab',
  space: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
}

/**
 * Normalize a model-supplied key name.
 * @param key - raw key.
 * @returns the library's name for it.
 */
export function normalizeKey(key: string): string {
  const trimmed = key.trim()
  const lower = trimmed.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/** Whether this action submits something whose result cannot be undone. */
export function isSubmitAction(action: ActionRequest): boolean {
  return action.kind === 'press_key' && normalizeKey(action.key ?? '') === 'enter'
}

interface EffectRecord {
  readonly at: number
  /** False only when the library said nothing was delivered. */
  readonly landed: boolean
}

function actionOf(input: {
  action: ActionKind
  text?: string
  key?: string
  modifiers?: readonly string[]
  direction?: string
  amount?: number
}): ActionRequest {
  const action: {
    kind: ActionKind
    text?: string
    key?: string
    modifiers?: readonly import('./protocol.ts').Modifier[]
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
  } = { kind: input.action }
  if (input.text !== undefined) action.text = input.text
  if (input.key !== undefined) action.key = input.key
  if (input.modifiers !== undefined && input.modifiers.length > 0) {
    action.modifiers = input.modifiers as readonly import('./protocol.ts').Modifier[]
  }
  if (input.direction !== undefined) action.direction = input.direction as 'up' | 'down' | 'left' | 'right'
  if (input.amount !== undefined) action.amount = input.amount
  if (action.kind === 'type_text' || action.kind === 'set_value') {
    if (action.text === undefined) throw new Error(`${action.kind} needs text`)
  }
  if (action.kind === 'press_key' && (action.key === undefined || action.key === '')) {
    throw new Error('press_key needs key')
  }
  if (action.kind === 'scroll' && action.direction === undefined) {
    throw new Error('scroll needs direction')
  }
  return action as ActionRequest
}

/**
 * Register the background desktop tools on the calling preset.
 * @param ctx - plugin context carrying the tool registry.
 * @param sessions - child-process owner.
 * @param config - resolved tunables.
 */
export interface ToolDependencies {
  /** Bring one app to the front. Injected so tests never touch the real desktop. */
  readonly activate?: (app: string) => Promise<void>
}

export function registerDesktopTools(
  ctx: Context,
  sessions: DesktopSessions,
  config: ResolvedConfig,
  dependencies: ToolDependencies = {},
): void {
  const activate = dependencies.activate ?? activateApp
  let holdTimer: NodeJS.Timeout | undefined
  const effects = new Map<string, EffectRecord>()

  /**
   * Draw the warm ribbon around the window this action touches, when the helper
   * is available. The ribbon is a courtesy signal: it never blocks the action.
   */
  const showRibbon = async (
    call: Call,
    app: string,
    target: { windowId?: string; windowTitle?: string } = {},
  ): Promise<void> => {
    const frame = ctx.get('backgroundFrame') as
      | { show(bounds: { x: number; y: number; width: number; height: number }, label: string): Promise<void>; hide(): Promise<void> }
      | undefined
    if (frame === undefined) return
    try {
      const windows = await call.client.request<readonly import('./protocol.ts').WindowInfo[]>({
        op: 'windows',
        app,
      })
      const window = chooseWindow(windows, target)
      if (window?.bounds === undefined) return
      await frame.show(window.bounds, `后台操作中 · ${app}`)
      if (holdTimer !== undefined) clearTimeout(holdTimer)
      holdTimer = setTimeout(() => {
        holdTimer = undefined
        void frame.hide()
      }, config.frameHoldMs)
      holdTimer.unref()
    } catch {
      // No helper, no bounds, or the ribbon window is gone: the action still stands.
    }
  }

  ctx.effect(() => () => {
    if (holdTimer !== undefined) clearTimeout(holdTimer)
    const frame = ctx.get('backgroundFrame') as { hide(): Promise<void> } | undefined
    void frame?.hide()
  })
  ctx.tools.register(defineTool({
    name: 'desktop_status',
    description:
      'Report whether silent desktop control is usable on this machine: accessibility permission, the app in front, '
      + 'how long the user has been idle, and whether this session currently holds a window. '
      + 'Call this first when a desktop step fails for an unexplained reason.',
    parameters: {},
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const call = await callOf(exec, sessions)
      try {
        const status = await call.client.request<{
          permissions?: { accessibility?: { state?: string } }
          platform?: string
          version?: string
        }>({ op: 'status' })
        const state = await osState(call.client)
        const raised = raisedApp()
        const held = raised !== undefined && raised.owner === call.sessionId
        const lines = [
          `platform: ${status.platform ?? process.platform}`,
          `accessibility: ${status.permissions?.accessibility?.state ?? 'unknown'}`,
          `library: ${status.version ?? 'unknown'}`,
          `frontmost: ${state.app ?? 'none'}`,
          `user idle: ${state.idleMs === null ? 'unknown' : `${Math.round(state.idleMs / 1000)} s`}`,
          `borrowed window: ${held ? (raised?.app ?? 'none') : 'none'}`,
        ]
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `desktop_status failed\n${failureText(asHostError(error))}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_apps',
    description:
      'List the applications currently running on this machine. Use the exact name it returns with desktop_snapshot, '
      + 'desktop_raise, and desktop_act.',
    parameters: {},
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const call = await callOf(exec, sessions)
      try {
        const apps = await call.client.request<readonly AppInfo[]>({ op: 'apps' })
        if (apps.length === 0) return { text: 'no applications reported' }
        const lines = apps.map(app => `${app.name} (pid ${app.pid})${app.bundleId === undefined ? '' : ` · ${app.bundleId}`}`)
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `desktop_apps failed\n${failureText(asHostError(error))}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_snapshot',
    description:
      'Read one application\'s interface as a text tree. Every actionable element shows its role, its name, and a ref '
      + 'like {@s1z2:e4}. Start with depth 2–3 for a map; deeper levels add detail and tokens. '
      + 'Refs die as soon as the interface changes, so snapshot again after any action that changes the screen. '
      + 'Reading the app the user is working in is allowed, but never operate it.',
    parameters: {
      app: {
        type: 'string',
        description: 'Application name from desktop_apps. Omit to read the window that is in front.',
      },
      depth: {
        type: 'integer',
        default: 3,
        description: 'How many levels to read, 1–8. Default: 3.',
      },
      max_nodes: {
        type: 'integer',
        description: 'Most nodes to render. Default: 140.',
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      try {
        const depth = Math.min(8, Math.max(1, args.depth ?? 3))
        const snapshot = await call.client.request<SnapshotData>({
          op: 'snapshot',
          ...args.app !== undefined && args.app !== '' ? { app: args.app } : {},
          depth,
          interactive: true,
          compact: true,
        })
        const rendered = renderSnapshot(snapshot, {
          maxNodes: args.max_nodes ?? config.maxNodes,
          maxChars: config.maxChars,
        })
        call.entry.refs.remember(snapshot, rendered.refs, rendered.elements)
        return { text: rendered.text }
      } catch (error) {
        return { text: `desktop_snapshot failed\n${failureText(asHostError(error))}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_act',
    description:
      'Operate one element by the ref a snapshot showed you. Actions: click, double_click, right_click, set_value, '
      + 'type_text, press_key, scroll, toggle, check, uncheck, expand, collapse, select, clear. '
      + 'Prefer set_value over type_text for fields that accept a value. Actions run headless first: no mouse movement, '
      + 'no focus stealing. If a control exposes no semantic action and its window is in front, the call retries once '
      + 'with physical input and says so in the result. '
      + 'The same action on the same control is refused for about 12 seconds after it may have landed, so never repeat '
      + 'a click or Enter to "make sure": a submit result already tells you to confirm with desktop_wait or a fresh '
      + 'snapshot instead. Key names are case-insensitive; Return is accepted for enter.',
    parameters: {
      ref: { type: 'string', required: true, description: 'A fully qualified ref from the latest snapshot.' },
      action: {
        type: 'string',
        required: true,
        enum: [
          'click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key',
          'scroll', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'select', 'clear',
        ],
        description: 'What to do with the element.',
      },
      text: { type: 'string', description: 'Text for set_value or type_text.' },
      key: { type: 'string', description: 'Named key for press_key, for example s or Return.' },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Modifiers for press_key: cmd, ctrl, alt, shift.',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Direction for scroll.',
      },
      amount: { type: 'integer', description: 'Scroll amount. Default: 3.' },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const known = call.entry.refs.lookup(args.ref)
      if (known === undefined) {
        return { text: 'UNKNOWN_REF: that ref belongs to no snapshot this session took. Call desktop_snapshot first.' }
      }
      if (!known.known) {
        return {
          text: 'REF_NOT_SHOWN: that ref was not in the snapshot text you received. '
            + 'Use a ref that appears in the latest snapshot, or snapshot again.',
        }
      }
      const action = actionOf({
        action: args.action as ActionKind,
        ...args.text !== undefined ? { text: args.text } : {},
        ...args.key !== undefined ? { key: normalizeKey(args.key) } : {},
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
        ...args.direction !== undefined ? { direction: args.direction } : {},
        ...args.action === 'scroll' ? { amount: args.amount ?? 3 } : {},
      })
      const effectKey = [
        call.sessionId,
        known.app,
        known.role ?? '',
        known.name ?? '',
        action.kind,
        action.text ?? action.key ?? '',
      ].join('\u0000')
      const previous = effects.get(effectKey)
      if (previous !== undefined && previous.landed && Date.now() - previous.at < config.repeatWindowMs) {
        return {
          text: 'IDENTICAL_ACTION: the same action on the same control already ran '
            + `${Math.round((Date.now() - previous.at) / 1000)}s ago and may have landed. `
            + 'Do not repeat it. Confirm the result with desktop_wait (kind=text) or a fresh desktop_snapshot; '
            + 'if the result is visible, continue from there.',
        }
      }
      try {
        await gate(call, known.app, config)
        await showRibbon(call, known.app, {
          ...known.windowId !== undefined ? { windowId: known.windowId } : {},
          ...known.windowTitle !== undefined ? { windowTitle: known.windowTitle } : {},
        })
        let data: unknown
        let escalated = false
        try {
          data = await call.client.request({ op: 'act', ref: args.ref, action, policy: POLICY.headless })
        } catch (error) {
          const hostError = asHostError(error)
          // Only pointer and key delivery may escalate: a physical click makes no sense for
          // a value write, and escalating one would turn a harmless refusal into a stray click.
          const escalatable = action.kind === 'click' || action.kind === 'double_click'
            || action.kind === 'right_click' || action.kind === 'press_key'
          const retryable = escalatable
            && (hostError.code === 'POLICY_DENIED' || hostError.code === 'ACTION_NOT_SUPPORTED')
          const state = retryable ? await osState(call.client) : undefined
          const borrowed = raisedApp()?.owner === call.sessionId && raisedApp()?.app === known.app
          const inFront = state?.app === known.app || borrowed
          if (!retryable || !config.physicalFallback || !inFront) throw error
          // The control has no semantic path, but the window is in front: deliver with
          // real input, exactly like a person would. The ribbon already marks the window.
          data = await call.client.request({
            op: 'act',
            ref: args.ref,
            action,
            policy: POLICY.headed,
            // Do not sit in the library's 5 s preflight when the control never becomes usable.
            timeout_ms: 2_000,
          })
          escalated = true
        }
        effects.set(effectKey, { at: Date.now(), landed: true })
        refreshLease(known.app, call.sessionId)
        const lines = [actionText(data)]
        if (escalated) lines.push('note: semantic control was unavailable; this ran as physical input.')
        if (isSubmitAction(action)) {
          lines.push(
            'note: a submit was sent. Give the app a moment, then confirm with desktop_wait (kind=text)'
            + ' or a fresh snapshot. Never press it again to "make sure".',
          )
        }
        return { text: lines.join('\n') }
      } catch (error) {
        const hostError = asHostError(error)
        effects.set(effectKey, {
          at: Date.now(),
          landed: hostError.delivery !== 'not_delivered' && hostError.code !== 'INVALID_ARGS',
        })
        releaseLease(known.app, call.sessionId)
        return { text: `desktop_act failed\n${failureText(hostError)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_wait',
    description:
      'Wait for the interface to change instead of sleeping: a pause, a window title, text on screen, or an element state. '
      + 'Use it after an action that opens a dialog, a window, or a menu.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['pause', 'window', 'text', 'element'],
        description: 'What to wait for.',
      },
      ms: { type: 'integer', description: 'Milliseconds for kind=pause.' },
      title: { type: 'string', description: 'Window title fragment for kind=window.' },
      text: { type: 'string', description: 'Visible text for kind=text.' },
      ref: { type: 'string', description: 'Element ref for kind=element.' },
      predicate: {
        type: 'string',
        enum: ['exists', 'enabled', 'visible', 'actionable', 'value'],
        description: 'Element state to wait for. Default: exists.',
      },
      value: { type: 'string', description: 'Expected value for predicate=value.' },
      app: { type: 'string', description: 'Application to scope the wait to.' },
      timeout_ms: { type: 'integer', description: 'Give up after this long. Default: 30000.' },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const timeout = Math.min(120_000, Math.max(200, args.timeout_ms ?? 30_000))
      const wait = args.kind === 'pause'
        ? { kind: 'pause' as const, ms: Math.min(10_000, Math.max(0, args.ms ?? 500)) }
        : args.kind === 'window'
          ? {
            kind: 'window' as const,
            title: args.title ?? '',
            ...args.app !== undefined ? { app: args.app } : {},
            timeoutMs: timeout,
          }
          : args.kind === 'text'
            ? {
              kind: 'text' as const,
              text: args.text ?? '',
              ...args.app !== undefined ? { app: args.app } : {},
              timeoutMs: timeout,
            }
            : {
              kind: 'element' as const,
              ref: args.ref ?? '',
              ...args.predicate !== undefined ? { predicate: args.predicate } : {},
              ...args.value !== undefined ? { value: args.value } : {},
              timeoutMs: timeout,
            }
      try {
        const data = await call.client.request({ op: 'wait', wait }, timeout + 5000)
        const payload = (data ?? {}) as { found?: boolean; count?: number; elapsed_ms?: number }
        const parts = [`wait ${args.kind} finished`]
        if (payload.found !== undefined) parts.push(`found=${String(payload.found)}`)
        if (payload.count !== undefined) parts.push(`count=${payload.count}`)
        if (payload.elapsed_ms !== undefined) parts.push(`${payload.elapsed_ms} ms`)
        return { text: parts.join(' · ') }
      } catch (error) {
        return { text: `desktop_wait failed\n${failureText(asHostError(error))}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_raise',
    description:
      'Borrow the foreground for one app, for the cases where headless control cannot work (a control that needs its '
      + 'window in front). Allowed only while the user is idle; the window is returned automatically after 90 seconds or '
      + 'as soon as the user touches the keyboard or mouse. Never use it on an app the user is working in — that request '
      + 'is refused. Mention it to the user when the task is long enough to notice the window move.',
    parameters: {
      app: { type: 'string', required: true, description: 'Application name from desktop_apps.' },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const state = await osState(call.client)
      const decision = decideRaise({
        app: args.app,
        owner: call.sessionId,
        raised: raisedApp(),
        screenLockOwner: screenLockOwner(),
      })
      if (!decision.allow) return { text: denialText(decision) }
      if (state.app === args.app) {
        return { text: `${args.app} is already in front; nothing was borrowed. Work on it directly.` }
      }
      try {
        await activate(args.app)
      } catch (error) {
        return {
          text: `RAISE_FAILED: the system refused to bring ${args.app} to the front. `
            + `Do not use tricks to force it. Wait for the user to open it, or report back.\n`
            + `${error instanceof Error ? error.message : String(error)}`,
        }
      }
      // Activation is asynchronous: give the window manager a moment, but never
      // force the issue when the system keeps saying no.
      let after = await osState(call.client)
      for (let attempt = 0; attempt < 3 && after.app !== args.app; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 300))
        after = await osState(call.client)
      }
      if (after.app !== args.app) {
        return {
          text: `RAISE_FAILED: ${args.app} did not come to the front. It stays in the background. `
            + 'Do not retry more than once; report back if you cannot continue headless.',
        }
      }
      const raised = markRaised(args.app, call.sessionId, state.app ?? undefined, config)
      return {
        text: `${args.app} is now in front (borrowed). It returns automatically at `
          + `${new Date(raised.deadline).toLocaleTimeString()} or when the user touches anything.`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_release',
    description:
      'Give back a window borrowed with desktop_raise, immediately. Call it as soon as the step that needed the '
      + 'foreground is finished.',
    parameters: {},
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const sessionId = agentId(exec)
      const raised = raisedApp()
      if (raised === undefined || raised.owner !== sessionId) {
        return { text: 'nothing was borrowed, so there is nothing to return' }
      }
      await sessions.releaseForeground(sessionId)
      return { text: `returned the foreground${raised.previous === undefined ? '' : ` to ${raised.previous}`}` }
    },
  }))
}