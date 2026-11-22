import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionState } from '../src/session-state.ts'

test('the lock probe answers instead of throwing', async () => {
  const state = await sessionState()
  assert.equal(typeof state.locked, 'boolean')
  assert.equal(typeof state.unknown, 'boolean')
  // It must never claim "unlocked" when it could not decide.
  assert.equal(state.locked && state.unknown, false)
})

test('a failed probe is reported as unknown, never as unlocked-and-fine', async () => {
  const state = await sessionState()
  if (state.unknown) assert.equal(state.locked, false)
})
