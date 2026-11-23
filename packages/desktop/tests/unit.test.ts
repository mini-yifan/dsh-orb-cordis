import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { actionText, denialText, failureText } from '../src/errors.ts'
import { RefBook } from '../src/sessions.ts'
import { agentSessionId } from '../src/sessions.ts'
import type { SnapshotData } from '../src/protocol.ts'

test('config fills every default', () => {
  const resolved = resolveConfig()
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.raiseMaxMs, 90_000)
  assert.equal(resolved.idleCloseMs, 600_000)
})

test('config rejects impossible values', () => {
  assert.throws(() => resolveConfig({ raiseMaxMs: 0 }), /raiseMaxMs/)
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

test('failure text surfaces structured error.details checks and occluder', () => {
  const text = failureText({
    code: 'TIMEOUT',
    message: 'Target did not become actionable',
    resultCode: -9,
    details: {
      kind: 'actionability_timeout',
      retryable: false,
      last_report: {
        checks: [
          { check: 'visible', status: 'pass' },
          { check: 'enabled', status: 'fail', reason: 'readonly control' },
        ],
      },
      occluder: { role: 'sheet', name: 'Confirm' },
    },
  })
  assert.match(text, /details: kind=actionability_timeout/)
  assert.match(text, /failed checks: enabled \(readonly control\)/)
  assert.match(text, /occluder=sheet "Confirm"/)
  assert.match(text, /retryable=false/)
})

test('the ref book preserves depth, merges root drills, and registers find refs', () => {
  const book = new RefBook()
  const base: SnapshotData = {
    app: '系统设置',
    windowId: 'w-10',
    snapshotId: 's1',
    refCount: 2,
    complete: true,
    tree: { role: 'window' },
  }
  book.remember(base, ['@s1:e1'], new Map([['@s1:e1', { role: 'outline', name: '边栏' }]]), { depth: 16, interactive: false })
  book.remember(base, ['@s1:e20'], new Map([['@s1:e20', { role: 'combobox', name: '默认网页浏览器', states: ['readonly'] }]]), { merge: true })
  assert.equal(book.lookup('@s1:e1')?.known, true, 'outer ref stays valid after root merge')
  assert.equal(book.lookup('@s1:e20')?.known, true)
  assert.equal(book.lookup('@s1:e20')?.depth, 16)
  assert.equal(book.lookup('@s1:e20')?.interactive, false)
  assert.deepEqual(book.lookup('@s1:e20')?.states, ['readonly'])

  book.rememberFind(
    { app: 'QQ', snapshotId: 's_find', windowId: 'w-99' },
    [{ ref: '@s_find:e52', role: 'button', name: '我的手机' }, { role: 'statictext', name: '纯文本' }],
  )
  assert.equal(book.lookup('@s_find:e52')?.known, true)
  assert.equal(book.lookup('@s_find:e52')?.windowId, 'w-99')
})
