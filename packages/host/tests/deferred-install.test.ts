import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFERRED_INSTALL_CEILING_MS,
  deferredDir,
  deferredInstallInProgress,
  mergeApprovedBuilds,
  scheduleInstallAfterExit,
  takeDeferredOutcome,
  type DeferredInstall,
} from '../src/deferred-install.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-deferred-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

let counter = 0
function profile(): string {
  counter += 1
  const dir = join(root, `profile-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function statusFile(dir: string, spec: string, pid: number, startedAt: number): void {
  mkdirSync(deferredDir(dir), { recursive: true })
  writeFileSync(join(deferredDir(dir), 'status.json'), JSON.stringify({ phase: 'installing', spec, pid, startedAt }))
}

/** A pid that is certainly gone: spawnSync waited for it to exit. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(child.status, 0)
  return child.pid
}

describe('release-age exemption and build approvals share the workspace file', () => {
  it('adds a top-level onlyBuiltDependencies list, keeping the release-age key', () => {
    const before = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n'
    assert.equal(
      mergeApprovedBuilds(before, ['koffi']),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\nonlyBuiltDependencies:\n  - koffi\n',
    )
  })

  it('creates the file for a profile that has none, and appends to an existing list', () => {
    assert.equal(mergeApprovedBuilds('', ['koffi']), 'onlyBuiltDependencies:\n  - koffi\n')
    assert.equal(
      mergeApprovedBuilds('onlyBuiltDependencies:\n  - zod\n', ['koffi']),
      'onlyBuiltDependencies:\n  - zod\n  - koffi\n',
    )
    // Already approved: nothing to write.
    assert.equal(mergeApprovedBuilds('onlyBuiltDependencies:\n  - koffi\n', ['koffi']), undefined)
  })

  it('writes nothing for an empty approval list and leaves unfamiliar shapes alone', () => {
    assert.equal(mergeApprovedBuilds('packages:\n  - .\n', []), undefined)
    assert.equal(mergeApprovedBuilds('onlyBuiltDependencies: [koffi]\n', ['zod']), undefined)
  })
})

describe('the after-exit script', () => {
  it('marks the install as running before pnpm starts, and swaps that for the outcome', async () => {
    const dir = profile()
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    // Stands in for pnpm: records whether the status file was already in place.
    const fake = join(bin, 'pnpm')
    writeFileSync(fake, '#!/bin/sh\n'
      + 'if [ -f .dsh-orb-update/status.json ]; then echo present > .dsh-orb-update/pnpm-saw-status.txt; '
      + 'else echo absent > .dsh-orb-update/pnpm-saw-status.txt; fi\n'
      + 'exit 0\n')
    chmodSync(fake, 0o755)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n')
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    const job: DeferredInstall = {
      profileDir: dir,
      spec: 'dsh-orb@0.2.0',
      registry: 'https://registry.npmmirror.com',
      parentPid: deadPid(),
      approvedBuilds: ['koffi'],
    }
    try {
      scheduleInstallAfterExit(job)
      const result = join(deferredDir(dir), 'result.json')
      const deadline = Date.now() + 30_000
      while (!existsSync(result) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      assert.ok(existsSync(result), 'the script writes its outcome')
      assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), { spec: 'dsh-orb@0.2.0', ok: true, detail: '' })
      assert.equal(existsSync(join(deferredDir(dir), 'status.json')), false, 'the status goes away with the outcome')
      assert.equal(
        readFileSync(join(deferredDir(dir), 'pnpm-saw-status.txt'), 'utf8').trim(),
        'present',
        'pnpm only ever runs while the install is marked as running',
      )
      assert.equal(
        readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
        'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\nonlyBuiltDependencies:\n  - koffi\n',
      )
      const outcome = takeDeferredOutcome(dir)
      assert.equal(outcome?.ok, true)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})

describe('install-in-progress detection', () => {
  it('is true while the script runs and false once its outcome lands', () => {
    const dir = profile()
    assert.equal(deferredInstallInProgress(dir), false, 'nothing scheduled')
    statusFile(dir, 'dsh-orb@0.2.0', process.pid, Date.now())
    assert.equal(deferredInstallInProgress(dir), true)
    writeFileSync(join(deferredDir(dir), 'result.json'), JSON.stringify({ spec: 'dsh-orb@0.2.0', ok: true, detail: '' }))
    assert.equal(deferredInstallInProgress(dir), false)
  })

  it('keeps trusting a young status whose script is gone, and collects an old one as failed', () => {
    const dir = profile()
    statusFile(dir, 'dsh-orb@0.2.0', deadPid(), Date.now())
    assert.equal(deferredInstallInProgress(dir), true, 'a fresh status is trusted while the script may still fork')

    const stale = profile()
    const old = join(deferredDir(stale), 'status.json')
    statusFile(stale, 'dsh-orb@0.3.0', deadPid(), Date.now() - DEFERRED_INSTALL_CEILING_MS - 1000)
    const past = new Date(Date.now() - DEFERRED_INSTALL_CEILING_MS - 1000)
    utimesSync(old, past, past)
    assert.equal(deferredInstallInProgress(stale), false, 'past its own ceiling the leftover is collected')
    assert.equal(existsSync(old), false)
    assert.deepEqual(takeDeferredOutcome(stale), {
      spec: 'dsh-orb@0.3.0',
      ok: false,
      detail: 'deferred-install-stalled',
    })
  })
})
