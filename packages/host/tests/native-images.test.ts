import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KOFFI_DIR_ENV, mappedImages, ownPackageRoot, removeStaleStages, requireKoffi, stageKoffi } from '../src/native-images.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-native-'))
after(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Windows keeps the koffi copy this process loaded until it exits.
  }
})

/** The workspace's koffi folder; its `node_modules` parent also holds the `@koromix` prebuilds. */
const workspaceKoffi = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'koffi'))

let counter = 0
/** An installed package as the profile holds it: `node_modules/dsh-orb` with koffi vendored inside. */
function installedPackage(): string {
  counter += 1
  const pkg = join(root, `profile-${counter}`, 'node_modules', 'dsh-orb')
  cpSync(workspaceKoffi, join(pkg, 'node_modules', 'koffi'), { recursive: true, dereference: true })
  const prebuilds = join(dirname(workspaceKoffi), '@koromix')
  if (existsSync(prebuilds)) cpSync(prebuilds, join(pkg, 'node_modules', '@koromix'), { recursive: true, dereference: true })
  writeFileSync(join(pkg, 'package.json'), '{"name":"dsh-orb","version":"0.1.0"}\n')
  return pkg
}

/** A process holding koffi loaded from `koffiDir`, until it is killed. */
async function holdKoffi(koffiDir: string): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(koffiDir)}); console.log('loaded'); setInterval(() => {}, 1000)`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => { resolve() })
    child.once('exit', (code) => { reject(new Error(`koffi holder exited ${code}`)) })
  })
  return {
    stop: () => new Promise<void>((resolve) => {
      child.removeAllListeners('exit')
      child.once('exit', () => { resolve() })
      child.kill()
    }),
  }
}

describe('koffi staging', () => {
  it('copies koffi and its prebuilds out of the package once per version', () => {
    const pkg = installedPackage()
    const cache = join(root, 'cache-copy')
    const version = (JSON.parse(readFileSync(join(pkg, 'node_modules', 'koffi', 'package.json'), 'utf8')) as { version: string }).version
    const staged = stageKoffi(pkg, cache)
    assert.equal(staged, join(cache, `koffi-${version}`))
    assert.ok(existsSync(join(staged, 'node_modules', 'koffi', 'package.json')))
    assert.ok(existsSync(join(staged, '.ready')))
    rmSync(join(staged, 'node_modules', 'koffi', 'package.json'))
    assert.equal(stageKoffi(pkg, cache), staged, 'a finished copy is reused, not rewritten')
    assert.equal(existsSync(join(staged, 'node_modules', 'koffi', 'package.json')), false)
  })

  it('stages nothing for a package without koffi', () => {
    const pkg = join(root, 'bare', 'node_modules', 'dsh-orb')
    mkdirSync(pkg, { recursive: true })
    assert.equal(stageKoffi(pkg, join(root, 'cache-bare')), undefined)
  })

  it('loads koffi from the staged copy the environment names', () => {
    const staged = stageKoffi(installedPackage(), join(root, 'cache-load'))
    assert.ok(staged !== undefined)
    const previous = process.env[KOFFI_DIR_ENV]
    process.env[KOFFI_DIR_ENV] = staged
    try {
      const koffi = requireKoffi<{ load: unknown }>(import.meta.url)
      assert.equal(typeof koffi.load, 'function')
    } finally {
      if (previous === undefined) delete process.env[KOFFI_DIR_ENV]
      else process.env[KOFFI_DIR_ENV] = previous
    }
  })

  it('resolves the package root two levels above the built host', () => {
    const url = new URL('file:///C:/p/node_modules/dsh-orb/dist/host/index.js')
    assert.equal(ownPackageRoot(url.href), fileURLToPath(new URL('file:///C:/p/node_modules/dsh-orb')))
  })
})

/**
 * The desktop's Electron runtime, which runs pnpm and this host. Its Node cannot delete a
 * link to a mapped image, while a standalone Node 24.21 can, so the lock only shows when
 * the probe runs under it. `DSH_ORB_TEST_ELECTRON` points at another install.
 */
function desktopRuntime(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const configured = process.env.DSH_ORB_TEST_ELECTRON
  if (configured !== undefined && configured !== '') return configured
  const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  return existsSync(installed) ? installed : undefined
}

/** {@link mappedImages} as the desktop runtime sees it. */
function probeOnDesktop(runtime: string, pkg: string): Promise<string[]> {
  const module = new URL('../src/native-images.ts', import.meta.url).href
  const child = spawn(runtime, [
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(module)}); console.log(JSON.stringify(m.mappedImages(process.argv[1])))`,
    pkg,
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
  const out: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`probe exited ${code}`))
      resolve(JSON.parse(Buffer.concat(out).toString('utf8').trim()) as string[])
    })
  })
}

const runtime = desktopRuntime()

describe('mapped image probe', () => {
  it('finds nothing to block a package no process has loaded', () => {
    assert.deepEqual(mappedImages(installedPackage()), [])
  })

  it('names the addon a running process loaded from inside the package, and only that one', { skip: runtime === undefined }, async () => {
    const pkg = installedPackage()
    const holder = await holdKoffi(join(pkg, 'node_modules', 'koffi'))
    try {
      const mapped = await probeOnDesktop(runtime ?? '', pkg)
      assert.equal(mapped.length, 1, `mapped: ${mapped.join(', ')}`)
      assert.match(mapped[0] ?? '', /win32_x64[\\/]koffi\.node$/)
    } finally {
      await holder.stop()
    }
    assert.deepEqual(await probeOnDesktop(runtime ?? '', pkg), [], 'the lock goes with the process')
  })

  it('leaves the package free while koffi runs from the staged copy', { skip: runtime === undefined }, async () => {
    const pkg = installedPackage()
    const staged = stageKoffi(pkg, join(root, 'cache-free'))
    assert.ok(staged !== undefined)
    const holder = await holdKoffi(join(staged, 'node_modules', 'koffi'))
    try {
      assert.deepEqual(await probeOnDesktop(runtime ?? '', pkg), [])
    } finally {
      await holder.stop()
    }
  })
})

describe('stale stage cleanup', () => {
  it('removes old pnpm staging folders beside the package and keeps young ones', () => {
    const pkg = installedPackage()
    const parent = dirname(pkg)
    const old = join(parent, 'dsh-orb_tmp_123_1')
    const young = join(parent, 'dsh-orb_tmp_456_1')
    const other = join(parent, 'zod_tmp_789_1')
    for (const dir of [old, young, other]) mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(old, hourAgo, hourAgo)
    utimesSync(other, hourAgo, hourAgo)
    removeStaleStages(pkg)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(young), true, 'an install may still be using it')
    assert.equal(existsSync(other), true, 'another package is not ours to touch')
    assert.equal(existsSync(pkg), true)
  })

  it('touches nothing outside a node_modules folder', () => {
    const pkg = join(root, 'checkout', 'dsh-orb')
    const sibling = join(root, 'checkout', 'dsh-orb_tmp_1_1')
    mkdirSync(pkg, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    removeStaleStages(pkg, Date.now() + 24 * 60 * 60 * 1000)
    assert.equal(existsSync(sibling), true)
  })
})
