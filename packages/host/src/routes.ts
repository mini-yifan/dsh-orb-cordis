/**
 * Settings routes on the official web port.
 * The main window calls these with a relative fetch, so the existing login cookie is enough.
 * The helper may read only the avatar, and only with its socket token.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { AVATAR_PRESETS, avatarPresetPath, isAvatarPresetId } from './avatar-presets.ts'
import { normalizeCatalog, type ModelCatalog } from './catalog.ts'
import {
  isAgentModelSelection,
  MAX_AVATAR_BYTES,
  sniffAvatarMime,
  type AgentModelSelection,
  type ProfileStore,
} from './preferences.ts'
import { selectionRuntimeAvailable } from '@dsh-orb/native-selection'
import { defaultAvatarPath } from './helper-path.ts'
import { isTccRight, type TccMonitor, type TccStatus } from './tcc.ts'
import type { UpdateState } from './update.ts'

const PREFIX = '/.dsh-orb'
const HELPER_HEADER = 'x-dsh-orb-helper'

interface RouteContext {
  readonly webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    admit?(request: IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: IncomingMessage): boolean
  }
  readonly sessionController: {
    modelCatalog(): unknown
  }
}

/** Side effects that have to reach the live ball. */
export interface OrbControl {
  helperAuthorized(token: string): boolean
  publishChrome(): Promise<void>
  setOverlayModel(selection: AgentModelSelection): Promise<void>
  setBackgroundModel(selection: AgentModelSelection): Promise<void>
  setSelectionEnabled(enabled: boolean): Promise<void>
  setMillifractionEnabled(enabled: boolean): Promise<void>
  setObservationFrameEnabled(enabled: boolean): Promise<void>
  setBallEnabled(enabled: boolean): Promise<void>
  helperStatus?(): string
  /** 'downloading'/'extracting' while the helper runtime is prepared; '' otherwise. */
  helperPhase?(): string
  /** The pending ball-initiated jump target, or null once consumed or expired. */
  takeJump(): { sessionId: string; at: number } | null
  /** Consumes the jump target armed by a matching bookmark click. */
  confirmJump(sessionId: string): void
  updateState(): UpdateState
  checkUpdate(): Promise<void>
  /** Starts the upgrade and returns at once; the page polls {@link updateState} while it runs. */
  installUpdate(approvedBuilds?: string[]): void
  setAutoCheck(enabled: boolean): void
}

interface RouteDeps {
  readonly ctx: RouteContext
  readonly store: ProfileStore
  readonly tcc: TccMonitor
  readonly control: OrbControl
}

/** Mount `/.dsh-orb` and return the disposer. */
export function registerOrbRoutes(deps: RouteDeps): () => void {
  return deps.ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    // A rejected handler used to hang the request (the official server does not answer it):
    // a bad body must come back as 400, not as an unhandled rejection.
    handler: (req, res) => handle(deps, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      const status = errorStatus(error) ?? 500
      if (status === 500) {
        console.error(`dsh-orb: route failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      sendJson(res, status, { error: status === 500 ? 'internal-error' : errorMessage(error) })
    }),
  })
}

/** A status a rejected route asked for: `readBody` sets 413, `readJson` sets 400. */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'request-failed'
}

export function orbSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

async function handle(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const helperAvatar = path === `${PREFIX}/avatar` && req.method === 'GET' && helperTokenOk(deps, req)
  if (!helperAvatar) {
    const rejection = rejectionStatus(deps.ctx, req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end()
      return
    }
  }
  const method = req.method ?? 'GET'
  if (method === 'GET' && path === `${PREFIX}/settings`) {
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/models`) {
    sendJson(res, 200, await catalog(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/tcc`) {
    sendJson(res, 200, deps.tcc.status())
    return
  }
  // Update management sits above the platform gate: Linux has no ball but still runs this host.
  if (method === 'GET' && path === `${PREFIX}/update`) {
    sendJson(res, 200, deps.control.updateState())
    return
  }
  if (method === 'POST' && path === `${PREFIX}/update/check`) {
    await deps.control.checkUpdate()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/update/install`) {
    const builds = stringListField(await readJson(req), 'approvedBuilds')
    deps.control.installUpdate(builds)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/update/auto`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-auto-check' })
      return
    }
    deps.control.setAutoCheck(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  // Bookmark jumps sit above the platform gate: the target is armed by the ball,
  // and the client plugin in the main window consumes it with a retain call.
  if (method === 'GET' && path === `${PREFIX}/jump`) {
    const target = deps.control.takeJump()
    sendJson(res, 200, { sessionId: target?.sessionId ?? null, at: target?.at ?? null })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/jump`) {
    const sessionId = asRecord(await readJson(req))?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      sendJson(res, 400, { error: 'invalid-session' })
      return
    }
    deps.control.confirmJump(sessionId)
    sendJson(res, 200, { ok: true })
    return
  }
  if ((method === 'GET' || method === 'HEAD') && path === `${PREFIX}/avatar`) {
    await sendAvatar(deps.store, method, res)
    return
  }
  if ((method === 'GET' || method === 'HEAD') && path.startsWith(`${PREFIX}/avatar/preset/`)) {
    const id = decodeURIComponent(path.slice(`${PREFIX}/avatar/preset/`.length))
    const file = avatarPresetPath(id)
    if (file === undefined || !await sendFile(res, method, file, 'image/gif')) {
      res.writeHead(404)
      res.end()
    }
    return
  }
  if (!orbSupported()) {
    sendJson(res, 403, { error: 'unsupported' })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/overlay-model`) {
    const selection = selectionFrom(await readJson(req))
    if (selection === undefined) {
      sendJson(res, 400, { error: 'invalid-model' })
      return
    }
    await deps.control.setOverlayModel(selection)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/background-model`) {
    const selection = selectionFrom(await readJson(req))
    if (selection === undefined) {
      sendJson(res, 400, { error: 'invalid-model' })
      return
    }
    await deps.control.setBackgroundModel(selection)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/selection`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-selection' })
      return
    }
    await deps.control.setSelectionEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/millifraction`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-millifraction' })
      return
    }
    await deps.control.setMillifractionEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/observation-frame`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-observation-frame' })
      return
    }
    await deps.control.setObservationFrameEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/ball`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-ball' })
      return
    }
    await deps.control.setBallEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/avatar`) {
    const bytes = await readBody(req, MAX_AVATAR_BYTES + 1).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'too-large') return undefined
      throw error
    })
    if (bytes === undefined || bytes.length > MAX_AVATAR_BYTES) {
      sendJson(res, 413, { error: 'too-large' })
      return
    }
    const mime = sniffAvatarMime(bytes)
    if (mime === undefined) {
      sendJson(res, 400, { error: 'invalid-type' })
      return
    }
    deps.store.writeAvatar(bytes, mime)
    await deps.control.publishChrome()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/avatar/preset`) {
    const preset = asRecord(await readJson(req))?.preset
    if (!isAvatarPresetId(preset)) {
      sendJson(res, 400, { error: 'invalid-preset' })
      return
    }
    deps.store.selectAvatarPreset(preset)
    await deps.control.publishChrome()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/avatar/restore`) {
    deps.store.restoreAvatar()
    await deps.control.publishChrome()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/tcc`) {
    const right = asRecord(await readJson(req))?.right
    if (!isTccRight(right)) {
      sendJson(res, 400, { error: 'invalid-tcc' })
      return
    }
    await deps.tcc.open(right)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  res.writeHead(404)
  res.end()
}

async function snapshot(deps: RouteDeps): Promise<{
  supported: boolean
  ballEnabled: boolean
  avatarUrl: string
  avatarPresetId: string | null
  avatarPresets: { id: string; url: string }[]
  overlay: AgentModelSelection
  background: AgentModelSelection
  selectionEnabled: boolean
  millifractionEnabled: boolean
  observationFrameEnabled: boolean
  tcc: TccStatus
  helperError: string
  helperPhase: string
  selectionAvailable: boolean
  permissionFallback: boolean
  update: UpdateState
}> {
  const models = deps.store.models()
  const version = Math.trunc(deps.store.avatarVersion())
  const selection = deps.store.avatarSelection()
  return {
    supported: orbSupported(),
    ballEnabled: deps.store.ballEnabled(),
    avatarUrl: `${PREFIX}/avatar?v=${version}`,
    avatarPresetId: selection.kind === 'preset' ? selection.id : null,
    // No version on the gallery URLs: the files are the same on every render, and a
    // bump would make the page refetch every multi-megabyte GIF on any avatar change.
    avatarPresets: AVATAR_PRESETS.map((preset) => ({ id: preset.id, url: `${PREFIX}/avatar/preset/${preset.id}` })),
    overlay: models.overlay,
    background: models.background,
    selectionEnabled: deps.store.selectionEnabled(),
    millifractionEnabled: deps.store.millifractionEnabled(),
    observationFrameEnabled: deps.store.observationFrameEnabled(),
    tcc: deps.tcc.status(),
    helperError: deps.control.helperStatus?.() ?? '',
    helperPhase: deps.control.helperPhase?.() ?? '',
    selectionAvailable: selectionRuntimeAvailable(),
    permissionFallback: deps.store.permissionFallback(),
    update: deps.control.updateState(),
  }
}

async function catalog(deps: RouteDeps): Promise<ModelCatalog> {
  try {
    return normalizeCatalog(await deps.ctx.sessionController.modelCatalog())
  } catch (error) {
    console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    return { groups: [] }
  }
}

/** The profile's avatar: a built-in preset, the uploaded bytes, or the shipped GIF. */
async function sendAvatar(store: ProfileStore, method: string, res: ServerResponse): Promise<void> {
  const selection = store.avatarSelection()
  if (selection.kind === 'preset') {
    const file = avatarPresetPath(selection.id)
    if (file !== undefined && await sendFile(res, method, file, 'image/gif')) return
  }
  const custom = selection.kind === 'custom' ? store.readAvatar() : undefined
  if (custom !== undefined) {
    sendImage(res, method, custom.bytes, custom.mime)
    return
  }
  if (await sendFile(res, method, defaultAvatarPath(), 'image/gif')) return
  res.writeHead(404)
  res.end()
}

/** Reads the file and answers with the image; false means the caller still has to answer. */
async function sendFile(res: ServerResponse, method: string, file: string, mime: string): Promise<boolean> {
  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    return false
  }
  sendImage(res, method, body, mime)
  return true
}

function sendImage(res: ServerResponse, method: string, body: Buffer, mime: string): void {
  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(method === 'HEAD' ? undefined : body)
}

function helperTokenOk(deps: RouteDeps, req: IncomingMessage): boolean {
  const header = req.headers[HELPER_HEADER]
  return typeof header === 'string' && deps.control.helperAuthorized(header)
}

export function tokensMatch(given: string, expected: string): boolean {
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

function rejectionStatus(ctx: RouteContext, req: IncomingMessage): number | undefined {
  if (typeof ctx.connection.admit === 'function') {
    const admitted = ctx.connection.admit(req)
    if (typeof admitted === 'object' && admitted !== null && 'rejection' in admitted && typeof admitted.rejection === 'number') {
      return admitted.rejection
    }
    return undefined
  }
  if (typeof ctx.connection.isAuthenticated === 'function') {
    return ctx.connection.isAuthenticated(req) ? undefined : 401
  }
  return 401
}

function selectionFrom(value: unknown): AgentModelSelection | undefined {
  return isAgentModelSelection(value) ? value : undefined
}

function booleanField(value: unknown): boolean | undefined {
  const enabled = asRecord(value)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

/** Optional list of package names, absent when the field is missing or empty. */
function stringListField(value: unknown, key: string): string[] | undefined {
  const list = asRecord(value)?.[key]
  if (!Array.isArray(list)) return undefined
  const names = list.filter((item): item is string => typeof item === 'string' && item !== '')
  return names.length === 0 ? undefined : names
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(req, 64 * 1024)
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    // The route wrapper answers 400; without it the request would hang.
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
