/**
 * An update that has to wait until this process exits.
 * When a native image inside the package is still mapped (see `native-images.ts`),
 * asking pnpm to replace the package now would fail and take the live package
 * apart. The update is handed to a small detached script outside the package
 * instead: it waits for this process to exit, then runs the same pnpm the
 * official plugin manager uses. A status file marks the install as running so the
 * next start does not load a package that is being replaced; its outcome is read
 * back once the script writes one.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What the detached script installs, and whose exit it waits for. */
export interface DeferredInstall {
  readonly profileDir: string
  readonly spec: string
  readonly registry: string
  readonly parentPid: number
  /** Approvals the settings page granted; the script merges them into the profile before pnpm runs. */
  readonly approvedBuilds: readonly string[]
}

/** How the last deferred install ended. */
export interface DeferredOutcome {
  readonly spec: string
  readonly ok: boolean
  readonly detail: string
}

/** Marks an install the after-exit script is running right now. */
interface DeferredStatus {
  readonly phase: 'installing'
  readonly spec?: unknown
  readonly pid?: unknown
  readonly startedAt?: unknown
}

/**
 * How long a status file without an outcome is still trusted. The script runs at most three
 * 15-minute pnpm attempts plus its waits (~45 minutes), so anything older cannot be live.
 */
export const DEFERRED_INSTALL_CEILING_MS = 47 * 60 * 1000

/** Folder under the profile that holds the job, the script, its log, and its outcome. */
export function deferredDir(profileDir: string): string {
  return join(profileDir, '.dsh-orb-update')
}

/**
 * Write the job and start the detached script. It runs on this executable with
 * `ELECTRON_RUN_AS_NODE`, so it needs no Node on PATH, and from the profile folder,
 * so it holds nothing open inside the package it replaces.
 */
export function scheduleInstallAfterExit(job: DeferredInstall): void {
  const dir = deferredDir(job.profileDir)
  mkdirSync(dir, { recursive: true })
  rmSync(join(dir, 'result.json'), { force: true })
  const jobFile = join(dir, 'job.json')
  const script = join(dir, 'apply.mjs')
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`)
  writeFileSync(script, APPLY_SCRIPT)
  const child = spawn(process.execPath, [script, jobFile], {
    cwd: job.profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/** The outcome a previous run's script left, removed once read. */
export function takeDeferredOutcome(profileDir: string): DeferredOutcome | undefined {
  const file = join(deferredDir(profileDir), 'result.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  rmSync(file, { force: true })
  try {
    const parsed = JSON.parse(raw) as Partial<DeferredOutcome>
    if (typeof parsed.spec !== 'string' || typeof parsed.ok !== 'boolean') return undefined
    return { spec: parsed.spec, ok: parsed.ok, detail: typeof parsed.detail === 'string' ? parsed.detail : '' }
  } catch {
    return undefined
  }
}

/**
 * Whether the after-exit script is installing right now. The script's own status file is
 * the signal: it exists while pnpm runs and is removed once the outcome is written.
 * A status whose script died is only trusted until the script's own ceiling passes; then
 * the leftover is collected as a failed outcome so the host can start.
 * @param profileDir - profile that scheduled the install.
 * @returns true while a live install is running.
 */
export function deferredInstallInProgress(profileDir: string): boolean {
  const dir = deferredDir(profileDir)
  let raw: string
  try {
    raw = readFileSync(join(dir, 'status.json'), 'utf8')
  } catch {
    return false
  }
  try {
    if (statSync(join(dir, 'result.json')).isFile()) return false
  } catch {
    // No outcome yet: the install is still running or the script died.
  }
  let status: DeferredStatus | undefined
  try {
    status = JSON.parse(raw) as DeferredStatus
  } catch {
    status = undefined
  }
  if (scriptAlive(Number(status?.pid))) return true
  const started = Number(status?.startedAt)
  if (Number.isFinite(started) && Date.now() - started <= DEFERRED_INSTALL_CEILING_MS) return true
  // The script died before writing an outcome and its ceiling has passed: collect the
  // leftover as a failure, or every later start would wait for it again.
  rmSync(join(dir, 'status.json'), { force: true })
  const spec = typeof status?.spec === 'string' ? status.spec : ''
  try {
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ spec, ok: false, detail: 'deferred-install-stalled' })}\n`)
  } catch {
    // The profile folder is gone; nothing to report.
  }
  return false
}

/** The script's own `alive()`: a process that answers EPERM is running under another user. */
function scriptAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code === 'EPERM'
  }
}

/**
 * Merge `builds` into the profile's top-level `onlyBuiltDependencies` list, the key pnpm 10+
 * reads for install-script approvals. Other keys, including the release-age exemption, are
 * left exactly as they are. Unfamiliar file shapes are left alone: pnpm's next write repairs them.
 * @param text - current `pnpm-workspace.yaml`, empty when the profile has none.
 * @param builds - approved package names.
 * @returns the updated file, or undefined when nothing needs to change.
 */
export function mergeApprovedBuilds(text: string, builds: readonly string[]): string | undefined {
  if (builds.length === 0) return undefined
  const lines = text.split('\n')
  let key = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === 'onlyBuiltDependencies:') {
      key = index
      break
    }
    // Inline arrays and shorthand are not pnpm's own output: leave them alone.
    if (/^onlyBuiltDependencies\s*:/.test(line)) return undefined
  }
  if (key === -1) {
    const head = text === '' || text.endsWith('\n') ? text : text + '\n'
    return head + 'onlyBuiltDependencies:\n' + builds.map((name) => '  - ' + yamlScalar(name)).join('\n') + '\n'
  }
  const kept: string[] = []
  let indent = '  '
  let index = key + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const written = /^([ \t]+)-[ \t]+\S/.exec(line)
    if (written === null) break
    indent = written[1] ?? indent
    kept.push(line)
  }
  const present = new Set(kept.map((line) => unquote(line.slice(line.indexOf('-') + 1).trim())))
  const added = builds.filter((name) => !present.has(name)).map((name) => indent + '- ' + yamlScalar(name))
  if (added.length === 0) return undefined
  return [...lines.slice(0, key + 1), ...kept, ...added, ...lines.slice(index)].join('\n')
}

/** `@` cannot start a plain YAML scalar, so a scoped name is quoted the way pnpm writes one. */
function yamlScalar(name: string): string {
  return name.startsWith('@') ? "'" + name.replaceAll("'", "''") + "'" : name
}

function unquote(entry: string): string {
  const first = entry.slice(0, 1)
  const last = entry.slice(-1)
  if ((first === "'" || first === '"') && last === first) return entry.slice(1, -1)
  return entry
}

/**
 * The detached script. Self-contained: the package it replaces may be gone by the
 * time it runs. On the desktop it uses the pnpm the app ships in `resources/runtime`
 * with the environment the plugin manager gives it; elsewhere (`dsh web`) the `pnpm`
 * on PATH.
 * The approval helpers below are embedded as their own source, so the script and the
 * tested functions cannot drift apart.
 */
const APPLY_SCRIPT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const jobFile = process.argv[2]
const dir = dirname(jobFile)
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
const log = (line) => appendFileSync(join(dir, 'apply.log'), new Date().toISOString() + ' ' + line + '\\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

${yamlScalar.toString()}

${unquote.toString()}

${mergeApprovedBuilds.toString()}

function pnpm() {
  const support = join(dirname(process.execPath), 'resources', 'runtime')
  const bundled = join(support, 'pnpm', 'bin', 'pnpm.mjs')
  if (existsSync(bundled)) {
    return {
      command: process.execPath,
      args: ['--expose-internals', bundled],
      shell: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: join(support, 'bin') + delimiter + (process.env.PATH ?? ''),
      },
    }
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { command: 'pnpm', args: [], shell: process.platform === 'win32', env }
}

log('waiting for process ' + job.parentPid + ' to exit before installing ' + job.spec)
while (alive(job.parentPid)) await sleep(500)
await sleep(1500)

// The status file marks this install as running before pnpm touches the profile, so a start
// during the install knows not to load the package being replaced. It goes away with the
// outcome: the pair is the whole state, and neither half is ever read alone.
writeFileSync(join(dir, 'status.json'), JSON.stringify({ phase: 'installing', spec: job.spec, pid: process.pid, startedAt: Date.now() }) + '\\n')
try {
  const approved = job.approvedBuilds ?? []
  if (approved.length > 0) {
    const file = join(job.profileDir, 'pnpm-workspace.yaml')
    const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const after = mergeApprovedBuilds(before, approved)
    if (after !== undefined) writeFileSync(file, after)
    log('approved builds: ' + approved.join(', '))
  }
} catch (error) {
  log('could not write approved builds: ' + String(error))
}

const { command, args, shell, env } = pnpm()
const argv = [...args, 'add', job.spec, '--save-exact', '--registry=' + job.registry]
let ok = false
let detail = ''
for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
  const run = spawnSync(command, argv, { cwd: job.profileDir, env, shell, encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000 })
  const output = (run.stdout ?? '') + (run.stderr ?? '') + (run.error ? String(run.error) : '')
  log('attempt ' + attempt + ' exited ' + run.status + '\\n' + output)
  ok = run.status === 0
  if (!ok) {
    detail = output.split('\\n').map((line) => line.trim()).find((line) => line.includes('ERR_PNPM_')) ?? output.trim().split('\\n').pop() ?? 'pnpm failed'
    await sleep(3000)
  }
}
writeFileSync(join(dir, 'result.json'), JSON.stringify({ spec: job.spec, ok, detail: detail.slice(0, 200) }) + '\\n')
rmSync(join(dir, 'status.json'), { force: true })
log(ok ? 'installed ' + job.spec : 'gave up on ' + job.spec)
`
