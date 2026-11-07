import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { actionText, denialText, failureText } from '../src/errors.ts'
import { chooseWindow } from '../src/frame.ts'
import { RefBook } from '../src/sessions.ts'
import { agentSessionId } from '../src/sessions.ts'
import type { SnapshotData } from '../src/protocol.ts'

test('config fills every default', () => {
  const resolved = resolveConfig()
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.frameHoldMs, 4_000)
  assert.equal(resolved.raiseMaxMs, 90_000)
  assert.equal(resolved.idleCloseMs, 600_000)
})

test('config rejects impossible values', () => {
  assert.throws(() => resolveConfig({ frameHoldMs: 0 }), /frameHoldMs/)
  assert.throws(() => resolveConfig({ maxNodes: Number.NaN }), /maxNodes/)
})

test('failure text always names a next step', () => {
  const text = failureText({ code: 'STALE_REF', message: 'gone', resultCode: -6 })
  assert.match(text, /^STALE_REF: gone\nnext: /)
})

test('unsafe delivery warns against repeating', () => {
  const text = failureText({
    code: 'ACTION_FAILED',
    message: 'partial',
    resultCode: -4,
    delivery: 'delivery_uncertain',
    retry: 'unsafe',
  })
  assert.match(text, /may already have landed/)
})

test('guard refusals keep their code', () => {
  const text = denialText({ code: 'USER_IN_USE', message: 'in use', suggestion: 'back off' })
  assert.match(text, /^USER_IN_USE: in use\nnext: back off/)
})

test('action text reports delivery and the unverified warning', () => {
  const text = actionText({ action: 'click', ref_id: '@s1:e2', disposition: { delivery: 'delivered_unverified' } })
  assert.match(text, /ok · click · @s1:e2 · delivery=delivered_unverified/)
  assert.match(text, /Read the state again/)
})

test('the ref book only accepts refs it rendered', () => {
  const book = new RefBook()
  const snapshot: SnapshotData = {
    app: 'Notes',
    snapshotId: 's1',
    refCount: 2,
    complete: true,
    tree: { role: 'window' },
  }
  book.remember(snapshot, ['@s1:e1', '@s1:e2'])
  assert.deepEqual(book.lookup('@s1:e1'), { app: 'Notes', known: true })
  assert.deepEqual(book.lookup('@s1:e9'), { app: 'Notes', known: false })
  assert.equal(book.lookup('@other:e1'), undefined)
  assert.equal(book.lookup('not-a-ref'), undefined)
})

test('session ids are sanitized into the library charset', () => {
  assert.match(agentSessionId('session/abc.def'), /^dsh_[A-Za-z0-9_-]{1,60}$/)
  assert.ok(agentSessionId('x'.repeat(200)).length <= 64)
  assert.equal(agentSessionId(''), 'dsh_session')
})

const win = (id: string, title: string, width: number, height: number, x = 0, y = 0) => ({
  id,
  title,
  appName: '微信',
  pid: 1,
  focused: false,
  bounds: { x, y, width, height },
})

test('window choice skips menu-bar strips and tooltips', () => {
  const picked = chooseWindow([
    win('w-1', '微信', 1470, 33),
    win('w-2', '微信', 100, 58),
    win('w-3', '微信', 1470, 846),
  ], {})
  assert.equal(picked?.id, 'w-3')
})

test('window choice prefers the id the snapshot read', () => {
  const picked = chooseWindow([
    win('w-1', '微信', 1470, 846),
    win('w-2', '文件预览.pdf', 1470, 832),
  ], { windowId: 'w-2' })
  assert.equal(picked?.id, 'w-2')
})

test('window choice falls back to the title, then the largest', () => {
  const byTitle = chooseWindow([
    win('w-1', '微信', 1470, 846),
    win('w-2', '预览', 800, 600),
  ], { windowId: 'missing', windowTitle: '预览' })
  assert.equal(byTitle?.id, 'w-2')
  const largest = chooseWindow([win('a', 'x', 800, 600), win('b', 'y', 1200, 700)], {})
  assert.equal(largest?.id, 'b')
})

test('window choice refuses when nothing is big enough to frame', () => {
  assert.equal(chooseWindow([win('w-1', '微信', 1470, 33)], {}), undefined)
  assert.equal(chooseWindow([], {}), undefined)
})
