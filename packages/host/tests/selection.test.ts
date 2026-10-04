import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchWindowsSelectionMessage,
  draggedFarEnough,
  parseSelectionHelperLine,
} from '@dsh-orb/native-selection'
import { createOverlayGuard } from '../src/overlay-guard.ts'
import {
  composeSelectionTranslatePrompt,
  SELECTION_PREAMBLE,
  SelectionController,
  selectionSearchUrl,
  type SelectionHost,
  type SelectionMonitorHandle,
} from '../src/selection.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('selection lines', () => {
  it('parses ready, untrusted, keys, points, and selections', () => {
    assert.deepEqual(parseSelectionHelperLine('{"type":"ready"}'), { type: 'ready' })
    assert.deepEqual(parseSelectionHelperLine('{"type":"untrusted"}'), { type: 'untrusted' })
    assert.deepEqual(parseSelectionHelperLine('{"type":"key"}'), { type: 'key' })
    assert.deepEqual(parseSelectionHelperLine('{"type":"dismiss"}'), { type: 'dismiss' })
    assert.deepEqual(parseSelectionHelperLine('{"type":"mouse-down","x":3,"y":4}'), { type: 'mouse-down', x: 3, y: 4 })
    assert.deepEqual(parseSelectionHelperLine('{"type":"selection","text":"hi","pid":9,"bundle":"com.app"}'), {
      type: 'selection',
      text: 'hi',
      pid: 9,
      bundle: 'com.app',
    })
    assert.deepEqual(
      parseSelectionHelperLine('{"type":"selection","text":"hi","x":1,"y":2,"bounds":{"x":1,"y":2,"width":3,"height":4}}'),
      { type: 'selection', text: 'hi', x: 1, y: 2, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    )
  })

  it('drops blank lines, invalid JSON, empty text, and points with a string coordinate', () => {
    assert.equal(parseSelectionHelperLine(''), undefined)
    assert.equal(parseSelectionHelperLine('   '), undefined)
    assert.equal(parseSelectionHelperLine('not-json'), undefined)
    assert.equal(parseSelectionHelperLine('{"type":"selection","text":"   "}'), undefined)
    assert.equal(parseSelectionHelperLine('{"type":"mouse-up","x":"1","y":2}'), undefined)
  })

  it('treats eight pixels as a drag and seven as a click', () => {
    assert.equal(draggedFarEnough(8, 0), true)
    assert.equal(draggedFarEnough(0, 7), false)
  })

  it('keeps the macOS monitor on a private run loop and the Windows hooks on a worker', () => {
    const swift = readFileSync(join(here, '../../native-selection/src/macos-selection.swift'), 'utf8')
    const worker = readFileSync(join(here, '../../native-selection/src/windows-hook-worker.js'), 'utf8')
    const hooks = readFileSync(join(here, '../../native-selection/src/windows-native.js'), 'utf8')
    assert.match(swift, /CFRunLoopRun/)
    assert.match(swift, /tapCreate/)
    assert.match(swift, /shouldRead/)
    assert.match(swift, /minDragPixels/)
    assert.match(swift, /@_cdecl\("dsh_macos_selection_start"\)/)
    assert.equal(swift.includes('setActivationPolicy'), false)
    assert.equal(swift.includes('DispatchQueue.main.sync'), false)
    assert.match(worker, /GetMessageW/)
    assert.match(worker, /SetWindowsHookExW/)
    assert.match(hooks, /worker_threads/)
    assert.match(hooks, /PostThreadMessageW/)
  })
})

describe('selection actions', () => {
  it('dedupes the same selection for three seconds', () => {
    let now = 1_000
    const shown: string[] = []
    const controller = new SelectionController(fakeHost({
      now: () => now,
      show: (payload) => { shown.push(payload.text) },
    }), () => undefined)
    const event = { type: 'selection' as const, text: 'same', pid: 4, bundle: 'app', x: 10, y: 20 }
    controller.onHelperEvent(event)
    controller.onHelperEvent(event)
    now += 2_999
    controller.onHelperEvent(event)
    now += 2
    controller.onHelperEvent(event)
    assert.deepEqual(shown, ['same', 'same'])
  })

  it('hides the toolbar and skips reads while a turn or a click is in progress', () => {
    const shown: string[] = []
    const hidden: string[] = []
    const controller = new SelectionController(fakeHost({
      show: (payload) => { shown.push(payload.text) },
      hide: () => { hidden.push('hide') },
    }), () => undefined)
    controller.setSessionRunning(true)
    controller.onHelperEvent({ type: 'selection', text: 'busy', x: 1, y: 2 })
    controller.setSessionRunning(false)
    controller.setHidInput(true)
    controller.onHelperEvent({ type: 'selection', text: 'click', x: 1, y: 2 })
    assert.deepEqual(shown, [])
    assert.equal(hidden.length, 2)
  })

  it('opens a Bing URL for search and starts a translate turn with the capture preamble', () => {
    assert.equal(selectionSearchUrl('a b'), 'https://www.bing.com/search?q=a%20b')
    const opened: string[] = []
    const prompted: string[] = []
    const attached: string[] = []
    const controller = new SelectionController(fakeHost({
      openExternal: (url) => { opened.push(url) },
      prompt: (text) => { prompted.push(text) },
      attach: (text) => { attached.push(text) },
      language: () => 'zh',
    }), () => undefined)
    controller.onHelperEvent({ type: 'selection', text: '你好', x: 8, y: 9 })
    controller.search()
    controller.translate()
    controller.sendToAgent()
    assert.deepEqual(opened, ['https://www.bing.com/search?q=%E4%BD%A0%E5%A5%BD'])
    assert.equal(prompted.length, 1)
    assert.equal(prompted[0]?.startsWith(SELECTION_PREAMBLE), true)
    assert.match(prompted[0] ?? '', /Translate the following into Chinese:\n\n你好$/)
    assert.equal(composeSelectionTranslatePrompt('hi', 'en').includes('into English'), true)
    assert.deepEqual(attached, ['你好'])
  })

  it('excludes the host and helper pids and restores the front app after translate', () => {
    // Selection monitoring is macOS/Windows only; on Linux the controller never starts.
    if (process.platform === 'linux') return
    const excluded: number[][] = []
    const activated: number[] = []
    const monitor: SelectionMonitorHandle = {
      stop() {},
      setExcludePids(pids) { excluded.push([...pids]) },
      activatePid(pid) { activated.push(pid) },
      lastFrontPid: () => undefined,
    }
    const host = fakeHost({ helperPid: () => 42, helperConnected: () => true, enabled: () => true })
    const controller = new SelectionController(host, () => monitor)
    controller.sync()
    controller.onHelperEvent({ type: 'selection', text: 'go', pid: 77, x: 1, y: 2 })
    controller.translate()
    assert.deepEqual(excluded[0], [process.pid, 42])
    assert.deepEqual(activated, [77])
  })
})

describe('windows selection dispatch', () => {
  it('reads a selection from an injected mouse-up and ignores excluded pids', async () => {
    const events: { type: string; text?: string }[] = []
    const handlers = { onEvent: (event: { type: string; text?: string }) => { events.push(event) } }
    dispatchWindowsSelectionMessage(
      { type: 'mouse-up', x: 1, y: 2, button: 'left' },
      handlers,
      { readSelection: async () => ({ text: 'picked', pid: 5, x: 1, y: 2, width: 3, height: 4 }), activatePid() {} },
      new Set(),
    )
    dispatchWindowsSelectionMessage(
      { type: 'mouse-up', x: 1, y: 2, button: 'left' },
      handlers,
      { readSelection: async () => ({ text: 'secret', pid: 5 }), activatePid() {} },
      new Set([5]),
    )
    dispatchWindowsSelectionMessage({ type: 'key' }, handlers, { readSelection: async () => undefined, activatePid() {} }, new Set())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(events.map((event) => event.type), ['mouse-up', 'mouse-up', 'key', 'selection'])
    assert.equal(events[3]?.text, 'picked')
  })
})

describe('overlay guard', () => {
  it('wraps captures in overlay-capture intervals when the helper is attached', async () => {
    const sent: { type?: unknown; active?: unknown }[] = []
    const guard = createOverlayGuard({
      hasHelper: () => true,
      send: async (message) => { sent.push(message) },
      setHidInput() {},
      sleep: async () => {},
    })
    const session = await guard.withCapture(async (value) => value)
    assert.deepEqual(session.excludeWindowIds, [])
    assert.deepEqual(sent.map((message) => [message.type, message.active]), [
      ['overlay-capture', true],
      ['overlay-capture', false],
    ])
  })

  it('captures without helper messages when no helper is attached', async () => {
    const sent: unknown[] = []
    const guard = createOverlayGuard({
      hasHelper: () => false,
      send: async (message) => { sent.push(message) },
      setHidInput() {},
      sleep: async () => {},
    })
    await guard.withCapture(async (value) => value)
    assert.deepEqual(sent, [])
  })

  it('does not send capture intervals nested inside an input cloak', async () => {
    const sent: { type?: unknown; active?: unknown }[] = []
    const pending = new Map<string, () => void>()
    const guard = createOverlayGuard({
      hasHelper: () => true,
      send: (message) => {
        sent.push(message)
        if (message.type === 'overlay-input' && message.active === true) {
          return new Promise((resolve) => { pending.set(message.id, resolve) })
        }
        return Promise.resolve()
      },
      setHidInput() {},
      sleep: async () => {},
    })
    const input = guard.withInput(async () => guard.withCapture(async () => 'inside'))
    await waitFor(() => sent.length === 1)
    assert.equal(sent[0]?.type, 'overlay-input')
    pending.get(sentId(sent, 0))?.()
    assert.equal(await input, 'inside')
    assert.deepEqual(sent.map((message) => message.type), ['overlay-input', 'overlay-input'])
  })

  it('still sends capture end when the run aborts after the begin ack', async () => {
    const sent: { type?: unknown; active?: unknown }[] = []
    const guard = createOverlayGuard({
      hasHelper: () => true,
      send: async (message) => { sent.push(message) },
      setHidInput() {},
      sleep: async () => {},
    })
    await assert.rejects(
      guard.withCapture(async () => {
        throw new Error('capture failed')
      }),
    )
    assert.deepEqual(sent.map((message) => [message.type, message.active]), [
      ['overlay-capture', true],
      ['overlay-capture', false],
    ])
  })

  it('waits for click-through and observation-frame acks, and toggles nested input once', async () => {
    const sent: { type?: unknown; active?: unknown; bounds?: unknown }[] = []
    let helper = true
    const pending = new Map<string, () => void>()
    const guard = createOverlayGuard({
      hasHelper: () => helper,
      send: (message) => {
        sent.push(message)
        if (message.active === false) return Promise.resolve()
        return new Promise((resolve) => { pending.set(message.id, resolve) })
      },
      setHidInput() {},
      sleep: async () => {},
    })
    let nested = false
    const input = guard.withInput(async () => {
      await guard.withInput(async () => { nested = true })
      return 'clicked'
    })
    await waitFor(() => sent.length === 1)
    assert.equal(sent[0]?.type, 'overlay-input')
    assert.equal(sent[0]?.active, true)
    pending.get(sentId(sent, 0))?.()
    assert.equal(await input, 'clicked')
    assert.equal(nested, true)
    assert.equal(sent.length, 2)
    assert.equal(sent[1]?.active, false)

    const frame = guard.setObservationFrame({ x: 1, y: 2, width: 3, height: 4 })
    await waitFor(() => sent.length === 3)
    assert.equal(sent[2]?.type, 'observation-frame')
    assert.deepEqual(sent[2]?.bounds, { x: 1, y: 2, width: 3, height: 4 })
    pending.get(sentId(sent, 2))?.()
    await frame

    helper = false
    const hidden = guard.setObservationFrame(null)
    await hidden
    assert.equal(sent.length, 3)
  })
})

function sentId(sent: { id?: unknown }[], index: number): string {
  const id = sent[index]?.id
  if (typeof id !== 'string') throw new Error('missing ack id')
  return id
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function fakeHost(overrides: Partial<SelectionHost> = {}): SelectionHost {
  return {
    enabled: () => true,
    language: () => 'zh',
    setLanguage() {},
    helperConnected: () => false,
    helperPid: () => undefined,
    show() {},
    hide() {},
    pointer() {},
    attach() {},
    prompt() {},
    openExternal() {},
    requestAccessibility: () => false,
    accessibilityTrusted: () => false,
    now: () => 0,
    ...overrides,
  }
}
