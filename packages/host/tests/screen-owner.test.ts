import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_PRESET, desktopToolDenial, screenOwnerId } from '../../computer-use/src/screen-owner.ts'
import { publishScreenOwner } from '../src/screen-owner.ts'

/**
 * The host publishes the owner and `@dsh-orb/computer-use` reads it. The two packages are separate
 * builds that cannot import each other, so each defines the `Symbol.for` key itself — which is
 * exactly the seam that can drift. These tests exercise both halves in one process, the way the orb
 * host and the preset's tool layer share it at runtime.
 */
describe('host screen-owner publication', () => {
  it('is read by the computer-use gate under the same process-global key', () => {
    try {
      // The host adopts every conversation the ball shows, so both are the ball's own.
      publishScreenOwner('session-a')
      assert.equal(screenOwnerId(), 'session-a')
      assert.equal(desktopToolDenial('session-a', 'click', BALL_PRESET), undefined)
      publishScreenOwner('session-b')
      publishScreenOwner('session-a')
      assert.ok(desktopToolDenial('session-b', 'click', BALL_PRESET))
      assert.ok(desktopToolDenial('session-b', 'bash', BALL_PRESET))
      // Coordination tools keep working for the background conversation.
      assert.equal(desktopToolDenial('session-b', 'code_agent', BALL_PRESET), undefined)
      assert.equal(desktopToolDenial('session-b', 'web_search', BALL_PRESET), undefined)
      // Nothing outside the ball is ever in scope, whatever conversation is on screen.
      assert.equal(desktopToolDenial('main-window-chat', 'bash', 'standard'), undefined)
      // Nor is a main-window chat that runs the ball's own preset: membership decides, not the preset.
      assert.equal(desktopToolDenial('main-window-chat', 'bash', BALL_PRESET), undefined)
      assert.equal(desktopToolDenial('never-adopted', 'bash', BALL_PRESET), undefined)
    } finally {
      publishScreenOwner(undefined)
    }
  })

  it('lifts every restriction when the ball is gone', () => {
    try {
      publishScreenOwner('session-a')
      assert.ok(desktopToolDenial('session-b', 'click', BALL_PRESET))
      publishScreenOwner(undefined)
      assert.equal(screenOwnerId(), undefined)
      assert.equal(desktopToolDenial('session-b', 'click', BALL_PRESET), undefined)
    } finally {
      publishScreenOwner(undefined)
    }
  })
})
