/**
 * An update that has to wait until this process exits.
 * When a native image inside the package is still mapped (see `native-images.ts`),
 * asking pnpm to replace the package now would fail and take the live package
 * apart. The update is handed to a small detached script outside the package
 * instead: it waits for this process to exit, then runs the same pnpm the
 * official plugin manager uses. Its outcome is read back at the next start.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What the detached script installs, and whose exit it waits for. */
export interface DeferredInstall {
  readonly profileDir: string
  readonly spec: string
  readonly registry: string
  readonly parentPid: number
}

/** How the last deferred install ended. */
export interface DeferredOutcome {
  readonly spec: string
  readonly ok: boolean
  readonly detail: string
}

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
 * The detached script. Self-contained: the package it replaces may be gone by the
 * time it runs. On the desktop it uses the pnpm the app ships in `resources/runtime`
 * with the environment the plugin manager gives it; elsewhere (`dsh web`) the `pnpm`
 * on PATH.
 */
const APPLY_SCRIPT = `import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
log(ok ? 'installed ' + job.spec : 'gave up on ' + job.spec)
`
