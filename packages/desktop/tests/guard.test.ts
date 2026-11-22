import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  DEFAULT_GUARD_CONFIG,
  acquireLease,
  decideMutation,
  decideRaise,
  guardState,
  leaseOwner,
  markRaised,
  raisedApp,
  releaseLease,
} from '../src/guard.ts'

const config = DEFAULT_GUARD_CONFIG

beforeEach(() => {
  const state = guardState()
  state.leases.clear()
  state.raised = undefined
})

test('a background app is operable', () => {
  const decision = decideMutation({
    app: 'Excel',
    owner: 's1',
    leaseHolder: undefined,
    screenLockOwner: undefined,
  })
  assert.equal(decision.allow, true)
})

test('the app the user is working in is operable too: the ribbon says who is acting', () => {
  const decision = decideMutation({
    app: 'WeChat',
    owner: 's1',
    leaseHolder: undefined,
    screenLockOwner: undefined,
  })
  assert.equal(decision.allow, true)
})

test('another session cannot operate a leased app', () => {
  assert.equal(acquireLease('Excel', 's1', config), true)
  assert.equal(leaseOwner('Excel', config), 's1')
  const decision = decideMutation({
    app: 'Excel',
    owner: 's2',
    leaseHolder: leaseOwner('Excel', config),
    screenLockOwner: undefined,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'APP_BUSY')
  releaseLease('Excel', 's1')
  assert.equal(leaseOwner('Excel', config), undefined)
})

test('the foreground agent holding the physical lock blocks background input', () => {
  const decision = decideMutation({
    app: 'Excel',
    owner: 's1',
    leaseHolder: undefined,
    screenLockOwner: 'other-agent',
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'SCREEN_BUSY')
})

test('raising is allowed even while the user types: the window is framed, not hidden', () => {
  const decision = decideRaise({
    app: 'Excel',
    owner: 's1',
    raised: undefined,
    screenLockOwner: undefined,
  })
  assert.equal(decision.allow, true)
})

test('only one session may borrow the foreground', () => {
  markRaised('Excel', 's1', 'Word', config)
  assert.equal(raisedApp()?.app, 'Excel')
  const decision = decideRaise({
    app: 'Numbers',
    owner: 's2',
    raised: raisedApp(),
    screenLockOwner: undefined,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'SCREEN_BUSY')
})

test('the foreground lock also blocks borrowing the foreground', () => {
  const decision = decideRaise({
    app: 'Excel',
    owner: 's1',
    raised: undefined,
    screenLockOwner: 'other-agent',
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'SCREEN_BUSY')
})

test('a borrowed foreground expires instead of pinning the screen forever', () => {
  const raised = markRaised('Excel', 's1', 'Word', config)
  assert.ok(raised.deadline > raised.at)
})

test('an expired raise is forgotten on the next read', () => {
  const state = guardState()
  state.raised = { app: 'Excel', owner: 's1', at: 0, deadline: 1 }
  assert.equal(raisedApp(), undefined)
})