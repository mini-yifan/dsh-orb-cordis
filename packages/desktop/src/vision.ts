/**
 * Window inventory, window capture, and the CLI's accessibility-tree read.
 *
 * Everything here talks to the staged `agent-desktop` binary as a one-shot child
 * and normalizes its envelope, so the rest of the plugin never sees snake_case
 * or a raw base64 blob. Three things live here because they are all "ask the
 * CLI about one window":
 *
 * - {@link listWindows}, the only source of window ids, rectangles, and whether
 *   a window exposes an accessibility tree at all;
 * - {@link captureWindow}, which returns PNG bytes with no file written;
 * - {@link snapshotWindow}, the accessibility read by window id.
 *
 * The capture deliberately goes through the CLI rather than `screencapture`: it
 * is 0.31 s against 0.05 s, but it is the same code path on Windows, and the
 * only caller is a model turn that costs two seconds anyway.
 * @module @dsh-orb/desktop/src/vision
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { DesktopNode, ElementBounds, FindMatch, FindResult, SnapshotData, WindowInfo } from './protocol.ts'
import { cliName, nativeKey, packagedCliDir } from './native-paths.ts'

/** The CLI caps one debug PNG at 64 MiB; a sane observation is far smaller. */
const MAX_PNG_BYTES = 32 * 1024 * 1024

/** How long one CLI call may run. Screenshots of a cold Electron app are slow. */
const CLI_TIMEOUT_MS = 45_000

/** macOS system capture tool; `-o` omits the asymmetric window drop shadow. */
const SCREENCAPTURE = '/usr/sbin/screencapture'

/** Maximum tree depth accepted by snapshot reads (Electron trees often need 15–25). */
export const MAX_SNAPSHOT_DEPTH = 32

/** Default tree depth when callers do not override it. */
export const DEFAULT_SNAPSHOT_DEPTH = 12

/** One `agent-desktop` call result, with the library's envelope unwrapped. */
export interface Envelope<T> {
  readonly ok: boolean
  readonly data?: T
  readonly error?: { code?: string; message?: string; suggestion?: string; details?: unknown }
}

/** One screenshot as returned to callers. */
export interface ScreenshotData {
  readonly data: string
  readonly format: string
  readonly width: number
  readonly height: number
  readonly scale_factor: number
  /** True when the raster covers the exact window rectangle with no OS drop shadow. */
  readonly shadowless?: boolean
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
 * @returns the parsed envelope.
 */
export async function runCli<T>(
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
    // `--stdin` commands read the payload from the pipe, which keeps long or
    // quoted text out of argv.
    if (stdin !== undefined && child.stdin !== null) child.stdin.end(stdin)
  })
}

/** Format a CLI envelope failure for the model. */
export function failureText(envelope: Envelope<unknown>): string {
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
 * app name from arriving as `undefined` in anything the model reads, and it is
 * the only place that reports `accessible`, which decides whether the tree is
 * worth trying at all.
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
 * Extract the numeric CGWindowID from an `agent-desktop` window id like `w-37196`.
 * @param windowId - raw window id.
 * @returns the digits-only id, or undefined when the id is not numeric.
 */
export function numericWindowId(windowId: string): string | undefined {
  const match = /^(?:w-)?(\d+)$/.exec(windowId.trim())
  return match?.[1]
}

/**
 * Read pixel width and height from a PNG buffer's IHDR chunk without decoding pixels.
 * @param bytes - raw PNG bytes.
 * @returns dimensions, or undefined when the buffer is not a valid PNG header.
 */
export function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 24) return undefined
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A, followed by IHDR length & type (bytes 12..15 = "IHDR").
  if (
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47
    || bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52
  ) {
    return undefined
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  if (width === 0 || height === 0) return undefined
  return { width, height }
}

/**
 * Capture one macOS window without its asymmetric drop shadow via `screencapture -x -o -l`.
 *
 * macOS draws a much deeper drop shadow on the bottom of a window than on the top
 * (measured 76 px top vs 148 px bottom on System Settings), so symmetric shadow
 * padding shifts every visual click upward by ~18 logical points. `-o` omits the
 * shadow completely (~50 ms) and maps 1:1 onto the window's logical bounds.
 */
async function captureWindowShadowless(
  numericId: string,
  bounds: { readonly width: number; readonly height: number } | undefined,
  signal: AbortSignal,
): Promise<Envelope<ScreenshotData> | undefined> {
  const tmpFile = join(tmpdir(), `dsh-orb-desktop-${randomUUID()}.png`)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        SCREENCAPTURE,
        ['-x', '-o', '-l', numericId, tmpFile],
        { timeout: 15_000, signal },
        (error) => {
          if (error !== null) reject(error)
          else resolve()
        },
      )
    })
    const bytes = await readFile(tmpFile)
    const dims = pngDimensions(bytes)
    if (dims === undefined) return undefined
    const scale = bounds !== undefined && bounds.width > 0 ? dims.width / bounds.width : 0
    return {
      ok: true,
      data: {
        data: bytes.toString('base64'),
        format: 'png',
        width: dims.width,
        height: dims.height,
        scale_factor: scale,
        shadowless: true,
      },
    }
  } catch {
    return undefined
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

/**
 * Capture one window as PNG bytes.
 *
 * On macOS this prefers shadowless `screencapture -x -o -l` (0 pt click offset,
 * ~50 ms, never touches Desktop or clipboard) and falls back to `agent-desktop
 * screenshot --window-id` when unavailable or on non-macOS platforms.
 * @param windowId - window identity from `list-windows`.
 * @param signal - cooperative cancellation.
 * @param bounds - optional window logical size used to record scale_factor.
 * @returns the screenshot envelope.
 */
export async function captureWindow(
  windowId: string,
  signal: AbortSignal,
  bounds?: { readonly width: number; readonly height: number },
): Promise<Envelope<ScreenshotData>> {
  if (process.platform === 'darwin') {
    const id = numericWindowId(windowId)
    if (id !== undefined) {
      const shadowless = await captureWindowShadowless(id, bounds, signal)
      if (shadowless !== undefined) return shadowless
    }
  }
  return await runCli<ScreenshotData>(['screenshot', '--window-id', windowId], signal)
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

/** Media type for one CLI screenshot format. */
function mediaTypeOf(format: string): ImageMediaType {
  const flat = format.toLowerCase()
  if (flat === 'png') return 'image/png'
  if (flat === 'jpg' || flat === 'jpeg') return 'image/jpeg'
  if (flat === 'webp') return 'image/webp'
  return 'image/png'
}

/** Stored image metadata as it travels through a JSON tool output. */
export interface ImageValue {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/**
 * Save one capture into the attachment store and return its JSON metadata.
 *
 * The bytes go to the store, never to a file: a tool result carries an
 * attachment id, and the renderer turns that id back into an image block. That
 * is also what makes a replayed session log rebuild the same picture.
 * @param ctx - context carrying `attachments`.
 * @param windowId - window being shown, used as the attachment name.
 * @param bytes - decoded PNG.
 * @param format - the CLI's media format string.
 * @returns the metadata a tool output carries.
 */
export async function storePicture(
  ctx: Context,
  windowId: string,
  bytes: Uint8Array,
  format: string,
): Promise<ImageValue> {
  const saved = await ctx.attachments.saveImage({
    data: bytes,
    mediaType: mediaTypeOf(format),
    name: `desktop-window-${windowId}`,
  })
  return {
    attachmentId: saved.attachmentId,
    mediaType: saved.mediaType,
    bytes: saved.bytes,
    width: saved.width,
    height: saved.height,
  }
}

/**
 * Turn stored metadata back into the reference an image block carries.
 * @param value - JSON fields a tool returned.
 * @returns the branded attachment reference.
 */
export function typeImageValue(value: ImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType as ImageMediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  }
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
  readonly surfaces?: readonly (string | { readonly kind?: string })[]
  readonly tree?: RawTreeNode
}

/**
 * Normalize the overlay list a snapshot or action reports.
 * @param surfaces - raw field: strings, or objects carrying a `kind`.
 * @returns the kinds, or undefined when the CLI reported none.
 */
export function surfacesOf(
  surfaces: readonly (string | { readonly kind?: string })[] | undefined,
): readonly string[] | undefined {
  if (surfaces === undefined) return undefined
  const kinds = surfaces
    .map(entry => typeof entry === 'string' ? entry : entry.kind)
    .filter((kind): kind is string => typeof kind === 'string' && kind !== '')
  return kinds.length === 0 ? undefined : kinds
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
 * @param windowId - window id from a `desktop` result.
 * @param options - depth and interaction flags.
 * @param signal - cooperative cancellation.
 * @returns the normalized snapshot, or an error envelope.
 */
export interface SnapshotWindowOptions {
  depth?: number
  interactive?: boolean
  compact?: boolean
  /** Start traversal from an existing ref instead of the window root (`--root`). */
  root?: string
  /** Shallow overview with `children_count` on cut containers (`--skeleton`). */
  skeleton?: boolean
  /**
   * Overlay kind to read instead of the window: `menu`, `menubar`, `sheet`,
   * `popover` or `alert`. A popup a click opened lives here, not in the window tree.
   */
  surface?: string
  /** Application that owns the overlay (`--app`), required for a surface read. */
  app?: string
  /**
   * Snapshot namespace. Must be the same `dsh_<session>` the resident child
   * uses, or the refs this read produces are invisible to desktop_act: each
   * session keeps its own ref store, and a ref from another store fails with
   * SNAPSHOT_NOT_FOUND. Omit only when the caller cannot know it, accepting
   * that the refs then live in the session-less store.
   */
  session?: string
}

export async function snapshotWindow(
  windowId: string,
  options: SnapshotWindowOptions,
  signal: AbortSignal,
): Promise<Envelope<SnapshotData>> {
  const hasRoot = options.root !== undefined && options.root !== ''
  const hasSurface = !hasRoot && options.surface !== undefined && options.surface !== ''
  const args = hasRoot
    ? ['snapshot', '--root', options.root as string]
    : hasSurface
      ? ['snapshot', '--surface', options.surface as string]
      : ['snapshot', '--window-id', windowId]
  args.push('--timeout-ms', '15000')
  if (hasSurface && options.app !== undefined && options.app !== '') {
    args.push('--app', options.app)
  }
  if (options.session !== undefined && options.session !== '') {
    args.push('--session', options.session)
  }
  if (options.skeleton === true && !hasSurface) args.push('--skeleton')
  if (options.interactive !== false) args.push('-i')
  if (options.compact !== false) args.push('--compact')
  const depth = Math.min(MAX_SNAPSHOT_DEPTH, Math.max(1, options.depth ?? DEFAULT_SNAPSHOT_DEPTH))
  args.push('--max-depth', String(depth))
  const raw = await runCli<RawSnapshot>(args, signal)
  if (!raw.ok || raw.data === undefined) return raw as Envelope<SnapshotData>
  const data = raw.data
  const surfaces = surfacesOf(data.surfaces)
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
      ...surfaces === undefined ? {} : { surfaces },
      tree: normalizeRawNode(data.tree ?? { role: 'window' }, 64),
    },
  }
}

/** One raw entry returned by `agent-desktop find`. */
interface RawFindMatch {
  readonly ref_id?: string
  readonly role?: string
  readonly name?: string
  readonly value?: string
  readonly states?: readonly string[]
  readonly bounds?: { readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number }
}

interface RawFindData {
  readonly snapshot_id?: string
  readonly matches?: readonly RawFindMatch[]
  readonly match?: RawFindMatch
  readonly roles_present?: readonly string[]
}

export interface FindElementsOptions {
  readonly windowId?: string
  readonly app?: string
  readonly root?: string
  readonly surface?: string
  readonly query?: string
  readonly name?: string
  readonly role?: string
  readonly value?: string
  readonly exact?: boolean
  readonly limit?: number
  readonly session?: string
}

/**
 * Search one window, subtree, or overlay for matching accessibility elements.
 *
 * Mirrors the filter-in-place workflow that makes deep trees fast without
 * dumping tens of kilobytes of raw AX text into context.
 */
export async function findElements(
  options: FindElementsOptions,
  signal: AbortSignal,
): Promise<Envelope<FindResult>> {
  const args = ['find', '--timeout-ms', '10000']
  if (options.root !== undefined && options.root !== '') {
    args.push('--root', options.root)
  } else if (options.surface !== undefined && options.surface !== '') {
    args.push('--surface', options.surface)
    if (options.app !== undefined && options.app !== '') args.push('--app', options.app)
  } else if (options.windowId !== undefined && options.windowId !== '') {
    args.push('--window-id', options.windowId)
  } else if (options.app !== undefined && options.app !== '') {
    args.push('--app', options.app)
  }
  if (options.session !== undefined && options.session !== '') args.push('--session', options.session)
  if (options.query !== undefined && options.query !== '') args.push('--text', options.query)
  if (options.name !== undefined && options.name !== '') args.push('--name', options.name)
  if (options.role !== undefined && options.role !== '') args.push('--role', options.role)
  if (options.value !== undefined && options.value !== '') args.push('--value', options.value)
  if (options.exact === true) args.push('--exact')
  const limit = Math.min(100, Math.max(1, options.limit ?? 25))
  args.push('--limit', String(limit))

  const raw = await runCli<RawFindData>(args, signal)
  if (!raw.ok || raw.data === undefined) return raw as Envelope<FindResult>
  const list = raw.data.matches ?? (raw.data.match !== undefined ? [raw.data.match] : [])
  const matches: FindMatch[] = list.map((item) => {
    const b = item.bounds
    const hasBounds = b !== undefined
      && typeof b.x === 'number' && typeof b.y === 'number'
      && typeof b.width === 'number' && typeof b.height === 'number'
      && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0
    return {
      ...typeof item.ref_id === 'string' && item.ref_id !== '' ? { ref: item.ref_id } : {},
      role: typeof item.role === 'string' && item.role !== '' ? item.role : 'element',
      ...typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {},
      ...typeof item.value === 'string' && item.value !== '' ? { value: item.value } : {},
      ...Array.isArray(item.states) && item.states.length > 0 ? { states: item.states } : {},
      ...hasBounds ? { bounds: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } } : {},
    }
  })
  const rolesPresent = Array.isArray(raw.data.roles_present)
    ? raw.data.roles_present.filter((role): role is string => typeof role === 'string' && role !== '')
    : undefined
  return {
    ok: true,
    data: {
      snapshotId: String(raw.data.snapshot_id ?? ''),
      matches,
      ...rolesPresent !== undefined && rolesPresent.length > 0 ? { rolesPresent } : {},
    },
  }
}

/**
 * Read an element's live screen-space bounding rectangle via `agent-desktop get`.
 */
export async function getElementBounds(
  ref: string,
  session: string | undefined,
  signal: AbortSignal,
): Promise<Envelope<ElementBounds>> {
  const args = ['get', ref, '--property', 'bounds']
  if (session !== undefined && session !== '') args.push('--session', session)
  const raw = await runCli<Record<string, unknown>>(args, signal)
  if (!raw.ok || raw.data === undefined) {
    return {
      ok: false,
      ...raw.error !== undefined ? { error: raw.error } : {},
    }
  }
  const box = (raw.data.bounds ?? raw.data.value ?? raw.data) as {
    x?: unknown; y?: unknown; width?: unknown; height?: unknown
  } | null
  if (
    box === null || typeof box !== 'object'
    || typeof box.x !== 'number' || typeof box.y !== 'number'
    || typeof box.width !== 'number' || typeof box.height !== 'number'
    || !Number.isFinite(box.x) || !Number.isFinite(box.y)
    || box.width <= 0 || box.height <= 0
  ) {
    return {
      ok: false,
      error: { code: 'ELEMENT_NOT_FOUND', message: `element ${ref} reported no usable screen bounds` },
    }
  }
  return {
    ok: true,
    data: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ...typeof raw.data.live === 'boolean' ? { live: raw.data.live } : {},
    },
  }
}
