/**
 * Profile files the ball and the settings page share.
 * Names match the desktop fork so an existing profile keeps its choices.
 *
 * `orb-agent-models.json` records only the tracks the user picked in the ball. A track
 * without an entry follows the shared fallback in {@link ProfileStore.applyModelFallback},
 * which `model-defaults.ts` resolves from the live catalog and the main window's default
 * model — the route the official sign-in points at the account once the profile has no
 * API key. {@link DEFAULT_MODEL} is the last resort, not the shipped default.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseVoiceSettings, type VoiceSettings } from '@dsh-orb/voice/settings'
import { isAvatarPresetId } from './avatar-presets.ts'

const PERMISSION_FILE = 'orb-permission.json'
const MODELS_FILE = 'orb-agent-models.json'
const MILLIFRACTION_FILE = 'millifraction-coordinates.json'
const OBSERVATION_FRAME_FILE = 'observation-frame.json'
const SELECTION_FILE = 'selection-toolbar.json'
const LASSO_FILE = 'lasso-capture.json'
const BALL_FILE = 'ball-enabled.json'
const AVATAR_FILE = 'orb-avatar'
const AVATAR_META_FILE = 'orb-avatar.json'
const UPDATE_FILE = 'orb-update.json'
const HISTORY_FILE = 'orb-history.json'
const WORKSPACE_FILE = 'orb-workspace.json'
const VOICE_FILE = 'orb-voice.json'
const WHATS_NEW_FILE = 'orb-whats-new.json'

/** Retention choices shown in the settings select; 0 means forever. */
export const HISTORY_RETENTION_DAYS = [0, 1, 7, 14, 30, 60] as const

/** Largest finite retention the select offers, in days. */
export const MAX_HISTORY_RETENTION_DAYS = 60

/** True for the six choices the settings page can send. */
export function isHistoryRetentionDays(value: number): boolean {
  return (HISTORY_RETENTION_DAYS as readonly number[]).includes(value)
}

export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentModels {
  readonly overlay: AgentModelSelection
  readonly background: AgentModelSelection
}

/** Same provider, model, and effort. Used to skip writes that would change nothing. */
export function sameSelection(left: AgentModelSelection, right: AgentModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

export type AvatarMime = 'image/gif' | 'image/png' | 'image/webp'

/** What the ball shows: the shipped GIF, an uploaded image, or a built-in preset. */
export type AvatarSelection =
  | { kind: 'default' }
  | { kind: 'custom'; mime: AvatarMime }
  | { kind: 'preset'; id: string }

/** Last update check the profile remembers. `checkedAt` is Unix time in milliseconds. */
export interface UpdateRecord {
  readonly checkedAt: number
  /** Newest version a registry reported, empty until one answers. */
  readonly latestVersion: string
  /** Version the ball already announced, so a restart does not repeat itself. */
  readonly notifiedVersion: string
  readonly autoCheck: boolean
  /**
   * Why the last upgrade failed, when the failure happened after this plugin was
   * unloaded. Empty once the next install starts. A reload reads it back, because
   * the instance that saw the failure is already gone.
   */
  readonly lastError: string
}

const DEFAULT_UPDATE: UpdateRecord = { checkedAt: 0, latestVersion: '', notifiedVersion: '', autoCheck: true, lastError: '' }

/**
 * Retention for the floating-ball workspace history. `retentionDays` of 0 means forever,
 * which is the default: an absent or unreadable file never deletes anything.
 */
export interface HistoryRecord {
  readonly retentionDays: number
  /** Unix time in milliseconds; 0 until a cleanup has moved something to the trash. */
  readonly lastCleanupAt: number
  readonly lastDeletedSessions: number
  /** Bytes moved into the system trash by the last cleanup. */
  readonly lastMovedBytes: number
  /**
   * Sessions the user put back from the system trash. A manual restore is a keep
   * decision: automatic retention must not immediately put the same conversation
   * back into the trash.
   */
  readonly restoredSessionIds: readonly string[]
}

const DEFAULT_HISTORY: HistoryRecord = {
  retentionDays: 0,
  lastCleanupAt: 0,
  lastDeletedSessions: 0,
  lastMovedBytes: 0,
  restoredSessionIds: [],
}

/** Current workspace plus the shipped default, for the settings card. */
export interface WorkspaceState {
  readonly path: string
  readonly defaultPath: string
  readonly custom: boolean
}

/** The floating-ball workspace when the profile names no other one. */
export function defaultWorkspaceDirectory(): string {
  return resolve(dshHomePath('dsh_orb'))
}

/**
 * The shipped DeepSeek pair. It is the fallback the unpicked tracks start on, and the
 * last resort for a deployment whose catalog or main-window default names nothing the
 * ball can route. `model-defaults.ts` decides which of those wins and installs it.
 */
export const DEFAULT_MODEL: AgentModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

/** Explicit ball choices only: an absent track follows the unpicked-track fallback. */
interface StoredModels {
  readonly overlay?: AgentModelSelection
  readonly background?: AgentModelSelection
}

/**
 * Upload cap, enforced by the settings page and again by the avatar route. The gallery
 * this page links to serves GIFs up to ~2.6 MB, so anything tighter rejects the very
 * files the flow sends people to fetch; the ball re-fetches the bytes on every chrome
 * publish, which is what keeps this a budget rather than a formality.
 */
export const MAX_AVATAR_BYTES = 4 * 1024 * 1024

/**
 * Active official profile directory.
 * Desktop and `dsh web` both provide `profileContext.dir`. The process directory is the fallback.
 */
export function profileDirectory(ctx: { get(name: string): unknown }): string {
  const profile = ctx.get('profileContext')
  if (typeof profile === 'object' && profile !== null && 'dir' in profile) {
    const dir = (profile as { dir?: unknown }).dir
    if (typeof dir === 'string' && dir !== '') return dir
  }
  return process.cwd()
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

export function isAgentModelSelection(value: unknown): value is AgentModelSelection {
  return parseSelection(value) !== undefined
}

/** In-memory view of the profile files. Writes update the cache and the disk together. */
export class ProfileStore {
  private permissionValue: PermissionPreset
  private permissionFallbackValue: boolean
  private modelValue: StoredModels
  /**
   * What a track the user never picked follows. Memory only: it is the main window's
   * default, refreshed by `model-defaults.ts`, and must not be mistaken for a choice.
   */
  private modelFallbackValue: AgentModelSelection = DEFAULT_MODEL
  private millifractionValue: boolean
  private observationFrameValue: boolean
  private selectionValue: boolean
  private selectionLanguage: 'zh' | 'en'
  private lassoValue: boolean
  private ballValue: boolean
  private updateValue: UpdateRecord
  private historyValue: HistoryRecord
  private whatsNewValue: Set<string>
  private voiceValue: VoiceSettings

  constructor(readonly dir: string) {
    const permission = readPermission(dir)
    this.permissionValue = permission.preset
    this.permissionFallbackValue = permission.fallback
    this.modelValue = readModels(dir)
    this.millifractionValue = readMillifraction(dir)
    this.observationFrameValue = readObservationFrame(dir)
    const selection = readSelection(dir)
    this.selectionValue = selection.enabled
    this.selectionLanguage = selection.language
    this.lassoValue = readLasso(dir)
    this.ballValue = readBall(dir)
    this.updateValue = readUpdate(dir)
    this.historyValue = readHistory(dir)
    this.whatsNewValue = readWhatsNew(dir)
    const voice = readJson(join(dir, VOICE_FILE))
    // A fresh profile starts with voice off. A file written before the master switch
    // existed keeps the old effective state: on only if one of its columns was on.
    this.voiceValue = parseVoiceSettings(voice, { legacyMaster: legacyVoiceOn(voice) })
  }

  permission(): PermissionPreset {
    return this.permissionValue
  }

  /** True when the permission file exists but cannot be used. Missing means full access. */
  permissionFallback(): boolean {
    return this.permissionFallbackValue
  }

  setPermission(preset: PermissionPreset): void {
    this.permissionValue = preset
    this.permissionFallbackValue = false
    writeJson(join(this.dir, PERMISSION_FILE), { preset })
  }

  /**
   * The two tracks: an explicit ball choice wins, a track the user never picked follows
   * the unpicked-track fallback. Nothing here is persisted — a track stays "following"
   * until the user picks a model for it.
   */
  models(): AgentModels {
    return {
      overlay: this.modelValue.overlay ?? this.modelFallbackValue,
      background: this.modelValue.background ?? this.modelFallbackValue,
    }
  }

  /**
   * Install what the unpicked tracks follow.
   * @param selection - the resolved fallback; invalid values are ignored.
   * @returns whether it moved, which is what makes a live session re-select.
   */
  applyModelFallback(selection: AgentModelSelection): boolean {
    const next = parseSelection(selection)
    if (next === undefined || sameSelection(next, this.modelFallbackValue)) return false
    this.modelFallbackValue = next
    return true
  }

  setOverlay(selection: AgentModelSelection): void {
    this.modelValue = { ...this.modelValue, overlay: selection }
    this.writeModels()
  }

  setBackground(selection: AgentModelSelection): void {
    this.modelValue = { ...this.modelValue, background: selection }
    this.writeModels()
  }

  millifractionEnabled(): boolean {
    return this.millifractionValue
  }

  setMillifractionEnabled(enabled: boolean): void {
    this.millifractionValue = enabled
    writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled })
  }

  /** The coloured frame around the window Computer Use works on; on unless turned off. */
  observationFrameEnabled(): boolean {
    return this.observationFrameValue
  }

  setObservationFrameEnabled(enabled: boolean): void {
    this.observationFrameValue = enabled
    writeJson(join(this.dir, OBSERVATION_FRAME_FILE), { enabled })
  }

  /** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
  coordinateMode(): 'millifraction' | 'pixel' {
    return this.millifractionValue ? 'millifraction' : 'pixel'
  }

  selectionEnabled(): boolean {
    return this.selectionValue
  }

  translateLanguage(): 'zh' | 'en' {
    return this.selectionLanguage
  }

  setTranslateLanguage(language: 'zh' | 'en'): void {
    this.selectionLanguage = language
    writeJson(join(this.dir, SELECTION_FILE), {
      enabled: this.selectionValue,
      translateTargetLanguage: language,
    })
  }

  setSelectionEnabled(enabled: boolean): void {
    this.selectionValue = enabled
    writeJson(join(this.dir, SELECTION_FILE), {
      enabled,
      translateTargetLanguage: this.selectionLanguage,
    })
  }

  lassoEnabled(): boolean {
    return this.lassoValue
  }

  setLassoEnabled(enabled: boolean): void {
    this.lassoValue = enabled
    writeJson(join(this.dir, LASSO_FILE), { enabled })
  }

  /** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
  ballEnabled(): boolean {
    return this.ballValue
  }

  setBallEnabled(enabled: boolean): void {
    this.ballValue = enabled
    writeJson(join(this.dir, BALL_FILE), { enabled })
  }

  updateRecord(): UpdateRecord {
    return this.updateValue
  }

  setUpdateRecord(patch: Partial<UpdateRecord>): void {
    this.updateValue = { ...this.updateValue, ...patch }
    writeJson(join(this.dir, UPDATE_FILE), this.updateValue)
  }

  /** Whether the user already closed this release note on this profile. */
  whatsNewDismissed(id: string): boolean {
    return this.whatsNewValue.has(id)
  }

  /**
   * Remember a closed release note. The file is written before the in-memory set moves, so a
   * failed write leaves the note visible instead of pretending it was dismissed.
   */
  dismissWhatsNew(id: string): void {
    if (this.whatsNewValue.has(id)) return
    const next = new Set(this.whatsNewValue)
    next.add(id)
    writeJson(join(this.dir, WHATS_NEW_FILE), { dismissed: [...next] })
    this.whatsNewValue = next
  }

  history(): HistoryRecord {
    return this.historyValue
  }

  setHistoryRecord(patch: Partial<HistoryRecord>): void {
    this.historyValue = { ...this.historyValue, ...patch }
    writeJson(join(this.dir, HISTORY_FILE), this.historyValue)
  }

  /** Wake, command, and speech settings. A bad file reads back as the factory values. */
  voice(): VoiceSettings {
    return this.voiceValue
  }

  /** Persist a settings object. Out-of-range fields are corrected before they hit disk. */
  setVoice(value: unknown): VoiceSettings {
    this.voiceValue = parseVoiceSettings(value)
    writeJson(join(this.dir, VOICE_FILE), this.voiceValue)
    return this.voiceValue
  }

  /**
   * The workspace the ball creates its conversations in. The future workspace setting
   * writes `orb-workspace.json`; missing or relative paths keep the shipped default.
   */
  workspaceDirectory(): string {
    const stored = record(readJson(join(this.dir, WORKSPACE_FILE)))?.path
    if (typeof stored === 'string' && isAbsolute(stored)) return resolve(stored)
    return defaultWorkspaceDirectory()
  }

  /** `null` restores the shipped default; any other absolute path is stored as-is. */
  setWorkspaceDirectory(path: string | null): void {
    if (path === null || resolve(path) === defaultWorkspaceDirectory()) {
      removeIfPresent(join(this.dir, WORKSPACE_FILE))
      return
    }
    writeJson(join(this.dir, WORKSPACE_FILE), { path: resolve(path) })
  }

  /** Bumped by every avatar change: the ball refetches on it, the settings preview re-renders on it. */
  avatarVersion(): number {
    for (const name of [AVATAR_META_FILE, AVATAR_FILE]) {
      try {
        return statSync(join(this.dir, name)).mtimeMs
      } catch {
        // Try the next file; no avatar at all means version 0.
      }
    }
    return 0
  }

  /**
   * Avatar the profile currently shows, checked against what is on disk.
   * An unknown preset id or a half-written upload falls back to the shipped GIF.
   */
  avatarSelection(): AvatarSelection {
    const preset = record(readJson(join(this.dir, AVATAR_META_FILE)))?.preset
    if (isAvatarPresetId(preset)) return { kind: 'preset', id: preset }
    const custom = this.readAvatar()
    if (custom !== undefined) return { kind: 'custom', mime: custom.mime }
    return { kind: 'default' }
  }

  readAvatar(): { bytes: Buffer; mime: AvatarMime } | undefined {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(this.dir, AVATAR_FILE))
    } catch {
      return undefined
    }
    const sniffed = sniffAvatarMime(bytes)
    if (sniffed === undefined) return undefined
    const declared = readAvatarMime(this.dir)
    if (declared !== undefined && declared !== sniffed) return undefined
    return { bytes, mime: declared ?? sniffed }
  }

  /** One avatar per profile: an uploaded image drops the preset pick and the other way round. */
  writeAvatar(bytes: Uint8Array, mime: AvatarMime): void {
    writeBytes(join(this.dir, AVATAR_FILE), bytes)
    writeJson(join(this.dir, AVATAR_META_FILE), { kind: 'custom', mime })
  }

  selectAvatarPreset(id: string): void {
    writeJson(join(this.dir, AVATAR_META_FILE), { kind: 'preset', preset: id })
    removeIfPresent(join(this.dir, AVATAR_FILE))
  }

  restoreAvatar(): void {
    for (const name of [AVATAR_FILE, AVATAR_META_FILE]) {
      removeIfPresent(join(this.dir, name))
    }
  }

  /**
   * Persist the explicit choices only. Writing a resolved value would freeze a track
   * the user never picked, and the reader already treats a missing entry as "follow
   * the main window".
   */
  private writeModels(): void {
    const { overlay, background } = this.modelValue
    writeJson(join(this.dir, MODELS_FILE), {
      ...overlay === undefined ? {} : { overlay: serializeSelection(overlay) },
      ...background === undefined ? {} : { background: serializeSelection(background) },
    })
  }
}

export function sniffAvatarMime(bytes: Uint8Array): AvatarMime | undefined {
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

export function defaultMillifraction(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

function readPermission(dir: string): { preset: PermissionPreset; fallback: boolean } {
  let raw: string
  try {
    raw = readFileSync(join(dir, PERMISSION_FILE), 'utf8')
  } catch (error) {
    if (isEnoent(error)) return { preset: 'danger-full-access', fallback: false }
    return { preset: 'workspace-write', fallback: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { preset: 'workspace-write', fallback: true }
  }
  const preset = record(parsed)?.preset
  if (isPermissionPreset(preset)) return { preset, fallback: false }
  return { preset: 'workspace-write', fallback: true }
}

/** Explicit choices, keyed by track. A track with no entry is resolved on read. */
function readModels(dir: string): StoredModels {
  const value = record(readJson(join(dir, MODELS_FILE)))
  const overlay = parseSelection(value?.overlay)
  const background = parseSelection(value?.background)
  return {
    ...overlay === undefined ? {} : { overlay },
    ...background === undefined ? {} : { background },
  }
}

function readMillifraction(dir: string): boolean {
  const enabled = record(readJson(join(dir, MILLIFRACTION_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : defaultMillifraction()
}

function readSelection(dir: string): { enabled: boolean; language: 'zh' | 'en' } {
  const value = record(readJson(join(dir, SELECTION_FILE)))
  const language = value?.translateTargetLanguage === 'en' ? 'en' : 'zh'
  // The toolbar ships on. A profile whose file predates it, or whose file was lost,
  // starts enabled; only an explicit `false` turns it off.
  const enabled = typeof value?.enabled === 'boolean' ? value.enabled : true
  return { enabled, language }
}

function readBall(dir: string): boolean {
  const enabled = record(readJson(join(dir, BALL_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

function readObservationFrame(dir: string): boolean {
  const enabled = record(readJson(join(dir, OBSERVATION_FRAME_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

function readLasso(dir: string): boolean {
  const enabled = record(readJson(join(dir, LASSO_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

function readAvatarMime(dir: string): AvatarMime | undefined {
  const mime = record(readJson(join(dir, AVATAR_META_FILE)))?.mime
  if (mime === 'image/gif' || mime === 'image/png' || mime === 'image/webp') return mime
  return undefined
}

function readUpdate(dir: string): UpdateRecord {
  const stored = record(readJson(join(dir, UPDATE_FILE)))
  if (stored === undefined) return DEFAULT_UPDATE
  return {
    checkedAt: typeof stored.checkedAt === 'number' && Number.isFinite(stored.checkedAt) ? stored.checkedAt : 0,
    latestVersion: typeof stored.latestVersion === 'string' ? stored.latestVersion : '',
    notifiedVersion: typeof stored.notifiedVersion === 'string' ? stored.notifiedVersion : '',
    autoCheck: typeof stored.autoCheck === 'boolean' ? stored.autoCheck : true,
    lastError: typeof stored.lastError === 'string' ? stored.lastError : '',
  }
}

/** A missing or malformed file means nothing was dismissed: the note appears again. */
function readWhatsNew(dir: string): Set<string> {
  const stored = record(readJson(join(dir, WHATS_NEW_FILE)))
  const list = Array.isArray(stored?.dismissed) ? stored.dismissed : []
  return new Set(list.filter((id): id is string => typeof id === 'string' && id !== ''))
}

function readHistory(dir: string): HistoryRecord {
  const stored = record(readJson(join(dir, HISTORY_FILE)))
  if (stored === undefined) return DEFAULT_HISTORY
  const days = stored.retentionDays
  const retentionDays = typeof days === 'number' && isHistoryRetentionDays(days)
    ? days
    : DEFAULT_HISTORY.retentionDays
  return {
    retentionDays,
    lastCleanupAt: typeof stored.lastCleanupAt === 'number' && Number.isFinite(stored.lastCleanupAt) ? stored.lastCleanupAt : 0,
    lastDeletedSessions: typeof stored.lastDeletedSessions === 'number' && Number.isInteger(stored.lastDeletedSessions) && stored.lastDeletedSessions >= 0 ? stored.lastDeletedSessions : 0,
    lastMovedBytes: typeof stored.lastMovedBytes === 'number' && Number.isFinite(stored.lastMovedBytes) && stored.lastMovedBytes >= 0 ? stored.lastMovedBytes : 0,
    restoredSessionIds: Array.isArray(stored.restoredSessionIds)
      ? stored.restoredSessionIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..')).slice(-1000)
      : [],
  }
}

function parseSelection(value: unknown): AgentModelSelection | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (typeof item.provider !== 'string' || item.provider === '' || item.provider.length > 200) return undefined
  if (typeof item.model !== 'string' || item.model === '' || item.model.length > 200) return undefined
  if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || item.reasoningEffort === '' || item.reasoningEffort.length > 80)) {
    return undefined
  }
  return {
    provider: item.provider,
    model: item.model,
    ...typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {},
  }
}

function serializeSelection(selection: AgentModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** A pre-master voice file was running if any of its three columns was explicitly on. */
function legacyVoiceOn(value: unknown): boolean {
  const item = record(value)
  if (item === undefined) return false
  return item.wakeEnabled === true || item.commandEnabled === true || item.ttsEnabled === true
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function writeJson(file: string, value: unknown): void {
  writeBytes(file, Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`))
}

function writeBytes(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
}

function removeIfPresent(file: string): void {
  try {
    unlinkSync(file)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
