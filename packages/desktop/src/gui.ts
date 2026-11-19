/**
 * The visual route: one tool per gesture, and every gesture answers with the
 * window as it now looks.
 *
 * These tools are the foreground Computer Use set, retargeted at a named window
 * instead of "whatever is frontmost": `click`, `input_text`, `scroll`, `hotkey`,
 * `drag`, `wait`, `open_app`. The shape is deliberately the same, because that
 * shape is what makes the mode fast — one call does one thing and returns the
 * next picture, so a step is a step and never two. Two differences are forced by
 * being a background worker:
 *
 * - there is no first frame injected at session start, so `desktop_see` exists to
 *   take the first look on purpose;
 * - a window can be named, because the worker is usually told which app to
 *   operate rather than being handed whatever the user has in front.
 *
 * Points are `[x, y]` on a 0–1000 grid over the picture in the previous result.
 * That removes the pixel arithmetic, the scale factor, the window rectangle and
 * the drop-shadow padding from every click — and it survives the attachment
 * store downscaling the picture, because a fraction does not care.
 *
 * The accessibility tree is still here, one door over: `desktop_inspect` reads it
 * and `desktop_act` acts on a ref. That pair is the fallback for the cases a
 * picture cannot settle, and the route that does not disturb the user.
 * @module @dsh-orb/desktop/src/gui
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.ts'
import type { SnapshotData, WindowInfo } from './protocol.ts'
import {
  DEFAULT_SNAPSHOT_DEPTH,
  captureWindow,
  failureText,
  listWindows,
  picturePadding,
  runCli,
  snapshotWindow,
  storePicture,
  typeImageValue,
  type Envelope,
  type ImageValue,
  type SnapshotWindowOptions,
} from './vision.ts'
import { activateApp } from './activate.ts'
import { canPasteAtFocus, typeAtFocus, typeByRef } from './hid.ts'
import { withScreenLock } from './gui-lock.ts'
import { renderSnapshot } from './render.ts'
import { agentSessionId, type DesktopSessions } from './sessions.ts'
import { requireImageRoute } from './route.ts'
import { sessionState } from './session-state.ts'

/** A point is a fraction of the picture on a 0–1000 grid, on both axes. */
export const POINT_SPAN = 1000

/** How long a window has to appear after `desktop_open_app` before it gives up. */
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
export interface Target {
  readonly windowId: string
  readonly appName: string
  readonly title: string
  readonly bounds: Rect
  readonly focused: boolean
  readonly accessible: boolean
  /** Whether the OS says the window is on screen. A hidden one cannot be focused. */
  readonly visible: boolean
  /** Owning process, which is the stable identity when the title changes. */
  readonly pid: number
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

/** What one gesture needs, after the tool has validated its own arguments. */
interface Gesture {
  readonly window?: string
  readonly app?: string
  readonly point?: readonly [number, number]
  readonly to?: readonly [number, number]
  readonly text?: string
  readonly keys?: readonly string[]
  readonly direction?: string
  readonly amount?: number
  readonly button?: string
  readonly count?: number
  readonly replace?: boolean
  readonly submit?: boolean
  readonly seconds?: number
}

/**
 * Map a 0–1000 point on the picture to the absolute screen point `--xy` takes.
 * @param frame - geometry recorded when the picture was captured.
 * @param point - `[x, y]` on the 0–1000 grid.
 * @returns the logical screen point, rounded to whole points.
 */
export function pointToScreen(
  frame: Pick<Frame, 'left' | 'top' | 'spanX' | 'spanY'>,
  point: readonly [number, number],
): { readonly x: number, readonly y: number } {
  return {
    x: Math.round(frame.left + (point[0] / POINT_SPAN) * frame.spanX),
    y: Math.round(frame.top + (point[1] / POINT_SPAN) * frame.spanY),
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
  shot: { readonly width: number, readonly height: number, readonly scale: number, readonly shadowless?: boolean },
): Pick<Frame, 'left' | 'top' | 'spanX' | 'spanY'> {
  // Shadowless captures (macOS `screencapture -o`) cover the exact window
  // rectangle with 0 pt error on both axes, immune to asymmetric drop shadows.
  if (shot.shadowless === true) {
    return {
      left: bounds.x,
      top: bounds.y,
      spanX: bounds.width,
      spanY: bounds.height,
    }
  }
  // A capture that reports no scale (the OS tool) is exactly the window, so the
  // raster's own width is the scale. The CLI reports it directly and may include
  // the drop shadow, which `picturePadding` then measures.
  const derived = bounds.width > 0 ? shot.width / bounds.width : 0
  const scale = shot.scale > 0 ? shot.scale : (derived > 0 ? derived : 1)
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
 * Below this a window is a helper surface, not something a person uses: a
 * menu-bar strip, a 1x1 renderer, a tab bar fragment.
 *
 * QQ keeps thirteen windows and only one of them is ever on screen. Offering the
 * other twelve as "other QQ windows" is worse than saying nothing: a run spent
 * sixty seconds clicking 1920x30 and 1x1 windows because they were listed.
 */
const MIN_TARGET_WIDTH = 120
const MIN_TARGET_HEIGHT = 80

/** Whether a window is big enough to be a real target. */
function isSubstantial(window: WindowInfo): boolean {
  const bounds = window.bounds
  if (bounds === undefined) return false
  return bounds.width >= MIN_TARGET_WIDTH && bounds.height >= MIN_TARGET_HEIGHT
}

/**
 * Whether a window is minimized or parked at Windows' off-screen minimized
 * sentinel coordinates (`-32000, -32000`). Minimized windows on Windows cannot
 * be driven through UIA until restored via `agent-desktop restore`.
 */
export function isMinimizedWindow(window: WindowInfo): boolean {
  if (window.visible === false) return true
  const b = window.bounds
  if (b === undefined) return false
  return b.x <= -30_000 || b.y <= -30_000
}

function area(rect: Rect): number {
  return rect.width * rect.height
}

/**
 * Resolve an app name or bundle id to the pid that owns its windows.
 *
 * The CLI's matcher is the same one `focus-window` and `snapshot` use, so it
 * accepts what the OS accepts: a display name in any language, or a bundle id.
 * @param name - what the caller typed.
 * @param signal - cooperative cancellation.
 * @returns the pid, or undefined when no running app matches.
 */
async function resolveAppPid(name: string, signal: AbortSignal): Promise<number | undefined> {
  const listed = await runCli<{ apps?: readonly { pid?: number }[] }>(['list-apps', '--app', name], signal)
  if (!listed.ok) return undefined
  return listed.data?.apps?.[0]?.pid
}

/**
 * Pick one window out of a candidate pool.
 *
 * Order: focused, else the largest. `list-windows` is ordered by descending
 * window id, which is creation order, not z-order, so position in the list says
 * nothing about what is on top. Windows that are not on screen are only used
 * when nothing else is available — a hidden window cannot be focused, so a point
 * aimed at one can never land.
 * @param pool - candidates from one app or from the whole desktop.
 * @returns the best window, or undefined when the pool is empty.
 */
function preferredWindow(pool: readonly WindowInfo[]): WindowInfo | undefined {
  const byArea = (list: readonly WindowInfo[]): WindowInfo | undefined =>
    list.slice().sort((a, b) => area(b.bounds as Rect) - area(a.bounds as Rect))[0]
  const onScreen = pool.filter(window => window.visible !== false)
  for (const list of [
    onScreen.filter(isSubstantial),
    onScreen,
    pool.filter(isSubstantial),
    pool,
  ]) {
    if (list.length === 0) continue
    return list.find(window => window.focused) ?? byArea(list)
  }
  return undefined
}

/**
 * Choose the window a call acts on.
 *
 * Deliberately lenient: an app with several windows used to make an app-name
 * read fail with AMBIGUOUS_TARGET, and each such failure cost a whole model
 * turn. Picking one and printing its siblings costs one line and lets the model
 * correct on the next call — as long as the siblings it prints are real windows
 * and not helper surfaces.
 * @param windows - every window the OS reports.
 * @param args - the call's `window` and `app`.
 * @param last - the window this session last saw.
 * @returns the chosen window and the app's other usable windows.
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
    visible: window.visible !== false,
    pid: window.pid,
  })
  const siblingsOf = (target: Target): readonly Target[] =>
    usable
      .filter(window => window.id !== target.windowId && sameApp(window.appName, target.appName))
      // Only windows a person could be looking at. QQ keeps twelve hidden helper
      // surfaces for every one it shows; listing them is what made a run spend a
      // minute clicking 1920x30 and 1x1 windows.
      .filter(window => window.visible !== false && isSubstantial(window))
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
    const pick = preferredWindow(matches)
    if (pick === undefined) {
      const names = [...new Set(usable.map(window => window.appName))].slice(0, 12)
      return { siblings: [], why: `no window belongs to "${app}". Open windows belong to: ${names.join(', ')}` }
    }
    const target = asTarget(pick)
    return { target, siblings: siblingsOf(target), why: '' }
  }

  if (last !== undefined) {
    // Only reuse the previous window while it is still on screen: a window that
    // went hidden cannot be focused, so keeping it would make the next click fail
    // for a reason the model cannot see.
    const known = usable.find(window => window.id === last && window.visible !== false)
    if (known !== undefined) {
      const target = asTarget(known)
      return { target, siblings: siblingsOf(target), why: '' }
    }
  }

  const front = usable.find(window => window.focused) ?? preferredWindow(usable)
  if (front !== undefined) {
    const target = asTarget(front)
    return { target, siblings: siblingsOf(target), why: '' }
  }
  return { siblings: [], why: 'no window is in front and none was named' }
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
 * Normalize a key combination for `agent-desktop`.
 *
 * Accepts the array form the tools take (`["cmd", "c"]`) and the string form a
 * test or a human writes (`cmd+c`).
 * @param combo - key names in order, or one `+`-joined combo.
 * @returns the CLI's form, for example `cmd+c`.
 */
export function cliCombo(combo: string | readonly string[]): string {
  const parts = typeof combo === 'string' ? combo.split('+') : [...combo]
  return parts
    .map(part => part.trim().toLowerCase())
    .map(part => CLI_KEYS[part] ?? part)
    .filter(part => part !== '')
    .join('+')
}

/** Build the one line that names a window, in the format every tool uses. */
export function windowLine(target: Target): string {
  const size = `${String(target.bounds.width)}x${String(target.bounds.height)}`
  // The title is what tells a chat panel from that app's built-in browser: QQ
  // opens its document viewer as a window called "QQ(窗口)", and an earlier run
  // spent five turns working out that the picture it was given was not the app.
  const title = target.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
  return `window ${target.appName} ${target.windowId} ${size} `
    + `front=${target.focused ? 'yes' : 'no'} tree=${target.accessible ? 'yes' : 'no'}`
    // Only stated when it is the unusual case: an off-screen window cannot be
    // focused, so its picture may be blank and no click in it can land.
    + `${target.visible ? '' : ' on-screen=no'}`
    + `${title === '' ? '' : ` title="${title}"`}`
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
export function validPoint(point: readonly number[] | undefined): readonly [number, number] | undefined {
  if (point === undefined || point.length !== 2) return undefined
  const x = point[0]
  const y = point[1]
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  if (x < 0 || y < 0 || x > POINT_SPAN || y > POINT_SPAN) return undefined
  return [x, y]
}

/** The tool output every visual tool shares: a sentence, a window id, a picture. */
const PICTURE_OUTPUT = {
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
  render: (_args: unknown, value: { text: string, image?: ImageValue }): ContentBlock[] => {
    const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
    if (value.image !== undefined) blocks.push({ type: 'image', attachment: typeImageValue(value.image) })
    return blocks
  },
} as const

/**
 * Register the visual tools.
 * @param ctx - preset context carrying tools and attachments.
 * @param config - resolved tunables.
 * @param dependencies - injectable side effects, so tests never touch a screen.
 */
export interface GuiDependencies {
  /** Bring one app to the front. */
  readonly activate?: (app: string) => Promise<void>
  /** Shared session store so `desktop_open_app` can populate RefBook when returning an AX tree. */
  readonly sessions?: DesktopSessions
  /** Window inventory override for tests. */
  readonly listWindows?: (signal: AbortSignal) => Promise<Envelope<readonly WindowInfo[]>>
  /** PID resolver override for tests. */
  readonly resolveAppPid?: (name: string, signal: AbortSignal) => Promise<number | undefined>
  /** Accessibility snapshot override for tests. */
  readonly snapshot?: (
    windowId: string,
    options: SnapshotWindowOptions,
    signal: AbortSignal,
  ) => Promise<Envelope<SnapshotData>>
  /** Window capture override for tests. */
  readonly capture?: (
    windowId: string,
    signal: AbortSignal,
    bounds?: { readonly width: number; readonly height: number },
  ) => Promise<Envelope<import('./vision.ts').ScreenshotData>>
  /** Raw CLI runner override for tests. */
  readonly runCli?: <T>(args: readonly string[], signal: AbortSignal, stdin?: string) => Promise<Envelope<T>>
  /** Screen-lock probe override for tests. */
  readonly sessionState?: () => Promise<{ readonly locked: boolean | 'unknown' }>
}

export function registerGuiTools(
  ctx: Context,
  config: ResolvedConfig,
  dependencies: GuiDependencies = {},
): void {
  const activate = dependencies.activate ?? activateApp
  const sessions = dependencies.sessions
  const inventory = dependencies.listWindows ?? listWindows
  const resolvePid = dependencies.resolveAppPid ?? resolveAppPid
  const readWindow = dependencies.snapshot ?? snapshotWindow
  const capture = dependencies.capture ?? captureWindow
  const cli = dependencies.runCli ?? runCli
  const readLockState = dependencies.sessionState ?? sessionState
  /** The picture each session last received. */
  const frames = new Map<string, Frame>()
  /** When each (window, gesture) last landed, for the repeat guard. */
  const landed = new Map<string, number>()

  const sessionKey = (exec: { agent?: { id?: string } }): string => {
    const id = exec.agent?.id
    return typeof id === 'string' && id !== '' ? id : 'anonymous'
  }

  /**
   * Windows where the CLI's element search refused at least once.
   *
   * `find` answers ACTION_NOT_SUPPORTED for a window whose accessibility element
   * the CLI cannot reach, even when `snapshot` reads that same window fine — QQ's
   * main window is exactly like that. The answer will not change during a
   * session, and each miss costs a traversal, so remember it and paste straight
   * away next time.
   */
  const noElementSearch = new Set<string>()

  ctx.effect(() => () => {
    frames.clear()
    landed.clear()
    noElementSearch.clear()
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
    let captured = await capture(target.windowId, signal, target.bounds)
    if (!captured.ok && captured.error?.code === 'WINDOW_NOT_FOUND') {
      // System Settings renames its window per pane ("系统设置" → "桌面与程序坞"),
      // and the CLI treats a changed identity as a different window, so a capture
      // by the old id fails even though the app never moved. Re-resolve by pid —
      // the one identity that survives a title change — and try once more.
      const listed = await inventory(signal)
      const again = listed.ok && listed.data !== undefined
        ? preferredWindow(listed.data.filter(window => window.pid === target.pid && window.visible !== false))
        : undefined
      if (again !== undefined && again.id !== target.windowId) {
        target = {
          ...target,
          windowId: again.id,
          title: again.title,
          bounds: again.bounds as Rect,
          focused: again.focused,
          visible: again.visible !== false,
        }
        captured = await capture(target.windowId, signal, target.bounds)
      }
    }
    if (!captured.ok || captured.data === undefined) {
      return {
        text: `${lead}\nthis window could not be captured: ${failureText(captured)}\n`
          + 'It may be minimized, closing, or on a display this machine cannot raster. '
          + `Call desktop_see with window=${target.windowId} once it is visible, `
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
      ...frameOf(target.bounds, {
        width: shot.width,
        height: shot.height,
        scale: shot.scale_factor,
        ...shot.shadowless === true ? { shadowless: true } : {},
      }),
    })
    const lines = [lead, windowLine(target)]
    if (note !== '') lines.push(note)
    return { text: lines.join('\n'), window_id: target.windowId, image: saved }
  }

  /**
   * Bring the target window in front, so a click at its screen coordinates
   * actually lands in it.
   *
   * The focus is attempted even for a window the OS calls off-screen: that flag
   * is also false for a window on another Space, and focusing one of those does
   * work. Only when the attempt fails is the off-screen state used as the
   * explanation, because `focus-window` answers "focus did not settle" for a
   * hidden window — which reads like a transport failure and sends the model
   * looking for another window.
   * @param target - window to raise.
   * @param windows - every window, to name what is on screen instead.
   * @param signal - cooperative cancellation.
   * @returns undefined on success, or the reason it did not come forward.
   */
  const ensureFront = async (
    target: Target,
    windows: readonly WindowInfo[],
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (target.focused) return undefined
    let raised = await cli<unknown>(['focus-window', '--window-id', target.windowId], signal)
    if (raised.ok) return undefined
    // On Windows, `focus-window` can occasionally fail with "Window focus did
    // not settle" due to foreground lock rules even when unlocked. Try raising
    // via `activate` once and re-check before giving up.
    if (target.visible) {
      try {
        await activate(target.appName)
        raised = await cli<unknown>(['focus-window', '--window-id', target.windowId], signal)
        if (raised.ok) return undefined
      } catch {
        // Keep the original `focus-window` error below.
      }
    }
    if (!target.visible) {
      const alternatives = windows
        .filter(window => window.id !== target.windowId && window.visible !== false && isSubstantial(window))
        .slice(0, 4)
        .map(window => `${window.id} ${String(window.bounds?.width)}x${String(window.bounds?.height)}`)
      return `${target.appName} ${target.windowId} is not on screen. It may be minimized, behind a full-screen `
        + 'window, on another Space, or one of the app\'s internal helper windows. A click cannot land in it.'
        + (alternatives.length === 0
          ? ` No window of ${target.appName} is on screen at all: bring it up from the Dock or its menu bar, `
            + 'or relaunch it, then look again.'
          : ` On screen right now: ${alternatives.join(' | ')}.`)
    }
    return `could not bring ${target.appName} (${target.windowId}) to the front, so a click would land in `
      + `another app: ${failureText(raised)}\n`
      + `${target.appName} would not take focus. It may be minimized or behind a full-screen app. `
      + 'Try desktop_open_app with its name, or pick another window.'
  }

  /**
   * Resolve the target, refuse a point that does not fit the last picture, then
   * hand both back to the gesture.
   * @param gesture - the call's arguments.
   * @param exec - tool execution.
   * @param key - session key.
   * @param needsPoint - whether this gesture aims at a point in the last picture.
   * @returns the target, the frame, and the app's other windows.
   */
  const prepare = async (
    gesture: Gesture,
    exec: ToolExecution,
    key: string,
    needsPoint: boolean,
  ): Promise<{
    target?: Target
    frame?: Frame
    note: string
    windows: readonly WindowInfo[]
    refusal?: Observed
  }> => {
    const listed = await inventory(exec.signal)
    if (!listed.ok || listed.data === undefined) {
      const code = listed.error?.code ?? 'UNKNOWN'
      const hint = code === 'TIMEOUT'
        ? '\nThe screen may be locked, or an app is not answering. No picture can be taken in that state. '
          + 'Do not retry: report what is blocked.'
        : ''
      return { note: '', windows: [], refusal: { text: `could not list windows\n${failureText(listed)}${hint}` } }
    }
    const frame = frames.get(key)
    const chosen = chooseTarget(listed.data, gesture, frame?.windowId)
    if (chosen.target === undefined) {
      return { note: '', windows: listed.data, refusal: { text: `WINDOW_NOT_FOUND: ${chosen.why}` } }
    }
    const target = chosen.target
    const note = chosen.siblings.length === 0
      ? ''
      : `other ${target.appName} windows: ${chosen.siblings
        .slice(0, 6)
        .map(window => `${window.windowId} ${String(window.bounds.width)}x${String(window.bounds.height)}`)
        .join(' | ')}`

    if (!needsPoint) return { target, note, windows: listed.data }

    if (gesture.point === undefined) {
      return {
        target,
        note,
        windows: listed.data,
        refusal: await observe(target, exec.signal, 'no point given; here is the window to point at.', key, note),
      }
    }
    if (frame === undefined) {
      const fresh = await observe(target, exec.signal, 'no picture yet — here is the window.', key, note)
      return {
        target,
        note,
        windows: listed.data,
        refusal: withPicture(
          'NO_PICTURE: a point refers to the picture from the previous result, and this session has none. '
          + 'Use the picture below and make the call again.',
          fresh,
        ),
      }
    }
    if (frame.windowId !== target.windowId) {
      const fresh = await observe(target, exec.signal, 'that point belonged to another window; here is this one.', key, note)
      return {
        target,
        note,
        windows: listed.data,
        refusal: withPicture(
          `WRONG_WINDOW: the last picture was ${frame.appName} (${frame.windowId}), not `
          + `${target.appName} (${target.windowId}). Use the picture below and make the call again.`,
          fresh,
        ),
      }
    }
    if (!frameStillValid(frame, target.bounds)) {
      const fresh = await observe(target, exec.signal, 'the window moved or resized; here it is again.', key, note)
      return {
        target,
        note,
        windows: listed.data,
        refusal: withPicture(
          'VIEWPORT_CHANGED: the window moved or resized after that picture, so its points no longer mean the '
          + 'same controls. Use the picture below and make the call again.',
          fresh,
        ),
      }
    }
    return { target, frame, note, windows: listed.data }
  }

  /**
   * Refuse an identical gesture repeated inside the guard window.
   * @param target - window the gesture addresses.
   * @param name - gesture name.
   * @param guard - extra identity, for example the point or the keys.
   * @param note - window-list note to include.
   * @param exec - tool execution.
   * @param key - session key.
   * @returns a refusal with a fresh picture, or undefined to proceed.
   */
  const repeated = async (
    target: Target,
    name: string,
    guard: string,
    note: string,
    exec: ToolExecution,
    key: string,
  ): Promise<Observed | undefined> => {
    const id = [target.windowId, name, guard].join('\u0000')
    const when = landed.get(id)
    if (when !== undefined && Date.now() - when < config.repeatWindowMs) {
      const fresh = await observe(
        target,
        exec.signal,
        `that ${name} already ran ${String(Math.round((Date.now() - when) / 1000))}s ago and may have landed.`,
        key,
        note,
      )
      return withPicture('IDENTICAL_ACTION: it was not sent again. Decide from the picture below.', fresh)
    }
    return undefined
  }

  /** Record that a gesture landed, for {@link repeated}. */
  const remember = (target: Target, name: string, guard: string): void => {
    landed.set([target.windowId, name, guard].join('\u0000'), Date.now())
  }

  /** A settled picture: the app has had a moment to paint the result. */
  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, config.postActionWaitMs))
  }

  /** Check screen lock without requiring image modality (used by tree-first open_app). */
  const checkLock = async (): Promise<Observed | undefined> => {
    const screen = await readLockState()
    if (screen.locked === true) {
      return {
        text: 'SCREEN_LOCKED: this computer\'s screen is locked (or running outside an interactive desktop session), '
          + 'so no picture can be taken and no click can land. Unlocking needs the user and is not something this '
          + 'worker can do. Stop trying desktop tools: finish what you can without the screen, then report what is '
          + 'blocked and what the user must do.',
      }
    }
    return undefined
  }

  /** Common prelude: image route, lock check. Returns a refusal or undefined. */
  const admit = async (exec: ToolExecution): Promise<Observed | undefined> => {
    await requireImageRoute(ctx, exec)
    return await checkLock()
  }

  /**
   * Point one gesture at its window, refuse stale pictures, and report refusals
   * as a finished result.
   * @returns the window and frame, or a response to return as-is.
   */
  const aim = async (
    gesture: Gesture,
    exec: ToolExecution,
    key: string,
    needsPoint: boolean,
  ): Promise<
    { target: Target, frame?: Frame, note: string, windows: readonly WindowInfo[] } | { response: Observed }
  > => {
    const ready = await prepare(gesture, exec, key, needsPoint)
    if (ready.refusal !== undefined) return { response: ready.refusal }
    return {
      target: ready.target as Target,
      ...ready.frame === undefined ? {} : { frame: ready.frame },
      note: ready.note,
      windows: ready.windows,
    }
  }

  // ── the gestures ───────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'desktop_see',
    description:
      'Show one window as a picture. Every other desktop tool already returns a picture of what it did, so '
      + 'this is for the first look, or for looking again after something outside these tools changed the window '
      + '(a bash command, a web fetch, a background job). Nothing is written to the Desktop and nothing is copied '
      + 'to the clipboard. Points in the other tools are [x, y] on a 0–1000 grid over this picture.',
    parameters: {
      window: {
        type: 'string',
        description: 'Window id from a previous result, for example w-35248. Omit to use the window this session last saw.',
      },
      app: { type: 'string', description: 'Application name, when you have no window id yet.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const aimed = await aim({ ...pick(args, ['window', 'app']) }, exec, sessionKey(exec), false)
      if ('response' in aimed) return aimed.response
      return await observe(aimed.target, exec.signal, 'here is the window.', sessionKey(exec), aimed.note)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_click',
    description:
      'Click at a 0–1000 position on the picture from the previous result, then return the new picture. '
      + 'The window is raised first, because the pointer is real and the click goes to absolute screen coordinates. '
      + 'Use left (default) or right; count 2 is a double-click. Never click the same place again to "make sure" — '
      + 'the picture in this result is what happened.',
    parameters: {
      point: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of the picture, not pixels.',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button. Default: left.',
      },
      count: { type: 'integer', description: '1 for a single click, 2 for a double-click. Default: 1.' },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Modifiers held only for this click: cmd, shift, alt, ctrl.',
      },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const point = validPoint(args.point as readonly number[] | undefined)
      if (point === undefined) return { text: 'INVALID_ARGS: point must be [x, y] with both on a 0–1000 grid.' }
      const key = sessionKey(exec)
      const gesture: Gesture = { ...pick(args, ['window']), point, ...args.button === undefined ? {} : { button: String(args.button) }, ...args.count === undefined ? {} : { count: Number(args.count) } }
      const aimed = await aim(gesture, exec, key, true)
      if ('response' in aimed) return aimed.response
      const guard = `${point.join(',')}/${String(gesture.count ?? 1)}/${String(gesture.button ?? 'left')}`
      const again = await repeated(aimed.target, 'click', guard, aimed.note, exec, key)
      if (again !== undefined) return again
      const blockedFront = await ensureFront(aimed.target, aimed.windows, exec.signal)
      if (blockedFront !== undefined) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was sent.', key, aimed.note)
        return withPicture(blockedFront, fresh)
      }
      const at = pointToScreen(aimed.frame as Frame, point)
      const clicked = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
        'mouse-click', '--headed', '--xy', `${String(at.x)},${String(at.y)}`,
        '--button', gesture.button ?? 'left',
        '--count', String(gesture.count ?? 1),
        ...Array.isArray(args.modifiers)
          ? (args.modifiers as unknown[])
            .map(name => CLI_KEYS[String(name).toLowerCase()] ?? String(name).toLowerCase())
            .flatMap(name => ['--modifiers', name])
          : [],
      ], exec.signal))
      if (!clicked.ok) {
        const fresh = await observe(aimed.target, exec.signal, 'the click was not delivered.', key, aimed.note)
        return withPicture(failureText(clicked), fresh)
      }
      remember(aimed.target, 'click', guard)
      await settle()
      return await observe(
        aimed.target,
        exec.signal,
        `clicked ${fmtPoint(point)} — screen (${String(at.x)},${String(at.y)}).`,
        key,
        aimed.note,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_input_text',
    description:
      'Type text into a window, then return the new picture. Always point at the field: the click is what '
      + 'guarantees the text lands there rather than wherever focus happened to be. '
      + 'The text goes in through the accessibility tree when the window has one, so it never touches the clipboard '
      + 'and cannot land in the wrong field; when the window has no tree, macOS falls back to pasting and puts the '
      + 'clipboard back as it was. replace selects the field\'s content first; submit presses Return afterwards. '
      + 'On a window with a usable tree, desktop_act set_value is the same thing in one call.',
    parameters: {
      text: { type: 'string', required: true, description: 'Characters to type.' },
      point: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of the picture. The click focuses the field; '
          + 'without it the text goes wherever focus happens to be, which is how a message lands in the wrong place.',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
      replace: { type: 'boolean', description: 'Select the field\'s existing content first. Default: false.' },
      submit: { type: 'boolean', description: 'Press Return after typing. Default: false.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const text = typeof args.text === 'string' ? args.text : ''
      if (text === '') return { text: 'INVALID_ARGS: text is required.' }
      const point = validPoint(args.point as readonly number[] | undefined)
      if (point === undefined) {
        return { text: 'INVALID_ARGS: point is required and must be [x, y] with both on a 0–1000 grid. '
          + 'Click the field you mean; the click is what focuses it.' }
      }
      const key = sessionKey(exec)
      const gesture: Gesture = {
        ...pick(args, ['window']),
        point,
        replace: args.replace === true,
        submit: args.submit === true,
      }
      const aimed = await aim(gesture, exec, key, true)
      if ('response' in aimed) return aimed.response
      const blockedFront = await ensureFront(aimed.target, aimed.windows, exec.signal)
      if (blockedFront !== undefined) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was sent.', key, aimed.note)
        return withPicture(blockedFront, fresh)
      }
      const at = point === undefined ? undefined : pointToScreen(aimed.frame as Frame, point)
      const session = agentSessionId(exec.agent?.id ?? '')
      const outcome = await withScreenLock(exec.agent?.id, async (): Promise<{ how: string } | { failure: string }> => {
        if (at !== undefined) {
          const clicked = await runCli<unknown>([
            'mouse-click', '--headed', '--xy', `${String(at.x)},${String(at.y)}`,
            '--button', 'left', '--count', '1',
          ], exec.signal)
          if (!clicked.ok) return { failure: failureText(clicked) }
          // The field takes keyboard focus on its own run-loop turn.
          await new Promise(resolve => setTimeout(resolve, FOCUS_SETTLE_MS))
        }
        // The tree first: inserting into one element cannot land in the wrong
        // field and cannot touch the user's clipboard. This is the only path
        // Windows has, and it is the cheapest one everywhere.
        try {
          if (noElementSearch.has(aimed.target.windowId)) throw new Error('element search unavailable for this window')
          const ref = await typeByRef(text, {
            windowId: aimed.target.windowId,
            session,
            ...gesture.replace === true ? { replace: true } : {},
            ...gesture.submit === true ? { enter: true } : {},
          }, exec.signal)
          return { how: `inserted through the accessibility tree (${ref}).` }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('element search unavailable') === false) {
            noElementSearch.add(aimed.target.windowId)
          }
          if (!canPasteAtFocus()) {
            return {
              failure: `${message}\nThis window exposes no addressable text field, and pasting by pointing is `
                + 'not supported on this platform. Use desktop_inspect and desktop_act on a ref if the window has a tree.',
            }
          }
          // macOS (JXA NSPasteboard) and Windows (Win32 koffi clipboard + Ctrl+V)
          // both deliver text and restore every clipboard format afterwards.
          await typeAtFocus(text, {
            ...gesture.replace === true ? { replace: true } : {},
            ...gesture.submit === true ? { enter: true } : {},
            windowId: aimed.target.windowId,
          }, exec.signal)
          return { how: 'delivered by pasting, with the clipboard put back as it was.' }
        }
      })
      if ('failure' in outcome) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was typed.', key, aimed.note)
        return withPicture(outcome.failure, fresh)
      }
      await settle()
      return await observe(
        aimed.target,
        exec.signal,
        `typed ${String(text.length)} character(s)`
        + `${gesture.submit === true ? ' and pressed Return' : ''}`
        + `${gesture.replace === true ? ' (replacing the field)' : ''}`
        + ` — ${outcome.how}`,
        key,
        aimed.note,
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_scroll',
    description:
      'Scroll the window at a 0–1000 position on the picture from the previous result, then return the new picture. '
      + 'Scrolls the wheel over that point, so the list under it moves, not the whole window. '
      + 'Direction defaults to down; amount is 1 (smallest) to 10 (largest).',
    parameters: {
      point: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of the picture, not pixels.',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction. Default: down.',
      },
      amount: { type: 'integer', description: 'Scroll magnitude, 1 to 10. Default: 3.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const point = validPoint(args.point as readonly number[] | undefined)
      if (point === undefined) return { text: 'INVALID_ARGS: point must be [x, y] with both on a 0–1000 grid.' }
      const key = sessionKey(exec)
      const direction = typeof args.direction === 'string' ? args.direction : 'down'
      const gesture: Gesture = {
        ...pick(args, ['window']),
        point,
        direction,
        ...args.amount === undefined ? {} : { amount: Number(args.amount) },
      }
      const aimed = await aim(gesture, exec, key, true)
      if ('response' in aimed) return aimed.response
      const blockedFront = await ensureFront(aimed.target, aimed.windows, exec.signal)
      if (blockedFront !== undefined) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was sent.', key, aimed.note)
        return withPicture(blockedFront, fresh)
      }
      const at = pointToScreen(aimed.frame as Frame, point)
      const magnitude = Math.min(10, Math.max(1, Number(gesture.amount ?? 3)))
      const lines = magnitude * 3
      const dy = direction === 'up' ? lines : direction === 'down' ? -lines : 0
      const dx = direction === 'right' ? lines : direction === 'left' ? -lines : 0
      const scrolled = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
        'mouse-wheel', '--headed', '--x', String(at.x), '--y', String(at.y),
        ...dy !== 0 ? ['--dy', String(dy)] : [],
        ...dx !== 0 ? ['--dx', String(dx)] : [],
      ], exec.signal))
      if (!scrolled.ok) {
        const fresh = await observe(aimed.target, exec.signal, 'the scroll was not delivered.', key, aimed.note)
        return withPicture(failureText(scrolled), fresh)
      }
      await settle()
      return await observe(aimed.target, exec.signal, `scrolled ${direction} at ${fmtPoint(point)}.`, key, aimed.note)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_hotkey',
    description:
      'Press a key combination in the window, then return the new picture. '
      + 'Keys are names in order, for example ["cmd", "c"] or ["Return"]. '
      + 'The window is raised first, because keys go to the focused app.',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Key names in order, for example ["cmd", "shift", "4"].',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const listed = Array.isArray(args.keys) ? (args.keys as unknown[]).map(key => String(key)) : []
      if (listed.length === 0) return { text: 'INVALID_ARGS: keys must contain at least one key.' }
      const key = sessionKey(exec)
      const combo = cliCombo(listed)
      const gesture: Gesture = { ...pick(args, ['window']), keys: listed }
      const aimed = await aim(gesture, exec, key, false)
      if ('response' in aimed) return aimed.response
      const again = await repeated(aimed.target, 'hotkey', combo, aimed.note, exec, key)
      if (again !== undefined) return again
      const blockedFront = await ensureFront(aimed.target, aimed.windows, exec.signal)
      if (blockedFront !== undefined) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was sent.', key, aimed.note)
        return withPicture(blockedFront, fresh)
      }
      const sent = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>(
        ['press', '--headed', '--window-id', aimed.target.windowId, combo],
        exec.signal,
      ))
      if (!sent.ok) {
        const fresh = await observe(aimed.target, exec.signal, 'the key was not delivered.', key, aimed.note)
        return withPicture(failureText(sent), fresh)
      }
      remember(aimed.target, 'hotkey', combo)
      await settle()
      return await observe(aimed.target, exec.signal, `pressed ${combo}.`, key, aimed.note)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_drag',
    description:
      'Drag from one 0–1000 position to another on the picture from the previous result, then return the new picture. '
      + 'Both points are fractions of the same picture. The window is raised first.',
    parameters: {
      from: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of the picture, not pixels.',
      },
      to: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of the picture, not pixels.',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const from = validPoint(args.from as readonly number[] | undefined)
      const to = validPoint(args.to as readonly number[] | undefined)
      if (from === undefined || to === undefined) {
        return { text: 'INVALID_ARGS: from and to must both be [x, y] on a 0–1000 grid.' }
      }
      const key = sessionKey(exec)
      const gesture: Gesture = { ...pick(args, ['window']), point: from, to }
      const aimed = await aim(gesture, exec, key, true)
      if ('response' in aimed) return aimed.response
      const blockedFront = await ensureFront(aimed.target, aimed.windows, exec.signal)
      if (blockedFront !== undefined) {
        const fresh = await observe(aimed.target, exec.signal, 'nothing was sent.', key, aimed.note)
        return withPicture(blockedFront, fresh)
      }
      const start = pointToScreen(aimed.frame as Frame, from)
      const end = pointToScreen(aimed.frame as Frame, to)
      const dragged = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>([
        'drag', '--headed',
        '--from-xy', `${String(start.x)},${String(start.y)}`,
        '--to-xy', `${String(end.x)},${String(end.y)}`,
      ], exec.signal))
      if (!dragged.ok) {
        const fresh = await observe(aimed.target, exec.signal, 'the drag was not delivered.', key, aimed.note)
        return withPicture(failureText(dragged), fresh)
      }
      await settle()
      return await observe(aimed.target, exec.signal, `dragged ${fmtPoint(from)} → ${fmtPoint(to)}.`, key, aimed.note)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_wait',
    description:
      'Pause, then return a fresh picture of the window without moving the pointer. '
      + 'Use for a page reload, a loader, or a window that is still painting; do not use it as a substitute for '
      + 'reading the picture the last action already returned.',
    parameters: {
      seconds: {
        type: 'number',
        description: 'How long to pause, 1 to 120. Default: 1.',
      },
      window: { type: 'string', description: 'Window id. Omit to use the window this session last saw.' },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = await admit(exec)
      if (blocked !== undefined) return blocked
      const seconds = Math.min(120, Math.max(1, Number(args.seconds ?? 1)))
      const key = sessionKey(exec)
      const aimed = await aim({ ...pick(args, ['window']) }, exec, key, false)
      if ('response' in aimed) return aimed.response
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
      return await observe(aimed.target, exec.signal, `waited ${String(seconds)}s.`, key, aimed.note)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_open_app',
    description:
      'Bring an app to the front, or launch it. When the window exposes a usable accessibility tree (tree=yes), '
      + 'this returns the window metadata and its compact accessibility tree with actionable refs right away (no '
      + 'screenshot needed, saving a round trip). Only when the window has no usable tree (tree=no or tree_thin), '
      + 'or when `visual: true` is passed, does it capture and return a shadowless window picture. '
      + 'Use the name the user said, or a bundle identifier.',
    parameters: {
      name: { type: 'string', required: true, description: 'Application name or bundle identifier.' },
      visual: {
        type: 'boolean',
        description: 'Force returning a screenshot even when the window has an accessibility tree. Default: false.',
      },
    },
    output: PICTURE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const wantVisual = args.visual === true
      const locked = wantVisual ? await admit(exec) : await checkLock()
      if (locked !== undefined) return locked
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') return { text: 'INVALID_ARGS: name is required.' }
      const key = sessionKey(exec)
      try {
        await activate(name)
      } catch (error) {
        return { text: `OPEN_FAILED: ${error instanceof Error ? error.message : String(error)}` }
      }
      // Only an on-screen window counts as "opened". QQ keeps thirteen windows
      // and surfaces one; counting a hidden one would report success with a blank
      // picture and send the model hunting.
      const deadline = Date.now() + LAUNCH_WAIT_MS
      let pid = await resolvePid(name, exec.signal)
      let found: WindowInfo | undefined
      let listed = await inventory(exec.signal)
      let onlyHiddenSince: number | undefined
      let attemptedRestore = false
      const ownedBy = (windows: readonly WindowInfo[]): readonly WindowInfo[] =>
        pid === undefined
          ? windows.filter(window => sameApp(window.appName, name))
          : windows.filter(window => window.pid === pid)
      while (Date.now() < deadline) {
        if (pid === undefined) pid = await resolvePid(name, exec.signal)
        const own = listed.ok && listed.data !== undefined ? ownedBy(listed.data) : []
        const active = own.filter(window => !isMinimizedWindow(window))
        found = preferredWindow(active)
        if (found !== undefined) break
        // On Windows a minimized window is reported with visible=false or at
        // (-32000,-32000) and cannot be driven until restored. Try `restore` once.
        if (own.length > 0 && !attemptedRestore) {
          attemptedRestore = true
          const candidate = preferredWindow(own)
          if (candidate !== undefined) {
            await cli<unknown>(['restore', '--window-id', candidate.id], exec.signal).catch(() => {})
          }
        }
        if (own.length > 0 && active.length === 0) {
          onlyHiddenSince ??= Date.now()
          if (Date.now() - onlyHiddenSince > 1_500) break
        } else {
          onlyHiddenSince = undefined
        }
        await new Promise(resolve => setTimeout(resolve, 250))
        listed = await inventory(exec.signal)
      }
      const own = listed.ok && listed.data !== undefined ? ownedBy(listed.data) : []
      const hidden = own.filter(window => window.visible === false).length
      if (found === undefined) {
        const names = listed.ok && listed.data !== undefined
          ? [...new Set(listed.data.map(window => window.appName))].slice(0, 12).join(', ')
          : 'unavailable'
        if (own.length > 0) {
          return {
            text: `OPEN_FAILED: ${name} is running but has no window on screen: `
              + `${String(own.length)} window(s) of it exist and none is visible. It is minimized, or closed to `
              + 'its menu bar. Bring it up from the Dock or menu bar, or quit it and launch it again, then use '
              + 'desktop_inspect or desktop_see. Do not click a window that is not on screen: it cannot be focused, '
              + 'so nothing in it will work.',
          }
        }
        return { text: `OPEN_FAILED: ${name} is not running after ${String(LAUNCH_WAIT_MS / 1000)}s `
          + `and shows no window. Open windows belong to: ${names}` }
      }
      const prefix = hidden === 0
        ? `${name} is up.`
        : `${name} is up. ${String(hidden)} other window(s) of it are not on screen; they cannot be clicked, `
          + 'so do not go looking for them.'
      const target: Target = {
        windowId: found.id,
        appName: found.appName,
        title: found.title,
        bounds: found.bounds as Rect,
        focused: found.focused,
        accessible: found.accessible === true,
        visible: found.visible !== false,
        pid: found.pid,
      }

      // Tree-first: when the window exposes a usable AX tree, return it right
      // away (no screenshot, no extra desktop_inspect turn) and populate RefBook.
      const sessionId = exec.agent?.id
      if (!wantVisual && target.accessible && sessions !== undefined && typeof sessionId === 'string' && sessionId !== '') {
        try {
          const entry = await sessions.entry(sessionId)
          const read = await readWindow(
            target.windowId,
            { session: agentSessionId(sessionId), depth: DEFAULT_SNAPSHOT_DEPTH, interactive: true },
            exec.signal,
          )
          if (read.ok && read.data !== undefined) {
            const rendered = renderSnapshot(read.data, {
              maxNodes: config.maxNodes,
              maxChars: config.maxChars,
            })
            if (rendered.refs.length >= 3) {
              entry.refs.remember(read.data, rendered.refs, rendered.elements, {
                depth: DEFAULT_SNAPSHOT_DEPTH,
                interactive: true,
              })
              return {
                text: `${prefix}\n${windowLine(target)}\n${rendered.text}`,
                window_id: target.windowId,
              }
            }
          }
        } catch {
          // Fall back cleanly to a shadowless screenshot when the AX read fails.
        }
      }

      // No usable tree (or visual=true requested): verify image modality and capture.
      if (!wantVisual) await requireImageRoute(ctx, exec)
      const fallbackNote = !wantVisual && target.accessible
        ? 'note: accessibility tree was thin or unreadable, so a window picture was captured instead.'
        : ''
      return await observe(target, exec.signal, prefix, key, fallbackNote)
    },
  }))
}

/**
 * Format a point for the result text.
 * @param point - 0–1000 pair.
 * @returns the same two numbers the call used, so the next one can repeat them.
 */
function fmtPoint(point: readonly [number, number]): string {
  return `(${point[0].toFixed(0)},${point[1].toFixed(0)})`
}

/** Copy the named string fields out of a tool's args. */
function pick(args: Record<string, unknown>, names: readonly string[]): { window?: string, app?: string } {
  const out: { window?: string, app?: string } = {}
  for (const name of names) {
    const value = args[name]
    if (typeof value === 'string' && value !== '') {
      if (name === 'window') out.window = value
      if (name === 'app') out.app = value
    }
  }
  return out
}
