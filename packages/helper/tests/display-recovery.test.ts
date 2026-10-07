import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { attachDisplayRecovery } from '../src/display-events.ts'
import {
  AGENT_STRIP_WIDTH, BALL_SIZE, BALL_WINDOW_SIZE, CHROME_INSET, DOCK_HIT_HEIGHT, DOCK_HIT_WIDTH,
  FloatingPlacement, PANEL_WINDOW_SIZE, ballOriginFromWindow, type DisplayPair, type Rect,
} from '../src/geometry.ts'

const primary = pair(0, 0, 1920, 1080, { x: 0, y: 0, width: 1920, height: 1040 })
const left = pair(-1463, 0, 1463, 914)

describe('display topology recovery', () => {
  it('recovers a collapsed ball when its negative-coordinate secondary display is removed', () => {
    const f = fixture([left, primary], -1200, 500)
    f.displays = [primary]
    f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.ball(), { x: 0, y: 500 })
    assertBallInside(f.ball(), primary.workArea)
    assert.equal(f.bounds.width, BALL_WINDOW_SIZE)
    assert.equal(f.window.visible, false)
  })

  it('keeps a visible ball on its display despite unequal display centers and mixed scale factors', () => {
    const scaled = { ...primary, scaleFactor: 1.5 }
    const secondary = { ...left, scaleFactor: 1 }
    const f = fixture([secondary, scaled], 20, 200)
    const before = { ...f.bounds }
    f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.bounds, before)
    // A DPI change supplies new DIP work-area dimensions; do not scale them again.
    const changed = { ...scaled, workArea: { x: 0, y: 0, width: 1280, height: 680 } }
    f.placement.move(1800, 900, false)
    f.placement.recoverDisplays([changed])
    assert.deepEqual(f.ball(), { x: 1208, y: 608 })
  })

  it('uses the nearest usable area in a vertical layout with negative coordinates', () => {
    const upper = pair(0, -900, 1440, 900)
    const lower = pair(0, 0, 1440, 900)
    const f = fixture([upper, lower], 400, -800)
    f.placement.recoverDisplays([lower])
    assert.deepEqual(f.ball(), { x: 400, y: 0 })
    f.placement.move(500, 500, false)
    f.placement.recoverDisplays([upper])
    assert.deepEqual(f.ball(), { x: 500, y: -72 })
  })

  it('clamps to changed work-area offsets and dimensions without accidentally docking', async () => {
    const f = fixture([primary], 1800, 950)
    const changed = pair(0, 0, 1280, 720, { x: 40, y: 30, width: 1240, height: 650 })
    f.displays = [changed]
    f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.ball(), { x: 1208, y: 608 })
    assert.equal((await f.placement.clamp(false)).docked, undefined)
  })

  it('keeps expanded size and direction while bringing the panel into the remaining work area', () => {
    const f = fixture([left, primary], -400, 600)
    const state = f.placement.setExpanded(true)
    f.displays = [primary]
    f.placement.recoverDisplays(f.displays)
    assert.equal(f.bounds.width, PANEL_WINDOW_SIZE.width)
    assert.equal(f.bounds.height, PANEL_WINDOW_SIZE.height)
    assertContentInside(f.bounds, primary.workArea)
    assertBallInside(ballOriginFromWindow(f.bounds, state), primary.workArea)
    const recovered = { ...f.bounds }
    for (let i = 0; i < 5; i += 1) f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.bounds, recovered)
    f.placement.setExpanded(false)
    assertBallInside(f.ball(), primary.workArea)
  })

  it('preserves the bookmark reserve and direction after removing the ball display', () => {
    const f = fixture([left, primary], -400, 600)
    f.placement.setStrip(AGENT_STRIP_WIDTH)
    const state = f.placement.setExpanded(true)
    f.displays = [primary]
    f.placement.recoverDisplays(f.displays)
    assert.equal(f.bounds.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
    assertContentInside(f.bounds, primary.workArea)
    assertBallInside(ballOriginFromWindow(f.bounds, state), primary.workArea)
    const recovered = { ...f.bounds }
    for (let i = 0; i < 5; i += 1) f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.bounds, recovered)
    assert.equal(f.window.visible, false)
  })

  it('keeps the ball reachable when the panel fits but the panel plus strip does not', () => {
    const f = fixture([primary], 1800, 900)
    f.placement.setStrip(AGENT_STRIP_WIDTH)
    const state = f.placement.setExpanded(true)
    const narrow = pair(-400, -800, 400, 800)
    f.displays = [narrow]
    f.placement.recoverDisplays(f.displays)
    assert.equal(f.bounds.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
    assertBallInside(ballOriginFromWindow(f.bounds, state), narrow.workArea)
    const recovered = { ...f.bounds }
    f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.bounds, recovered)
  })

  it('keeps the recovered ball stable as bookmarks clear and reappear', () => {
    const f = fixture([left, primary], -400, 600)
    f.placement.setStrip(AGENT_STRIP_WIDTH)
    const state = f.placement.setExpanded(true)
    f.displays = [primary]
    f.placement.recoverDisplays(f.displays)
    const ball = ballOriginFromWindow(f.bounds, state)
    for (const strip of [0, AGENT_STRIP_WIDTH]) {
      const next = f.placement.setStrip(strip)
      assert.equal(next.expanded, true)
      assert.equal(next.strip, strip)
      assert.equal(f.bounds.width, PANEL_WINDOW_SIZE.width + strip)
      assert.deepEqual(ballOriginFromWindow(f.bounds, next), ball)
    }
  })

  it('keeps the ball reachable when the work area is smaller than the fixed panel', () => {
    const f = fixture([primary], 1800, 900)
    const state = f.placement.setExpanded(true)
    const small = pair(-200, -200, 200, 200)
    f.displays = [small]
    f.placement.recoverDisplays(f.displays)
    assertBallInside(ballOriginFromWindow(f.bounds, state), small.workArea)
    const recovered = { ...f.bounds }
    f.placement.recoverDisplays(f.displays)
    assert.deepEqual(f.bounds, recovered)
  })

  it('preserves every panel growth direction on a rotated display at negative coordinates', () => {
    const portrait = pair(-900, -1200, 900, 1200)
    for (const x of [100, 1800]) {
      for (const y of [100, 900]) {
        const f = fixture([primary], x, y)
        const state = f.placement.setExpanded(true)
        f.displays = [portrait]
        f.placement.recoverDisplays(f.displays)
        assertContentInside(f.bounds, portrait.workArea)
        assertBallInside(ballOriginFromWindow(f.bounds, state), portrait.workArea)
        const recovered = { ...f.bounds }
        f.placement.recoverDisplays(f.displays)
        assert.deepEqual(f.bounds, recovered)
        const collapsed = f.placement.setExpanded(false)
        assert.equal(collapsed.horizontal, state.horizontal)
        assert.equal(collapsed.vertical, state.vertical)
        assertBallInside(f.ball(), portrait.workArea)
      }
    }
  })

  for (const side of ['left', 'right'] as const) {
    it(`keeps a ${side} docked tab reachable after removal and work-area shrink`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      const old = pair(-1463, -914, 1463, 914)
      const f = fixture([old], side === 'left' ? -1480 : -55, -100)
      f.placement.setStrip(AGENT_STRIP_WIDTH)
      const docking = f.placement.clamp()
      t.mock.timers.tick(300)
      assert.equal((await docking).docked, side)
      const work = pair(0, 0, 1280, 720, { x: 40, y: 20, width: 1240, height: 650 })
      f.displays = [work]
      f.placement.recoverDisplays(f.displays)
      assert.equal(f.bounds.width, DOCK_HIT_WIDTH)
      assert.equal(f.bounds.height, DOCK_HIT_HEIGHT)
      assertRectInside(f.bounds, work.workArea)
      assert.equal(f.bounds.x, side === 'left' ? 40 : 1280 - DOCK_HIT_WIDTH)
      const recovered = { ...f.bounds }
      f.placement.recoverDisplays(f.displays)
      assert.deepEqual(f.bounds, recovered)
      const undocking = f.placement.unsnap()
      t.mock.timers.tick(400)
      assert.equal((await undocking).docked, undefined)
      assertBallInside(f.ball(), work.workArea)
      const expanded = f.placement.setExpanded(true)
      assert.equal(expanded.strip, AGENT_STRIP_WIDTH)
      assert.equal(f.bounds.width, PANEL_WINDOW_SIZE.width + AGENT_STRIP_WIDTH)
      assertContentInside(f.bounds, work.workArea)
    })
  }

  it('cancels both docking frames and the stale completion after repeated recovery events', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const f = fixture([left], -1480, 700)
    const detach = attachDisplayRecovery(f.screen, f.window, f.placement)
    const docking = f.placement.clamp()
    t.mock.timers.tick(80)
    f.displays = [primary]
    f.screen.emit('display-removed', {}, left)
    f.screen.emit('display-metrics-changed', {}, primary, ['workArea'])
    const recovered = { ...f.bounds }
    t.mock.timers.tick(500)
    assert.equal((await docking).docked, 'left')
    assert.deepEqual(f.bounds, recovered)
    assertRectInside(f.bounds, primary.workArea)
    detach()
  })

  it('cancels an undocking animation so it cannot return to the removed monitor', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const f = fixture([left], -1480, 700)
    const docking = f.placement.clamp()
    t.mock.timers.tick(300)
    await docking
    const undocking = f.placement.unsnap()
    t.mock.timers.tick(80)
    f.displays = [primary]
    f.placement.recoverDisplays(f.displays)
    const recovered = { ...f.bounds }
    t.mock.timers.tick(500)
    assert.equal((await undocking).docked, undefined)
    assert.deepEqual(f.bounds, recovered)
    assertBallInside(f.ball(), primary.workArea)
  })

  it('ignores empty or invalid work areas and recovers when a valid display arrives', () => {
    const f = fixture([left], -500, 500)
    const before = { ...f.bounds }
    f.placement.recoverDisplays([])
    f.placement.recoverDisplays([
      pair(0, 0, 0, 0), pair(0, 0, -100, 800), pair(Number.NaN, 0, 800, 800),
      pair(0, 0, Number.POSITIVE_INFINITY, 800), pair(0, 0, 71, 800),
    ])
    assert.deepEqual(f.bounds, before)
    f.placement.recoverDisplays([pair(0, 0, 0, 0), primary])
    assertBallInside(f.ball(), primary.workArea)
  })
})

describe('docked tabs in usable work areas', () => {
  for (const side of ['left', 'right'] as const) {
    it(`initial ${side} docking respects taskbar offsets on a negative-coordinate display`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      const display = pair(-900, -1000, 900, 1000, { x: -860, y: -970, width: 820, height: 930 })
      const f = fixture([display], side === 'left' ? -917 : -55, -10)
      const docking = f.placement.clamp()
      t.mock.timers.tick(300)
      assert.equal((await docking).docked, side)
      assertRectInside(f.bounds, display.workArea)
    })

    it(`a recovered ${side} tab stays usable through clamp, collapse and docked move`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      const x = side === 'left' ? -17 : 1865
      const f = fixture([primary], x, 1000)
      const docking = f.placement.clamp()
      t.mock.timers.tick(300)
      assert.equal((await docking).docked, side)
      const display = pair(0, 0, 1920, 1080, { x: 40, y: 30, width: 1840, height: 1000 })
      f.displays = [display]
      f.placement.recoverDisplays(f.displays)
      assertRectInside(f.bounds, display.workArea)
      assert.equal((await f.placement.clamp()).docked, side)
      assertRectInside(f.bounds, display.workArea)
      assert.equal(f.placement.setExpanded(false).docked, side)
      assertRectInside(f.bounds, display.workArea)
      // Stay within the drag-off threshold; the initial ball origin only triggers docking.
      assert.equal(f.placement.move(side === 'left' ? -17 : 1910, 1000).docked, side)
      assertRectInside(f.bounds, display.workArea)
    })
  }
})

describe('edge-contact signals with display recovery', () => {
  for (const signal of ['window', 'renderer'] as const) {
    for (const side of ['left', 'right'] as const) {
      it(`uses the work area for ${side} contact detected from the ${signal} origin`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
        const display = pair(-1440, -900, 1440, 900, { x: -1400, y: -870, width: 1360, height: 830 })
        const contact = { x: side === 'left' ? -1440 : -BALL_SIZE, y: -10 }
        const f = fixture([display], signal === 'window' ? contact.x : -700, signal === 'window' ? contact.y : -400)
        const docking = f.placement.clamp(true, signal === 'renderer' ? contact : undefined)
        t.mock.timers.tick(300)
        assert.equal((await docking).docked, side)
        assertRectInside(f.bounds, display.workArea)
      })
    }
  }

  it('uses the renderer display work area when the window origin belongs to another display', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const remoteDisplay = { ...pair(-1463, 0, 1463, 914, { x: -1423, y: 20, width: 1383, height: 854 }), scaleFactor: 1 }
    const scaledPrimary = { ...primary, scaleFactor: 1.5 }
    const f = fixture([scaledPrimary, remoteDisplay], 500, 400)
    const docking = f.placement.clamp(true, { x: remoteDisplay.bounds.x, y: 800 })
    t.mock.timers.tick(300)
    assert.equal((await docking).docked, 'left')
    assertRectInside(f.bounds, remoteDisplay.workArea)
    assert.equal(f.bounds.x, remoteDisplay.workArea.x)
  })

  it('does not let renderer-triggered docking overwrite recovery to the remaining monitor', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const f = fixture([left, primary], 500, 400)
    const docking = f.placement.clamp(true, { x: left.bounds.x, y: 600 })
    t.mock.timers.tick(80)
    const remaining = pair(0, 0, 1920, 1080, { x: 40, y: 20, width: 1840, height: 1020 })
    f.displays = [remaining]
    f.placement.recoverDisplays(f.displays)
    const recovered = { ...f.bounds }
    t.mock.timers.tick(500)
    assert.equal((await docking).docked, 'left')
    assert.deepEqual(f.bounds, recovered)
    assertRectInside(f.bounds, remaining.workArea)
    assert.equal(f.window.visible, false)
  })

  it('ignores non-finite and out-of-range renderer fallback origins', async () => {
    const f = fixture([primary], 500, 400)
    const before = { ...f.bounds }
    for (const origin of [
      { x: Number.NaN, y: 400 }, { x: 0, y: Number.POSITIVE_INFINITY },
      { x: 100_001, y: 400 }, { x: -100_001, y: 400 },
    ]) {
      assert.equal((await f.placement.clamp(true, origin)).docked, undefined)
      assert.deepEqual(f.bounds, before)
    }
  })

  it('does not use renderer edge contact when docking is disabled', async () => {
    const f = fixture([primary], 500, 400)
    assert.equal((await f.placement.clamp(false, { x: 0, y: 400 })).docked, undefined)
    assertBallInside(f.ball(), primary.workArea)
  })

  it('does not dock at a shared display seam from the renderer signal', async () => {
    const displays = [pair(0, 0, 1440, 900), pair(1440, 0, 1920, 1080)]
    const f = fixture(displays, 500, 400)
    assert.equal((await f.placement.clamp(true, { x: 1440, y: 400 })).docked, undefined)
    assertBallInside(f.ball(), displays[0]!.workArea)
  })
})

describe('screen event subscriptions', () => {
  it('recovers on added, removed, and relevant metrics events without showing a hidden ball', () => {
    const f = fixture([left, primary], -1000, 500)
    const detach = attachDisplayRecovery(f.screen, f.window, f.placement)
    f.displays = [primary]
    f.screen.emit('display-removed', {}, left)
    assertBallInside(f.ball(), primary.workArea)
    assert.equal(f.window.visible, false)
    f.placement.move(-1000, 500, false)
    f.screen.emit('display-added', {}, primary)
    assertBallInside(f.ball(), primary.workArea)
    for (const metric of ['bounds', 'workArea', 'scaleFactor', 'rotation']) {
      f.placement.move(3000, 3000, false)
      f.screen.emit('display-metrics-changed', {}, primary, [metric])
      assertBallInside(f.ball(), primary.workArea)
    }
    f.placement.move(3000, 3000, false)
    const before = { ...f.bounds }
    f.screen.emit('display-metrics-changed', {}, primary, [])
    f.screen.emit('display-metrics-changed', {}, primary, ['colorDepth'])
    assert.deepEqual(f.bounds, before)
    detach()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      assert.equal(f.screen.listenerCount(event), 0)
      f.screen.emit(event, {}, primary, ['bounds'])
    }
    assert.deepEqual(f.bounds, before)
  })

  it('does not access bounds or displays after the window is destroyed', () => {
    const f = fixture([primary], 100, 100)
    const detach = attachDisplayRecovery(f.screen, f.window, f.placement)
    f.window.destroyed = true
    f.screen.getAllDisplays = () => { throw new Error('screen accessed after destruction') }
    f.screen.emit('display-removed', {}, primary)
    f.screen.emit('display-metrics-changed', {}, primary, ['bounds'])
    detach()
    detach()
  })
})

function pair(x: number, y: number, width: number, height: number, workArea?: Rect): DisplayPair {
  const bounds = { x, y, width, height }
  return { bounds, workArea: workArea ?? bounds }
}

function fixture(displays: readonly DisplayPair[], x: number, y: number) {
  const f = {
    displays,
    bounds: { x: x - CHROME_INSET, y: y - CHROME_INSET, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE },
    ball: () => ({ x: f.bounds.x + CHROME_INSET, y: f.bounds.y + CHROME_INSET }),
    window: {
      visible: false,
      destroyed: false,
      isDestroyed: () => f.window.destroyed,
      getBounds: () => {
        assert.equal(f.window.destroyed, false)
        return { ...f.bounds }
      },
      setBounds: (next: Rect) => { f.bounds = { ...next } },
    },
    screen: Object.assign(new EventEmitter(), { getAllDisplays: () => f.displays }),
    placement: undefined as unknown as FloatingPlacement,
  }
  f.placement = new FloatingPlacement(f.window, (point) => {
    const contained = f.displays.find(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height)
    if (contained) return contained
    return [...f.displays].sort((a, b) => {
      const distance = ({ bounds }: DisplayPair) => (bounds.x + bounds.width / 2 - point.x) ** 2
        + (bounds.y + bounds.height / 2 - point.y) ** 2
      return distance(a) - distance(b)
    })[0]!
  }, () => f.displays.map(({ bounds }) => bounds))
  return f
}

function assertBallInside(ball: { x: number; y: number }, work: Rect): void {
  assertRectInside({ ...ball, width: BALL_SIZE, height: BALL_SIZE }, work)
}

function assertContentInside(bounds: Rect, work: Rect): void {
  assertRectInside({ x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET,
    width: bounds.width - 2 * CHROME_INSET, height: bounds.height - 2 * CHROME_INSET }, work)
}

function assertRectInside(bounds: Rect, work: Rect): void {
  assert.ok(bounds.x >= work.x && bounds.y >= work.y
    && bounds.x + bounds.width <= work.x + work.width
    && bounds.y + bounds.height <= work.y + work.height,
  `${JSON.stringify(bounds)} must be inside ${JSON.stringify(work)}`)
}
