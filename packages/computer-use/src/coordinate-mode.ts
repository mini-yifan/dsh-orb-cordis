/**
 * Per-session Computer Use click encoding: millifraction 0–1000 or attached-raster pixels.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/coordinate-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextFormed, ToolSchema } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': { kind: 'computer-use' } & ContextFormed
  }
}

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'

/** Click encoding recorded on a Computer Use session. */
export type CoordinateMode = 'millifraction' | 'pixel'

/** Attached observation raster used as the pixel click space. */
export interface ObservationRaster {
  readonly width: number
  readonly height: number
  /** Owner window the observation captured; a hotkey hands keyboard focus back to it. */
  readonly windowId?: number
  /** Extra window ids the observation included (menus and other family windows). */
  readonly transientWindowIds?: readonly number[]
  /** App owning {@link windowId}, for the hotkey focus error message. */
  readonly appName?: string
}

/** Window an observation belongs to, as a hotkey takes it. */
export interface ObservedWindow {
  readonly windowId: number
  readonly transientWindowIds?: readonly number[]
  readonly appName?: string
}

/** Canonical tool-result fields that fork render copy and the next envelope. */
export interface CoordinateOutcome {
  readonly coordinateMode: CoordinateMode
  readonly attachedWidth?: number
  readonly attachedHeight?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Click encoding for this Computer Use session: millifraction 0–1000 or
     * attached-raster pixels. Whole-value replace; the last event wins. A log
     * with none folds to millifraction. Written `ignorable: true` whenever the
     * host catalog does not know the type (official harnesses refuse a log
     * carrying an unknown required event outright); the coordinate contract is
     * also echoed in every GUI tool result's text, so a reader that skips this
     * event can still recover the space from the log.
     */
    'computer-use/coordinate-mode': { mode: CoordinateMode }
    /** V3→V4 migration alias of the same record (unknown ignorable events are namespaced `plugin:`). */
    'plugin:computer-use/coordinate-mode': { mode: CoordinateMode }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded Computer Use click encoding. */
    computerUseCoordinateMode: { mode: CoordinateMode }
  }
}

const COORDINATE_MODE_STATE_SCHEMA: ZodType<{ mode: CoordinateMode }> = zod.object({
  mode: zod.enum(['millifraction', 'pixel']),
}).strict()

/** Canonical record type plus the `plugin:`-prefixed alias a V3→V4 migration writes for it. */
type CoordinateModeEventType = 'computer-use/coordinate-mode' | 'plugin:computer-use/coordinate-mode'

/**
 * Does this event carry the coordinate-mode record — canonical name or the
 * migration alias — so every reader accepts both?
 * @param event - candidate session event.
 * @returns whether the event is a coordinate-mode record.
 */
function isCoordinateModeEvent(event: SessionEvent | undefined): event is SessionEvent<CoordinateModeEventType> {
  return event?.type === 'computer-use/coordinate-mode' || event?.type === 'plugin:computer-use/coordinate-mode'
}

/** Projection unit folding the coordinate-mode record to the last logged encoding. */
export const coordinateModeProjection = {
  key: 'computerUseCoordinateMode',
  stateVersion: 1,
  stateSchema: COORDINATE_MODE_STATE_SCHEMA,
  init: () => ({ mode: 'millifraction' as const }),
  apply: (state, event: SessionEvent) => {
    if (!isCoordinateModeEvent(event)) return state
    if (event.data.mode === state.mode) return state
    return { mode: event.data.mode }
  },
} satisfies ProjectionDefinition<'computerUseCoordinateMode', { mode: CoordinateMode }>

interface OrbCoordinateMode {
  currentMode(): CoordinateMode
}

const observationCache = new WeakMap<object, ObservationRaster | false>()

/**
 * Create-time encoding for a session whose log cannot carry the record (the
 * official reader refuses unknown non-ignorable events, and no harness here
 * lets a plugin write the marker yet). Process-local: a resumed session falls
 * back to millifraction, the documented drift the stamp exists to avoid.
 */
const sessionModeCache = new WeakMap<object, CoordinateMode>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Last image raster in a content tree (observation envelopes, nested tool-result blocks).
 * @param value - message content or a nested block.
 * @returns the last image width/height, when any.
 */
function lastRasterIn(value: unknown): ObservationRaster | undefined {
  if (Array.isArray(value)) {
    let found: ObservationRaster | undefined
    for (const entry of value) {
      const raster = lastRasterIn(entry)
      if (raster !== undefined) found = raster
    }
    return found
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'image' && isRecord(value.attachment)) {
    const width = value.attachment.width
    const height = value.attachment.height
    if (typeof width === 'number' && typeof height === 'number'
      && Number.isFinite(width) && Number.isFinite(height)
      && width > 0 && height > 0) {
      return { width, height }
    }
  }
  let found: ObservationRaster | undefined
  for (const nested of Object.values(value)) {
    const raster = lastRasterIn(nested)
    if (raster !== undefined) found = raster
  }
  return found
}

/**
 * Reconstruct the last Computer Use observation raster from the session log.
 * @param session - session whose events may include first-frame notices or GUI results.
 * @returns attached width/height, or undefined when no CU image remains.
 */
function reconstructFromLog(session: Session): ObservationRaster | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'computer-use' || source.form !== 'notice') continue
      const raster = lastRasterIn(event.data.content)
      if (raster !== undefined) return raster
    }
    if (event.type === 'tool/result') {
      const raster = lastRasterIn(event.data.message.content)
      if (raster !== undefined) return raster
    }
  }
  return undefined
}

/**
 * Logged encoding when a coordinate-mode record exists — canonical type or the
 * `plugin:` alias a V3→V4 migration writes for it.
 * @param session - session to scan, or a test stub.
 * @returns the last logged mode, or undefined when the log has none.
 */
export function loggedCoordinateMode(session: Session | undefined): CoordinateMode | undefined {
  const events = session?.snapshotEvents?.()
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (isCoordinateModeEvent(event)) return event.data.mode
  }
  return undefined
}

/**
 * Click encoding in force for a request. Missing record, missing session, and
 * Headless/Web logs without a stamp all read as millifraction.
 * @param session - the session being assembled or executed.
 * @returns millifraction or pixel.
 */
export function coordinateModeOf(session: Session | undefined): CoordinateMode {
  return loggedCoordinateMode(session)
    ?? (session === undefined ? undefined : sessionModeCache.get(session))
    ?? 'millifraction'
}

/**
 * Remember the attached raster and window from an observation, so the next pixel click can
 * divide by the raster and the next hotkey can hand focus back to the window.
 * @param session - session that received the observation; omitted on stubs without identity.
 * @param screens - captured screens; empty clears the entry (fail closed).
 */
export function rememberObservation(
  session: Session | undefined,
  screens: readonly {
    readonly image: { readonly width: number; readonly height: number }
    readonly windowId?: number
    readonly transientWindowIds?: readonly number[]
    readonly appName?: string
  }[],
): void {
  if (session === undefined) return
  const first = screens[0]
  if (first === undefined) {
    observationCache.set(session, false)
    return
  }
  const image = first.image
  observationCache.set(session, {
    width: image.width,
    height: image.height,
    ...first.windowId === undefined ? {} : { windowId: first.windowId },
    ...first.transientWindowIds === undefined ? {} : { transientWindowIds: first.transientWindowIds },
    ...first.appName === undefined ? {} : { appName: first.appName },
  })
}

/**
 * Window of the session's own last observation, for a hotkey to restore focus to.
 * Reads the live cache only: the log carries no window id, and an empty entry stays empty.
 * @param session - session whose last observation window is needed.
 * @returns the window, or undefined when nothing was observed in this process.
 */
export function lastObservedWindow(session: Session | undefined): ObservedWindow | undefined {
  if (session === undefined) return undefined
  const cached = observationCache.get(session)
  if (cached === false || cached === undefined || cached.windowId === undefined) return undefined
  return {
    windowId: cached.windowId,
    ...cached.transientWindowIds === undefined ? {} : { transientWindowIds: cached.transientWindowIds },
    ...cached.appName === undefined ? {} : { appName: cached.appName },
  }
}

/**
 * Attached raster the model is looking at: live cache, else last CU image in the log.
 * @param session - session whose last observation is needed.
 * @returns width/height, or undefined when pixel mapping must fail.
 */
export function lastAttachedRaster(session: Session | undefined): ObservationRaster | undefined {
  if (session === undefined) return undefined
  const cached = observationCache.get(session)
  if (cached === false) return undefined
  if (cached !== undefined) return cached
  if (typeof session.snapshotEvents !== 'function') return undefined
  const reconstructed = reconstructFromLog(session)
  observationCache.set(session, reconstructed === undefined ? false : reconstructed)
  return reconstructed
}

/**
 * Canonical coordinate fields stored on a GUI tool result.
 * @param session - calling session.
 * @param screens - recapture screens; pixel mode names the first attached raster.
 * @returns coordinateMode plus optional attachedWidth/Height.
 */
export function coordinateOutcome(
  session: Session | undefined,
  screens: readonly { readonly image: { readonly width: number; readonly height: number } }[],
): CoordinateOutcome {
  const mode = coordinateModeOf(session)
  const first = screens[0]?.image
  if (mode === 'pixel' && first !== undefined) {
    return { coordinateMode: mode, attachedWidth: first.width, attachedHeight: first.height }
  }
  return { coordinateMode: mode }
}

/**
 * Model-facing sentence that the next click still uses this session's encoding.
 * @param outcome - canonical result fields.
 * @returns millifraction or pixel remain-copy.
 */
export function coordinatesRemain(outcome: CoordinateOutcome): string {
  if (outcome.coordinateMode === 'pixel') {
    if (outcome.attachedWidth !== undefined && outcome.attachedHeight !== undefined) {
      return `Coordinates remain pixels of the attached ${String(outcome.attachedWidth)}x${String(outcome.attachedHeight)} screenshot.`
    }
    return 'Coordinates remain pixels of the attached screenshot.'
  }
  return 'Coordinates remain 0–1000.'
}

/**
 * First-frame plugin notice that names this session's click space.
 * @param mode - session contract.
 * @returns millifraction or pixel notice text.
 */
export function firstFrameNotice(mode: CoordinateMode): string {
  if (mode === 'pixel') {
    return 'Current frontmost window. Coordinates are pixel columns and rows of this screenshot ([0, 0] top-left). Use attached_size on the observation envelope. Do not send 0–1000 fractions.'
  }
  return 'Current frontmost window. Coordinates are 0–1000 fractions of this screenshot ([0, 0] top-left, [1000, 1000] bottom-right). Center x is 500, not a pixel x.'
}

const PIXEL_POSITION = '[x, y] as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'
const PIXEL_FOCUS_POSITION = `${PIXEL_POSITION} The click focuses the field.`
const PIXEL_START_POSITION = '[x, y] start as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'
const PIXEL_END_POSITION = '[x, y] end as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'

const PIXEL_TOOLS: Readonly<Record<string, { description: string; parameters: Record<string, string> }>> = {
  click: {
    description:
      'Click at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. '
      + 'Use left (default) or right button; count 2 is a double-click. '
      + 'Optional modifiers (shift, cmd, option, control) are held only for this click.',
    parameters: { position: PIXEL_POSITION },
  },
  input_text: {
    description:
      'Click to focus a pixel position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.',
    parameters: { position: PIXEL_FOCUS_POSITION },
  },
  scroll: {
    description:
      'Scroll up or down at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1–10.',
    parameters: { position: PIXEL_POSITION },
  },
  long_press: {
    description:
      'Press and hold the left button at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. '
      + 'duration_seconds defaults to 3 and must be 1–10.',
    parameters: { position: PIXEL_POSITION },
  },
  drag: {
    description:
      'Drag from a start pixel position to an end pixel position on the attached frontmost-window screenshot, then return the post-action screenshot.',
    parameters: {
      start_position: PIXEL_START_POSITION,
      end_position: PIXEL_END_POSITION,
    },
  },
}

function rewritePixelTool(tool: ToolSchema): ToolSchema {
  const copy = PIXEL_TOOLS[tool.name]
  if (copy === undefined) return tool
  const parameters = structuredClone(tool.parameters) as Record<string, unknown>
  const properties = parameters.properties
  if (isRecord(properties)) {
    for (const [name, description] of Object.entries(copy.parameters)) {
      const field = properties[name]
      if (isRecord(field)) field.description = description
    }
  }
  return { ...tool, description: copy.description, parameters }
}

/**
 * Rewrite assembled `position` tool schemas for a pixel-mode session.
 * Millifraction assemblies keep the registered 0–1000 copy.
 * @param tools - assembled tool schemas.
 * @param mode - session contract.
 * @returns tools with pixel `position` copy when `mode` is pixel.
 */
export function toolsForCoordinateMode(tools: readonly ToolSchema[], mode: CoordinateMode): ToolSchema[] {
  if (mode === 'millifraction') return [...tools]
  return tools.map(rewritePixelTool)
}

function hasCoordinateModeEvent(session: Session): boolean {
  return session.snapshotEvents().some(event => isCoordinateModeEvent(event))
}

function hasEndSeed(session: Session): boolean {
  return session.snapshotEvents().some(event => event.type === 'session/end-seed')
}

/** How this harness can carry the create-time record. */
type StampCapability = 'catalog' | 'ignorable' | 'none'

/**
 * Append the record. `ignorable` rides the append options on harnesses that
 * accept the envelope marker; the cast keeps the call compilable against
 * 0.1.7-rc.2, whose `append` types only expose surface options.
 * @param session - session receiving the record.
 * @param mode - encoding to persist.
 * @param ignorable - write the envelope's `ignorable: true` marker.
 * @returns the appended event envelope.
 */
function appendCoordinateMode(
  session: Session,
  mode: CoordinateMode,
  ignorable: boolean,
): SessionEvent<'computer-use/coordinate-mode'> {
  if (!ignorable) return session.append('computer-use/coordinate-mode', { mode })
  const append = session.append as unknown as (
    this: Session,
    type: 'computer-use/coordinate-mode',
    data: { mode: CoordinateMode },
    opts: { ignorable?: true },
  ) => SessionEvent<'computer-use/coordinate-mode'>
  return append.call(session, 'computer-use/coordinate-mode', { mode }, { ignorable: true })
}

/**
 * Which write strategy this harness supports:
 * `catalog` — the host registers the type (fork harness), plain append;
 * `ignorable` — `append` accepts the envelope marker, so official readers skip
 * the record instead of refusing the log; `none` — neither, so writing the
 * event would make the log unreadable and the mode stays in process memory.
 * Probes with a throwaway in-memory session, whose append reports the marker.
 * @returns the resolved capability.
 */
function resolveStampCapability(): StampCapability {
  if (KNOWN_SESSION_EVENT_TYPES.has('computer-use/coordinate-mode')) return 'catalog'
  try {
    const probe = Session.create(SessionId('dsh-orb-coordinate-mode-probe'))
    return appendCoordinateMode(probe, 'millifraction', true).ignorable === true ? 'ignorable' : 'none'
  } catch {
    return 'none'
  }
}

/**
 * Stamp a blank overlay create with the Desktop default encoding, degrading by
 * host capability so the record never makes the log unreadable:
 * catalog/ignorable harnesses get the logged event; a harness with neither —
 * official 0.1.7 refuses unknown required events — only keeps the encoding in
 * process memory. History adopt / resume (an `session/end-seed` is already in
 * the log) and a log that already has the record are left unchanged.
 * Headless/Web omit `orbCoordinateMode` and do not record anything.
 * @param ctx - plugin context; optional `orbCoordinateMode` is Desktop-only.
 * @param session - newly created Computer Use session.
 */
export function stampCoordinateMode(ctx: Context, session: Session): void {
  if (hasCoordinateModeEvent(session) || hasEndSeed(session)) return
  const service = ctx.get('orbCoordinateMode') as OrbCoordinateMode | undefined
  if (service === undefined) return
  const mode = service.currentMode()
  sessionModeCache.set(session, mode)
  const capability = resolveStampCapability()
  if (capability === 'catalog') {
    appendCoordinateMode(session, mode, false)
    return
  }
  if (capability === 'ignorable') appendCoordinateMode(session, mode, true)
}

/**
 * Register the coordinate-mode projection when the host composes session-projection,
 * and stamp blank Computer Use agents at `agent/created`.
 * @param ctx - Computer Use standing mount.
 */
export function installCoordinateMode(ctx: Context): void {
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    projections.register(coordinateModeProjection)
  } else {
    ctx.inject(['sessionProjections'], (scoped) => {
      scoped.sessionProjections.register(coordinateModeProjection)
    })
  }
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    stampCoordinateMode(ctx, agent.session)
    return undefined
  })
}
