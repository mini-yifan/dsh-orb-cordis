import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { chooseTarget, cliCombo, frameOf, frameStillValid, pointToScreen, registerGuiTools } from '../src/gui.ts'
import { pasteScript, refOf } from '../src/hid.ts'
import type { WindowInfo } from '../src/protocol.ts'

/**
 * The visual route's arithmetic and choices.
 *
 * These are the parts of `desktop` that decide whether a point lands on the
 * control the model aimed at, and which window a bare app name means. Both have
 * been wrong in production: the first because macOS draws a drop shadow outside
 * the window rectangle, the second because an app with two windows made an
 * app-name read fail outright.
 *
 * Nothing here spawns the CLI or touches a screen.
 */

// Measured on this machine: a QQ window of 720x640 points at 2x captures
// 1440x1280 with two pixels of shadow on each side after rounding.
const qqBounds = { x: 375, y: 136, width: 720, height: 640 }
const qqShot = { width: 1440, height: 1280, scale: 2 }

// The shadowed case: 1470x846 points at 2x plus 68 physical pixels per side.
const shadowBounds = { x: 0, y: 33, width: 1470, height: 846 }
const shadowShot = { width: 3076, height: 1828, scale: 2 }

test('the picture centre maps to the window centre', () => {
  const frame = frameOf(shadowBounds, shadowShot)
  const at = pointToScreen(frame, [500, 500])
  assert.equal(at.x, shadowBounds.x + shadowBounds.width / 2)
  assert.equal(at.y, shadowBounds.y + shadowBounds.height / 2)
})

test('the top-left of the picture lands one shadow outside the window', () => {
  const frame = frameOf(shadowBounds, shadowShot)
  // 68 physical px / 2 = 34 points of shadow above and left of the window.
  assert.deepEqual(pointToScreen(frame, [0, 0]), { x: shadowBounds.x - 34, y: shadowBounds.y - 34 })
})

test('the bottom-right of the picture lands one shadow past the window', () => {
  const frame = frameOf(shadowBounds, shadowShot)
  assert.deepEqual(pointToScreen(frame, [1000, 1000]), {
    x: shadowBounds.x + shadowBounds.width + 34,
    y: shadowBounds.y + shadowBounds.height + 34,
  })
})

test('a display with no shadow maps straight onto the window rectangle', () => {
  const flat = { x: -218, y: -1080, width: 1920, height: 1080 }
  const frame = frameOf(flat, { width: 1920, height: 1080, scale: 1 })
  assert.deepEqual(pointToScreen(frame, [0, 0]), { x: flat.x, y: flat.y })
  assert.deepEqual(pointToScreen(frame, [1000, 1000]), { x: flat.x + 1920, y: flat.y + 1080 })
})

test('a sane capture needs no shadow correction', () => {
  const frame = frameOf(qqBounds, qqShot)
  assert.deepEqual(pointToScreen(frame, [0, 0]), { x: qqBounds.x, y: qqBounds.y })
})

test('a degenerate capture never divides by zero', () => {
  const frame = frameOf(qqBounds, { width: 0, height: 0, scale: 0 })
  assert.equal(Number.isFinite(frame.spanX), true)
  assert.equal(Number.isFinite(frame.spanY), true)
  assert.equal(Number.isFinite(pointToScreen(frame, [500, 500]).x), true)
})

test('the picture stays valid while the window keeps its rectangle', () => {
  const frame = { bounds: { x: 0, y: 33, width: 1470, height: 923 } }
  assert.equal(frameStillValid(frame, { x: 0, y: 33, width: 1470, height: 923 }), true)
})

test('a moved, resized, or bound-less window invalidates the picture', () => {
  const frame = { bounds: { x: 0, y: 33, width: 1470, height: 923 } }
  assert.equal(frameStillValid(frame, { x: 4, y: 33, width: 1470, height: 923 }), false)
  assert.equal(frameStillValid(frame, { x: 0, y: 40, width: 1470, height: 923 }), false)
  assert.equal(frameStillValid(frame, { x: 0, y: 33, width: 1400, height: 923 }), false)
  assert.equal(frameStillValid(frame, undefined), false)
})

const win = (
  id: string,
  appName: string,
  title: string,
  width: number,
  height: number,
  extra: Partial<WindowInfo> = {},
): WindowInfo => ({
  id,
  title,
  appName,
  pid: 1,
  focused: false,
  accessible: true,
  visible: true,
  bounds: { x: 0, y: 0, width, height },
  ...extra,
})

test('a window id picks that window, with or without its w- prefix', () => {
  const windows = [win('w-1', 'QQ', 'QQ', 720, 640), win('w-2', 'QQ', '登录', 350, 510)]
  assert.equal(chooseTarget(windows, { window: 'w-2' }, undefined).target?.windowId, 'w-2')
  assert.equal(chooseTarget(windows, { window: '2' }, undefined).target?.windowId, 'w-2')
})

test('an app with several windows picks one and names the rest', () => {
  const windows = [
    win('w-1', 'QQ', 'QQ', 720, 640),
    win('w-2', 'QQ', '登录', 350, 510),
    win('w-3', 'Notes', 'Untitled', 900, 700),
  ]
  const chosen = chooseTarget(windows, { app: 'QQ' }, undefined)
  // The largest is the main window, and the sibling is reported, not refused.
  assert.equal(chosen.target?.windowId, 'w-1')
  assert.deepEqual(chosen.siblings.map(window => window.windowId), ['w-2'])
})

test('a focused window wins over a larger one', () => {
  const windows = [
    win('w-1', 'QQ', 'QQ', 720, 640),
    win('w-2', 'QQ', '登录', 350, 510, { focused: true }),
  ]
  assert.equal(chooseTarget(windows, { app: 'QQ' }, undefined).target?.windowId, 'w-2')
})

test('without an app, the session keeps the window it last looked at', () => {
  const windows = [win('w-1', 'QQ', 'QQ', 720, 640), win('w-3', 'Notes', 'Untitled', 900, 700, { focused: true })]
  assert.equal(chooseTarget(windows, {}, 'w-1').target?.windowId, 'w-1')
  // A window that closed falls through to the one in front.
  assert.equal(chooseTarget(windows, {}, 'w-9').target?.windowId, 'w-3')
  assert.equal(chooseTarget(windows, {}, undefined).target?.windowId, 'w-3')
})

test('an unknown app is named along with what is actually open', () => {
  const chosen = chooseTarget([win('w-1', 'QQ', 'QQ', 720, 640)], { app: 'Calculator' }, undefined)
  assert.equal(chosen.target, undefined)
  assert.match(chosen.why, /Calculator/)
  assert.match(chosen.why, /QQ/)
})

test('a localized app name does not cross-match, but case does', () => {
  // Finder reports 访达 on this machine; an exact localized name is required.
  const windows = [win('w-1', '访达', '桌面', 920, 436)]
  assert.equal(chooseTarget(windows, { app: 'Finder' }, undefined).target, undefined)
  assert.equal(chooseTarget(windows, { app: '访达' }, undefined).target?.windowId, 'w-1')
  assert.equal(chooseTarget([win('w-1', 'QQ', 'QQ', 720, 640)], { app: 'qq' }, undefined).target?.windowId, 'w-1')
})

test('a hidden helper window is never picked and never listed', () => {
  // Measured on this machine: QQ owns 13 windows and shows 1. The other 12 are
  // menu-bar strips, 1x1 renderers and hidden 720x640 surfaces.
  const windows = [
    win('w-1', 'QQ', 'QQ', 1470, 846),
    win('w-2', 'QQ', 'QQ', 720, 640, { visible: false }),
    win('w-3', 'QQ', 'QQ', 1920, 30, { visible: false }),
    win('w-4', 'QQ', 'QQ', 1, 1, { visible: false }),
  ]
  const chosen = chooseTarget(windows, { app: 'QQ' }, undefined)
  assert.equal(chosen.target?.windowId, 'w-1')
  assert.equal(chosen.target?.visible, true)
  assert.deepEqual(chosen.siblings, [], 'hidden surfaces must not be offered as targets')
})

test('an app with no window on screen still resolves, so see can show how blank it is', () => {
  const windows = [win('w-2', 'QQ', 'QQ', 720, 640, { visible: false })]
  const chosen = chooseTarget(windows, { app: 'QQ' }, undefined)
  assert.equal(chosen.target?.windowId, 'w-2')
  assert.equal(chosen.target?.visible, false)
})

test('the last window is dropped once it leaves the screen', () => {
  const windows = [
    win('w-1', 'QQ', 'QQ', 1470, 846),
    win('w-2', 'QQ', 'QQ', 720, 640, { visible: false }),
  ]
  // A hidden window cannot be focused, so keeping it would fail the next click
  // for a reason the model cannot see.
  assert.equal(chooseTarget(windows, {}, 'w-2').target?.windowId, 'w-1')
})

test('a window the model names explicitly is still returned, hidden or not', () => {
  const windows = [win('w-9', 'QQ', 'QQ', 720, 640, { visible: false })]
  const chosen = chooseTarget(windows, { window: 'w-9' }, undefined)
  assert.equal(chosen.target?.windowId, 'w-9')
  assert.equal(chosen.target?.visible, false)
})

test('a key combo is translated into the CLI vocabulary', () => {
  // The tools take the array form: ["cmd", "c"] cannot be mis-parsed.
  assert.equal(cliCombo(['cmd', 'c']), 'cmd+c')
  assert.equal(cliCombo(['Return']), 'return')
  assert.equal(cliCombo(['cmd', 'Shift', '4']), 'cmd+shift+4')
  assert.equal(cliCombo(['Option']), 'alt')
  assert.equal(cliCombo([]), '')
  assert.equal(cliCombo('Return'), 'return')
  assert.equal(cliCombo('Enter'), 'return')
  assert.equal(cliCombo('ESC'), 'escape')
  assert.equal(cliCombo('cmd+c'), 'cmd+c')
  assert.equal(cliCombo('Command+Shift+4'), 'cmd+shift+4')
  assert.equal(cliCombo('Tab'), 'tab')
  assert.equal(cliCombo('space'), 'space')
})

test('the paste script keeps every clipboard type and puts it back', () => {
  const script = pasteScript('今日青岛天气：小雨')
  assert.match(script, /clipboardSnapshot\(pb\)/)
  assert.match(script, /restoreClipboard\(pb, previous\)/)
  // The restore must happen after the paste, not before it.
  assert.ok(script.indexOf('restoreClipboard(pb, previous)') > script.indexOf('chord([KEY_CMD, KEY_V])'))
  // Text is embedded as a JS string literal, so quotes and newlines survive.
  const tricky = pasteScript('he said "hi"\nline 2\\')
  assert.match(tricky, /stringWithString\("he said \\"hi\\"\\nline 2\\\\"\)/)
  assert.doesNotMatch(tricky, /tapKey\(KEY_ENTER/)
})

test('enter is pressed after the paste and the restore', () => {
  const script = pasteScript('hi', { enter: true })
  assert.ok(script.indexOf('tapKey(KEY_ENTER') > script.indexOf('restoreClipboard(pb, previous)'))
})

test('replace selects the field before pasting', () => {
  const script = pasteScript('hi', { replace: true })
  assert.ok(script.indexOf('chord([KEY_CMD, KEY_A])') < script.indexOf('chord([KEY_CMD, KEY_V])'))
})

/** A context that registers tools and can answer the image-modality question. */
function harness(options: { images: boolean }) {
  const tools = new Map<string, { name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string }> }>()
  const ctx = {
    tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } },
    effect: () => ({ dispose: () => {} }),
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        async resolveModelInfo() {
          return { inputModalities: options.images ? ['text', 'image'] : ['text'] }
        },
      }
    },
    attachments: {
      async saveImage() {
        return { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 100, height: 50 }
      },
    },
  }
  registerGuiTools(ctx as never, resolveConfig())
  return { tools }
}

const exec = {
  agent: {
    id: 'agent-1',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
  },
  signal: AbortSignal.timeout(5_000),
}

test('a find answer is read whichever shape it came back in', () => {
  // `find --first` answers { match }; without --first it answers { matches }.
  // Reading only one of them made every text lookup a miss, which fell through
  // five sequential probes and then pasted — 10 s across two calls in a real run.
  assert.equal(refOf({ match: { ref_id: '@s1:e1', role: 'textfield' } }), '@s1:e1')
  assert.equal(refOf({ matches: [{ ref_id: '@s2:e4', role: 'textarea' }] }), '@s2:e4')
  assert.equal(refOf({ matches: [] }), undefined)
  assert.equal(refOf({}), undefined)
  assert.equal(refOf(undefined), undefined)
})

test('an overlay list is read from either shape the CLI uses', async () => {
  const { surfacesOf } = await import('../src/vision.ts')
  assert.deepEqual(surfacesOf(['menu', 'sheet']), ['menu', 'sheet'])
  assert.deepEqual(surfacesOf([{ kind: 'popover' }, { kind: '' }]), ['popover'])
  assert.equal(surfacesOf([]), undefined)
  assert.equal(surfacesOf(undefined), undefined)
})

test('registers one tool per gesture, the Computer Use set', () => {
  const { tools } = harness({ images: true })
  assert.deepEqual([...tools.keys()].sort(), [
    'desktop_click',
    'desktop_drag',
    'desktop_hotkey',
    'desktop_input_text',
    'desktop_open_app',
    'desktop_scroll',
    'desktop_see',
    'desktop_wait',
  ])
})

test('a text-only model is refused before any window is touched', async () => {
  const { tools } = harness({ images: false })
  const tool = tools.get('desktop_see')
  assert.ok(tool)
  await assert.rejects(
    () => tool.execute({}, exec),
    /needs a model that declares image input.*desktop_inspect/s,
  )
})

test('shadowless capture maps 0-1000 points directly onto window bounds with 0pt offset', () => {
  const settingsBounds = { x: 281, y: 33, width: 723, height: 846 }
  const frame = frameOf(settingsBounds, { width: 1446, height: 1692, scale: 2, shadowless: true })
  assert.deepEqual(pointToScreen(frame, [0, 0]), { x: 281, y: 33 })
  assert.deepEqual(pointToScreen(frame, [500, 500]), { x: Math.round(281 + 723 / 2), y: Math.round(33 + 846 / 2) })
  assert.deepEqual(pointToScreen(frame, [1000, 1000]), { x: 281 + 723, y: 33 + 846 })
})

test('desktop_open_app returns AX tree without screenshot when window is accessible and rich', async () => {
  const { RefBook } = await import('../src/sessions.ts')
  const refs = new RefBook()
  let captured = false
  const tools = new Map<string, { name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string, image?: unknown }> }>()
  const ctx = {
    tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } },
    effect: () => ({ dispose: () => {} }),
    get: () => undefined,
    attachments: {
      async saveImage() {
        return { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 100, height: 50 }
      },
    },
  }
  const sessions = { async entry() { return { client: { alive: true }, refs, lastUsed: Date.now() } } }
  registerGuiTools(ctx as never, resolveConfig(), {
    activate: async () => {},
    sessions: sessions as never,
    resolveAppPid: async () => 101,
    sessionState: async () => ({ locked: false }),
    listWindows: async () => ({
      ok: true,
      data: [{
        id: 'w-100',
        title: '系统设置',
        appName: '系统设置',
        pid: 101,
        focused: true,
        accessible: true,
        visible: true,
        bounds: { x: 100, y: 50, width: 723, height: 846 },
      }],
    }),
    snapshot: async () => ({
      ok: true,
      data: {
        app: '系统设置',
        windowId: 'w-100',
        windowTitle: '系统设置',
        snapshotId: 's_open',
        refCount: 3,
        complete: true,
        tree: {
          role: 'window',
          children: [
            { role: 'button', name: '桌面与程序坞', ref: '@s_open:e1', actions: ['Click'] },
            { role: 'button', name: '外观', ref: '@s_open:e2', actions: ['Click'] },
            { role: 'combobox', name: '默认网页浏览器', value: 'Google Chrome', ref: '@s_open:e3', actions: ['Click'] },
          ],
        },
      },
    }),
    capture: async () => {
      captured = true
      return { ok: true, data: { data: '', format: 'png', width: 100, height: 100, scale_factor: 1, shadowless: true } }
    },
  })
  const openTool = tools.get('desktop_open_app')
  assert.ok(openTool)
  const res = await openTool.execute({ name: 'System Settings' }, exec)
  assert.equal(captured, false, 'should not capture screenshot when AX tree is usable')
  assert.equal(res.image, undefined)
  assert.match(res.text, /window 系统设置 w-100/)
  assert.match(res.text, /默认网页浏览器/)
  assert.equal(refs.lookup('@s_open:e3')?.known, true)
})

test('desktop_open_app falls back to shadowless screenshot when tree=no or visual=true', async () => {
  const { RefBook } = await import('../src/sessions.ts')
  const refs = new RefBook()
  let captureCount = 0
  const tools = new Map<string, { name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string, image?: unknown }> }>()
  const ctx = {
    tools: { register: (tool: { name: string }) => { tools.set(tool.name, tool as never) } },
    effect: () => ({ dispose: () => {} }),
    get(name: string) {
      if (name !== 'llm') return undefined
      return { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } }
    },
    attachments: {
      async saveImage() {
        return { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 723, height: 846 }
      },
    },
  }
  const sessions = { async entry() { return { client: { alive: true }, refs, lastUsed: Date.now() } } }
  registerGuiTools(ctx as never, resolveConfig(), {
    activate: async () => {},
    sessions: sessions as never,
    resolveAppPid: async () => 202,
    sessionState: async () => ({ locked: false }),
    listWindows: async () => ({
      ok: true,
      data: [{
        id: 'w-200',
        title: 'CanvasApp',
        appName: 'CanvasApp',
        pid: 202,
        focused: true,
        accessible: false,
        visible: true,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }],
    }),
    capture: async () => {
      captureCount += 1
      return { ok: true, data: { data: Buffer.from('x').toString('base64'), format: 'png', width: 1600, height: 1200, scale_factor: 2, shadowless: true } }
    },
  })
  const openTool = tools.get('desktop_open_app')
  assert.ok(openTool)
  const res = await openTool.execute({ name: 'CanvasApp' }, exec)
  assert.equal(captureCount, 1)
  assert.ok(res.image !== undefined)
  assert.match(res.text, /tree=no/)
})
