/**
 * Profile files the ball and the settings page share.
 * Names match the desktop fork so an existing profile keeps its choices.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAvatarPresetId } from './avatar-presets.ts'

const PERMISSION_FILE = 'orb-permission.json'
const MODELS_FILE = 'orb-agent-models.json'
const MILLIFRACTION_FILE = 'millifraction-coordinates.json'
const SELECTION_FILE = 'selection-toolbar.json'
const BALL_FILE = 'ball-enabled.json'
const HOTKEY_FILE = 'orb-hotkey.json'
const AVATAR_FILE = 'orb-avatar'
const AVATAR_META_FILE = 'orb-avatar.json'

export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** Fixed accelerator presets for the summon hotkey — no free-form input, so no accelerator parser. */
export const HOTKEY_ACCELERATORS = ['Alt+B', 'Alt+O', 'Control+Alt+B', 'F9'] as const

export type HotkeyAccelerator = (typeof HOTKEY_ACCELERATORS)[number]

export interface HotkeyConfig {
  readonly enabled: boolean
  readonly accelerator: HotkeyAccelerator
}

const DEFAULT_HOTKEY: HotkeyConfig = { enabled: false, accelerator: 'Alt+B' }

export function isHotkeyAccelerator(value: unknown): value is HotkeyAccelerator {
  return typeof value === 'string' && (HOTKEY_ACCELERATORS as readonly string[]).includes(value)
}

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentModels {
  readonly overlay: AgentModelSelection
  readonly background: AgentModelSelection
}

export type AvatarMime = 'image/gif' | 'image/png' | 'image/webp'

/** What the ball shows: the shipped GIF, an uploaded image, or a built-in preset. */
export type AvatarSelection =
  | { kind: 'default' }
  | { kind: 'custom'; mime: AvatarMime }
  | { kind: 'preset'; id: string }

const DEFAULT_MODEL: AgentModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

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
  private modelValue: AgentModels
  private millifractionValue: boolean
  private selectionValue: boolean
  private selectionLanguage: 'zh' | 'en'
  private ballValue: boolean
  private hotkeyState: HotkeyConfig

  constructor(readonly dir: string) {
    const permission = readPermission(dir)
    this.permissionValue = permission.preset
    this.permissionFallbackValue = permission.fallback
    this.modelValue = readModels(dir)
    this.millifractionValue = readMillifraction(dir)
    const selection = readSelection(dir)
    this.selectionValue = selection.enabled
    this.selectionLanguage = selection.language
    this.ballValue = readBall(dir)
    this.hotkeyState = readHotkey(dir)
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

  models(): AgentModels {
    return this.modelValue
  }

  setOverlay(selection: AgentModelSelection): void {
    this.modelValue = { overlay: selection, background: this.modelValue.background }
    this.writeModels()
  }

  setBackground(selection: AgentModelSelection): void {
    this.modelValue = { overlay: this.modelValue.overlay, background: selection }
    this.writeModels()
  }

  millifractionEnabled(): boolean {
    return this.millifractionValue
  }

  setMillifractionEnabled(enabled: boolean): void {
    this.millifractionValue = enabled
    writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled })
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

  /** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
  ballEnabled(): boolean {
    return this.ballValue
  }

  setBallEnabled(enabled: boolean): void {
    this.ballValue = enabled
    writeJson(join(this.dir, BALL_FILE), { enabled })
  }

  hotkey(): HotkeyConfig {
    return this.hotkeyState
  }

  setHotkey(enabled: boolean, accelerator: HotkeyAccelerator): void {
    this.hotkeyState = { enabled, accelerator }
    writeJson(join(this.dir, HOTKEY_FILE), { enabled, accelerator })
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

  private writeModels(): void {
    writeJson(join(this.dir, MODELS_FILE), {
      overlay: serializeSelection(this.modelValue.overlay),
      background: serializeSelection(this.modelValue.background),
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

function readModels(dir: string): AgentModels {
  const value = record(readJson(join(dir, MODELS_FILE)))
  return {
    overlay: parseSelection(value?.overlay) ?? DEFAULT_MODEL,
    background: parseSelection(value?.background) ?? DEFAULT_MODEL,
  }
}

function readMillifraction(dir: string): boolean {
  const enabled = record(readJson(join(dir, MILLIFRACTION_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : defaultMillifraction()
}

function readSelection(dir: string): { enabled: boolean; language: 'zh' | 'en' } {
  const value = record(readJson(join(dir, SELECTION_FILE)))
  const language = value?.translateTargetLanguage === 'en' ? 'en' : 'zh'
  // The selection toolbar is disabled everywhere (buggy). The stored flag is
  // ignored so profiles that enabled it before also stay off; only the
  // language preference is still honored.
  return { enabled: false, language }
}

function readBall(dir: string): boolean {
  const enabled = record(readJson(join(dir, BALL_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

function readHotkey(dir: string): HotkeyConfig {
  const value = record(readJson(join(dir, HOTKEY_FILE)))
  // A corrupt or unknown accelerator falls back to the shipped default, which is off:
  // a broken file must not silently enable a global hotkey.
  if (value === undefined || !isHotkeyAccelerator(value.accelerator)) return DEFAULT_HOTKEY
  return { enabled: value.enabled === true, accelerator: value.accelerator }
}

function readAvatarMime(dir: string): AvatarMime | undefined {
  const mime = record(readJson(join(dir, AVATAR_META_FILE)))?.mime
  if (mime === 'image/gif' || mime === 'image/png' || mime === 'image/webp') return mime
  return undefined
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
