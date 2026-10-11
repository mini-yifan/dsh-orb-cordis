import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { expectedHash, isLockTaken, lockExpired, PINNED_SHA256, withDownloadLock } from '../src/electron-runtime.ts'

const fileName = 'electron-v44.0.0-darwin-arm64.zip'

const root = mkdtempSync(join(tmpdir(), 'orb-download-lock-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const lockName = 'electron-runtime.download.lock'

let counter = 0
function parent(): string {
  counter += 1
  const dir = join(root, `parent-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A pid that is certainly gone: spawnSync waited for it to exit. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(child.status, 0)
  return child.pid
}

function staleLock(dir: string, owner: string | undefined, ageMs = 0): string {
  const lock = join(dir, lockName)
  mkdirSync(lock, { recursive: true })
  if (owner !== undefined) writeFileSync(join(lock, 'owner'), owner)
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    utimesSync(lock, past, past)
  }
  return lock
}

describe('Electron checksum pin', () => {
  it('accepts a checksum list that matches the pinned hash', () => {
    const pinned = PINNED_SHA256[fileName]
    assert.equal(expectedHash(`${pinned} *${fileName}\n`, fileName), pinned)
  })

  it('rejects a checksum list that disagrees with the pin', () => {
    const other = 'a'.repeat(64)
    assert.throws(
      () => expectedHash(`${other} *${fileName}\n`, fileName),
      /does not match the pinned hash/,
    )
  })

  it('rejects a file that was never pinned', () => {
    assert.throws(
      () => expectedHash(`${'b'.repeat(64)} *electron-v44.0.0-freebsd-x64.zip\n`, 'electron-v44.0.0-freebsd-x64.zip'),
      /no pinned Electron/,
    )
  })
})

describe('Electron download lock', () => {
  it('appears with its owner already inside and is released after the task', async () => {
    const dir = parent()
    const lock = join(dir, lockName)
    await withDownloadLock(dir, async () => {
      const owner = readFileSync(join(lock, 'owner'), 'utf8')
      assert.equal(Number(owner.split('\n')[0]), process.pid)
    })
    assert.equal(existsSync(lock), false)
  })

  it('never runs two acquisitions at once', async () => {
    const dir = parent()
    const order: string[] = []
    let concurrent = 0
    let peak = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withDownloadLock(dir, async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      order.push('first')
      await gate
      concurrent -= 1
    })
    const second = withDownloadLock(dir, async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      order.push('second')
      concurrent -= 1
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Whoever renamed its staging directory first holds the lock; the other waits, and the
    // lock only ever appears with its owner inside, so neither can take the other's lock.
    assert.equal(peak, 1, 'the second waiter does not run beside the holder')
    release()
    await Promise.all([first, second])
    assert.deepEqual([...order].sort(), ['first', 'second'])
  })

  it('takes over a lock whose owner is gone, and keeps one whose owner lives', async () => {
    const dead = parent()
    staleLock(dead, `${deadPid()}\n${Date.now()}\n`)
    let ran = false
    await withDownloadLock(dead, async () => { ran = true })
    assert.equal(ran, true, 'a dead owner cannot hold the lock')

    const live = parent()
    assert.equal(await lockExpired(staleLock(live, `${process.pid}\n${Date.now()}\n`)), false)
  })

  it('collects an owner-less lock only once the directory is old', async () => {
    const fresh = parent()
    const freshLock = staleLock(fresh, undefined)
    assert.equal(await lockExpired(freshLock), false, 'a lock being made cannot be swept')

    const old = parent()
    const oldLock = staleLock(old, undefined, 40_000)
    assert.equal(await lockExpired(oldLock), true)
  })

  it('treats EPERM from the liveness probe as a live owner', async () => {
    const dir = parent()
    const lock = staleLock(dir, `${process.pid}\n${Date.now()}\n`)
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    const probe = mock.method(process, 'kill', () => { throw denied })
    try {
      assert.equal(await lockExpired(lock), false)
    } finally {
      probe.mock.restore()
    }
  })

  it('reads every rename refusal as a held lock, and a real failure as an error', () => {
    // Windows refuses a directory-over-directory rename with EPERM or EACCES rather than
    // the POSIX EEXIST/ENOTEMPTY; all four mean someone else holds the lock.
    for (const code of ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']) {
      assert.equal(isLockTaken(Object.assign(new Error('taken'), { code })), true, code)
    }
    for (const code of ['ENOSPC', 'EISDIR', 'ENOENT']) {
      assert.equal(isLockTaken(Object.assign(new Error('real failure'), { code })), false, code)
    }
    assert.equal(isLockTaken(new Error('no code')), false)
    assert.equal(isLockTaken(undefined), false)
  })
})
