import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createZOrderGuard,
  rectFillsMonitor,
  startZOrderGuard,
  type FullscreenSample,
  type ZOrderProbe,
  type ZOrderWindow,
  type WindowRect,
} from '../src/zorder.ts'

const MONITOR: WindowRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
const SECOND_MONITOR: WindowRect = { left: -1920, top: -200, right: 0, bottom: 880 }
const MONITOR_HANDLE = 0x0000_0000_0000_1001n
const BALL_HANDLE = 0x0000_0000_0000_2002n
const FOREGROUND_HANDLE = 0x0000_0000_0000_3003n

function handleBuffer(handle: bigint): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(handle)
  return buffer
}

interface FakeWindow extends ZOrderWindow {
  calls: string[]
  destroy(): void
}

function fakeWindow(options?: { topmost?: boolean; handle?: bigint }): FakeWindow {
  const calls: string[] = []
  let topmost = options?.topmost ?? true
  let destroyed = false
  const buffer = handleBuffer(options?.handle ?? BALL_HANDLE)
  return {
    calls,
    isDestroyed: () => destroyed,
    isAlwaysOnTop: () => topmost,
    setAlwaysOnTop(flag: boolean, level?: string) {
      topmost = flag
      calls.push(level === undefined ? `alwaysOnTop(${flag})` : `alwaysOnTop(${flag}, ${level})`)
    },
    getNativeWindowHandle: () => buffer,
    destroy() {
      destroyed = true
    },
  }
}

function fakeProbe(
  sample: FullscreenSample | undefined,
  monitorOf: (handle: bigint) => bigint = () => MONITOR_HANDLE,
): ZOrderProbe & { bottoms: bigint[] } {
  const bottoms: bigint[] = []
  return {
    bottoms,
    foreground: () => sample,
    monitorOf,
    sendToBottom(handle: bigint) {
      bottoms.push(handle)
    },
  }
}

describe('fullscreen rect matching', () => {
  it('accepts a window that matches the monitor on all four edges', () => {
    assert.equal(rectFillsMonitor({ ...MONITOR }, MONITOR), true)
  })

  it('rejects a maximized window that stops at the work area', () => {
    // Taskbar visible: a maximized Edge window reports its DWM frame, with the bottom
    // edge 32 px above the monitor bottom.
    assert.equal(rectFillsMonitor({ left: -8, top: -8, right: 2568, bottom: 1408 }, MONITOR), false)
  })

  it('rejects a maximized window that keeps the DWM invisible border', () => {
    // Taskbar auto-hid: the frame overhangs the monitor by ~8 px on every side.
    assert.equal(rectFillsMonitor({ left: -8, top: -8, right: 2568, bottom: 1448 }, MONITOR), false)
  })

  it('accepts a fullscreen window on a secondary display with negative coordinates', () => {
    assert.equal(rectFillsMonitor({ ...SECOND_MONITOR }, SECOND_MONITOR), true)
  })

  it('honours the tolerance only up to its limit', () => {
    assert.equal(rectFillsMonitor({ ...MONITOR, left: -4 }, MONITOR), true)
    assert.equal(rectFillsMonitor({ ...MONITOR, left: -5 }, MONITOR), false)
  })
})

describe('z-order guard', () => {
  it('leaves the topmost band and sends the ball to the bottom of the z-order', () => {
    const window = fakeWindow()
    const probe = fakeProbe({ handle: FOREGROUND_HANDLE, monitor: MONITOR_HANDLE })
    createZOrderGuard(window, probe).tick()
    assert.deepEqual(window.calls, ['alwaysOnTop(false)'])
    assert.deepEqual(probe.bottoms, [BALL_HANDLE])
  })

  it('sends the ball to the bottom even when the fullscreen window is topmost itself', () => {
    // HWND_BOTTOM is relative to the whole z-order, so it needs no information about
    // the foreground window and cannot be refused for naming another process's window.
    const window = fakeWindow()
    const probe = fakeProbe({ handle: FOREGROUND_HANDLE, monitor: MONITOR_HANDLE })
    createZOrderGuard(window, probe).tick()
    assert.deepEqual(window.calls, ['alwaysOnTop(false)'])
    assert.deepEqual(probe.bottoms, [BALL_HANDLE])
  })

  it('does nothing while the fullscreen window is on another display', () => {
    const window = fakeWindow()
    const probe = fakeProbe(
      { handle: FOREGROUND_HANDLE, monitor: 0x0000_0000_0000_1002n },
      () => MONITOR_HANDLE,
    )
    createZOrderGuard(window, probe).tick()
    assert.deepEqual(window.calls, [])
    assert.deepEqual(probe.bottoms, [])
  })

  it('restores the topmost band once fullscreen ends', () => {
    const window = fakeWindow({ topmost: false })
    createZOrderGuard(window, fakeProbe(undefined)).tick()
    assert.deepEqual(window.calls, ['alwaysOnTop(true, screen-saver)'])
  })

  it('leaves a normal window alone when fullscreen ends', () => {
    const window = fakeWindow({ topmost: true })
    createZOrderGuard(window, fakeProbe(undefined)).tick()
    assert.deepEqual(window.calls, [])
  })

  it('ignores a destroyed window', () => {
    const window = fakeWindow()
    window.destroy()
    createZOrderGuard(window, fakeProbe({ handle: FOREGROUND_HANDLE, monitor: MONITOR_HANDLE })).tick()
    assert.deepEqual(window.calls, [])
  })

  it('survives a probe that throws and a monitor that cannot be resolved', () => {
    const window = fakeWindow()
    const broken: ZOrderProbe = {
      foreground() {
        throw new Error('user32 is gone')
      },
      monitorOf() {
        throw new Error('no monitor')
      },
      sendToBottom() {
        throw new Error('no window')
      },
    }
    assert.doesNotThrow(() => createZOrderGuard(window, broken).tick())
    const throwingMonitor = fakeProbe({ handle: FOREGROUND_HANDLE, monitor: MONITOR_HANDLE }, () => {
      throw new Error('no monitor')
    })
    createZOrderGuard(window, throwingMonitor).tick()
    assert.deepEqual(window.calls, [])
  })

  it('stops acting after stop()', () => {
    const window = fakeWindow()
    const guard = createZOrderGuard(window, fakeProbe({ handle: FOREGROUND_HANDLE, monitor: MONITOR_HANDLE }))
    guard.stop()
    guard.tick()
    assert.deepEqual(window.calls, [])
  })
})

describe('starting the guard', () => {
  it('is a no-op on platforms without the Win32 window band', () => {
    // No native load and no interval on macOS/Linux; the returned stop is still safe.
    for (const platform of ['darwin', 'linux']) {
      const stop = startZOrderGuard(fakeWindow(), platform)
      assert.equal(typeof stop, 'function')
      stop()
      stop()
    }
  })
})
