import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCREEN_BUSY_MESSAGE, screenLockOwner, withScreenLock } from '../src/gui-lock.ts'

const SCREEN_LOCK = Symbol.for('dsh-orb.gui-lock')

/** Clear the shared record so tests do not leak into each other. */
function reset(): void {
  delete (globalThis as { [SCREEN_LOCK]?: unknown })[SCREEN_LOCK]
}

test('an idle screen is free', () => {
  reset()
  assert.equal(screenLockOwner(), undefined)
})

test('a lock held by another session refuses the click', async () => {
  reset()
  const holder = globalThis as { [SCREEN_LOCK]?: { held: boolean, owner: unknown } }
  // Stand in for a Computer Use session holding the shared lock.
  holder[SCREEN_LOCK] = { held: true, owner: 'computer-use-agent' }
  assert.equal(screenLockOwner(), 'computer-use-agent')
  let ran = false
  await assert.rejects(
    () => withScreenLock('desktop-agent', async () => { ran = true }),
    new RegExp(SCREEN_BUSY_MESSAGE.slice(0, 40)),
  )
  assert.equal(ran, false, 'the input must not be delivered when the screen is taken')
})

test('the holder may re-enter its own lock', async () => {
  reset()
  const value = await withScreenLock('agent-1', async () =>
    await withScreenLock('agent-1', async () => 'inner'))
  assert.equal(value, 'inner')
})

test('the lock is released even when the input throws', async () => {
  reset()
  await assert.rejects(() => withScreenLock('agent-1', async () => { throw new Error('boom') }), /boom/)
  assert.equal(screenLockOwner(), undefined, 'a failed click must not leave the screen locked')
})

test('the lock is released on success', async () => {
  reset()
  await withScreenLock('agent-1', async () => 'ok')
  assert.equal(screenLockOwner(), undefined)
})

test('an unidentified caller still cannot interleave with a holder', async () => {
  reset()
  const holder = globalThis as { [SCREEN_LOCK]?: { held: boolean, owner: unknown } }
  holder[SCREEN_LOCK] = { held: true, owner: 'someone' }
  await assert.rejects(() => withScreenLock(undefined, async () => 'nope'))
})
