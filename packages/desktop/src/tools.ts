/**
 * The accessibility half of the desktop agent's tools: read a window's tree, and
 * act on one element by ref.
 *
 * This is the second path, not the first. The first is `desktop` in
 * `gui.ts` — one call, one action, one new picture. The tree is worth reaching
 * for when the picture cannot settle a question: the exact identity of a control
 * in a dense list, a field that must be set atomically, an element that is
 * invisible behind a scroll. On an Electron or canvas window the tree is often
 * absent or nearly empty, and both tools say so instead of letting the model
 * drill.
 *
 * Two tools only: `desktop_inspect` reads, `desktop_act` acts on a ref. Every
 * other status query the background preset used to have is gone, because the
 * picture that `desktop` returns already answers "what is in front", "which
 * windows does this app have", and "did it work".
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
  leaseOwner,
  refreshLease,
  releaseLease,
  screenLockOwner,
} from './guard.ts'
import { chooseWindow } from './frame.ts'
import { chooseTarget, windowLine } from './gui.ts'
import { agentSessionId } from './sessions.ts'
import { POLICY } from './ffi.ts'
import { renderSnapshot } from './render.ts'
import type { ActionKind, ActionRequest, SnapshotData, HostError, WindowInfo } from './protocol.ts'
import type { DesktopSessions, SessionEntry } from './sessions.ts'
import { listWindows, snapshotWindow, type Envelope } from './vision.ts'

const TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * Fewer addressable elements than this means the tree cannot be worked with.
 * A healthy native app exposes dozens; a cold Electron shell exposes none or a
 * handful of junk. The number is a hint for the model, never a hard switch.
 */
const MIN_USEFUL_REFS = 3

interface Call {
  readonly sessionId: string
  readonly entry: SessionEntry
  readonly client: DesktopClient
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

/** What a tree read produced, plus whether the model should stop reading. */
interface TreeRead {
  readonly text: string
  readonly refs: readonly string[]
  readonly thin: boolean
}

/**
 * Say what to do instead, in the result the model is already reading.
 *
 * A thin tree is the desktop counterpart of the phone's poor tree: the next step
 * is pixels, not another snapshot at a different depth.
 * @param text - rendered tree.
 * @param refs - how many addressable elements it yielded.
 * @returns the text with a switch-route hint when the tree is unusable.
 */
function withThinHint(text: string, refs: readonly string[]): string {
  if (refs.length >= MIN_USEFUL_REFS) return text
  return `${text}\n\ntree_thin: this window produced ${String(refs.length)} addressable element(s). `
    + 'The accessibility tree is not usable here. Stop snapshotting: take desktop_see and point at '
    + 'what you see with desktop_click.'
}

/**
 * Read one app's tree, render it, and remember the refs it exposed.
 *
 * Used by both the inspect tool and the post-action observation, so the two can
 * never drift: whatever refs one of them hands the model is exactly what the ref
 * book will accept next.
 * @param call - calling session.
 * @param app - application name, or undefined for the front window.
 * @param config - tunables.
 * @param options - depth and node-budget overrides.
 * @returns the rendered tree and its thin-tree verdict.
 */
async function readTree(
  call: Call,
  app: string | undefined,
  config: ResolvedConfig,
  options: { depth?: number, maxNodes?: number } = {},
): Promise<TreeRead> {
  const depth = Math.min(8, Math.max(1, options.depth ?? 3))
  const snapshot = await call.client.request<SnapshotData>({
    op: 'snapshot',
    ...app !== undefined && app !== '' ? { app } : {},
    depth,
    interactive: true,
    compact: true,
  })
  const rendered = renderSnapshot(snapshot, {
    maxNodes: options.maxNodes ?? config.maxNodes,
    maxChars: config.maxChars,
  })
  call.entry.refs.remember(snapshot, rendered.refs, rendered.elements)
  return { text: withThinHint(rendered.text, rendered.refs), refs: rendered.refs, thin: rendered.refs.length < MIN_USEFUL_REFS }
}

/**
 * Read the window a ref belongs to, preferring the exact window.
 *
 * `readTree` can only name an app, and an app with several windows refuses that
 * with AMBIGUOUS_TARGET — QQ always has two. The ref already carries the window
 * it came from, so use it when it is known and fall back to the app name only
 * when it is not. This is what keeps the post-action observation working on
 * multi-window apps instead of failing right after every action.
 * @param call - calling session.
 * @param known - what the ref book recorded for this ref.
 * @param config - tunables.
 * @returns the rendered tree and its thin-tree verdict.
 */
async function readTreeFor(
  call: Call,
  known: { readonly app: string, readonly windowId?: string },
  config: ResolvedConfig,
  readWindow: typeof snapshotWindow = snapshotWindow,
): Promise<TreeRead> {
  if (known.windowId !== undefined && known.windowId !== '') {
    const read = await readWindow(
      known.windowId,
      { session: agentSessionId(call.sessionId) },
      AbortSignal.timeout(30_000),
    )
    if (read.ok && read.data !== undefined) {
      const rendered = renderSnapshot(read.data, { maxNodes: config.maxNodes, maxChars: config.maxChars })
      call.entry.refs.remember(read.data, rendered.refs, rendered.elements)
      return {
        text: withThinHint(rendered.text, rendered.refs),
        refs: rendered.refs,
        thin: rendered.refs.length < MIN_USEFUL_REFS,
      }
    }
    // Fall through: the window may have closed while the app lives on.
  }
  return await readTree(call, known.app, config)
}

/**
 * Ask the library which app owns the foreground and how idle the user is.
 * @param client - session child.
 * @returns the observed state.
 */
async function osState(client: DesktopClient): Promise<{ app: string | null }> {
  const value = await client.request<{ app?: string | null }>({ op: 'state' })
  return { app: value.app ?? null }
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

/**
 * Accept a ref the way the tree printed it.
 *
 * The renderer shows refs as `{@s1:e4}` so they stand out in the outline, and a
 * model that copies one verbatim — braces included — used to be told it "belongs
 * to no snapshot", which reads as "the tree path does not work here". Stripping
 * the wrapper costs nothing and removes a whole class of dead end.
 * @param raw - whatever the model passed as a ref.
 * @returns the bare `@snapshot:id` form.
 */
export function normalizeRef(raw: string): string {
  const trimmed = raw.trim()
  const braced = /^\{(.*)\}$/.exec(trimmed)
  const inner = (braced?.[1] ?? trimmed).trim()
  return inner.replace(/^['"`]|['"`]$/g, '').trim()
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
 * Register the accessibility tools on the calling preset.
 * @param ctx - plugin context carrying the tool registry.
 * @param sessions - child-process owner.
 * @param config - resolved tunables.
 */
/**
 * Side effects that can be replaced, so a test never spawns the CLI or reads a
 * real window. Production passes nothing and gets the real implementations.
 */
export interface DesktopDependencies {
  /** Window inventory. */
  readonly listWindows?: (signal: AbortSignal) => Promise<Envelope<readonly WindowInfo[]>>
  /** Accessibility read for one window. */
  readonly snapshot?: (
    windowId: string,
    options: { depth?: number, session?: string },
    signal: AbortSignal,
  ) => Promise<Envelope<SnapshotData>>
}

export function registerDesktopTools(
  ctx: Context,
  sessions: DesktopSessions,
  config: ResolvedConfig,
  dependencies: DesktopDependencies = {},
): void {
  const inventory = dependencies.listWindows ?? listWindows
  const readWindow = dependencies.snapshot ?? snapshotWindow
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
    name: 'desktop_inspect',
    description:
      'Read one window\'s interface as a text tree: role, name, and a ref like {@s1z2:e4} for every actionable '
      + 'element. This is the first call for a desktop task. It resolves the window itself (the one you name, else the '
      + 'app\'s, else the one in front) and its first line says whether that window has a usable tree: '
      + '`tree=yes` means act on refs with desktop_act, and one action plus its new tree come back in a single call, '
      + 'so a tree step is one turn. '
      + '`tree=no`, or a result ending in tree_thin, means this window exposes nothing to address: stop reading and '
      + 'use desktop_see with the point-based tools instead. Electron and canvas apps are usually tree=no.',
    parameters: {
      window: {
        type: 'string',
        description: 'Window id from a previous result, for example w-35248. Preferred when you have one.',
      },
      app: {
        type: 'string',
        description: 'Application name. Omit with window to read the window in front.',
      },
      depth: {
        type: 'integer',
        default: 6,
        description: 'How many levels to read, 1–8. Default: 6. A shallow read hides deep controls '
          + '(a chat composer sits several groups down) and costs another round trip to re-read.',
      },
      max_nodes: {
        type: 'integer',
        description: 'Most nodes to render. Default: 140. Raises the character budget with it.',
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      // Resolve the window from the OS, not from an app name: the CLI reads by
      // window id, which is the only form that works when the app owns several
      // windows, and it is also the only source of the `tree=yes|no` answer that
      // decides whether the rest of the task goes through the tree at all.
      const listed = await inventory(exec.signal)
      if (!listed.ok || listed.data === undefined) {
        const code = listed.error?.code ?? 'UNKNOWN'
        const parts = [`${code}: ${listed.error?.message ?? 'window inventory failed'}`]
        if (listed.error?.suggestion !== undefined) parts.push(listed.error.suggestion)
        return {
          text: `desktop_inspect failed\n${parts.join('\n')}\n`
            + (code === 'TIMEOUT'
              ? 'The screen may be locked, or an app is not answering. No window can be read in that state. '
                + 'Do not retry: report what is blocked.'
              : 'No window inventory, so no tree can be read.'),
        }
      }
      const chosen = chooseTarget(listed.data, {
        ...typeof args.window === 'string' && args.window !== '' ? { window: args.window } : {},
        ...typeof args.app === 'string' && args.app !== '' ? { app: args.app } : {},
      }, undefined)
      if (chosen.target === undefined) {
        return { text: `desktop_inspect failed\nWINDOW_NOT_FOUND: ${chosen.why}` }
      }
      const target = chosen.target
      const heading = windowLine(target)
      const others = chosen.siblings.length === 0
        ? ''
        : `\nother ${target.appName} windows: ${chosen.siblings
          .slice(0, 6)
          .map(window => `${window.windowId} ${String(window.bounds.width)}x${String(window.bounds.height)}`)
          .join(' | ')}`

      // The window itself said there is nothing to address. Say so before paying
      // for a read that can only fail with ACTION_NOT_SUPPORTED.
      if (!target.accessible) {
        return {
          text: `${heading}${others}\n\ntree=no: this window exposes no accessibility tree, so there are no refs to act `
            + 'on. Stop reading and use desktop_see with this window id, then the point-based tools '
            + '(desktop_click, desktop_input_text, desktop_hotkey, desktop_scroll).',
        }
      }

      try {
        const read = await readWindow(
          target.windowId,
          {
            session: agentSessionId(call.sessionId),
            ...args.depth === undefined ? {} : { depth: args.depth },
          },
          exec.signal,
        )
        if (!read.ok || read.data === undefined) {
          const error = read.error
          const parts = [`${error?.code ?? 'FAILED'}: ${error?.message ?? 'snapshot failed'}`]
          if (error?.suggestion !== undefined) parts.push(error.suggestion)
          if (error?.code === 'ACTION_NOT_SUPPORTED' || error?.code === 'WINDOW_NOT_FOUND') {
            parts.push('This window cannot be read through accessibility. Use desktop_see with this window id '
              + 'and the point-based tools instead.')
          }
          return { text: `desktop_inspect failed\n${heading}${others}\n${parts.join('\n')}` }
        }
        const rendered = renderSnapshot(read.data, {
          maxNodes: args.max_nodes ?? config.maxNodes,
          // Asking for more nodes means the model needs more of the tree; a
          // fixed character budget would cut it at the same place every time.
          maxChars: args.max_nodes === undefined
            ? config.maxChars
            : Math.max(config.maxChars, args.max_nodes * 120),
        })
        call.entry.refs.remember(read.data, rendered.refs, rendered.elements)
        return { text: `${heading}${others}\n${withThinHint(rendered.text, rendered.refs)}` }
      } catch (error) {
        return { text: `desktop_inspect failed\n${heading}${others}\n${failureText(asHostError(error))}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_act',
    description:
      'Operate one element by a ref that desktop_inspect showed you. Actions: click, double_click, right_click, '
      + 'set_value, type_text, press_key, scroll, toggle, check, uncheck, expand, collapse, select, clear. '
      + 'Prefer set_value over type_text for fields that accept a value. Actions run headless first: no mouse movement, '
      + 'no focus stealing, so this is the route that does not disturb the user. '
      + 'The result comes back with a fresh tree of the same window, so you do not need a separate inspect after an '
      + 'action: read the new refs from this result and act again. '
      + 'The same action on the same control is refused for about 12 seconds after it may have landed, so never repeat '
      + 'a click or Enter to "make sure": a submit result already tells you to confirm from the tree it returns. '
      + 'If this fails because the control exposes no semantic action, do not force it: use desktop_see and '
      + 'desktop_click on the point. On Windows an element that repeats in its window (identical rows or buttons) '
      + 'has no ref path either: those have to be clicked by point. '
      + 'Key names are case-insensitive; Return is accepted for enter.',
    parameters: {
      ref: { type: 'string', required: true, description: 'A fully qualified ref from the latest desktop_inspect.' },
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
      const ref = normalizeRef(args.ref)
      const known = call.entry.refs.lookup(ref)
      if (known === undefined) {
        const latest = call.entry.refs.latest()
        return {
          text: `UNKNOWN_REF: "${args.ref}" is not a ref this session was given. A ref is the token the tree `
            + 'prints in braces, passed without the braces: @<snapshot>:e<number>. '
            + (latest === undefined
              ? 'Call desktop_inspect first: its result contains the refs.'
              : `Your latest desktop_inspect of ${latest.app} is snapshot ${latest.snapshotId}, `
                + `so its refs look like @${latest.snapshotId}:e22.`),
        }
      }
      if (!known.known) {
        return {
          text: 'REF_NOT_SHOWN: that ref was not in the snapshot text you received. '
            + 'Use a ref that appears in the latest desktop_inspect result, or inspect again.',
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
        // The refusal is the moment the model most wants to know what happened,
        // so hand it the current tree instead of only a "do not repeat".
        let observation = ''
        try {
          const tree = await readTreeFor(call, known, config, readWindow)
          observation = `\n\n--- ${known.app} now ---\n${tree.text}`
        } catch {
          observation = '\n\nCall desktop_inspect to see the current state.'
        }
        return {
          text: 'IDENTICAL_ACTION: the same action on the same control already ran '
            + `${Math.round((Date.now() - previous.at) / 1000)}s ago and may have landed. `
            + 'Do not repeat it; decide from the state below.'
            + observation,
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
          data = await call.client.request({ op: 'act', ref, action, policy: POLICY.headless })
        } catch (error) {
          const hostError = asHostError(error)
          // Some controls (a settings row, a custom popup) advertise no semantic
          // action at all, and the headless call refuses. The library can still
          // click the element's own frame with real input, which aims far better
          // than a model guessing a point from a picture — so do that instead of
          // sending the model off to click coordinates.
          //
          // Only actions that are pointer or key delivery may escalate: retrying a
          // value write physically would turn a harmless refusal into a stray click.
          const escalatable = action.kind === 'click' || action.kind === 'double_click'
            || action.kind === 'right_click' || action.kind === 'press_key'
          const retryable = escalatable
            && (hostError.code === 'POLICY_DENIED' || hostError.code === 'ACTION_NOT_SUPPORTED')
          const state = retryable ? await osState(call.client) : undefined
          const inFront = state?.app === known.app
          if (!retryable || !config.physicalFallback || !inFront) throw error
          data = await call.client.request({
            op: 'act',
            ref,
            action,
            policy: POLICY.headed,
            // Do not sit in the library's 5 s preflight when the control never
            // becomes actionable; the frame click itself needs no waiting.
            timeout_ms: 2_000,
          })
          escalated = true
        }
        effects.set(effectKey, { at: Date.now(), landed: true })
        refreshLease(known.app, call.sessionId)
        const lines = [actionText(data)]
        if (escalated) {
          lines.push('note: this control exposes no semantic action, so it was clicked by its own frame with real '
            + 'input. That is still precise — it is the element\'s frame, not a guessed point.')
        }

        // Observe the same window right away. This is the phone's after() applied
        // to the desktop: one action plus its new tree in a single result, so the
        // model does not spend a whole turn asking what changed. A failed read is
        // not a failed action — the action already landed, so only the reading is
        // reported as missing.
        try {
          const tree = await readTreeFor(call, known, config, readWindow)
          if (isSubmitAction(action)) {
            lines.push('note: a submit was sent. Read the tree below before doing anything else;'
              + ' never press it again to "make sure".')
          }
          lines.push('', `--- ${known.app} now ---`, tree.text)
        } catch (error) {
          const hostError = asHostError(error)
          lines.push('', `note: the action was sent, but the follow-up read failed (${hostError.code}: ${hostError.message}).`
            + ' Call desktop_inspect before acting again.')
        }
        return { text: lines.join('\n') }
      } catch (error) {
        const hostError = asHostError(error)
        effects.set(effectKey, {
          at: Date.now(),
          landed: hostError.delivery !== 'not_delivered' && hostError.code !== 'INVALID_ARGS',
        })
        releaseLease(known.app, call.sessionId)
        if (hostError.code === 'POLICY_DENIED' || hostError.code === 'ACTION_NOT_SUPPORTED') {
          return {
            text: `${failureText(hostError)}\n`
              + 'This control has no semantic action, and it could not be clicked either (the window is not in '
              + 'front, or physical input is off). Bring the window forward with desktop_open_app, then retry this '
              + 'same ref — the frame click is precise and needs no point.',
          }
        }
        return { text: `desktop_act failed\n${failureText(hostError)}` }
      }
    },
  }))
}
