/**
 * Update check and one-click upgrade for the installed bundle.
 * The check probes the package registries — npmmirror first: it mirrors npmjs
 * and answers where GitHub stalls — and falls back to the repository's GitHub
 * Releases when no registry knows the package. The upgrade installs
 * `name@version` through the official plugin manager, asking the registry that
 * answered the check first. A bare tarball URL is not an install spec: pnpm
 * 11.7 records it without `integrity` and refuses it before downloading.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileStore } from './preferences.ts'

/** The GitHub repository that publishes plugin releases, `plugin-v<version>` tags. */
export const UPDATE_REPO = 'mini-yifan/dsh-orb-cordis'

/** Registry sources probed before GitHub, in order. npmmirror syncs minutes after a publish. */
export const REGISTRY_BASES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/** How long a remembered answer stays fresh for the automatic check. */
export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Delay before the first automatic check: the official host needs the network at boot. */
export const FIRST_CHECK_DELAY_MS = 20 * 1000

const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000

/** Answer a host without an updater gives: the settings page then hides the whole card. */
export const EMPTY_UPDATE_STATE: UpdateState = {
  currentVersion: '',
  installedVersion: '',
  latestVersion: null,
  available: false,
  checking: false,
  updating: false,
  canUpdate: false,
  autoCheck: false,
  checkedAt: null,
  restartRequired: false,
  error: null,
  pendingBuilds: [],
}

/** What the settings page renders. `currentVersion` is the code this process runs. */
export interface UpdateState {
  currentVersion: string
  /** Version on disk now; differs from {@link currentVersion} after an upgrade until restart. */
  installedVersion: string
  latestVersion: string | null
  available: boolean
  checking: boolean
  updating: boolean
  canUpdate: boolean
  autoCheck: boolean
  checkedAt: number | null
  restartRequired: boolean
  error: string | null
  pendingBuilds: string[]
}

/** The package manifest next to the built host. */
export interface OwnPackage {
  readonly name: string
  readonly version: string
}

/** The slice of the official `pluginManager` service this plugin uses. */
export interface PluginManager {
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
    approvedBuilds?: string[]
    /** Registry asked first. The manager keeps its own fallbacks when this one is among them. */
    registry?: string
  }): Promise<InstallResult>
}

export interface InstallResult {
  readonly changed?: boolean
  readonly application?: string
  readonly error?: { readonly code?: string; readonly diagnostic?: string }
  readonly pendingBuilds?: readonly string[]
  readonly bundle?: string
}

export interface UpdateDeps {
  readonly store: ProfileStore
  /** Official service, read live because it mounts after us. */
  manager(): unknown
  /** Announce a newly published version on the ball, once per version. */
  notify(version: string): void
  /** Test seam: newest published version, or undefined when no registry answers. */
  fetchLatest?(name: string): Promise<string | undefined>
  /** Test seam: the installed manifest. */
  own?: OwnPackage | undefined
}

/**
 * Read the installed manifest.
 * The path assumes the assembled layout: `dist/host/index.js` next to the package's
 * `package.json`, which holds both in the profile's `node_modules/dsh-orb` and in a
 * `link:`ed source checkout. Running from `packages/host/lib` finds nothing, so callers
 * treat an unknown version as "no update UI".
 */
export function ownPackage(url: string = import.meta.url): OwnPackage | undefined {
  let raw: string
  try {
    raw = readFileSync(new URL('../../package.json', url), 'utf8')
  } catch {
    return undefined
  }
  try {
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
    if (manifest.name === '' || manifest.version === '') return undefined
    return { name: manifest.name, version: manifest.version }
  } catch {
    return undefined
  }
}

/** Order two dotted versions. A prerelease sorts below the release it precedes. */
export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left)
  const b = splitVersion(right)
  for (let index = 0; index < Math.max(a.main.length, b.main.length); index += 1) {
    const one = a.main[index] ?? 0
    const other = b.main[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return comparePrerelease(a.pre, b.pre)
}

function isPluginManager(value: unknown): value is PluginManager {
  return typeof value === 'object' && value !== null
    && typeof (value as { installBundle?: unknown }).installBundle === 'function'
}

/**
 * Checks the repository's latest release and runs the official installer.
 * Every failure stays inside this class: the update path must never break the ball.
 */
export class UpdateChecker {
  private readonly store: ProfileStore
  private readonly deps: UpdateDeps
  private readonly own: OwnPackage | undefined
  private installed: string
  private latest: string | null
  private checking = false
  private updating = false
  private error: string | null = null
  private pendingBuilds: string[] = []
  private restartRequired = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  /** The registry base that answered the last check; GitHub is the fallback when none did. */
  private source: string | undefined

  constructor(deps: UpdateDeps) {
    this.deps = deps
    this.store = deps.store
    this.own = 'own' in deps ? deps.own : ownPackage()
    this.installed = this.own?.version ?? ''
    this.latest = this.store.updateRecord().latestVersion || null
  }

  state(): UpdateState {
    const latest = this.latest
    const installed = this.installed
    return {
      currentVersion: this.own?.version ?? '',
      installedVersion: installed,
      latestVersion: latest,
      available: this.available(),
      checking: this.checking,
      updating: this.updating,
      canUpdate: this.own !== undefined && isPluginManager(this.deps.manager()),
      autoCheck: this.store.updateRecord().autoCheck,
      checkedAt: this.store.updateRecord().checkedAt || null,
      restartRequired: this.restartRequired,
      error: this.error,
      pendingBuilds: [...this.pendingBuilds],
    }
  }

  /** Version waiting to be installed, when the check found one. */
  availableVersion(): string | null {
    return this.available() ? this.latest : null
  }

  /** Schedule the automatic checks and return the disposer. */
  start(): () => void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, FIRST_CHECK_DELAY_MS)
    this.timer.unref()
    this.interval = setInterval(() => { void this.check() }, PERIODIC_CHECK_MS)
    this.interval.unref()
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.interval !== undefined) clearInterval(this.interval)
      this.timer = undefined
      this.interval = undefined
    }
  }

  /**
   * Ask the repository's latest release for the newest published version.
   * The automatic call is throttled by {@link AUTO_CHECK_INTERVAL_MS}; `/update/check` is not.
   */
  async check(manual = false): Promise<void> {
    if (this.checking || this.updating || this.own === undefined) return
    const record = this.store.updateRecord()
    if (!manual && !record.autoCheck) return
    if (!manual && Date.now() - record.checkedAt < AUTO_CHECK_INTERVAL_MS) return
    this.checking = true
    try {
      const latest = await this.fetch()
      if (latest === null) {
        // The repository answered but publishes no release yet: a clean, quiet nothing.
        this.error = null
        this.store.setUpdateRecord({ checkedAt: Date.now() })
        return
      }
      if (latest === undefined) {
        this.error = 'network'
        return
      }
      this.latest = latest
      this.error = null
      const announce = compareVersions(latest, this.installed) > 0 && record.notifiedVersion !== latest
      this.store.setUpdateRecord({
        checkedAt: Date.now(),
        latestVersion: latest,
        ...announce ? { notifiedVersion: latest } : {},
      })
      if (announce) this.deps.notify(latest)
    } finally {
      this.checking = false
    }
  }

  /**
   * Install the version the check found through the official plugin manager.
   * The spec is `name@version` and the registry is the one that answered the
   * check, so pnpm resolves registry metadata — including `dist.integrity` —
   * instead of a bare tarball URL. The manager owns the profile lock, the
   * download and the manifest restore; an already-installed bundle is replaced
   * and the result says the restart carries the new code.
   */
  async install(approvedBuilds?: string[]): Promise<void> {
    const version = this.availableVersion()
    const manager = this.deps.manager()
    if (version === null || this.updating || !isPluginManager(manager) || this.own === undefined) return
    this.updating = true
    this.error = null
    this.pendingBuilds = []
    try {
      exemptReleaseAge(this.store.dir, this.own.name)
      const result = await manager.installBundle(installSpec(version, this.own.name), {
        requestId: `dsh-orb-update-${Date.now()}`,
        registry: installRegistry(this.source),
        ...approvedBuilds === undefined ? {} : { approvedBuilds },
      })
      if (result.application === 'failed') {
        this.error = reportedInstallError(result.error)
        this.pendingBuilds = result.pendingBuilds === undefined ? [] : [...result.pendingBuilds]
        if (this.pendingBuilds.length > 0) this.error = 'build-blocked'
        return
      }
      this.installed = version
      this.latest = version
      this.restartRequired = compareVersions(version, this.own.version) !== 0
      this.store.setUpdateRecord({ latestVersion: version, notifiedVersion: version, checkedAt: Date.now() })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.updating = false
    }
  }

  setAutoCheck(enabled: boolean): void {
    this.store.setUpdateRecord({ autoCheck: enabled })
  }

  private available(): boolean {
    return this.own !== undefined && this.latest !== null && compareVersions(this.latest, this.installed) > 0
  }

  private async fetch(): Promise<string | null | undefined> {
    const own = this.own
    if (own === undefined) return undefined
    if (this.deps.fetchLatest !== undefined) return this.deps.fetchLatest(own.name)
    const forced = process.env.DSH_ORB_UPDATE_LATEST?.trim()
    if (forced !== undefined && forced !== '') return forced
    this.source = undefined
    let answered = false
    for (const base of registryBases()) {
      const body = await curlText(`${base}/${own.name}/latest`)
      if (body === undefined) continue
      answered = true
      const version = versionFromRegistry(body)
      if (version !== undefined) {
        this.source = base
        return version
      }
      // A 404 (not synced yet) or a malformed answer: try the next source.
    }
    const body = await curlText(`${apiBase()}/releases/latest`)
    if (body === undefined) return answered ? null : undefined
    // An empty body is the repository's 404: no release published yet, not a failure.
    return versionFromRelease(body) ?? null
  }
}

/** The API base the check asks; `DSH_ORB_UPDATE_API` re-points it (tests, mirrors). */
function apiBase(): string {
  const configured = process.env.DSH_ORB_UPDATE_API?.trim()
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '')
  return `https://api.github.com/repos/${UPDATE_REPO}`
}

/** The tag a release publishes: version 0.2.0 ships as `plugin-v0.2.0`. */
export function releaseTag(version: string): string {
  return `plugin-v${version.trim().replace(/^v/, '')}`
}

/**
 * The tarball a release attaches, the name `pnpm pack` produces for the bundle.
 * `DSH_ORB_UPDATE_URL` overrides the whole address (tests, staged releases).
 */
export function releaseTarballUrl(version: string): string {
  const clean = version.trim().replace(/^v/, '')
  const overridden = process.env.DSH_ORB_UPDATE_URL?.trim()
  if (overridden !== undefined && overridden !== '') return overridden
  return `https://github.com/${UPDATE_REPO}/releases/download/${releaseTag(clean)}/dsh-orb-${clean}.tgz`
}

/** The registry sources the check probes; `DSH_ORB_UPDATE_REGISTRIES` re-points them (tests, mirrors). */
export function registryBases(): string[] {
  const configured = process.env.DSH_ORB_UPDATE_REGISTRIES?.trim()
  if (configured === undefined || configured === '') return [...REGISTRY_BASES]
  return configured
    .split(',')
    .map((base) => base.trim().replace(/\/+$/, ''))
    .filter((base) => base !== '')
}

/** The version a registry's dist-tag document names: `{"version":"0.2.0"}`. */
export function versionFromRegistry(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown }
    if (typeof parsed.version !== 'string') return undefined
    const version = parsed.version.trim().replace(/^v/, '')
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

/** The tarball address a registry serves for a package version. */
export function registryTarballUrl(base: string, name: string, version: string): string {
  const clean = version.trim().replace(/^v/, '')
  return `${base.replace(/\/+$/, '')}/${name}/-/${name}-${clean}.tgz`
}

/**
 * The spec the installer receives.
 * `name@version` makes pnpm read `dist.integrity` from registry metadata.
 * pnpm 11.7 (the version the official client bundles) rejects a bare tarball
 * URL whose lockfile entry has no integrity, before it downloads the file
 * (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). `DSH_ORB_UPDATE_URL` overrides the
 * whole spec (tests, staged releases).
 */
export function installSpec(version: string, name: string): string {
  const overridden = process.env.DSH_ORB_UPDATE_URL?.trim()
  if (overridden !== undefined && overridden !== '') return overridden
  const clean = version.trim().replace(/^v/, '')
  return `${name}@${clean}`
}

/**
 * Registry the manager should ask first: the one that answered the check, or
 * the primary mirror when this process has not checked yet. The manager still
 * falls through to its own list when this registry is one of them.
 */
export function installRegistry(source: string | undefined): string {
  return source ?? REGISTRY_BASES[0] ?? 'https://registry.npmmirror.com'
}

/**
 * Text for a failed install. A specific manager code (incompatible version,
 * and so on) wins. `operation-error` is the manager's wrapper around a pnpm
 * failure, so the card shows the `ERR_PNPM_*` line from the diagnostic instead
 * of that wrapper.
 */
export function reportedInstallError(error: InstallResult['error']): string {
  const code = error?.code
  const lines = error?.diagnostic?.split('\n').map((line) => line.trim()).filter((line) => line !== '') ?? []
  if (code !== undefined && code !== '' && code !== 'operation-error') return code
  const detail = lines.find((line) => line.includes('ERR_PNPM_')) ?? lines[0]
  if (detail !== undefined && detail !== '') return detail.slice(0, 200)
  return code === undefined || code === '' ? 'operation-error' : code
}

/**
 * Record the package as an explicit exemption from pnpm's minimum-release-age
 * gate. pnpm v11 defaults `minimumReleaseAge` to 24 hours, so a registry-named
 * resolution silently settles for an older version while a fresh release waits
 * out the cutoff (observed 2026-10-06: `dsh-orb` resolved to 0.1.1 everywhere
 * the hour after 0.1.2 shipped), and the manager's install pipeline verifies the
 * lockfile against the gate before pnpm's own auto-exemption can apply. The
 * entry is the bare package name — pnpm grants it to every version, and unlike
 * exact `name@version` entries it passes the lockfile verification path
 * reliably (observed: versioned entries still failed verification). The write
 * puts that name first among its own rules, because pnpm honours only the first
 * one (see `withReleaseAgeExclusion`).
 *
 * Called twice: once when the plugin starts, so the profile reads correctly
 * whatever route installed the version (pnpm's own auto-exemption appends a
 * `name@version` rule that an older rule shadows), and once before an update
 * installs. Best-effort: an unreadable or unexpected file skips the write, and
 * the caller proceeds on pnpm's own defaults.
 */
export function exemptReleaseAge(profileDir: string, name: string): void {
  try {
    const file = join(profileDir, 'pnpm-workspace.yaml')
    const next = withReleaseAgeExclusion(readFileSync(file, 'utf8'), name)
    if (next !== undefined) writeFileSync(file, next)
  } catch {
    // No workspace file (dev checkout, older profile): nothing to exempt.
  }
}

/** The package an exemption entry names, with any version or version union dropped. */
function excludedPackageName(entry: string): string {
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@')
  return at === -1 ? entry : entry.slice(0, at)
}

/**
 * Write the package's exemption as the first entry of the profile's
 * `minimumReleaseAgeExclude` block, replacing whatever rules the file already
 * carried for the same name.
 *
 * pnpm's `evaluateVersionPolicy` returns at the FIRST rule whose package name
 * matches, so a rule only counts when nothing of the same name precedes it
 * (pnpm #732). Appending the bare name — what this used to do — is therefore
 * dead the moment any `name@version` rule sits earlier, and pnpm appends such a
 * rule for every young version it installs, so the file grows one shadowing
 * entry per release. The result is a profile where the package is not actually
 * exempt: `pnpm remove` re-resolves the young dependency, produces a
 * resolution-policy violation, and aborts with
 * `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` (its remove path never wires
 * the violation callback), which blocks uninstalling ANY other plugin until the
 * version ages past the cutoff.
 *
 * A bare name exempts every version, so the same-name `name@version` rules a
 * profile collected are dropped instead of being left to shadow it later, and
 * the bare entry is written first. Other packages' lines keep their order and
 * spelling. Returns the new text, or undefined when the file already reads that
 * way or is not the block list pnpm writes.
 */
export function withReleaseAgeExclusion(text: string, name: string): string | undefined {
  if (name === '') return undefined
  const lines = text.split('\n')
  let key = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === 'minimumReleaseAgeExclude:') {
      key = index
      break
    }
    // Inline arrays and shorthand are not pnpm's own output: leave them alone.
    if (/^minimumReleaseAgeExclude\s*:/.test(line)) return undefined
  }
  // `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one.
  const entry = name.startsWith('@') ? `'${name.replaceAll("'", "''")}'` : name
  if (key === -1) {
    const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${head}minimumReleaseAgeExclude:\n  - ${entry}\n`
  }
  // One rule per name: this package's own lines are replaced by the bare entry,
  // and a file that already reads that way is left byte for byte.
  const kept: string[] = []
  let indent: string | undefined
  let seen = 0
  let bareFirst = false
  let index = key + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const written = /^([ \t]+)-[ \t]+\S/.exec(line)
    if (written === null) break
    indent ??= written[1]
    const body = line.slice(line.indexOf('-') + 1).trim().replace(/^['"]|['"]$/g, '')
    if (excludedPackageName(body) === name) {
      if (seen === 0) bareFirst = body === name
      seen += 1
      indent = written[1] ?? indent
      continue
    }
    kept.push(line)
  }
  if (bareFirst && seen === 1) return undefined
  const updated = [...lines.slice(0, key + 1), `${indent ?? '  '}- ${entry}`, ...kept, ...lines.slice(index)].join('\n')
  return updated === text ? undefined : updated
}

/** The version a release names: `plugin-v0.2.0` → `0.2.0`. */
export function versionFromRelease(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { tag_name?: unknown }
    if (typeof parsed.tag_name !== 'string') return undefined
    const version = parsed.tag_name.trim().replace(/^plugin-v/, '')
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

function splitVersion(value: string): { main: number[]; pre: string } {
  const trimmed = value.trim().replace(/^v/, '')
  const dash = trimmed.indexOf('-')
  const head = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const pre = dash === -1 ? '' : trimmed.slice(dash + 1)
  const main = head.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  return { main, pre }
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const other = b[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumber = /^\d+$/.test(one) ? Number.parseInt(one, 10) : undefined
    const otherNumber = /^\d+$/.test(other) ? Number.parseInt(other, 10) : undefined
    if (oneNumber !== undefined && otherNumber !== undefined) return oneNumber < otherNumber ? -1 : 1
    if (oneNumber !== undefined) return -1
    if (otherNumber !== undefined) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * Fetch a plain-text body. HTTPS answers are pinned to https end to end; a
 * plain-http address (the local mock) keeps its scheme so the loopback works.
 * Resolves `''` when the server answers 404, `undefined` when the transfer
 * fails or answers with another non-2xx status.
 */
async function curlText(url: string): Promise<string | undefined> {
  const proto = url.startsWith('https://') ? ['--proto', '=https', '--proto-redir', '=https'] : []
  // The Windows schannel backend aborts the handshake when a certificate
  // revocation check cannot complete — common behind proxies. Skipping it costs
  // no trust here (the answer is data, not code); other backends ignore the flag.
  const tls = process.platform === 'win32' ? ['--ssl-no-revoke'] : []
  return new Promise((resolve) => {
    const child = spawn('curl', [
      '-sSL',
      ...proto,
      ...tls,
      '--connect-timeout', '5',
      '--max-time', '15',
      '-w', '\n%{http_code}',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.resume()
    child.once('error', () => { resolve(undefined) })
    child.once('exit', (code) => {
      if (code !== 0) return resolve(undefined)
      const text = Buffer.concat(out).toString('utf8')
      const cut = text.lastIndexOf('\n')
      const status = cut === -1 ? '' : text.slice(cut + 1).trim()
      const body = cut === -1 ? '' : text.slice(0, cut)
      if (status === '404') return resolve('')
      resolve(status.startsWith('2') ? body : undefined)
    })
  })
}
