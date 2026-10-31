import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDesktopHostProcess, suppressDockTile, type PolicySetter } from '../src/dock-suppression.ts'

/** A setter that records the policy it was asked for. */
function recording(accept: (policy: number) => boolean = () => true) {
  const asked: number[] = []
  const set: PolicySetter = (policy) => {
    asked.push(policy)
    return accept(policy)
  }
  return { asked, set }
}

/** A loader that hands back a fixed setter, standing in for the Objective-C runtime. */
const loading = (set: PolicySetter | undefined) => () => set

describe('Desktop Host detection', () => {
  it('recognises the packaged app executable', () => {
    assert.equal(
      isDesktopHostProcess({}, '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'),
      true,
    )
  })

  it('recognises the launcher environment the desktop shell injects', () => {
    // The shell sets this when it hands the Host a package manager; the executable
    // path then need not mention the product at all.
    assert.equal(
      isDesktopHostProcess({ DSH_DESKTOP_NODE_EXECUTABLE: '/usr/local/bin/node' }, '/usr/local/bin/node'),
      true,
    )
  })

  it('rejects a plain terminal node process', () => {
    // `dsh web` runs from the user's node: no app identity, so no Dock to stay out of.
    assert.equal(isDesktopHostProcess({}, '/opt/homebrew/bin/node'), false)
  })

  it('treats an empty launcher value as absent', () => {
    assert.equal(isDesktopHostProcess({ DSH_DESKTOP_NODE_EXECUTABLE: '' }, '/opt/homebrew/bin/node'), false)
  })
})

describe('Dock tile suppression', () => {
  it('asks for the prohibited policy on the Desktop Host', () => {
    const rec = recording()
    const ok = suppressDockTile({ platform: 'darwin', isHost: () => true, load: loading(rec.set) })
    assert.equal(ok, true)
    // 2 is NSApplicationActivationPolicyProhibited: the WindowServer never activates
    // the process, so the Dock never creates a tile.
    assert.deepEqual(rec.asked, [2])
  })

  it('does nothing on platforms without an NSApplication', () => {
    const rec = recording()
    const ok = suppressDockTile({ platform: 'win32', isHost: () => true, load: loading(rec.set) })
    assert.equal(ok, false)
    assert.deepEqual(rec.asked, [])
  })

  it('leaves a plain node process alone rather than creating an NSApplication', () => {
    const rec = recording()
    const ok = suppressDockTile({ platform: 'darwin', isHost: () => false, load: loading(rec.set) })
    assert.equal(ok, false)
    assert.deepEqual(rec.asked, [])
  })

  it('reports failure when AppKit refuses the policy', () => {
    const rec = recording(() => false)
    const ok = suppressDockTile({ platform: 'darwin', isHost: () => true, load: loading(rec.set) })
    assert.equal(ok, false)
    assert.deepEqual(rec.asked, [2])
  })

  it('skips the switch when there is no NSApplication to address', () => {
    const ok = suppressDockTile({ platform: 'darwin', isHost: () => true, load: loading(undefined) })
    assert.equal(ok, false)
  })

  it('keeps the plugin alive when the loader throws', () => {
    // A Dock tile is cosmetic; the ball, voice, and selection must still start.
    const ok = suppressDockTile({
      platform: 'darwin',
      isHost: () => true,
      load: () => { throw new Error('no Objective-C runtime') },
    })
    assert.equal(ok, false)
  })

  it('keeps the plugin alive when the setter throws', () => {
    const ok = suppressDockTile({
      platform: 'darwin',
      isHost: () => true,
      load: loading(() => { throw new Error('activation policy unavailable') }),
    })
    assert.equal(ok, false)
  })
})
