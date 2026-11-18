/**
 * Visual fallback for the background desktop agent: look at one window, then
 * click a point in it.
 *
 * The accessibility tree is the fast path and stays the default. This module is
 * the second path, used when a window exposes no usable tree — Electron shells,
 * canvas UIs, and the `accessible: false` windows `list-windows` reports. It
 * exists because the background agent could already see pixels only by shelling
 * out to `agent-desktop screenshot`, writing a PNG to /tmp, and calling the
 * host's `read_image`; that cost three round trips and never told the model
 * which window or coordinate space the pixels belonged to.
 *
 * Two rules keep the cheap path cheap:
 * - a screenshot is attached as image content, never written to the Desktop and
 *   never copied to the clipboard (unlike the foreground `screenshot` tool);
 * - a picture is spent by one coordinate gesture. After a click the model gets
 *   the new tree text, not a new picture, so a coordinate step costs two calls
 *   and a tree step still costs one.
 * @module @dsh-orb/desktop/src/vision
 */

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.ts'
import { cliName, nativeKey, packagedCliDir } from './native-paths.ts'
import type { DesktopNode, SnapshotData, WindowInfo } from './protocol.ts'
import { requireImageRoute } from './route.ts'
import { sessionState } from './session-state.ts'
import { withScreenLock } from './gui-lock.ts'
import { chooseWindow } from './frame.ts'

/** Coordinates are pixels of the screenshot the model was shown. */
export const COORDINATE_SPACE = 'screenshot pixels'

/** A picture older than this cannot be spent on a click. */
export const IMAGE_TTL_MS = 30_000

/** The CLI caps one debug PNG at 64 MiB; a sane observation is far smaller. */
const MAX_PNG_BYTES = 32 * 1024 * 1024

/** How long one CLI call may run. Screenshots of a cold Electron app are slow. */
const CLI_TIMEOUT_MS = 45_000

/** One window the model may point at. Bounds are logical points, as `--xy` takes them. */
export interface WindowSurface {
  readonly windowId: string
  readonly appName: string
  readonly title: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Physical pixels per logical point in this window's raster. */
  readonly scale: number
  /** Whether the accessibility tree could read this window at all. */
  readonly accessible: boolean
}

/** A picture the model has actually received, and the geometry that made it. */
interface Observation {
  readonly windowId: string
  readonly appName: string
  readonly width: number
  readonly height: number
  /** How picture pixels map to logical screen points. */
  readonly geometry: PictureGeometry
  /** The window rectangle at capture time, for the move/resize guard. */
  readonly originX: number
  readonly originY: number
  readonly boundsWidth: number
  readonly boundsHeight: number
  readonly capturedAt: number
  /** Cleared once a coordinate gesture spends it. */
  spent: boolean
}

/** One `agent-desktop` call result, with the library's envelope unwrapped. */
interface Envelope<T> {
  readonly ok: boolean
  readonly data?: T
  readonly error?: { code?: string; message?: string; suggestion?: string }
}

/** One screenshot as the CLI returns it. */
interface ScreenshotData {
  readonly data: string
  readonly format: string
  readonly width: number
  readonly height: number
  readonly scale_factor: number
}

/** Where the staged CLI lives, resolved once. */
function cliPath(): string | undefined {
  const key = nativeKey(process.platform, process.arch)
  if (key === undefined) return undefined
  const dir = packagedCliDir(key)
  if (dir === undefined) return undefined
  return `${dir}/${cliName(key)}`
}

/**
 * Run one `agent-desktop` command and parse its JSON envelope.
 * @param args - command and flags.
 * @param signal - cooperative cancellation.
 * @param stdin - optional text for `--stdin`.
 * @returns the parsed envelope.
 */
async function runCli<T>(
  args: readonly string[],
  signal: AbortSignal,
  stdin?: string,
): Promise<Envelope<T>> {
  const binary = cliPath()
  if (binary === undefined) {
    return { ok: false, error: { code: 'CLI_MISSING', message: 'agent-desktop is not available for this platform' } }
  }
  return await new Promise<Envelope<T>>((resolve) => {
    const child = execFile(
      binary,
      [...args],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_PNG_BYTES, signal },
      (error, stdout, stderr) => {
        if (error !== null && (stdout === undefined || stdout.trim() === '')) {
          resolve({
            ok: false,
            error: { code: 'CLI_FAILED', message: (stderr || error.message || 'agent-desktop failed').trim().slice(0, 800) },
          })
          return
        }
        try {
          resolve(JSON.parse(stdout) as Envelope<T>)
        } catch {
          resolve({
            ok: false,
            error: { code: 'CLI_OUTPUT', message: (stdout || stderr || '').trim().slice(0, 800) },
          })
        }
      },
    )
    if (stdin !== undefined && child.stdin !== null) {
      child.stdin.end(stdin)
    }
  })
}

/** Format a CLI envelope failure for the model. */
function failureText(envelope: Envelope<unknown>): string {
  const error = envelope.error
  if (error === undefined) return 'the desktop command failed without an error'
  const parts = [`${error.code ?? 'FAILED'}: ${error.message ?? 'unknown error'}`]
  if (error.suggestion !== undefined) parts.push(error.suggestion)
  return parts.join('\n')
}

/** One window exactly as the CLI prints it, before normalization. */
interface RawWindow {
  readonly id?: string
  readonly title?: string
  readonly app_name?: string
  readonly pid?: number
  readonly is_focused?: boolean
  readonly visible?: boolean
  readonly accessible?: boolean
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/**
 * List windows with their logical rectangles and whether the tree could be read.
 *
 * The CLI speaks snake_case (`app_name`, `is_focused`); the rest of this plugin
 * speaks the camelCase {@link WindowInfo}. Normalizing here is what keeps the
 * app name from arriving as `undefined` in anything the model reads.
 * Exposed because `desktop_status` needs the same rows: the FFI window record
 * carries no accessibility bit, so the only way to tell the model "this app has
 * no tree" is to ask the CLI.
 * @param signal - cooperative cancellation.
 * @returns every window the OS reports, or an error envelope.
 */
export async function listWindows(signal: AbortSignal): Promise<Envelope<readonly WindowInfo[]>> {
  const raw = await runCli<readonly RawWindow[]>(['list-windows'], signal)
  if (!raw.ok || raw.data === undefined) return raw as Envelope<readonly WindowInfo[]>
  const windows: WindowInfo[] = []
  for (const window of raw.data) {
    if (window.id === undefined) continue
    windows.push({
      id: window.id,
      title: window.title ?? '',
      appName: window.app_name ?? '',
      pid: window.pid ?? 0,
      focused: window.is_focused === true,
      ...window.bounds === undefined ? {} : { bounds: window.bounds },
      ...window.accessible === undefined ? {} : { accessible: window.accessible },
      ...window.visible === undefined ? {} : { visible: window.visible },
    })
  }
  return { ok: true, data: windows }
}

/**
 * Capture one window as PNG bytes. The CLI returns base64 with no path argument,
 * which keeps the bytes off the user's Desktop.
 * @param windowId - window identity from `list-windows`.
 * @param signal - cooperative cancellation.
 * @returns the screenshot envelope.
 */
async function captureWindow(windowId: string, signal: AbortSignal): Promise<Envelope<ScreenshotData>> {
  return await runCli<ScreenshotData>(['screenshot', '--window-id', windowId], signal)
}

/**
 * Whether a stored picture may still be spent.
 * @param observation - the picture the model holds.
 * @param now - current epoch milliseconds.
 * @returns a reason code when the picture cannot be used, or undefined when it can.
 */
export function pictureBlocker(
  observation: { readonly spent: boolean; readonly capturedAt: number },
  now: number,
): 'OBSERVATION_SPENT' | 'OBSERVATION_STALE' | undefined {
  if (observation.spent) return 'OBSERVATION_SPENT'
  if (now - observation.capturedAt > IMAGE_TTL_MS) return 'OBSERVATION_STALE'
  return undefined
}

/**
 * Where the picture sits in logical screen space, and how big one of its pixels
 * is.
 *
 * Two things make this more than a scale factor:
 * - a window capture includes the drop shadow macOS draws outside the window
 *   rectangle, so the picture starts above and left of the window;
 * - the attachment store may downscale the raster, so the picture handed to the
 *   model can be smaller than what the OS captured.
 *
 * Both are folded in once, at capture time, so a click is one multiply and one
 * add against numbers the model never has to reason about.
 */
export interface PictureGeometry {
  /** Logical screen x of the picture's left edge (window origin minus shadow). */
  readonly viewLeft: number
  /** Logical screen y of the picture's top edge. */
  readonly viewTop: number
  /** Logical points per horizontal picture pixel. */
  readonly pointsPerPixelX: number
  /** Logical points per vertical picture pixel. */
  readonly pointsPerPixelY: number
}

/**
 * Compute the geometry of one captured window picture.
 *
 * `scale` is physical pixels per logical point (the CLI's `scale_factor`), so
 * shadow padding divides by it to return to points. The attachment store may
 * have shrunk the raster, which is why the picture's own size — not the captured
 * size — divides the covered area.
 * @param raster - the picture the model receives, in pixels.
 * @param shadow - shadow padding on each axis, in captured pixels.
 * @param scale - physical pixels per logical point.
 * @param bounds - the window's logical rectangle.
 * @returns the geometry a click maps through.
 */
export function pictureGeometry(
  raster: { readonly width: number; readonly height: number },
  shadow: { readonly x: number; readonly y: number },
  scale: number,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): PictureGeometry {
  const factor = scale > 0 ? scale : 1
  const padPointsX = shadow.x / factor
  const padPointsY = shadow.y / factor
  // The picture covers the window plus its shadow on both sides.
  const coveredWidth = bounds.width + padPointsX * 2
  const coveredHeight = bounds.height + padPointsY * 2
  return {
    viewLeft: bounds.x - padPointsX,
    viewTop: bounds.y - padPointsY,
    pointsPerPixelX: raster.width > 0 ? coveredWidth / raster.width : 1,
    pointsPerPixelY: raster.height > 0 ? coveredHeight / raster.height : 1,
  }
}

/**
 * Map a picture pixel to the logical screen point `--xy` expects.
 * @param geometry - geometry recorded when the picture was taken.
 * @param x - horizontal picture pixel.
 * @param y - vertical picture pixel.
 * @returns the logical screen point, rounded to whole points.
 */
export function picturePointToScreen(
  geometry: PictureGeometry,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(geometry.viewLeft + x * geometry.pointsPerPixelX),
    y: Math.round(geometry.viewTop + y * geometry.pointsPerPixelY),
  }
}

/**
 * Padding baked into a window raster by the drop shadow, in physical pixels.
 *
 * Derived by subtracting the window's own painted area from the raster on each
 * axis and halving it. Negative rounding is clamped to zero so a raster equal to
 * the window never shifts coordinates.
 * @param rasterWidth - captured PNG width.
 * @param rasterHeight - captured PNG height.
 * @param bounds - the window's logical rectangle.
 * @param scale - physical pixels per logical point.
 * @returns padding on each axis.
 */
export function picturePadding(
  rasterWidth: number,
  rasterHeight: number,
  bounds: { readonly width: number; readonly height: number },
  scale: number,
): { readonly x: number; readonly y: number } {
  const factor = scale > 0 ? scale : 1
  return {
    x: Math.max(0, Math.round((rasterWidth - bounds.width * factor) / 2)),
    y: Math.max(0, Math.round((rasterHeight - bounds.height * factor) / 2)),
  }
}

/**
 * Whether a window still has the rectangle the picture was taken against.
 *
 * A moved or resized window invalidates every pixel in the picture, so the
 * comparison is exact. The window's size — not the raster — is compared,
 * because the raster also carries shadow padding that is stable per window.
 * @param observation - geometry recorded when the picture was taken.
 * @param bounds - the window's rectangle now.
 * @returns true when the picture's pixels still address the same controls.
 */
export function pictureViewportMatches(
  observation: { readonly originX: number; readonly originY: number; readonly boundsWidth: number; readonly boundsHeight: number },
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined,
): boolean {
  if (bounds === undefined) return false
  return bounds.x === observation.originX
    && bounds.y === observation.originY
    && bounds.width === observation.boundsWidth
    && bounds.height === observation.boundsHeight
}

/** Media type for one CLI screenshot format. */
function mediaTypeOf(format: string): ImageMediaType {
  const flat = format.toLowerCase()
  if (flat === 'png') return 'image/png'
  if (flat === 'jpg' || flat === 'jpeg') return 'image/jpeg'
  if (flat === 'webp') return 'image/webp'
  return 'image/png'
}

/** Stored image metadata as it travels through a JSON tool output. */
interface ImageValue {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/**
 * Turn stored metadata back into the reference an image block carries.
 * @param value - JSON fields this tool returned.
 * @returns the branded attachment reference.
 */
function rebrand(value: ImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType as ImageMediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  }
}

/**
 * Register the visual fallback: `desktop_see` and `desktop_click_xy`.
 *
 * Both tools stay registered for the whole preset whenever the model route
 * accepts images. Tool names and schemas never change with permission state,
 * because they enter every request and a change invalidates the prompt cache.
 * @param ctx - preset context carrying tools and attachments.
 * @param config - resolved tunables.
 */
export function registerVisionTools(ctx: Context, config: ResolvedConfig): void {
  /** The picture the model currently holds, per session. */
  const observations = new Map<string, Observation>()

  const sessionKey = (exec: { agent?: { id?: string } }): string => {
    const id = exec.agent?.id
    return typeof id === 'string' && id !== '' ? id : 'anonymous'
  }

  ctx.effect(() => () => {
    observations.clear()
  })

  ctx.tools.register(defineTool({
    name: 'desktop_see',
    description:
      'Look at one window as a picture, when its accessibility tree is unusable — an Electron or canvas app, or a window '
      + 'list_windows reported as not accessible. Returns the picture plus the window rectangle it covers, and arms exactly '
      + 'one coordinate click in screenshot pixels. Nothing is written to the Desktop or the clipboard. '
      + 'Use snapshot first: the tree is faster and survives UI changes. Come here only when the tree is empty, unreadable, '
      + 'or does not contain the control you need. A picture is only valid for 30 seconds and for one click; look again '
      + 'before the next coordinate action.',
    parameters: {
      app: {
        type: 'string',
        description: 'Application name from desktop_apps. Omit with window_id to use the window in front.',
      },
      window_id: {
        type: 'string',
        description: 'Window id from desktop_status (for example w-4521), to look at a window that is behind another one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          window_id: { type: 'string' },
          // Image metadata rides in the output as plain JSON so a replayed log
          // rebuilds the same attachment block; the renderer brands the id.
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
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: rebrand(value.image) })
        return blocks
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await requireImageRoute(ctx, exec)
      const screen = await sessionState()
      if (screen.locked) {
        return {
          text: 'SCREEN_LOCKED: this Mac is locked, so no picture can be taken and no click can land. '
            + 'Unlocking needs the password and is not something this worker can do. Stop trying desktop tools: '
            + 'finish what you can without the screen, then report what is blocked and what the user must do.',
        }
      }
      const signal = exec.signal
      const windows = await listWindows(signal)
      if (!windows.ok || windows.data === undefined) {
        // A locked screen and a hung app both land here. Name the likely cause so
        // the model stops instead of burning turns on retries that cannot work.
        const code = windows.error?.code ?? 'UNKNOWN'
        const hint = code === 'TIMEOUT'
          ? '\nThe screen may be locked, or an app is not answering; window inventory cannot complete. '
            + 'No picture can be taken in that state. Do not retry: report what is blocked.'
          : ''
        return { text: `desktop_see failed\n${failureText(windows)}${hint}` }
      }
      const wanted = args.window_id
      const target = wanted !== undefined && wanted !== ''
        ? windows.data.find(candidate => candidate.id === wanted)
        : chooseWindow(windows.data, {})
      if (target === undefined) {
        return { text: `desktop_see failed\nWINDOW_NOT_FOUND: no window matches ${wanted ?? args.app ?? 'the front window'}. Call desktop_status for the window list.` }
      }
      if (args.app !== undefined && args.app !== '' && target.appName !== args.app) {
        return { text: `desktop_see failed\nWINDOW_NOT_FOUND: ${target.id} belongs to ${target.appName}, not ${args.app}.` }
      }
      const bounds = target.bounds
      if (bounds === undefined) {
        return { text: `desktop_see failed\nWINDOW_NOT_FOUND: ${target.appName} reports no window rectangle.` }
      }
      const captured = await captureWindow(target.id, signal)
      if (!captured.ok || captured.data === undefined) {
        // A window that reports a rectangle but cannot be rastered is usually
        // minimized, closing, or on a display the capture cannot reach. Retrying
        // the same id cannot help, so say what can: another window, the tree, or
        // a hand-back.
        return {
          text: `desktop_see failed for ${target.appName} (${target.id})\n${failureText(captured)}\n`
            + 'This window reports a rectangle but could not be captured — it may be minimized, closing, or on a '
            + 'display this machine cannot raster. Do not retry the same window. Either snapshot the accessibility '
            + 'tree instead, look at a different window, or stop and report what is blocked.',
        }
      }
      const shot = captured.data
      const bytes = Buffer.from(shot.data, 'base64')
      const saved = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: mediaTypeOf(shot.format),
        name: `desktop-window-${target.id}`,
      })
      const picture: ImageValue = {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
      }
      const key = sessionKey(exec)
      // The raster includes the window's drop shadow, so record real geometry now
      // rather than assuming `bounds x scale` is the picture.
      const padding = picturePadding(shot.width, shot.height, bounds, shot.scale_factor)
      const geometry = pictureGeometry(
        { width: saved.width, height: saved.height },
        padding,
        shot.scale_factor,
        bounds,
      )
      observations.set(key, {
        windowId: target.id,
        appName: target.appName,
        // The saved raster may be smaller than the capture; click space is the
        // picture the model actually sees.
        width: saved.width,
        height: saved.height,
        geometry,
        originX: bounds.x,
        originY: bounds.y,
        boundsWidth: bounds.width,
        boundsHeight: bounds.height,
        capturedAt: Date.now(),
        spent: false,
      })
      const lines = [
        `<window>${target.appName}</window>`,
        `<window_id>${target.id}</window_id>`,
        `<window_title>${target.title.replace(/[\r\n]+/g, ' ').slice(0, 120)}</window_title>`,
        `<coordinate_space>${COORDINATE_SPACE}</coordinate_space>`,
        `<attached_size>${String(saved.width)}x${String(saved.height)}</attached_size>`,
        `<window_rectangle>${String(bounds.x)},${String(bounds.y)},${String(bounds.width)},${String(bounds.height)}</window_rectangle>`,
        `<shadow_padding>${String(padding.x)},${String(padding.y)}</shadow_padding>`,
        `<tree_accessible>${target.accessible === true ? 'true' : 'false'}</tree_accessible>`,
        'Coordinates are pixels of this picture, origin at its top-left. The picture includes the window shadow, so '
        + 'the window itself starts at (shadow_padding) inside it — aim at controls, not at the edge. '
        + 'One picture arms one click; call desktop_see again before the next coordinate action.',
      ]
      return {
        text: lines.join('\n'),
        window_id: target.id,
        image: picture,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_click_xy',
    description:
      'Click a point in the picture the last desktop_see returned. Coordinates are pixels of that picture. '
      + 'Use this only when the accessibility tree has no usable control: a semantic click on a ref is faster, verifiable, '
      + 'and never touches the pointer. This sends real physical input at the window point, so the target must be the '
      + 'window you just looked at and the picture must be under 30 seconds old. One picture allows one click: look again '
      + 'before clicking again. Submits (Enter, Send) are not special here — after acting, confirm by reading the window, '
      + 'never by clicking twice.',
    parameters: {
      x: { type: 'integer', required: true, description: 'Horizontal pixel in the last desktop_see picture.' },
      y: { type: 'integer', required: true, description: 'Vertical pixel in the last desktop_see picture.' },
      count: { type: 'integer', description: 'Click count, 1 or 2. Default: 1.' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button. Default: left.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await requireImageRoute(ctx, exec)
      if (!config.coordinateClick) {
        return {
          text: 'COORDINATE_INPUT_OFF: this worker is configured not to move the pointer. '
            + 'Use desktop_snapshot and desktop_act on the accessibility tree, or hand back what is blocked.',
        }
      }
      const key = sessionKey(exec)
      const observation = observations.get(key)
      if (observation === undefined) {
        return { text: 'NO_OBSERVATION: call desktop_see first; a click needs a picture this session actually received.' }
      }
      const blocker = pictureBlocker(observation, Date.now())
      if (blocker === 'OBSERVATION_SPENT') {
        return { text: 'OBSERVATION_SPENT: that picture already bought one click. Call desktop_see again to look at the window.' }
      }
      if (blocker === 'OBSERVATION_STALE') {
        const age = Math.round((Date.now() - observation.capturedAt) / 1000)
        return { text: `OBSERVATION_STALE: the picture is ${String(age)}s old (limit 30s). Call desktop_see again.` }
      }
      if (args.x < 0 || args.y < 0 || args.x >= observation.width || args.y >= observation.height) {
        return {
          text: `OUT_OF_BOUNDS: (${String(args.x)},${String(args.y)}) is outside the ${String(observation.width)}x${String(observation.height)} picture.`,
        }
      }
      // The window may have moved or closed since the picture. A changed
      // rectangle means the picture's points no longer mean the same thing.
      const windows = await listWindows(exec.signal)
      if (!windows.ok || windows.data === undefined) {
        return { text: `desktop_click_xy failed\n${failureText(windows)}` }
      }
      const current = windows.data.find(candidate => candidate.id === observation.windowId)
      if (current === undefined) {
        observations.delete(key)
        return { text: `WINDOW_GONE: ${observation.appName} (${observation.windowId}) is no longer open. Call desktop_status.` }
      }
      if (!pictureViewportMatches(observation, current.bounds)) {
        observations.delete(key)
        return {
          text: 'VIEWPORT_CHANGED: the window moved or resized after that picture, so its pixels no longer map to the same '
            + 'controls. Call desktop_see again.',
        }
      }
      // Picture pixels -> logical screen points, which is what `--xy` takes.
      const point = picturePointToScreen(observation.geometry, args.x, args.y)
      const pointX = point.x
      const pointY = point.y
      // Join the shared GUI lock: the foreground Computer Use session moves the
      // same pointer, and a click taken outside it can land on its work.
      let clicked: Envelope<unknown>
      try {
        clicked = await withScreenLock(exec.agent?.id, async () => await runCli<unknown>(
          [
            'mouse-click',
            '--headed',
            '--xy', `${String(pointX)},${String(pointY)}`,
            '--button', args.button ?? 'left',
            '--count', String(args.count ?? 1),
          ],
          exec.signal,
        ))
      } catch (error) {
        // The picture is spent either way: a busy screen must not become a retry loop.
        observation.spent = true
        const busy = error instanceof Error && error.message.includes('operating the screen')
        return {
          text: busy
            ? 'SCREEN_BUSY: another session is using the pointer, so this click was not sent.\n'
              + 'The picture is spent. Report the conflict; do not retry.'
            : `desktop_click_xy failed before sending\n${error instanceof Error ? error.message : String(error)}`,
        }
      }
      // One picture, one gesture: spend it whether or not delivery was proven,
      // so a failed click cannot become a repeated click.
      observation.spent = true
      if (!clicked.ok) {
        return {
          text: `desktop_click_xy failed\n${failureText(clicked)}\nThe picture is spent either way. Read the window before trying again.`,
        }
      }
      return {
        text: `Clicked (${String(args.x)},${String(args.y)}) in the ${observation.appName} picture — window point (${String(pointX)},${String(pointY)}).\n`
          + 'Physical input cannot prove what the app did with it. Read the window (desktop_snapshot, or desktop_see for a '
          + 'new picture) and decide from that. Do not click the same place again to "make sure".',
      }
    },
  }))
}

/** One raw snapshot tree node as the CLI prints it. */
interface RawTreeNode {
  readonly role?: string
  readonly name?: string
  readonly value?: string
  readonly ref_id?: string
  readonly available_actions?: readonly string[]
  readonly states?: readonly string[]
  readonly children?: readonly RawTreeNode[]
  readonly children_count?: number
  readonly subtree_truncated?: boolean
}

/** One `snapshot` result as the CLI prints it. */
interface RawSnapshot {
  readonly app?: string
  readonly window?: { readonly id?: string, readonly title?: string }
  readonly snapshot_id?: string
  readonly ref_count?: number
  readonly complete?: boolean
  readonly nodes_observed?: number
  readonly tree?: RawTreeNode
}

/**
 * Convert one CLI tree node into the shape the renderer expects.
 *
 * Exported for tests: this is the mapping that decides whether a ref from a
 * window-id read is addressable, and getting `ref_id` wrong silently produces a
 * tree with no usable controls.
 * @param node - a node from `snapshot --window-id`.
 * @param depth - remaining levels to keep.
 * @returns the protocol-shaped node.
 */
export function normalizeRawNode(node: RawTreeNode, depth: number): DesktopNode {
  const children = depth > 0 && Array.isArray(node.children)
    ? node.children.map(child => normalizeRawNode(child, depth - 1))
    : undefined
  return {
    role: typeof node.role === 'string' && node.role !== '' ? node.role : 'element',
    ...typeof node.name === 'string' && node.name !== '' ? { name: node.name } : {},
    ...typeof node.value === 'string' && node.value !== '' ? { value: node.value } : {},
    ...typeof node.ref_id === 'string' && node.ref_id !== '' ? { ref: node.ref_id } : {},
    ...Array.isArray(node.available_actions) && node.available_actions.length > 0
      ? { actions: node.available_actions }
      : {},
    ...Array.isArray(node.states) && node.states.length > 0 ? { states: node.states } : {},
    ...children !== undefined && children.length > 0 ? { children } : {},
    ...typeof node.children_count === 'number' ? { childrenCount: node.children_count } : {},
    ...node.subtree_truncated === true ? { subtreeTruncated: true } : {},
  }
}

/**
 * Read one window's accessibility tree by window id.
 *
 * `snapshot --app <name>` refuses with AMBIGUOUS_TARGET when an app owns more
 * than one window — QQ always does — and the FFI snapshot call takes only an app
 * name, so a window id had no path at all. That refusal was the single biggest
 * cost in the first unlocked measurement run: 41 snapshots and nine
 * AMBIGUOUS_TARGET failures, 95 steps without finishing. The CLI accepts
 * `--window-id`, so route the read through it when the model knows the window.
 * @param windowId - window id from desktop_status.
 * @param options - depth and interaction flags.
 * @param signal - cooperative cancellation.
 * @returns the normalized snapshot, or an error envelope.
 */
export async function snapshotWindow(
  windowId: string,
  options: {
    depth?: number
    interactive?: boolean
    compact?: boolean
    /**
     * Snapshot namespace. Must be the same `dsh_<session>` the resident child
     * uses, or the refs this read produces are invisible to desktop_act: each
     * session keeps its own ref store, and a ref from another store fails with
     * SNAPSHOT_NOT_FOUND. Omit only when the caller cannot know it, accepting
     * that the refs then live in the session-less store.
     */
    session?: string
  },
  signal: AbortSignal,
): Promise<Envelope<SnapshotData>> {
  const args = ['snapshot', '--window-id', windowId, '--timeout-ms', '15000']
  if (options.session !== undefined && options.session !== '') {
    args.push('--session', options.session)
  }
  if (options.interactive !== false) args.push('-i')
  if (options.compact !== false) args.push('--compact')
  args.push('--max-depth', String(Math.min(8, Math.max(1, options.depth ?? 3))))
  const raw = await runCli<RawSnapshot>(args, signal)
  if (!raw.ok || raw.data === undefined) return raw as Envelope<SnapshotData>
  const data = raw.data
  return {
    ok: true,
    data: {
      app: String(data.app ?? ''),
      ...data.window?.id === undefined ? {} : { windowId: data.window.id },
      ...data.window?.title === undefined ? {} : { windowTitle: data.window.title },
      snapshotId: String(data.snapshot_id ?? ''),
      refCount: Number(data.ref_count ?? 0),
      complete: data.complete !== false,
      ...typeof data.nodes_observed === 'number' ? { nodesObserved: data.nodes_observed } : {},
      tree: normalizeRawNode(data.tree ?? { role: 'window' }, 64),
    },
  }
}
