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

test('headless control of a background app is allowed', () => {
  const decision = decideMutation({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Word',
    idleMs: 100,
    raised: undefined,
    leaseHolder: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, true)
})

test('the app the user is working in is refused', () => {
  const decision = decideMutation({
    app: 'Word',
    owner: 's1',
    frontmost: 'Word',
    idleMs: 500,
    raised: undefined,
    leaseHolder: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'USER_IN_USE')
})

test('a frontmost app is operable once the user has been away', () => {
  const decision = decideMutation({
    app: 'Word',
    owner: 's1',
    frontmost: 'Word',
    idleMs: config.presentMs + 1,
    raised: undefined,
    leaseHolder: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, true)
})

test('a borrowed window is dropped the moment the user touches anything', () => {
  markRaised('Excel', 's1', 'Word', config)
  assert.equal(raisedApp()?.app, 'Excel')
  const decision = decideMutation({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Excel',
    idleMs: 10,
    raised: raisedApp(),
    leaseHolder: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'USER_ACTIVE')
})

test('a borrowed window is operable while the user stays idle', () => {
  markRaised('Excel', 's1', 'Word', config)
  const decision = decideMutation({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Excel',
    idleMs: 5000,
    raised: raisedApp(),
    leaseHolder: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, true)
})

test('another session cannot operate a leased app', () => {
  assert.equal(acquireLease('Excel', 's1', config), true)
  assert.equal(leaseOwner('Excel', config), 's1')
  const decision = decideMutation({
    app: 'Excel',
    owner: 's2',
    frontmost: 'Word',
    idleMs: 5000,
    raised: undefined,
    leaseHolder: leaseOwner('Excel', config),
    screenLockOwner: undefined,
    config,
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
    frontmost: 'Excel',
    idleMs: 60_000,
    raised: undefined,
    leaseHolder: undefined,
    screenLockOwner: 'other-agent',
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'SCREEN_BUSY')
})

test('raising is refused while the user types', () => {
  const decision = decideRaise({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Word',
    idleMs: 100,
    raised: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'USER_ACTIVE')
})

test('raising is refused when the user is reading that app', () => {
  const decision = decideRaise({
    app: 'Word',
    owner: 's1',
    frontmost: 'Word',
    idleMs: 5000,
    raised: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'USER_IN_USE')
})

test('raising is allowed after the user goes quiet', () => {
  const decision = decideRaise({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Word',
    idleMs: 5000,
    raised: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, true)
})

test('raising is refused when presence is unknown', () => {
  const decision = decideRaise({
    app: 'Excel',
    owner: 's1',
    frontmost: 'Word',
    idleMs: undefined,
    raised: undefined,
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'PRESENCE_UNKNOWN')
})

test('only one session may borrow the foreground', () => {
  markRaised('Excel', 's1', 'Word', config)
  const decision = decideRaise({
    app: 'Numbers',
    owner: 's2',
    frontmost: 'Excel',
    idleMs: 5000,
    raised: raisedApp(),
    screenLockOwner: undefined,
    config,
  })
  assert.equal(decision.allow, false)
  if (!decision.allow) assert.equal(decision.code, 'SCREEN_BUSY')
})