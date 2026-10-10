import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createForegroundMemory, type ForegroundNative } from '../src/windows-foreground.ts'

interface FakeForeground extends ForegroundNative {
  current: number
  focused: number[]
}

function fakeForeground(current: number): FakeForeground {
  const state: FakeForeground = {
    current,
    focused: [],
    foreground: () => state.current,
    focus(target: number) {
      state.focused.push(target)
      state.current = target
      return true
    },
  }
  return state
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

describe('windows foreground memory', () => {
  it('hands the remembered user window back after the ball took the foreground', () => {
    const host = fakeForeground(42)
    const memory = createForegroundMemory({ chromeWindowIds: () => [7], native: host })
    memory.start()
    host.current = 7
    memory.restore()
    memory.stop()
    assert.deepEqual(host.focused, [42])
    assert.equal(host.current, 42)
  })

  it('leaves the foreground alone while the ball is the only window it has seen', () => {
    const host = fakeForeground(7)
    const memory = createForegroundMemory({ chromeWindowIds: () => [7], native: host })
    memory.start()
    memory.restore()
    memory.stop()
    assert.deepEqual(host.focused, [])
  })

  it('keeps sampling the user window while the ball holds the foreground, and stops on demand', async () => {
    const host = fakeForeground(7)
    const memory = createForegroundMemory({ chromeWindowIds: () => [7], native: host, intervalMs: 2 })
    memory.start()
    await sleep(15)
    host.current = 42
    await sleep(15)
    host.current = 7
    await sleep(15)
    memory.stop()
    host.current = 99
    await sleep(15)
    memory.restore()
    assert.deepEqual(host.focused, [42])
  })

  it('survives a native call that throws', () => {
    const host = fakeForeground(42)
    host.foreground = () => { throw new Error('no desktop') }
    const memory = createForegroundMemory({ chromeWindowIds: () => [], native: host })
    assert.doesNotThrow(() => {
      memory.start()
      memory.restore()
    })
    memory.stop()
  })

  it('never remembers the ball while the chrome list is still unknown', async () => {
    const host = fakeForeground(7)
    let chrome: readonly number[] = []
    const memory = createForegroundMemory({ chromeWindowIds: () => chrome, native: host, intervalMs: 2 })
    memory.start()
    await sleep(15)
    chrome = [7, 11]
    await sleep(15)
    memory.stop()
    // Move the foreground off the ball so a stale memory would actually hand it back.
    host.current = 99
    memory.restore()
    assert.deepEqual(host.focused, [])
  })

  it('forgets a window once the helper reports it as the ball', async () => {
    const host = fakeForeground(7)
    // The helper reported chrome, but its own ball handle is not in the list yet.
    let chrome: readonly number[] = [11]
    const memory = createForegroundMemory({ chromeWindowIds: () => chrome, native: host, intervalMs: 2 })
    memory.start()
    await sleep(15)
    chrome = [7, 11]
    await sleep(15)
    memory.stop()
    host.current = 99
    memory.restore()
    assert.deepEqual(host.focused, [])
  })
})
