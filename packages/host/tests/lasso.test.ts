import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LassoController,
  readLassoAction,
  type ImageRef,
  type LassoAction,
  type LassoCaptureResult,
} from '../src/lasso.ts'

const rect = { x: 10, y: 20, width: 200, height: 100 }
const display = { x: 0, y: 0, width: 1440, height: 900, scale: 2 }
const image: ImageRef = {
  attachmentId: 'att-1',
  mediaType: 'image/jpeg',
  bytes: 1234,
  width: 400,
  height: 200,
}

function captureResult(): LassoCaptureResult {
  return {
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/jpeg',
    screen: { bounds: { x: 0, y: 0, width: 800, height: 600 }, scale: 2, appName: 'Finder' },
    foreground: { appName: 'Finder' },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  }
}

function setup() {
  const broadcasts: Record<string, unknown>[] = []
  const statuses: string[] = []
  const translated: ImageRef[] = []
  const captured: { mode: string; copy: boolean }[] = []
  const seeds: { sessionId: string; seed: unknown }[] = []
  const attachments = {
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
      assert.equal(input.data.length, 3)
      return Promise.resolve(image)
    },
  }
  const controller = new LassoController({
    capture: () => ({
      capture(input) {
        captured.push({ mode: input.mode, copy: input.copyToClipboard === true })
        return Promise.resolve(captureResult())
      },
    }),
    attachments: () => attachments,
    seed: () => ({
      set(sessionId, seed) { seeds.push({ sessionId, seed }) },
      clear() {},
    }),
    broadcast: (message) => { broadcasts.push(message as Record<string, unknown>) },
    status: (text) => { statuses.push(text) },
    currentSessionId: () => 'session-1',
    translate: (img) => { translated.push(img) },
    now: () => 1_000,
  })
  return { controller, broadcasts, statuses, translated, captured, seeds }
}

describe('lasso controller', () => {
  it('saves the highlight, broadcasts the chip, and seeds the next prompt', async () => {
    const { controller, broadcasts, captured, seeds } = setup()
    await controller.action({ action: 'send', rect, display })
    assert.deepEqual(captured, [{ mode: 'highlight', copy: false }])
    assert.equal(broadcasts[0]?.type, 'lasso-attach')
    assert.equal(broadcasts[1]?.type, 'lasso-result')
    assert.equal(broadcasts[1]?.ok, true)
    const id = broadcasts[0]?.selectionId
    assert.equal(typeof id, 'string')
    assert.equal(controller.has(id as string), true)
    assert.equal(controller.takeForPrompt(id as string, 'session-1'), true)
    assert.equal(seeds.length, 1)
    assert.equal(seeds[0]?.sessionId, 'session-1')
    assert.equal(controller.has(id as string), false)
  })

  it('does not seed a different session', async () => {
    const { controller, broadcasts } = setup()
    await controller.action({ action: 'send', rect, display })
    const id = broadcasts[0]?.selectionId as string
    assert.equal(controller.takeForPrompt(id, 'session-2'), false)
  })

  it('dismiss drops the pending image', async () => {
    const { controller, broadcasts } = setup()
    await controller.action({ action: 'send', rect, display })
    const id = broadcasts[0]?.selectionId as string
    controller.dismiss(id)
    assert.equal(controller.has(id), false)
    assert.equal(controller.takeForPrompt(id, 'session-1'), false)
  })

  it('copies the crop and keeps the frame open', async () => {
    const { controller, broadcasts, captured } = setup()
    await controller.action({ action: 'copy', rect, display })
    assert.deepEqual(captured, [{ mode: 'crop', copy: true }])
    assert.deepEqual(broadcasts.at(-1), {
      type: 'lasso-result',
      action: 'copy',
      ok: true,
    })
  })

  it('saves the crop and starts a translation without a send chip', async () => {
    const { controller, broadcasts, translated, captured } = setup()
    await controller.action({ action: 'translate', rect, display })
    assert.deepEqual(captured, [{ mode: 'crop', copy: false }])
    assert.deepEqual(translated, [image])
    assert.deepEqual(broadcasts.at(-1), {
      type: 'lasso-result',
      action: 'translate',
      ok: true,
    })
  })

  it('reports a capture failure and leaves no chip', async () => {
    const results: Record<string, unknown>[] = []
    const failing = new LassoController({
      capture: () => ({ capture: () => Promise.reject(new Error('boom')) }),
      attachments: () => ({ saveImage: () => Promise.resolve(image) }),
      seed: () => undefined,
      broadcast: (message) => { results.push(message as Record<string, unknown>) },
      status: () => {},
      currentSessionId: () => 'session-1',
      translate: () => {},
    })
    await failing.action({ action: 'send', rect, display })
    assert.equal(results.at(-1)?.type, 'lasso-result')
    assert.equal(results.at(-1)?.ok, false)
  })
})

describe('lasso action validation', () => {
  it('accepts a well formed action', () => {
    assert.deepEqual(readLassoAction({ action: 'send', rect, display }), {
      action: 'send',
      rect,
      display,
    })
  })

  it('rejects unknown actions and broken rects', () => {
    assert.equal(readLassoAction({ action: 'save', rect, display }), undefined)
    assert.equal(readLassoAction({ action: 'send', rect: { x: 0, y: 0, width: 0, height: 10 }, display }), undefined)
    assert.equal(readLassoAction({ action: 'send', rect }), undefined)
  })
})
