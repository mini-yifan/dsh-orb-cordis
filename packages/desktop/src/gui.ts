/**
 * The desktop agent's one GUI tool: look at a window, name a point, get the next
 * picture back.
 *
 * This is the background preset's counterpart of the foreground Computer Use
 * tools, and it exists because of a measurement. A real QQ task took 55 model
 * turns and 174 seconds through the accessibility tree, against 8 turns and 23
 * seconds in Computer Use. The gap was not tool latency — `list-windows` costs
 * 0.23 s and a window capture 0.31 s — it was round trips: seeing cost one call,
 * acting cost another, and every `AMBIGUOUS_TARGET` or thin tree cost a third.
 *
 * So the shape here is the phone's `after()`, applied to a desktop window:
 *
 * - one call is one step, and the step returns the window as it now looks;
 * - a point is `[x, y]` on a 0–1000 grid over the picture the model was given,
 *   never a pixel and never a screen coordinate, so no scale factor, shadow
 *   padding or window rectangle ever enters the model's arithmetic;
 * - a pointer action raises its window first, because the click is delivered at
 *   absolute screen coordinates and would otherwise land on whatever is on top;
 * - text is pasted through the clipboard and the clipboard is put back, so a
 *   window with no accessibility tree can still be filled in.
 *
 * The accessibility tree is still here, one door over: `desktop_inspect` reads
 * it and `desktop_act` acts on a ref. That pair is the fallback for the cases a
 * picture cannot settle — an element whose exact identity matters, a control
 * that is invisible in a dense list, a field that must be set atomically.
 * @module @dsh-orb/desktop/src/gui
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.ts'
import type { WindowInfo } from './protocol.ts'
import { failureText, typeImageValue, type ImageValue } from './vision.ts'
import { activateApp } from './activate.ts'
import { canPasteAtFocus, typeAtFocus } from './hid.ts'
import { withScreenLock } from './gui-lock.ts'
import { requireImageRoute } from './route.ts'
import { sessionState } from './session-state.ts'
import {
  captureWindow,
  listWindows,
  picturePadding,
  runCli,
  storePicture,
} from './vision.ts'

/** A point is a fraction of the picture on a 0–1000 grid, on both axes. */
export const POINT_SPAN = 1000

/** How long a window has to appear after `launch` before the action gives up. */
const LAUNCH_WAIT_MS = 12_000

/** A click settles before the next keystroke: focus moves on the run loop, not instantly. */
const FOCUS_SETTLE_MS = 200

/** One window rectangle in logical screen points, as `--xy` takes them. */
interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The window a call resolved to, with everything the text line reports. */
interface Target {
  readonly windowId: string
  readonly appName: string
  readonly title: string
  readonly bounds: Rect
  readonly focused: boolean
  readonly accessible: boolean
}

/**
 * The picture the model last received, and how its 0–1000 grid sits in logical
 * screen points.
 *
 * The captured raster carries the drop shadow macOS draws outside the window
 * rectangle on both sides, so the picture covers more than `bounds`; folding
 * that in once at capture time is what lets a point stay a bare fraction.
 */
interface Frame {
  readonly windowId: string
  readonly appName: string
  /** The window rectangle the picture was taken against. */
  readonly bounds: Rect
  /** Logical screen x of the picture's left edge. */
  readonly left: number
  /** Logical screen y of the picture's top edge. */
  readonly top: number
  /** Logical points the picture spans, left to right. */
  readonly spanX: number
  /** Logical points the picture spans, top to bottom. */
  readonly spanY: number
}

/** One decoded action argument, validated before anything touches the screen. */
interface ActionArgs {
  action: string
  window?: string
  app?: string
  point?: readonly number[]
  to?: readonly number[]
  text?: string
  keys?: string
  direction?: string
  amount?: number
  button?: string
  count?: number
  replace?: boolean
  enter?: boolean
}

/**
 * Map a 0–1000 point on the picture to the absolute screen point `--xy` takes.
 * @param frame - geometry recorded when the picture was captured.
 * @param point - `[x, y]` on the 0–1000 grid.
 * @returns the logical screen point, rounded to whole points.
 */
export function pointToScreen(
  frame: Pick<Frame, 'left' | 'top' | 'spanX' | 'spanY'>,
  point: readonly number[],
): { readonly x: number, readonly y: number } {
  const x = point[0] ?? 0
  const y = point[1] ?? 0
  return {
    x: Math.round(frame.left + (x / POINT_SPAN) * frame.spanX),
    y: Math.round(frame.top + (y / POINT_SPAN) * frame.spanY),
  }
}

/**
 * Geometry for one captured window picture.
 * @param bounds - the window's logical rectangle.
 * @param shot - the capture's own size and scale.
 * @returns the frame a later point maps through.
 */
export function frameOf(
  bounds: Rect,
  shot: { readonly width: number, readonly height: number, readonly scale: number },
): Pick<Frame, 'left' | 'top' | 'spanX' | 'spanY'> {
  const scale = shot.scale > 0 ? shot.scale : 1
  const padding = picturePadding(shot.width, shot.height, bounds, scale)
  const padX = padding.x / scale
  const padY = padding.y / scale
  return {
    left: bounds.x - padX,
    top: bounds.y - padY,
    spanX: bounds.width + padX * 2,
    spanY: bounds.height + padY * 2,
  }
}

/**
 * Whether a stored picture still addresses the same controls.
 * @param frame - geometry recorded with the picture.
 * @param bounds - the window's rectangle now.
 * @returns true when the window has not moved or resized.
 */
export function frameStillValid(frame: Pick<Frame, 'bounds'>, bounds: Rect | undefined): boolean {
  if (bounds === undefined) return false
  return bounds.x === frame.bounds.x
    && bounds.y === frame.bounds.y
    && bounds.width === frame.bounds.width
    && bounds.height === frame.bounds.height
}

/** Case-insensitive app match that also accepts a localized name either way. */
function sameApp(left: string, right: string): boolean {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Choose the window a call acts on.
 *
 * Deliberately lenient: an app with several windows used to make an app-name
 * read fail with AMBIGUOUS_TARGET, and each such failure cost a whole model
 * turn. Picking the focused (else the largest titled) window and printing its
 * siblings costs one line and lets the model correct on the next call.
 * @param windows - every window the OS reports.
 * @param args - the call's `window` and `app`.
 * @param last - the window this session last saw.
 * @returns the chosen window and the app's other windows.
 */
export function chooseTarget(
  windows: readonly WindowInfo[],
  args: { readonly window?: string, readonly app?: string },
  last: string | undefined,
): { target?: Target, siblings: readonly Target[], why: string } {
  const usable = windows.filter(window => window.bounds !== undefined && window.id !== undefined)
  const asTarget = (window: WindowInfo): Target => ({
    windowId: window.id,
    appName: window.appName,
    title: window.title,
    bounds: window.bounds as Rect,
    focused: window.focused,
    accessible: window.accessible === true,
  })
  const siblingsOf = (target: Target): readonly Target[] =>
    usable
      .filter(window => window.id !== target.windowId && sameApp(window.appName, target.appName))
      .map(asTarget)

  const wanted = args.window
  if (wanted !== undefined && wanted !== '') {
    const exact = usable.find(window => window.id === wanted)
    const loose = exact ?? usable.find(window => window.id.replace(/^w-/, '') === wanted.replace(/^w-/, ''))
    if (loose === undefined) return { siblings: [], why: `no window ${wanted} is open` }
    const target = asTarget(loose)
    return { target, siblings: siblingsOf(target), why: '' }
  }

  const app = args.app
  if (app !== undefined && app !== '') {
    const matches = usable.filter(window => sameApp(window.appName, app))
    if (matches.length === 0) {
      const names = [...new Set(usable.map(window => window.appName))].slice(0, 12)
      return { siblings: [], why: `no window belongs to "${app}". Open windows belong to: ${names.join(', ')}` }
    }
    const visible = matches.filter(window => window.visible !== false)
    const pool = visible.length > 0 ? visible : matches
    const pick = pool.find(window => window.focused)
      ?? pool.slice().sort((a, b) => area(b.bounds as Rect) - area(a.bounds as Rect))[0]
    const target = asTarget(pick as WindowInfo)
    return { target, siblings: siblingsOf(target), why: '' }
  }

  if (last !== undefined) {
    const known = usable.find(window => window.id === last)
    if (known !== undefined) {
      const target = asTarget(known)
      return { target, siblings: siblingsOf(target), why: '' }
    }
  }

  const front = usable.find(window => window.focused)
  if (front !== undefined) {
    const target = asTarget(front)
    return { target, siblings: siblingsOf(target), why: '' }
  }
  return { siblings: [], why: 'no window is in front and none was named' }
}

function area(rect: Rect): number {
  return rect.width * rect.height
}

/** Keys a model writes, in the CLI's vocabulary. */
const CLI_KEYS: Record<string, string> = {
  enter: 'return',
  esc: 'escape',
  escape: 'escape',
  return: 'return',
  tab: 'tab',
  space: 'space',
  backspace: 'delete',
  delete: 'delete',
  del: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

/**
 * Normalize a key combo for `agent-desktop press`.
 * @param combo - for example `Return`, `cmd+c`, `Shift+Tab`.
 * @returns the CLI's form, for example `return`, `cmd+c`.
 */
export function cliCombo(combo: string): string {
  return combo
    .split('+')
    .map(part => part.trim().toLowerCase())
    .map(part => CLI_KEYS[part] ?? part)
    .join('+')
}

/** Build the one line that names the window a picture shows. */
function windowLine(target: Target): string {
  const size = `${String(target.bounds.width)}x${String(target.bounds.height)}`
  return `window ${target.appName} ${target.windowId} ${size} `
    + `front=${target.focused ? 'yes' : 'no'} tree=${target.accessible ? 'yes' : 'no'}`
}

/** A picture that could not be taken is text only. */
interface Observed {
  readonly text: string
  readonly window_id?: string
  readonly image?: ImageValue
}

/**
 * A refusal or a short note that still hands back the picture the model needs.
 *
 * A point refers to the previous picture. When that picture is gone, stale, or
 * belongs to another window, the correction is immediate — so it arrives with
 * this same result instead of costing an extra turn to fetch.
 * @param lead - what went wrong.
 * @param fresh - the picture just taken.
 * @returns the combined result.
 */
function withPicture(lead: string, fresh: Observed): Observed {
  return { ...fresh, text: `${lead}\n\n${fresh.text}` }
}

/**
 * Check a point is a real 0–1000 pair.
 * @param point - model-supplied array.
 * @returns the same point, or undefined when it is malformed.
 */
function validPoint(point: readonly number[] | undefined): readonly [number, number] | undefined {
  if (point === undefined || point.length !== 2) return undefined
  const x = point[0]
  const y = point[1]
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  if (x < 0 || y < 0 || x > POINT_SPAN || y > POINT_SPAN) return undefined
  return [x, y]
}

/**
 * Register the GUI tool.
 * @param ctx - preset context carrying tools and attachments.
 * @param config - resolved tunables.
 * @param dependencies - injectable side effects, so tests never touch a screen.
 */
export interface GuiDependencies {
  /** Bring one app to the front. */
  readonly activate?: (app: string) => Promise<void>
}

export function registerGuiTools(
  ctx: Context,
  config: ResolvedConfig,
  dependencies: GuiDependencies = {},
): void {
  const activate = dependencies.activate ?? activateApp
  /** The picture each session last received. */
  const frames = new Map<string, Frame>()
  /** When each (window, action) last landed, for the repeat guard. */
  const landed = new Map<string, number>()

  const sessionKey = (exec: { agent?: { id?: string } }): string => {
    const id = exec.agent?.id
    return typeof id === 'string' && id !== '' ? id : 'anonymous'
  }

  ctx.effect(() => () => {
    frames.clear()
    landed.clear()
  })

  /**
   * Capture one window, attach it, and remember the frame its points map through.
   * @param target - the window to show.
   * @param signal - cooperative cancellation.
   * @param lead - the sentence that says what just happened.
   * @param key - session whose frame is updated.
   * @param note - extra line, for example the app's other windows.
   * @returns text plus the picture.
   */
  const observe = async (
    target: Target,
    signal: AbortSignal,
    lead: string,
    key: string,
    note = '',
  ): Promise<Observed> => {
    const captured = await captureWindow(target.windowId, signal)
    if (!captured.ok || captured.data === undefined) {
      return {
        text: `${lead}\nthis window could not be captured: ${failureText(captured)}\n`
          + 'It may be minimized, closing, or on a display this machine cannot raster. '
          + `Call desktop with action=see and window=${target.windowId} once it is visible, `
          + 'or look at another window.',
        window_id: target.windowId,
      }
    }
    const shot = captured.data
    const saved = await storePicture(ctx, target.windowId, Buffer.from(shot.data, 'base64'), shot.format)
    frames.set(key, {
      windowId: target.windowId,
      appName: target.appName,
      bounds: target.bounds,
      ...frameOf(target.bounds, { width: shot.width, height: shot.height, scale: shot.scale_factor }),
    })
    const lines = [lead, windowLine(target)]
    if (note !== '') lines.push(note)
    return { text: lines.join('\n'), window_id: target.windowId, image: saved }
  }

  /**
   * Bring the target window in front, so a click at its screen coordinates
   * actually lands in it.
   * @param target - window to raise.
   * @param signal - cooperative cancellation.
   * @returns undefined on success, or the reason it did not come forward.
   */
  const ensureFront = async (target: Target, signal: AbortSignal): Promise<string | undefined> => {
    if (target.focused) return undefined
    const raised = await runCli<unknown>(['focus-window', '--window-id', target.windowId], signal)
    if (!raised.ok) {
      return `could not bring ${target.appName} (${target.windowId}) to the front, so a click would land in `
        + `another app: ${failureText(raised)}`
    }
    return undefined
  }

  ctx.tools.register(defineTool({
    name: 'desktop',
    description:
      'Operate one desktop window. Every call does one thing and returns a new picture of that window, '
      + 'so one call is one step — no separate look, no separate status check. '
      + 'point is [x, y] on a 0–1000 grid over the picture you were just given: (0,0) is its top-left, '
      + '(1000,1000) its bottom-right. Read the position off the picture; never compute pixels or screen coordinates. '
      + 'Actions: see (show a window), click, type (text into the focused field, optional point to click first and '
      + 'enter to submit), press (one key combo), scroll, drag, launch (start or activate an app). '
      + 'A click raises the window first, because the pointer is real. Windows with no accessibility tree work '
      + 'exactly as well here as native ones. When an app has several windows the result names them: pass window '
      + 'to pick one.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['see', 'click', 'type', 'press', 'scroll', 'drag', 'launch'],
        description: 'What to do.',
      },
      window: {
        type: 'string',
        description: 'Window id from a previous result, for example w-35248. Omit to use this session\'s last window.',
      },
      app: {
        type: 'string',
        description: 'Application name, for launch, or to pick an app\'s window when you have no id yet.',
      },
      point: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y] on the 0–1000 grid over the picture, not pixels. For click, type, scroll.',
      },
      to: {
        type: 'array',
        items: { type: 'number' },
        description: '[x, y] on the 0–1000 grid, the end of a drag.',
      },
      text: {
        type: 'string',
        description: 'What to type.',
      },
      replace: {
        type: 'boolean',
        description: 'For type: select the field\'s existing content first. Default: false.',
      },
      enter: {
        type: 'boolean',
        description: 'For type: press Return after typing. Default: false.',
      },
      keys: {
        type: 'string',
        description: 'For press: one combo, for example Return, escape, cmd+c, cmd+shift+4.',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'For scroll.',
      },
      amount: {
        type: 'integer',
        description: 'For scroll: 1 (smallest) to 10 (largest). Default: 3.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'For click. Default: left.',
      },
      count: {
        type: 'integer',
        description: 'For click: 1 or 2. Default: 1.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          window_id: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: typeImageValue(value.image) })
        return blocks
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await requireImageRoute(ctx, exec)
      const key = sessionKey(exec)
      const screen = await sessionState()
      if (screen.locked) {
        return {
          text: 'SCREEN_LOCKED: this Mac is locked, so no picture can be taken and no click can land. '
            + 'Unlocking needs the password and is not something this worker can do. Stop trying desktop tools: '
            + 'finish what you can without the screen, then report what is blocked and what the user must do.',
        }
      }
      const action = String(args.action)
      const parsed: ActionArgs = {
        action,
        ...typeof args.window === 'string' && args.window !== '' ? { window: args.window } : {},
        ...typeof args.app === 'string' && args.app !== '' ? { app: args.app } : {},
        ...Array.isArray(args.point) ? { point: args.point as readonly number[] } : {},
        ...Array.isArray(args.to) ? { to: args.to as readonly number[] } : {},
        ...typeof args.text === 'string' ? { text: args.text } : {},
        ...typeof args.keys === 'string' && args.keys !== '' ? { keys: args.keys } : {},
        ...typeof args.direction === 'string' ? { direction: args.direction } : {},
        ...typeof args.amount === 'number' ? { amount: args.amount } : {},
        ...typeof args.button === 'string' ? { button: args.button } : {},
        ...typeof args.count === 'number' ? { count: args.count } : {},
        ...args.replace === true ? { replace: true } : {},
        ...args.enter === true ? { enter: true } : {},
      }

      // Launch first: it is the one action that may need a window that does not exist yet.
      if (action === 'launch') {
        const name = parsed.app ?? parsed.window
        if (name === undefined) return { text: 'INVALID_ARGS: launch needs an app name.' }
        try {
          await activate(name)
        } catch (error) {
          return {
            text: `LAUNCH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        const deadline = Date.now() + LAUNCH_WAIT_MS
        let found: WindowInfo | undefined
        while (Date.now() < deadline) {
          const listed = await listWindows(exec.signal)
          if (listed.ok && listed.data !== undefined) {
            found = listed.data
              .filter(window => sameApp(window.appName, name) && window.bounds !== undefined)
              .sort((a, b) => (b.bounds === undefined ? 0 : area(b.bounds)) - (a.bounds === undefined ? 0 : area(a.bounds)))[0]
          }
          if (found !== undefined) break
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        if (found === undefined) {
          const listed = await listWindows(exec.signal)
          const names = listed.ok && listed.data !== undefined
            ? [...new Set(listed.data.map(window => window.appName))].slice(0, 12).join(', ')
            : 'unavailable'
          return { text: `LAUNCH_FAILED: ${name} did not show a window within ${String(LAUNCH_WAIT_MS / 1000)}s. `
            + `Open windows belong to: ${names}` }
        }
        return await observe({
          windowId: found.id,
          appName: found.appName,
          title: found.title,
          bounds: found.bounds as Rect,
          focused: found.focused,
          accessible: found.accessible === true,
        }, exec.signal, `${name} is up.`, key)
      }

      const listed = await listWindows(exec.signal)
      if (!listed.ok || listed.data === undefined) {
        const code = listed.error?.code ?? 'UNKNOWN'
        const hint = code === 'TIMEOUT'
          ? '\nThe screen may be locked, or an app is not answering. No picture can be taken in that state. '
            + 'Do not retry: report what is blocked.'
          : ''
        return { text: `desktop failed\n${failureText(listed)}${hint}` }
      }
      const current = frames.get(key)
      const chosen = chooseTarget(listed.data, parsed, current?.windowId)
      if (chosen.target === undefined) {
        return { text: `WINDOW_NOT_FOUND: ${chosen.why}` }
      }
      let target = chosen.target
      const siblingNote = chosen.siblings.length === 0
        ? ''
        : `\nother ${target.appName} windows: ${chosen.siblings
          .slice(0, 6)
          .map(window => `${window.windowId} ${String(window.bounds.width)}x${String(window.bounds.height)}`
            + (window.title === '' ? '' : ` ${window.title.replace(/[\r\n]+/g, ' ').slice(0, 40)}`))
          .join(' | ')}`

      /** Show the current target with this call's window list appended. */
      const show = async (lead: string): Promise<Observed> =>
        await observe(target, exec.signal, lead, key, siblingNote)

      // A point belongs to the picture the model was last given. When that
      // picture is gone or stale, the cheapest correction is to hand the model a
      // fresh one in this same result, so the retry costs no extra turn.
      const needsPicture = action === 'click' || action === 'scroll' || action === 'drag'
        || (action === 'type' && parsed.point !== undefined)
      const point = validPoint(parsed.point)
      if (needsPicture) {
        if (parsed.point !== undefined && point === undefined) {
          return { text: 'INVALID_ARGS: point must be [x, y] with both on a 0–1000 grid.' }
        }
        if (parsed.point === undefined) {
          return { text: 'INVALID_ARGS: this action needs point, [x, y] on the 0–1000 grid of the picture.' }
        }
        if (current === undefined) {
          const fresh = await show('no picture yet — here is the window.')
          return withPicture(
            'NO_PICTURE: a point refers to the picture from the previous result, and this session has none. '
            + 'Use the picture below and make the call again.',
            fresh,
          )
        }
        if (current.windowId !== target.windowId) {
          const fresh = await show('that point belonged to another window; here is this one.')
          return withPicture(
            `WRONG_WINDOW: the last picture was ${current.appName} (${current.windowId}), not `
            + `${target.appName} (${target.windowId}). Use the picture below and make the call again.`,
            fresh,
          )
        }
        const nowBounds = target.bounds
        if (!frameStillValid(current, nowBounds)) {
          const fresh = await show('the window moved or resized; here it is again.')
          return withPicture(
            'VIEWPORT_CHANGED: the window moved or resized after that picture, so its points no longer mean the '
            + 'same controls. Use the picture below and make the call again.',
            fresh,
          )
        }
      }

      if (action === 'see') {
        return await show('here is the window.')
      }

      if (action === 'press' && parsed.keys === undefined) {
        return { text: 'INVALID_ARGS: press needs keys, for example Return or cmd+c.' }
      }
      if (action === 'type' && (parsed.text === undefined || parsed.text === '')) {
        return { text: 'INVALID_ARGS: type needs text.' }
      }
      if (action === 'type' && !canPasteAtFocus()) {
        return {
          text: 'PLATFORM_NOT_SUPPORTED: typing into a window by point needs a pasteboard round trip, '
            + 'which this plugin only implements on macOS. Use desktop_inspect and desktop_act here.',
        }
      }

      // The same click or the same key twice in a row is nearly always the model
      // doubting the previous result. Name that instead of sending it again.
      const repeatKey = action === 'click' || action === 'press'
        ? [target.windowId, action, point?.join(','), parsed.keys ?? '', String(parsed.count ?? 1)].join('\u0000')
        : undefined
      if (repeatKey !== undefined) {
        const when = landed.get(repeatKey)
        if (when !== undefined && Date.now() - when < config.repeatWindowMs) {
          const fresh = await show(`that ${action} already ran ${String(Math.round((Date.now() - when) / 1000))}s ago and may have landed.`)
          return withPicture('IDENTICAL_ACTION: it was not sent again. Decide from the picture below.', fresh)
        }
      }

      try {
        if (action === 'type') {
          // Text delivery pastes, so the window has to be in front for the keys
          // to reach it; a click also puts the caret where the caller asked.
          const blocked = await ensureFront(target, exec.signal)
          if (blocked !== undefined) {
            const fresh = await show('nothing was sent.')
            return withPicture(blocked, fresh)
          }
          target = { ...target, focused: true }
          const at = point === undefined ? undefined : pointToScreen(current as Frame, point)
          // One lock for the click and the keys: the foreground Computer Use
          // session moves the same pointer and posts the same events.
          const failure = await withScreenLock(exec.agent?.id, async (): Promise<string | undefined> => {
            if (at !== undefined) {
              const clicked = await runCli<unknown>([
                'mouse-click', '--headed', '--xy', `${String(at.x)},${String(at.y)}`,
                '--button', 'left', '--count', '1',
              ], exec.signal)
              if (!clicked.ok) return failureText(clicked)
              // The field takes keyboard focus on its own run-loop turn.
              await new Promise(resolve => setTimeout(resolve, FOCUS_SETTLE_MS))
            }
            await typeAtFocus(parsed.text as string, {
              ...parsed.replace === true ? { replace: true } : {},
              ...parsed.enter === true ? { enter: true } : {},
            }, exec.signal)
            return undefined
          })
          if (failure !== undefined) {
            const fresh = await show('the focus click failed, so nothing was typed.')
            return withPicture(failure, fresh)
          }
          const lead = `typed ${String((parsed.text as string).length)} character(s)`
            + `${parsed.enter === true ? ' and pressed Return' : ''}`
            + `${parsed.replace === true ? ' (replacing the field)' : ''}.`
          return await show(lead)
        }

        const blocked = await ensureFront(target, exec.signal)
        if (blocked !== undefined) {
          const fresh = await show('nothing was sent.')
          return withPicture(blocked, fresh)
        }
        target = { ...target, focused: true }

        if (action === 'click') {
          const at = pointToScreen(current as Frame, point as readonly [number, number])
          const clicked = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
            'mouse-click', '--headed', '--xy', `${String(at.x)},${String(at.y)}`,
            '--button', parsed.button ?? 'left',
            '--count', String(parsed.count ?? 1),
          ], exec.signal))
          if (!clicked.ok) {
            const fresh = await show('the click was not delivered.')
            return withPicture(failureText(clicked), fresh)
          }
          if (repeatKey !== undefined) landed.set(repeatKey, Date.now())
          return await show(`clicked ${fmtPoint(point as readonly [number, number])} — screen (${String(at.x)},${String(at.y)}).`)
        }

        if (action === 'scroll') {
          const at = pointToScreen(current as Frame, point as readonly [number, number])
          const direction = parsed.direction ?? 'down'
          const magnitude = Math.min(10, Math.max(1, parsed.amount ?? 3))
          const lines = magnitude * 3
          const dy = direction === 'up' ? lines : direction === 'down' ? -lines : 0
          const dx = direction === 'right' ? lines : direction === 'left' ? -lines : 0
          const scrolled = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
            'mouse-wheel', '--x', String(at.x), '--y', String(at.y),
            ...dy !== 0 ? ['--dy', String(dy)] : [],
            ...dx !== 0 ? ['--dx', String(dx)] : [],
          ], exec.signal))
          if (!scrolled.ok) {
            const fresh = await show('the scroll was not delivered.')
            return withPicture(failureText(scrolled), fresh)
          }
          return await show(`scrolled ${direction} at ${fmtPoint(point as readonly [number, number])}.`)
        }

        if (action === 'drag') {
          const end = validPoint(parsed.to)
          if (end === undefined) return { text: 'INVALID_ARGS: drag needs to, [x, y] on the 0–1000 grid.' }
          const from = pointToScreen(current as Frame, point as readonly [number, number])
          const to = pointToScreen(current as Frame, end)
          const dragged = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
            'drag', '--headed',
            '--from-xy', `${String(from.x)},${String(from.y)}`,
            '--to-xy', `${String(to.x)},${String(to.y)}`,
          ], exec.signal))
          if (!dragged.ok) {
            const fresh = await show('the drag was not delivered.')
            return withPicture(failureText(dragged), fresh)
          }
          return await show(`dragged ${fmtPoint(point as readonly [number, number])} → ${fmtPoint(end)}.`)
        }

        if (action === 'press') {
          const combo = cliCombo(parsed.keys as string)
          const sent = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>(
            ['press', '--window-id', target.windowId, combo],
            exec.signal,
          ))
          if (!sent.ok) {
            const fresh = await show('the key was not delivered.')
            return withPicture(failureText(sent), fresh)
          }
          if (repeatKey !== undefined) landed.set(repeatKey, Date.now())
          return await show(`pressed ${combo}.`)
        }

        return { text: `INVALID_ARGS: unknown action ${action}.` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const busy = message.includes('operating the screen')
        return {
          text: busy
            ? 'SCREEN_BUSY: another session is using the screen, so nothing was sent. Report the conflict; do not retry.'
            : `desktop failed before sending\n${message}${siblingNote}`,
        }
      }
    },
  }))
}

/**
 * Format a point for the result text.
 * @param point - 0–1000 pair.
 * @returns a short human form.
 */
function fmtPoint(point: readonly [number, number]): string {
  return `${point[0].toFixed(0)}%,${point[1].toFixed(0)}%`
}
