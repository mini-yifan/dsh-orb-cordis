import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BALL_WINDOW_SIZE,
  CHROME_INSET,
  FloatingPlacement,
  PANEL_WINDOW_SIZE,
  ballOriginFromWindow,
  type DisplayPair,
  type Rect,
} from '../src/geometry.ts'

/**
 * Drag contract. The main process reads the OS cursor and places the ball under it,
 * so the renderer never supplies a position. These tests drive the real
 * FloatingPlacement with a window whose bounds only change through setBounds, the
 * way the OS window does, and assert the page and bridge stay signal-only.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
/** Comments may discuss the old input path; only executable code is asserted on. */
const code = shell.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
const main = readFileSync(join(here, '../src/main.ts'), 'utf8')

const display: DisplayPair = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
}

/**
 * A window whose bounds only change through setBounds. `drift` models the OS
 * quantizing each applied position by whole pixels (per-display DPI).
 */
function windowAt(origin: { x: number; y: number }, drift = 0) {
  let bounds: Rect = {
    x: origin.x - CHROME_INSET,
    y: origin.y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  const placed = new FloatingPlacement({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next, x: next.x + drift } },
  }, () => display, () => [display.bounds])
  return {
    placed,
    bounds: () => ({ ...bounds }),
    /** The OS moves the window on its own between two drag ticks. */
    nudge(next: Rect) { bounds = { ...next } },
  }
}

describe('floating ball drag input', () => {
  it('keeps the ball under the cursor on every tick, whatever the window did in between', () => {
    const { placed, bounds, nudge } = windowAt({ x: 400, y: 300 })
    placed.press({ x: 430, y: 330 })
    placed.beginDrag()
    const path = [{ x: 440, y: 335 }, { x: 470, y: 350 }, { x: 468, y: 390 }, { x: 600, y: 420 }]
    for (const cursor of path) {
      placed.dragTo(cursor, true)
      // grab = (30, 30): the ball origin is always cursor minus grab, never a running sum.
      assert.equal(bounds().x + CHROME_INSET, cursor.x - 30)
      assert.equal(bounds().y + CHROME_INSET, cursor.y - 30)
      // A window nudged by the OS must not feed back into the next target.
      nudge({ ...bounds(), x: bounds().x + 17, y: bounds().y - 9 })
    }
  })

  it('ignores ticks until the gesture has passed the drag threshold', async () => {
    const { placed, bounds } = windowAt({ x: 400, y: 300 })
    const before = bounds()
    placed.press({ x: 430, y: 330 })
    placed.dragTo({ x: 0, y: 330 })
    const state = await placed.endDrag({ x: 0, y: 330 })
    assert.deepEqual(bounds(), before)
    assert.equal(state.docked, undefined)
  })

  it('keeps an open panel expanded while an agent runs, and the ball still follows', () => {
    const { placed, bounds } = windowAt({ x: 400, y: 300 })
    placed.setExpanded(true)
    placed.press({ x: 420, y: 320 })
    placed.beginDrag()
    placed.dragTo({ x: 500, y: 320 }, false)
    assert.equal(bounds().width, PANEL_WINDOW_SIZE.width)
    const origin = ballOriginFromWindow(bounds(), { horizontal: 'right', vertical: 'down' })
    assert.deepEqual(origin, { x: 480, y: 300 })
  })

  it('docks a ball flush with the edge even when the OS quantizes the placement', async () => {
    // Grab 71 on the right puts a cursor at x = 1439 exactly on the ball's right edge (origin 1368);
    // grab 0 on the left puts a cursor at x = 0 exactly on the left edge (origin 0).
    for (const drift of [-2, -1, 1, 2]) {
      const right = windowAt({ x: 1000, y: 400 }, drift)
      right.placed.press({ x: 1071, y: 430 })
      right.placed.beginDrag()
      right.placed.dragTo({ x: 1439, y: 430 })
      const state = await right.placed.endDrag({ x: 1439, y: 430 })
      assert.equal(state.docked, 'right', `right edge, drift ${drift}`)
    }
    for (const drift of [-2, -1, 1, 2]) {
      const left = windowAt({ x: 1000, y: 400 }, drift)
      left.placed.press({ x: 1000, y: 430 })
      left.placed.beginDrag()
      left.placed.dragTo({ x: 0, y: 430 })
      const state = await left.placed.endDrag({ x: 0, y: 430 })
      assert.equal(state.docked, 'left', `left edge, drift ${drift}`)
    }
  })

  it('leaves the ball free when released clear of both edges', async () => {
    const { placed } = windowAt({ x: 400, y: 300 })
    placed.press({ x: 430, y: 330 })
    placed.beginDrag()
    placed.dragTo({ x: 700, y: 330 })
    const state = await placed.endDrag({ x: 700, y: 330 })
    assert.equal(state.docked, undefined)
  })

  it('ends a press that never became a drag without moving the window', async () => {
    const { placed, bounds } = windowAt({ x: 400, y: 300 })
    const before = bounds()
    placed.press({ x: 430, y: 330 })
    const state = await placed.endDrag({ x: 0, y: 330 })
    assert.deepEqual(bounds(), before)
    assert.equal(state.docked, undefined)
  })
})

describe('floating ball drag wiring', () => {
  it('never reads a renderer-side window position while dragging', () => {
    // screenX is Chromium's cached window origin plus clientX, and a window origin
    // cached at press goes stale as the window moves. Neither may drive the ball.
    assert.doesNotMatch(code, /\bscreen[XY]\b/)
    assert.doesNotMatch(code, /api\.(move|clamp|origin)\(/)
    assert.doesNotMatch(code, /clientX - grab/)
    assert.match(code, /api\.dragPress\(\)/)
    assert.match(code, /api\.dragBegin\(\)/)
    assert.match(code, /api\.dragMove\(/)
    assert.match(code, /api\.dragEnd\(/)
  })

  it('exposes drag signals through the preload bridge and nothing that carries a position', () => {
    assert.match(preload, /dragPress\(\) \{\s*ipcRenderer\.send\('orb:drag-press'\)/)
    assert.match(preload, /dragBegin\(\) \{\s*ipcRenderer\.send\('orb:drag-begin'\)/)
    assert.match(preload, /dragMove\(canDock\) \{\s*ipcRenderer\.send\('orb:drag-move', canDock !== false\)/)
    assert.match(preload, /dragEnd\(canDock\) \{\s*return ipcRenderer\.invoke\('orb:drag-end', canDock !== false\)/)
    assert.doesNotMatch(preload, /orb:(move|clamp|origin)\b/)
  })

  it('reads the drag cursor in the main process, in the same DIP space as the window', () => {
    assert.match(main, /screen\.getCursorScreenPoint\(\)/)
    assert.match(main, /ipcMain\.on\('orb:drag-press'/)
    assert.match(main, /ipcMain\.handle\('orb:drag-end'/)
    assert.doesNotMatch(main, /orb:(move|clamp|origin)\b/)
  })

  it('measures the drag threshold from the press point', () => {
    assert.match(code, /Math\.hypot\(event\.clientX - pressAt\.x, event\.clientY - pressAt\.y\) <= 4/)
  })

  it('keeps enter and leave from flipping the panel while a button is held', () => {
    assert.match(code, /function syncExpand\(\) \{\s*\n\s*if \(pointerHeld \|\| dragging\) return/)
    assert.match(code, /pointerleave[\s\S]{0,200}if \(pointerHeld \|\| dragging\) return/)
    // A dropped pointerup must not leave the gesture stuck: a fresh enter with no
    // button down ends it.
    assert.match(code, /if \(pointerHeld && typeof event\.buttons === 'number' && event\.buttons === 0\) void finishGesture\(\)/)
  })

  it('ends the gesture on every release path, including a lost capture and a window blur', () => {
    assert.match(code, /ball\.addEventListener\('lostpointercapture', \(\) => \{ void finishGesture\(\) \}\)/)
    assert.match(code, /window\.addEventListener\('blur', \(\) => \{\s*\n\s*if \(pointerHeld\) void finishGesture\(\)/)
    assert.match(code, /if \(!skipDock\) \{[\s\S]*?applyDockedFrom\(await api\.dragEnd\(/)
  })

  it('applies the layout a release reports, so an open panel shows the side it now grew', () => {
    assert.match(code, /function applyDockedFrom\(result\) \{[\s\S]*?if \(result\.expanded === true\) applyDirection\(result\)/)
  })
})
