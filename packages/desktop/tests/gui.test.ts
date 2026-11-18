import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { chooseTarget, cliCombo, frameOf, frameStillValid, pointToScreen, registerGuiTools } from '../src/gui.ts'
import { pasteScript } from '../src/hid.ts'
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

test('a key combo is translated into the CLI vocabulary', () => {
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

test('registers exactly one visual tool', () => {
  const { tools } = harness({ images: true })
  assert.deepEqual([...tools.keys()], ['desktop'])
})

test('a text-only model is refused before any window is touched', async () => {
  const { tools } = harness({ images: false })
  const tool = tools.get('desktop')
  assert.ok(tool)
  await assert.rejects(
    () => tool.execute({ action: 'see' }, exec),
    /needs a model that declares image input.*desktop_inspect/s,
  )
})
