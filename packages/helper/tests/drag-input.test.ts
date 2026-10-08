import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Windows drag regressions: the ball has to follow the cursor exactly and the
 * panel must not open or close while a gesture is in flight. These contracts live
 * in the page script, so they are asserted against the source.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
/** Comments may discuss the old input path; only executable code is asserted on. */
const code = shell.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')

describe('floating ball drag input', () => {
  it('derives the drag position from the applied window origin plus client offsets', () => {
    // `screenX` is computed from the window origin Chromium has cached, so while the
    // ball is being moved under the cursor it goes stale and the drag jumps.
    assert.doesNotMatch(code, /\bscreen[XY]\b/)
    assert.match(shell, /api\.origin\(\)/)
    assert.match(shell, /x: base\.x \+ point\.x - grab\.x, y: base\.y \+ point\.y - grab\.y/)
    assert.match(preload, /origin\(\) \{\s*\n\s*return ipcRenderer\.invoke\('orb:origin'\)/)
  })

  it('measures the drag threshold from the press point', () => {
    assert.match(shell, /Math\.hypot\(event\.clientX - grabAt\.x, event\.clientY - grabAt\.y\) <= 4/)
  })

  it('ignores enter and leave while a button is held', () => {
    // An enter that lands mid-gesture used to run setExpanded(true): the window grew
    // to panel size around the ball and collapsed again, which reads as a jump.
    assert.match(shell, /function syncExpand\(\) \{\s*\n\s*if \(pointerHeld \|\| dragging \|\| collapsing\) return/)
    assert.match(shell, /pointerenter[\s\S]{0,800}syncExpand\(\)/)
    assert.match(shell, /pointerleave[\s\S]{0,300}if \(pointerHeld\) return/)
    // A dropped pointerup must not leave the flags stuck: a fresh enter that
    // reports no button down reconciles the gesture.
    assert.match(shell, /if \(pointerHeld && typeof event\.buttons === 'number' && event\.buttons === 0\) releaseDrag\(\)/)
  })

  it('leaves the hover decision to the helper poll when the preload offers one', () => {
    // The window is FIXED_WINDOW_SIZE in every state, so `pointerenter` fires for every
    // pixel of transparent chrome around the ball. Expanding from it would pop the panel
    // open on a pointer that never touched the ball, so the renderer only expands when the
    // helper is not driving hover; the main process decides from the OS cursor instead.
    assert.match(shell, /const helperDrivesHover = typeof api\.onHoverRequest === 'function'/)
    assert.match(shell, /if \(helperDrivesHover\) return\s*\n\s*syncExpand\(\)/)
    assert.match(shell, /if \(typeof api\.onHoverRequest === 'function'\) api\.onHoverRequest\(/)
    assert.match(shell, /if \(typeof api\.onLeaveRequest === 'function'\) api\.onLeaveRequest\(/)
    // And the helper side asks through those same channels.
    assert.match(shell, /function requestExpandFromHelper\(\)/)
    assert.match(shell, /function requestCollapseFromHelper\(\)/)
  })

  it('coalesces moves so one frame cannot queue several IPC round-trips', async () => {
    assert.match(shell, /pendingOrigin = \{ x, y, grab: grab_ \?\? dragGrab\(\) \}\s*\n\s*if \(moveRequest\) return/)
    assert.match(shell, /while \(pendingOrigin !== undefined\)/)
    // The collapse that starts a drag must flush the newest position, not the one
    // that crossed the threshold, and must not fire into a later gesture.
    assert.match(shell, /void moveBallWhenIdle\(\)/)
    assert.match(shell, /if \(session !== dragSession \|\| pendingOrigin === undefined\) return/)

    // Behaviour: five moves while one round-trip is in flight cost two calls and
    // the last call carries the newest position.
    const sent: { x: number; y: number }[] = []
    let pendingOrigin: { x: number; y: number } | undefined
    let moveRequest = false
    async function moveBall(x: number, y: number): Promise<void> {
      pendingOrigin = { x, y }
      if (moveRequest) return
      moveRequest = true
      try {
        while (pendingOrigin !== undefined) {
          const next = pendingOrigin
          pendingOrigin = undefined
          sent.push(next)
          await Promise.resolve()
        }
      } finally {
        moveRequest = false
        pendingOrigin = undefined
      }
    }
    await Promise.all([moveBall(1, 1), moveBall(2, 2), moveBall(3, 3), moveBall(4, 4), moveBall(5, 5)])
    assert.deepEqual(sent, [{ x: 1, y: 1 }, { x: 5, y: 5 }])
  })

  it('commits the dock even when a lost capture delivers no coordinates', () => {
    assert.match(shell, /await clampBall\(where, held\)/)
    assert.match(shell, /const where = base === undefined \? undefined : dragPosition\(event, base\)/)
  })

  it('releases a held gesture if the window loses focus mid-drag', () => {
    assert.match(shell, /window\.addEventListener\('blur', \(\) => \{\s*\n\s*if \(pointerHeld\) releaseDrag\(\)/)
  })
})
