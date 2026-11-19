/**
 * The accessibility-first toolset of the desktop agent:
 * - `desktop_inspect`: read a window, subtree (`root`), skeleton, or overlay (`surface`)
 * - `desktop_find`: search elements by text/name/role/value without dumping the whole tree
 * - `desktop_act`: operate one element by ref (semantic first, auto `scroll_to`, exact bounds click fallback, optional `submit`)
 * - `desktop_batch`: execute a short deterministic sequence of AX actions in a single turn
 *
 * Visual coordinate tools live in `gui.ts` as the zero-offset fallback for windows
 * that expose no usable accessibility tree (`tree=no` or `tree_thin`).
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
import { withScreenLock } from './gui-lock.ts'
import { chooseWindow } from './frame.ts'
import { chooseTarget, windowLine } from './gui.ts'
import { agentSessionId } from './sessions.ts'
import { POLICY } from './ffi.ts'
import { renderSnapshot } from './render.ts'
import type {
  ActionKind,
  ActionRequest,
  ElementBounds,
  FindResult,
  HostError,
  SnapshotData,
  WindowInfo,
} from './protocol.ts'
import type { DesktopSessions, SessionEntry } from './sessions.ts'
import {
  DEFAULT_SNAPSHOT_DEPTH,
  MAX_SNAPSHOT_DEPTH,
  findElements,
  getElementBounds,
  listWindows,
  runCli,
  snapshotWindow,
  surfacesOf,
  type Envelope,
  type FindElementsOptions,
  type SnapshotWindowOptions,
} from './vision.ts'

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
export const MIN_USEFUL_REFS = 3

/** First-attempt headless preflight budget: fail fast instead of sitting 5 s on offscreen/readonly controls. */
const HEADLESS_PREFLIGHT_MS = 1_500

/** Maximum steps allowed in one `desktop_batch` call. */
const MAX_BATCH_STEPS = 8

/** Maximum wait per step in `desktop_batch` or `wait_ms` in `desktop_act`. */
const MAX_WAIT_MS = 5_000

/** Roles that commonly spawn a separate menu/sheet/popover surface on click or expand. */
const MENU_TRIGGER_ROLE = /combobox|popup|menu|button|disclosure|splitbutton/i

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
 * Read one app's tree via FFI, render it, and remember the refs it exposed.
 */
async function readTree(
  call: Call,
  app: string | undefined,
  config: ResolvedConfig,
  options: { depth?: number; maxNodes?: number; interactive?: boolean } = {},
): Promise<TreeRead> {
  const depth = Math.min(MAX_SNAPSHOT_DEPTH, Math.max(1, options.depth ?? DEFAULT_SNAPSHOT_DEPTH))
  const interactive = options.interactive !== false
  const snapshot = await call.client.request<SnapshotData>({
    op: 'snapshot',
    ...app !== undefined && app !== '' ? { app } : {},
    depth,
    interactive,
    compact: true,
  })
  const rendered = renderSnapshot(snapshot, {
    maxNodes: options.maxNodes ?? config.maxNodes,
    maxChars: config.maxChars,
    pruneEmpty: !interactive,
  })
  call.entry.refs.remember(snapshot, rendered.refs, rendered.elements, { depth, interactive })
  return { text: withThinHint(rendered.text, rendered.refs), refs: rendered.refs, thin: rendered.refs.length < MIN_USEFUL_REFS }
}

/**
 * Read the window a ref belongs to, preserving the depth and text mode it was
 * originally read with (at least 6, never collapsing back to depth 3).
 */
async function readTreeFor(
  call: Call,
  known: { readonly app: string; readonly windowId?: string; readonly depth?: number; readonly interactive?: boolean },
  config: ResolvedConfig,
  readWindow: (windowId: string, options: SnapshotWindowOptions, signal: AbortSignal) => Promise<Envelope<SnapshotData>> = snapshotWindow,
): Promise<TreeRead> {
  const depth = Math.min(MAX_SNAPSHOT_DEPTH, Math.max(6, known.depth ?? DEFAULT_SNAPSHOT_DEPTH))
  const interactive = known.interactive !== false
  if (known.windowId !== undefined && known.windowId !== '') {
    const read = await readWindow(
      known.windowId,
      { session: agentSessionId(call.sessionId), depth, interactive },
      AbortSignal.timeout(30_000),
    )
    if (read.ok && read.data !== undefined) {
      const rendered = renderSnapshot(read.data, {
        maxNodes: config.maxNodes,
        maxChars: config.maxChars,
        pruneEmpty: !interactive,
      })
      call.entry.refs.remember(read.data, rendered.refs, rendered.elements, { depth, interactive })
      return {
        text: withThinHint(rendered.text, rendered.refs),
        refs: rendered.refs,
        thin: rendered.refs.length < MIN_USEFUL_REFS,
      }
    }
    // Fall through: the window may have closed while the app lives on.
  }
  return await readTree(call, known.app, config, { depth, interactive })
}

/**
 * Overlays an app presents right now.
 *
 * A menu, sheet, popover or alert is a separate surface: the window tree does not
 * change when one opens, so without this a click that opened a dropdown looks
 * exactly like a click that did nothing.
 */
async function defaultListSurfaces(app: string, signal: AbortSignal): Promise<readonly string[]> {
  const listed = await runCli<{ surfaces?: readonly (string | { kind?: string })[] }>(
    ['list-surfaces', '--app', app],
    signal,
  )
  return listed.ok ? (surfacesOf(listed.data?.surfaces) ?? []) : []
}

function shouldCheckSurfaces(actionKind: string, role: string | undefined): boolean {
  if (actionKind === 'right_click' || actionKind === 'expand') return true
  if (actionKind !== 'click' && actionKind !== 'click_bounds') return false
  if (role === undefined || role === '') return true
  return MENU_TRIGGER_ROLE.test(role)
}

/**
 * Ask the library which app owns the foreground and how idle the user is.
 */
async function osState(client: DesktopClient): Promise<{ app: string | null }> {
  const value = await client.request<{ app?: string | null }>({ op: 'state' })
  return { app: value.app ?? null }
}

function asHostError(error: unknown): HostError {
  const value = error as {
    code?: string
    message?: string
    suggestion?: string
    resultCode?: number
    delivery?: string
    retry?: string
    details?: unknown
  }
  return {
    code: value.code ?? 'INTERNAL',
    message: value.message ?? String(error),
    ...value.suggestion !== undefined ? { suggestion: value.suggestion } : {},
    resultCode: typeof value.resultCode === 'number' ? value.resultCode : 0,
    ...value.delivery !== undefined ? { delivery: value.delivery } : {},
    ...value.retry !== undefined ? { retry: value.retry } : {},
    ...value.details !== undefined ? { details: value.details } : {},
  }
}

/**
 * Check ownership before a mutation, then take the app lease.
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
 */
export function normalizeKey(key: string): string {
  const trimmed = key.trim()
  const lower = trimmed.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/**
 * Accept a ref the way the tree printed it.
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
  if (action.kind === 'type_text' || action.kind === 'set_value' || action.kind === 'select') {
    if (action.text === undefined || (action.kind === 'select' && action.text.trim() === '')) {
      throw new Error(`${action.kind} needs text`)
    }
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
 * Side effects that can be replaced, so a test never spawns the CLI or reads a
 * real window. Production passes nothing and gets the real implementations.
 */
export interface DesktopDependencies {
  /** Window inventory. */
  readonly listWindows?: (signal: AbortSignal) => Promise<Envelope<readonly WindowInfo[]>>
  /** Accessibility read for one window, root subtree, or overlay surface. */
  readonly snapshot?: (
    windowId: string,
    options: SnapshotWindowOptions,
    signal: AbortSignal,
  ) => Promise<Envelope<SnapshotData>>
  /** Filtered accessibility search. */
  readonly find?: (options: FindElementsOptions, signal: AbortSignal) => Promise<Envelope<FindResult>>
  /** Live screen bounds of a ref. */
  readonly getBounds?: (
    ref: string,
    session: string | undefined,
    signal: AbortSignal,
  ) => Promise<Envelope<ElementBounds>>
  /** Currently open overlay surfaces for an app. */
  readonly listSurfaces?: (app: string, signal: AbortSignal) => Promise<readonly string[]>
  /** Raw CLI runner (used for `scroll-to`, `focus-window`, `mouse-click`, `press`). */
  readonly runCli?: <T>(args: readonly string[], signal: AbortSignal, stdin?: string) => Promise<Envelope<T>>
}

const VALID_ACTIONS = new Set<string>([
  'click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key',
  'scroll', 'scroll_to', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'select', 'clear',
])

const BATCH_ACTIONS = new Set<string>([...VALID_ACTIONS, 'wait'])

export function registerDesktopTools(
  ctx: Context,
  sessions: DesktopSessions,
  config: ResolvedConfig,
  dependencies: DesktopDependencies = {},
): void {
  const inventory = dependencies.listWindows ?? listWindows
  const readWindow = dependencies.snapshot ?? snapshotWindow
  const find = dependencies.find ?? findElements
  const getBounds = dependencies.getBounds ?? getElementBounds
  const listSurfaces = dependencies.listSurfaces ?? defaultListSurfaces
  const cli = dependencies.runCli ?? runCli
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

  /**
   * Click the exact screen center of a ref's live AX bounding box.
   *
   * Used for explicit `click_bounds` and as the precise fallback when a control
   * exposes no working semantic action: no screenshot, no guessed coordinates.
   */
  const clickByElementBounds = async (
    call: Call,
    ref: string,
    known: { readonly app: string; readonly windowId?: string; readonly states?: readonly string[] },
    signal: AbortSignal,
    options: { button?: 'left' | 'right'; count?: number; scrollFirst?: boolean } = {},
  ): Promise<{ ok: true; cx: number; cy: number; scrolled: boolean } | { ok: false; message: string }> => {
    const session = agentSessionId(call.sessionId)
    let scrolled = false
    if (options.scrollFirst === true || known.states?.includes('offscreen') === true) {
      await cli<unknown>(['scroll-to', ref, '--session', session], AbortSignal.timeout(15_000))
      scrolled = true
    }
    const boundsRes = await getBounds(ref, session, signal)
    if (!boundsRes.ok || boundsRes.data === undefined) {
      return { ok: false, message: boundsRes.error?.message ?? 'element bounds unavailable' }
    }
    if (known.windowId !== undefined && known.windowId !== '') {
      const focused = await cli<unknown>(['focus-window', '--window-id', known.windowId], signal)
      if (!focused.ok) {
        return { ok: false, message: focused.error?.message ?? `could not focus window ${known.windowId}` }
      }
    }
    const box = boundsRes.data
    const cx = Math.round(box.x + box.width / 2)
    const cy = Math.round(box.y + box.height / 2)
    const button = options.button ?? 'left'
    const count = options.count ?? 1
    const clicked = await withScreenLock(call.sessionId, async () => await cli<unknown>(
      ['mouse-click', '--headed', '--xy', `${String(cx)},${String(cy)}`, '--button', button, '--count', String(count)],
      signal,
    ))
    if (!clicked.ok) {
      return { ok: false, message: clicked.error?.message ?? 'bounds mouse-click failed' }
    }
    return { ok: true, cx, cy, scrolled }
  }

  ctx.effect(() => () => {
    if (holdTimer !== undefined) clearTimeout(holdTimer)
    const frame = ctx.get('backgroundFrame') as { hide(): Promise<void> } | undefined
    void frame?.hide()
  })

  // ── desktop_inspect ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'desktop_inspect',
    description:
      'Read one window, subtree, or overlay as an accessibility text tree: role, name, value, and a ref like {@s1:e4} '
      + 'for every actionable element. Default depth is 12 (up to 32 for deep Electron/web trees). '
      + 'Use `skeleton: true` on large windows for a fast overview, then `root: "@s1:e3"` to drill into one branch '
      + 'without losing outer refs. Set `include_text: true` to include static text labels, status text, or chat messages '
      + 'so you can verify outcomes without taking a screenshot. '
      + 'For targeted lookup by keyword or role, prefer `desktop_find` instead of dumping a huge tree. '
      + 'Only when the first line says `tree=no` or output ends in `tree_thin`, switch to `desktop_see` + point tools.',
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
        default: DEFAULT_SNAPSHOT_DEPTH,
        description: `How many levels to read, 1–${String(MAX_SNAPSHOT_DEPTH)}. Default: ${String(DEFAULT_SNAPSHOT_DEPTH)}.`,
      },
      max_nodes: {
        type: 'integer',
        description: 'Most nodes to render. Default: 140. Raises the character budget with it.',
      },
      root: {
        type: 'string',
        description: 'Drill into one container ref from an earlier snapshot (e.g. @s1:e3). Keeps outer refs valid.',
      },
      skeleton: {
        type: 'boolean',
        description: 'Return a shallow structural overview with children_count on cut containers. Default: false.',
      },
      include_text: {
        type: 'boolean',
        description: 'Include static text nodes (labels, status, chat messages) alongside interactive controls. Default: false.',
      },
      surface: {
        type: 'string',
        enum: ['menu', 'menubar', 'sheet', 'popover', 'alert'],
        description: 'Read an overlay instead of the window (menu, menubar, sheet, popover, or alert).',
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const rootRef = typeof args.root === 'string' && args.root.trim() !== '' ? normalizeRef(args.root) : undefined
      const surface = typeof args.surface === 'string' ? args.surface : undefined
      const skeleton = args.skeleton === true
      const includeText = args.include_text === true
      const interactive = !includeText
      const depth = Math.min(
        MAX_SNAPSHOT_DEPTH,
        Math.max(1, typeof args.depth === 'number' ? args.depth : DEFAULT_SNAPSHOT_DEPTH),
      )

      if (rootRef !== undefined && surface !== undefined) {
        return { text: 'INVALID_ARGS: root and surface cannot be combined. Omit one of them.' }
      }

      if (rootRef !== undefined) {
        const known = call.entry.refs.lookup(rootRef)
        try {
          const read = await readWindow(
            known?.windowId ?? '',
            {
              session: agentSessionId(call.sessionId),
              root: rootRef,
              depth,
              interactive,
              ...skeleton ? { skeleton: true } : {},
            },
            exec.signal,
          )
          if (!read.ok || read.data === undefined) {
            const error = read.error
            const parts = [`${error?.code ?? 'FAILED'}: ${error?.message ?? 'root snapshot failed'}`]
            if (error?.suggestion !== undefined) parts.push(error.suggestion)
            return { text: `desktop_inspect failed\n${parts.join('\n')}` }
          }
          const rendered = renderSnapshot(read.data, {
            maxNodes: typeof args.max_nodes === 'number' ? args.max_nodes : config.maxNodes,
            maxChars: typeof args.max_nodes === 'number'
              ? Math.max(config.maxChars, args.max_nodes * 120)
              : config.maxChars,
            pruneEmpty: includeText,
          })
          // Merge drilled refs into the existing snapshot so outer refs remain valid.
          call.entry.refs.remember(read.data, rendered.refs, rendered.elements, {
            depth,
            interactive,
            merge: true,
          })
          return { text: `drilled ${rootRef}\n${rendered.text}` }
        } catch (error) {
          return { text: `desktop_inspect failed\n${failureText(asHostError(error))}` }
        }
      }

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

      if (!target.accessible && surface === undefined) {
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
            depth,
            interactive,
            ...skeleton ? { skeleton: true } : {},
            ...surface === undefined ? {} : { surface, app: target.appName },
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
          maxNodes: typeof args.max_nodes === 'number' ? args.max_nodes : config.maxNodes,
          maxChars: typeof args.max_nodes === 'number'
            ? Math.max(config.maxChars, args.max_nodes * 120)
            : config.maxChars,
          pruneEmpty: includeText,
        })
        call.entry.refs.remember(read.data, rendered.refs, rendered.elements, { depth, interactive })
        const overlay = surface !== undefined
          ? `reading the ${surface} overlay`
          : (read.data.surfaces ?? []).length === 0
            ? ''
            : `overlay(s) now open: ${(read.data.surfaces ?? []).join(', ')} — a menu or popup is NOT part of the `
              + 'window tree. Read it with desktop_inspect surface=<kind>, then act on its refs.'
        const body = surface !== undefined ? rendered.text : withThinHint(rendered.text, rendered.refs)
        return {
          text: `${heading}${others}${overlay === '' ? '' : `\n${overlay}`}\n${body}`,
        }
      } catch (error) {
        return { text: `desktop_inspect failed\n${heading}${others}\n${failureText(asHostError(error))}` }
      }
    },
  }))

  // ── desktop_find ───────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'desktop_find',
    description:
      'Search a window, subtree, or overlay for matching accessibility elements by keyword, name, role, or value, '
      + 'without dumping the entire tree. Returned refs are immediately actionable with desktop_act or desktop_batch. '
      + 'Use this first on dense apps (System Settings, Electron apps like QQ/Slack/Chrome) when you know what control '
      + 'or text you are looking for.',
    parameters: {
      window: { type: 'string', description: 'Window id from a previous result. Preferred when you have one.' },
      app: { type: 'string', description: 'Application name. Omit with window to search the window in front.' },
      query: { type: 'string', description: 'Fuzzy text match across name, value, title, and description.' },
      name: { type: 'string', description: 'Match element accessible name or label.' },
      role: { type: 'string', description: 'Match accessibility role (button, combobox, textfield, checkbox, menuitem, etc.).' },
      value: { type: 'string', description: 'Match current element value.' },
      exact: { type: 'boolean', description: 'Require case-insensitive exact match for name/value. Default: false.' },
      root: { type: 'string', description: 'Search only inside this ref subtree (e.g. @s1:e3).' },
      surface: {
        type: 'string',
        enum: ['menu', 'menubar', 'sheet', 'popover', 'alert'],
        description: 'Search an open overlay surface instead of the window.',
      },
      limit: { type: 'integer', description: 'Maximum matches to return (1–100). Default: 25.' },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined
      const role = typeof args.role === 'string' && args.role.trim() !== '' ? args.role.trim() : undefined
      const value = typeof args.value === 'string' && args.value.trim() !== '' ? args.value.trim() : undefined
      if (query === undefined && name === undefined && role === undefined && value === undefined) {
        return { text: 'INVALID_ARGS: provide at least one of query, name, role, or value.' }
      }
      const rootRef = typeof args.root === 'string' && args.root.trim() !== '' ? normalizeRef(args.root) : undefined
      const surface = typeof args.surface === 'string' ? args.surface : undefined
      if (rootRef !== undefined && surface !== undefined) {
        return { text: 'INVALID_ARGS: root and surface cannot be combined.' }
      }

      let appName = typeof args.app === 'string' && args.app !== '' ? args.app : ''
      let windowId = typeof args.window === 'string' && args.window !== '' ? args.window : undefined
      let windowTitle: string | undefined
      let heading = ''

      if (rootRef !== undefined) {
        const known = call.entry.refs.lookup(rootRef)
        if (known !== undefined) {
          appName = known.app
          windowId = known.windowId
          windowTitle = known.windowTitle
        }
        heading = `search under ${rootRef}`
      } else {
        const listed = await inventory(exec.signal)
        if (!listed.ok || listed.data === undefined) {
          const code = listed.error?.code ?? 'UNKNOWN'
          return {
            text: `desktop_find failed\n${code}: ${listed.error?.message ?? 'window inventory failed'}`,
          }
        }
        const chosen = chooseTarget(listed.data, {
          ...windowId !== undefined ? { window: windowId } : {},
          ...appName !== '' ? { app: appName } : {},
        }, undefined)
        if (chosen.target === undefined) {
          return { text: `desktop_find failed\nWINDOW_NOT_FOUND: ${chosen.why}` }
        }
        const target = chosen.target
        appName = target.appName
        windowId = target.windowId
        windowTitle = target.title
        heading = windowLine(target)
        if (!target.accessible && surface === undefined) {
          return {
            text: `${heading}\n\ntree=no: this window exposes no accessibility tree. `
              + 'Use desktop_see with this window id and point-based tools instead.',
          }
        }
      }

      const found = await find({
        ...rootRef !== undefined ? { root: rootRef } : {},
        ...surface !== undefined ? { surface, app: appName } : {},
        ...rootRef === undefined && surface === undefined && windowId !== undefined ? { windowId } : {},
        ...rootRef === undefined && surface === undefined && windowId === undefined && appName !== '' ? { app: appName } : {},
        ...query !== undefined ? { query } : {},
        ...name !== undefined ? { name } : {},
        ...role !== undefined ? { role } : {},
        ...value !== undefined ? { value } : {},
        ...args.exact === true ? { exact: true } : {},
        ...typeof args.limit === 'number' ? { limit: args.limit } : {},
        session: agentSessionId(call.sessionId),
      }, exec.signal)

      if (!found.ok || found.data === undefined) {
        const err = found.error
        const parts = [`${err?.code ?? 'FAILED'}: ${err?.message ?? 'find failed'}`]
        if (err?.suggestion !== undefined) parts.push(err.suggestion)
        return { text: `desktop_find failed\n${heading}\n${parts.join('\n')}` }
      }

      const data = found.data
      if (data.snapshotId !== '' && data.matches.length > 0) {
        call.entry.refs.rememberFind(
          {
            app: appName || 'unknown',
            snapshotId: data.snapshotId,
            ...windowId !== undefined ? { windowId } : {},
            ...windowTitle !== undefined ? { windowTitle } : {},
          },
          data.matches,
        )
      }

      if (data.matches.length === 0) {
        const rolesHint = data.rolesPresent !== undefined && data.rolesPresent.length > 0
          ? `\nroles present: ${data.rolesPresent.join(', ')}`
          : ''
        return {
          text: `${heading}\n0 matches.${rolesHint}\nTry a broader query, omit role, or call desktop_inspect with skeleton=true or include_text=true.`,
        }
      }

      const lines = [
        heading,
        `${String(data.matches.length)} match(es)${data.snapshotId !== '' ? ` · snapshot ${data.snapshotId}` : ''}`,
      ]
      for (const m of data.matches) {
        const parts = [m.role]
        if (m.name !== undefined && m.name !== '') parts.push(`"${m.name.replace(/\s+/g, ' ').trim().slice(0, 80)}"`)
        if (m.value !== undefined && m.value !== '') parts.push(`= "${m.value.replace(/\s+/g, ' ').trim().slice(0, 120)}"`)
        if (m.ref !== undefined) parts.push(`{${m.ref}}`)
        const states = (m.states ?? []).filter(s => s !== 'enabled')
        if (states.length > 0) parts.push(`(${states.join(' ')})`)
        if (m.ref === undefined && m.bounds !== undefined) {
          parts.push(`[bounds ${Math.round(m.bounds.x)},${Math.round(m.bounds.y)} ${Math.round(m.bounds.width)}x${Math.round(m.bounds.height)}]`)
        }
        lines.push(`  ${parts.join(' ')}`)
      }
      return { text: lines.join('\n') }
    },
  }))

  // ── desktop_act ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'desktop_act',
    description:
      'Operate one element by a ref from desktop_inspect, desktop_find, or desktop_open_app. '
      + 'Actions: click, double_click, right_click, set_value, type_text, press_key, scroll, scroll_to, '
      + 'toggle, check, uncheck, expand, collapse, select, clear, click_bounds. '
      + 'For combobox/popup menus, prefer `select` with `text` set to the exact option label (e.g. "Safari浏览器"). '
      + 'Prefer `set_value` over `type_text` for fields; pass `submit: true` to press Return in the same call. '
      + 'Actions run headless first (no pointer, no focus stealing). If a control is below the fold it is scrolled into '
      + 'view automatically; if a control has no working semantic action, it falls back to clicking the element\'s exact '
      + 'AX bounding box (`click_bounds` can also be called directly) instead of guessing pixels. '
      + 'The result includes a fresh tree of the same window at your current depth, so one action is one turn. '
      + 'Never repeat a click or Enter within 12 s to "make sure": confirm from the returned tree.',
    parameters: {
      ref: { type: 'string', required: true, description: 'A qualified ref from desktop_inspect, desktop_find, or desktop_open_app.' },
      action: {
        type: 'string',
        required: true,
        enum: [
          'click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key',
          'scroll', 'scroll_to', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'select', 'clear', 'click_bounds',
        ],
        description: 'What to do with the element.',
      },
      text: { type: 'string', description: 'Text for set_value, type_text, or the option label for select.' },
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
      submit: {
        type: 'boolean',
        description: 'For set_value or type_text: press Return right after inserting text. Default: false.',
      },
      wait_ms: {
        type: 'integer',
        description: 'Optional pause (0–5000 ms) after the action before reading the updated tree.',
      },
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
              ? 'Call desktop_inspect or desktop_find first: its result contains the refs.'
              : `Your latest observation of ${latest.app} is snapshot ${latest.snapshotId}, `
                + `so its refs look like @${latest.snapshotId}:e22.`),
        }
      }
      if (!known.known) {
        return {
          text: 'REF_NOT_SHOWN: that ref was not in the snapshot text you received. '
            + 'Use a ref that appears in the latest desktop_inspect or desktop_find result, or inspect again.',
        }
      }

      const rawAction = String(args.action)
      const isClickBounds = rawAction === 'click_bounds'
      const action = isClickBounds
        ? undefined
        : actionOf({
            action: rawAction as ActionKind,
            ...args.text !== undefined ? { text: args.text } : {},
            ...args.key !== undefined ? { key: normalizeKey(args.key) } : {},
            ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
            ...args.direction !== undefined ? { direction: args.direction } : {},
            ...rawAction === 'scroll' ? { amount: args.amount ?? 3 } : {},
          })

      const effectKey = [
        call.sessionId,
        known.app,
        known.role ?? '',
        known.name ?? '',
        rawAction,
        args.text ?? (action?.key ?? ''),
        args.submit === true ? 'submit' : '',
      ].join('\u0000')
      const previous = effects.get(effectKey)
      if (previous !== undefined && previous.landed && Date.now() - previous.at < config.repeatWindowMs) {
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
        let usedBoundsClick: { cx: number; cy: number } | undefined
        let scrolled = false

        if (isClickBounds) {
          const clicked = await clickByElementBounds(call, ref, known, exec.signal)
          if (!clicked.ok) {
            throw Object.assign(new Error(clicked.message), {
              code: 'ACTION_FAILED',
              delivery: 'not_delivered',
              retry: 'safe',
            })
          }
          usedBoundsClick = { cx: clicked.cx, cy: clicked.cy }
          scrolled = clicked.scrolled
          data = { action: 'click_bounds', ref_id: ref, disposition: { delivery: 'delivered_unverified' } }
        } else {
          const act = action as ActionRequest
          const scrollRetryable = act.kind === 'click' || act.kind === 'double_click'
            || act.kind === 'right_click' || act.kind === 'press_key'
            || act.kind === 'expand' || act.kind === 'select'
          // On Windows, `type_text`, `right_click`, `double_click`, and non-frontmost
          // `press_key` return POLICY_DENIED in strict headless mode and require headed delivery.
          const physicalEscalatable = act.kind === 'click' || act.kind === 'double_click'
            || act.kind === 'right_click' || act.kind === 'press_key'
            || act.kind === 'expand' || act.kind === 'type_text'
          const boundsEscalatable = act.kind === 'click' || act.kind === 'double_click'
            || act.kind === 'right_click' || act.kind === 'expand'

          const attempt = async (): Promise<unknown> =>
            await call.client.request({
              op: 'act',
              ref,
              action: act,
              policy: POLICY.headless,
              timeout_ms: HEADLESS_PREFLIGHT_MS,
            })

          let failure: unknown
          try {
            data = await attempt()
          } catch (error) {
            failure = error
            if (scrollRetryable && asHostError(error).code === 'TIMEOUT') {
              scrolled = true
              await cli<unknown>(
                ['scroll-to', ref, '--session', agentSessionId(call.sessionId)],
                AbortSignal.timeout(15_000),
              )
              try {
                data = await attempt()
                failure = undefined
              } catch (again) {
                failure = again
              }
            }
          }

          if (failure !== undefined) {
            const hostError = asHostError(failure)
            const retryable = physicalEscalatable
              && (hostError.code === 'POLICY_DENIED' || hostError.code === 'ACTION_NOT_SUPPORTED'
                || hostError.code === 'TIMEOUT')
            if (!retryable || !config.physicalFallback) throw failure

            const state = await osState(call.client)
            let frontNow = state.app === known.app
            if (
              !frontNow
              && (act.kind === 'type_text' || act.kind === 'press_key')
              && known.windowId !== undefined
            ) {
              const focused = await cli<unknown>(['focus-window', '--window-id', known.windowId], exec.signal)
              if (focused.ok) frontNow = true
            }
            if (frontNow) {
              try {
                data = await withScreenLock(call.sessionId, async () => await call.client.request({
                  op: 'act',
                  ref,
                  action: act,
                  policy: POLICY.headed,
                  timeout_ms: 2_000,
                }))
                escalated = true
                failure = undefined
              } catch (headedError) {
                failure = headedError
              }
            }

            // On Windows, `press_key` to a non-frontmost or UIA-restricted window
            // can still succeed via CLI `press --headed --window-id` once focused.
            if (failure !== undefined && act.kind === 'press_key' && known.windowId !== undefined && act.key !== undefined) {
              const combo = [...(act.modifiers ?? []), act.key].join('+')
              const pressed = await withScreenLock(call.sessionId, async () => {
                await cli<unknown>(['focus-window', '--window-id', known.windowId as string], exec.signal)
                return await cli<unknown>(
                  ['press', '--headed', '--window-id', known.windowId as string, combo],
                  exec.signal,
                )
              })
              if (pressed.ok) {
                escalated = true
                data = { action: 'press_key', ref_id: ref, disposition: { delivery: 'delivered_unverified' } }
                failure = undefined
              }
            }

            // If headed FFI still failed (e.g. macOS AXPopUpButton readonly preflight TIMEOUT)
            // or the target window wasn't frontmost yet (and we know its exact windowId),
            // click the element's exact AX bounding box directly instead of making the model guess pixels.
            if (failure !== undefined && boundsEscalatable && known.windowId !== undefined) {
              const clicked = await clickByElementBounds(call, ref, known, exec.signal, {
                button: act.kind === 'right_click' ? 'right' : 'left',
                count: act.kind === 'double_click' ? 2 : 1,
                scrollFirst: !scrolled && hostError.code === 'TIMEOUT',
              })
              if (clicked.ok) {
                usedBoundsClick = { cx: clicked.cx, cy: clicked.cy }
                if (clicked.scrolled) scrolled = true
                escalated = true
                data = { action: act.kind, ref_id: ref, disposition: { delivery: 'delivered_unverified' } }
                failure = undefined
              }
            }

            if (failure !== undefined) throw failure
          }
        }

        let submitted = action !== undefined && isSubmitAction(action)
        if (
          args.submit === true
          && action !== undefined
          && (action.kind === 'set_value' || action.kind === 'type_text')
        ) {
          const submitAction: ActionRequest = { kind: 'press_key', key: 'enter' }
          try {
            await call.client.request({
              op: 'act',
              ref,
              action: submitAction,
              policy: POLICY.headless,
              timeout_ms: HEADLESS_PREFLIGHT_MS,
            })
            submitted = true
          } catch {
            if (known.windowId !== undefined) {
              const pressed = await withScreenLock(call.sessionId, async () => {
                await cli<unknown>(['focus-window', '--window-id', known.windowId as string], exec.signal)
                return await cli<unknown>(
                  ['press', '--headed', '--window-id', known.windowId as string, 'return'],
                  exec.signal,
                )
              })
              if (pressed.ok) submitted = true
            }
          }
        }

        effects.set(effectKey, { at: Date.now(), landed: true })
        refreshLease(known.app, call.sessionId)

        const waitMs = typeof args.wait_ms === 'number'
          ? Math.min(MAX_WAIT_MS, Math.max(0, Math.round(args.wait_ms)))
          : 0
        if (waitMs > 0) {
          await new Promise(resolve => setTimeout(resolve, waitMs))
        }

        const lines = [actionText(data)]
        if (scrolled) {
          lines.push('note: this control was scrolled into view by its own ref first.')
        }
        if (usedBoundsClick !== undefined) {
          lines.push(
            `note: clicked the element's exact AX bounds center at screen (${String(usedBoundsClick.cx)},${String(usedBoundsClick.cy)}).`,
          )
        } else if (escalated) {
          lines.push('note: this control exposes no semantic action, so it was clicked by its own frame with real '
            + 'input. That is still precise — it is the element\'s frame, not a guessed point.')
        }
        if (shouldCheckSurfaces(rawAction, known.role)) {
          const overlays = await listSurfaces(known.app, AbortSignal.timeout(10_000))
          if (overlays.length > 0) {
            lines.push(`overlay(s) now open: ${overlays.join(', ')} — they are not in the tree below. `
              + 'Read one with desktop_inspect surface=<kind>, or search it with desktop_find surface=<kind>.')
          }
        }

        try {
          const tree = await readTreeFor(call, known, config, readWindow)
          if (submitted) {
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
              + 'same ref or use action="click_bounds" — the frame click is precise and needs no guessed point.',
          }
        }
        return { text: `desktop_act failed\n${failureText(hostError)}` }
      }
    },
  }))

  // ── desktop_batch ──────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'desktop_batch',
    description:
      'Execute a short sequence (1–8 steps) of deterministic accessibility actions in one turn, then return ONE '
      + 'fresh tree at the end. Ideal for multi-field forms, check/toggle sequences, scroll_to + click, or '
      + 'set_value + wait + press_key(Return). Stops on the first error by default and blocks duplicate submits '
      + 'within the same batch.',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: `Ordered list of 1–${String(MAX_BATCH_STEPS)} steps.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', description: 'Qualified ref (required for all actions except wait).' },
            action: {
              type: 'string',
              required: true,
              enum: [
                'click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key',
                'scroll', 'scroll_to', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'select', 'clear', 'wait',
              ],
              description: 'Action to execute for this step.',
            },
            text: { type: 'string', description: 'Text for set_value, type_text, or select.' },
            key: { type: 'string', description: 'Key name for press_key.' },
            modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers for press_key.' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction for scroll.' },
            amount: { type: 'integer', description: 'Scroll amount.' },
            ms: { type: 'integer', description: 'Pause duration in ms for wait (0–5000).' },
          },
        },
      },
      stop_on_error: {
        type: 'boolean',
        description: 'Stop executing remaining steps after the first error. Default: true.',
      },
    },
    output: {
      schema: TEXT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const call = await callOf(exec, sessions)
      const rawSteps = Array.isArray(args.steps) ? args.steps as Record<string, unknown>[] : []
      if (rawSteps.length === 0 || rawSteps.length > MAX_BATCH_STEPS) {
        return {
          text: `INVALID_ARGS: steps must contain between 1 and ${String(MAX_BATCH_STEPS)} items.`,
        }
      }
      const stopOnError = args.stop_on_error !== false
      const summary: string[] = []
      let lastKnown: {
        app: string
        windowId?: string
        windowTitle?: string
        depth?: number
        interactive?: boolean
        role?: string
      } | undefined
      let submittedInBatch = false
      let anyMenuTrigger = false

      for (let i = 0; i < rawSteps.length; i += 1) {
        const step = rawSteps[i] ?? {}
        const stepNo = i + 1
        const kind = typeof step.action === 'string' ? step.action : ''
        if (!BATCH_ACTIONS.has(kind)) {
          summary.push(`[${String(stepNo)}] INVALID_ARGS: unsupported action "${kind}"`)
          if (stopOnError) break
          continue
        }
        if (kind === 'wait') {
          const ms = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(Number(step.ms ?? 300))))
          if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms))
          summary.push(`[${String(stepNo)}] wait ${String(ms)}ms: ok`)
          continue
        }

        const rawRef = typeof step.ref === 'string' ? step.ref : ''
        if (rawRef.trim() === '') {
          summary.push(`[${String(stepNo)}] INVALID_ARGS: ${kind} requires ref`)
          if (stopOnError) break
          continue
        }
        const ref = normalizeRef(rawRef)
        const known = call.entry.refs.lookup(ref)
        if (known === undefined || !known.known) {
          summary.push(`[${String(stepNo)}] ${known === undefined ? 'UNKNOWN_REF' : 'REF_NOT_SHOWN'}: ${rawRef}`)
          if (stopOnError) break
          continue
        }

        let action: ActionRequest
        try {
          action = actionOf({
            action: kind as ActionKind,
            ...typeof step.text === 'string' ? { text: step.text } : {},
            ...typeof step.key === 'string' ? { key: normalizeKey(step.key) } : {},
            ...Array.isArray(step.modifiers) ? { modifiers: step.modifiers.map(String) } : {},
            ...typeof step.direction === 'string' ? { direction: step.direction } : {},
            ...kind === 'scroll' ? { amount: typeof step.amount === 'number' ? step.amount : 3 } : {},
          })
        } catch (error) {
          summary.push(`[${String(stepNo)}] INVALID_ARGS: ${error instanceof Error ? error.message : String(error)}`)
          if (stopOnError) break
          continue
        }

        const isSubmit = isSubmitAction(action)
        if (isSubmit && submittedInBatch) {
          summary.push(`[${String(stepNo)}] SUBMIT_GUARD: a submit already ran in this batch; stopped to prevent duplicate submission.`)
          break
        }

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
          summary.push(`[${String(stepNo)}] IDENTICAL_ACTION: ${kind} ${ref} ran recently; skipped.`)
          if (stopOnError) break
          continue
        }

        try {
          await gate(call, known.app, config)
          let data: unknown
          try {
            data = await call.client.request({
              op: 'act',
              ref,
              action,
              policy: POLICY.headless,
              timeout_ms: HEADLESS_PREFLIGHT_MS,
            })
          } catch (firstErr) {
            const firstHost = asHostError(firstErr)
            const batchHeaded = config.physicalFallback
              && firstHost.code === 'POLICY_DENIED'
              && (action.kind === 'type_text' || action.kind === 'press_key'
                || action.kind === 'right_click' || action.kind === 'double_click')
            if (!batchHeaded) throw firstErr
            if (known.windowId !== undefined) {
              await cli<unknown>(['focus-window', '--window-id', known.windowId], exec.signal).catch(() => {})
            }
            data = await withScreenLock(call.sessionId, async () => await call.client.request({
              op: 'act',
              ref,
              action,
              policy: POLICY.headed,
              timeout_ms: 2_000,
            }))
          }
          effects.set(effectKey, { at: Date.now(), landed: true })
          refreshLease(known.app, call.sessionId)
          if (isSubmit) submittedInBatch = true
          if (shouldCheckSurfaces(action.kind, known.role)) anyMenuTrigger = true
          lastKnown = known
          summary.push(`[${String(stepNo)}] ${actionText(data).split('\n')[0]}`)
        } catch (error) {
          const hostError = asHostError(error)
          effects.set(effectKey, {
            at: Date.now(),
            landed: hostError.delivery !== 'not_delivered' && hostError.code !== 'INVALID_ARGS',
          })
          releaseLease(known.app, call.sessionId)
          lastKnown = known
          summary.push(`[${String(stepNo)}] FAILED (${kind} ${ref}): ${failureText(hostError).replace(/\n/g, ' | ')}`)
          if (stopOnError) break
        }
      }

      const lines = ['batch result:', ...summary]
      if (lastKnown !== undefined) {
        if (anyMenuTrigger) {
          const overlays = await listSurfaces(lastKnown.app, AbortSignal.timeout(10_000))
          if (overlays.length > 0) {
            lines.push(`overlay(s) now open: ${overlays.join(', ')} — read with desktop_inspect surface=<kind>.`)
          }
        }
        try {
          const tree = await readTreeFor(call, lastKnown, config, readWindow)
          if (submittedInBatch) {
            lines.push('note: a submit was sent in this batch. Confirm from the tree below; never submit again.')
          }
          lines.push('', `--- ${lastKnown.app} now ---`, tree.text)
        } catch (error) {
          const hostError = asHostError(error)
          lines.push('', `note: follow-up tree read failed (${hostError.code}: ${hostError.message}). Call desktop_inspect before acting again.`)
        }
      }
      return { text: lines.join('\n') }
    },
  }))
}
