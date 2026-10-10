import { describe, expect, it, vi } from 'vitest'

const produced = vi.hoisted(() => ({ count: 0 }))

vi.mock('../src/windows-native.ts', () => ({
  createProductionWindowsOps: () => {
    produced.count += 1
    return {
      listWindows: () => ({ foregroundHwnd: 0, windows: [] }),
      capturePng: () => Uint8Array.from([]),
      targetBlocksInput: (_hwnd: number) => false,
      windowFromPoint: () => 0,
      movePointer: () => undefined,
      mouseButton: () => undefined,
      scrollWheel: () => undefined,
      key: () => undefined,
      readClipboardText: () => '',
      setClipboardText: () => undefined,
      copyImageFile: () => undefined,
      listWindowApps: () => [],
      activateApp: () => false,
      foregroundWindowId: () => 0,
      focusWindow: () => false,
      launch: () => undefined,
      explorerFolder: () => undefined,
    }
  },
}))
import { runWithCaptureExcludeWindowIds } from '../src/capture-exclude.ts'
import { wrapDesktopBackend } from '../src/overlay-guard.ts'
import type { WindowsDesktopSnapshot, WindowsWindowFact } from '../src/windows-foreground.ts'
import {
  createWindowsDesktopBackend,
  encodeBgraPng,
  windowsKeyIsExtended,
  windowsVirtualKey,
  type WindowsDesktopOps,
} from '../src/windows.ts'

const bounds = { x: 10, y: 20, width: 100, height: 80 }
const png = encodeBgraPng(1, 1, Buffer.from([1, 2, 3, 255]), false)

function fact(overrides: Partial<WindowsWindowFact> = {}): WindowsWindowFact {
  return {
    hwnd: 5,
    pid: 10,
    ownerHwnd: 0,
    className: 'Notepad',
    appName: 'notepad',
    title: 'notes.txt',
    visible: true,
    iconic: false,
    cloaked: false,
    toolWindow: false,
    popup: false,
    frame: bounds,
    monitor: { x: 0, y: 0, width: 1920, height: 1080 },
    monitorDpi: 96,
    ...overrides,
  }
}

function shot(windows: readonly WindowsWindowFact[], foregroundHwnd = windows[0]?.hwnd ?? 0): WindowsDesktopSnapshot {
  return { foregroundHwnd, windows }
}

function ops(overrides: Partial<WindowsDesktopOps> = {}): WindowsDesktopOps & {
  readonly calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    listWindows: () => shot([fact()]),
    capturePng: () => png,
    targetBlocksInput: (_hwnd) => false,
    windowFromPoint: () => 0,
    movePointer: (x, y) => { calls.push(`move:${String(x)},${String(y)}`) },
    mouseButton: (_button, down) => { calls.push(down ? 'down' : 'up') },
    scrollWheel: (_x, _y, delta) => { calls.push(`wheel:${String(delta)}`) },
    key: (virtualKey, down, extended) => {
      calls.push(`key:${String(virtualKey)}:${down ? 'down' : 'up'}:${extended ? '1' : '0'}`)
    },
    readClipboardText: () => 'previous',
    setClipboardText: (text) => { calls.push(`clip:${text}`) },
    copyImageFile: (path) => { calls.push(`image:${path}`) },
    listWindowApps: () => ['notepad', 'explorer'],
    activateApp: () => false,
    foregroundWindowId: () => 0,
    focusWindow: () => false,
    launch: (target) => { calls.push(`launch:${target}`) },
    explorerFolder: () => undefined,
    ...overrides,
  }
}

describe('windows desktop backend', () => {
  it('encodes a one-pixel PNG and maps key names', () => {
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(encodeBgraPng(1, 1, Buffer.from([1, 2, 3, 255]), true).byteLength).toBeGreaterThan(8)
    expect(encodeBgraPng(1, 1, Buffer.alloc(0), false).byteLength).toBeGreaterThan(8)
    expect(windowsVirtualKey('ctrl')).toBe(0x11)
    expect(windowsVirtualKey('V')).toBe(0x56)
    expect(windowsVirtualKey('5')).toBe(0x35)
    expect(windowsVirtualKey('f12')).toBe(0x7B)
    expect(windowsVirtualKey('insert')).toBe(0x2D)
    expect(windowsKeyIsExtended('Delete')).toBe(true)
    expect(windowsKeyIsExtended('a')).toBe(false)
    // The Windows key is `E0 5B`, an extended scan code, under every alias.
    for (const name of ['win', 'windows', 'meta', 'cmd', 'command', 'super']) {
      expect(windowsKeyIsExtended(name)).toBe(true)
    }
    expect(() => { windowsVirtualKey('not-a-key') }).toThrow(/unknown key/u)
  })

  it('captures the selected window and reports an Explorer folder as finderFolder', async () => {
    const popup = fact({
      hwnd: 6,
      popup: true,
      title: '',
      frame: { x: 90, y: 20, width: 40, height: 80 },
    })
    const host = ops({
      listWindows: () => shot([fact({ appName: 'explorer', title: 'notes.txt' }), popup]),
      explorerFolder: hwnd => (hwnd === 5 ? 'C:\\work' : undefined),
    })
    const backend = createWindowsDesktopBackend(host)
    const screens = await backend.listScreens()
    expect(screens).toEqual([{
      index: 0,
      bounds: { x: 10, y: 20, width: 120, height: 80 },
      scale: 1,
      windowId: 5,
      transientWindowIds: [6],
      appName: 'explorer',
    }])
    await expect(backend.capture(screens[0]!)).resolves.toEqual({ data: png, mediaType: 'image/png' })
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: 'explorer',
      windowTitle: 'notes.txt',
      finderFolder: 'C:\\work',
    })
    await expect(backend.listApps()).resolves.toEqual(['notepad', 'explorer'])
  })

  it('skips an excluded foreground hwnd and omits an empty title', async () => {
    const ball = fact({ hwnd: 9, appName: 'electron', title: 'ball', frame: { x: 0, y: 0, width: 80, height: 80 } })
    const notes = fact({ title: '   ' })
    const host = ops({ listWindows: () => shot([ball, notes], 9) })
    const backend = createWindowsDesktopBackend(host)
    await runWithCaptureExcludeWindowIds([9], async () => {
      await expect(backend.listScreens()).resolves.toEqual([{
        index: 0,
        bounds,
        scale: 1,
        windowId: 5,
        appName: 'notepad',
      }])
      await expect(backend.inspectForeground()).resolves.toEqual({
        appName: 'notepad',
        focusNote: 'Keyboard focus is on another window. hotkey brings this window forward first; click inside it if focus must land on a specific control.',
      })
    })
  })

  it('clicks, double-clicks, and pastes through the clipboard before restoring it', async () => {
    const host = ops()
    const screen = { index: 0, bounds, scale: 1 }
    const backend = createWindowsDesktopBackend(host)
    await backend.click({ screen, position: [0, 0], button: 'left', count: 1 })
    expect(host.calls).toEqual(['move:10,20', 'down', 'up'])
    host.calls.length = 0
    await backend.click({ screen, position: [1000, 1000], button: 'right', count: 2 })
    expect(host.calls).toEqual(['move:110,100', 'down', 'up', 'down', 'up'])
    host.calls.length = 0
    await backend.typeText({ screen, position: [500, 1000], text: 'hi', replace: true, submit: true })
    const pasteUp = host.calls.indexOf('key:86:up:0')
    const restore = host.calls.indexOf('clip:previous')
    expect(host.calls).toContain('clip:hi')
    expect(host.calls.indexOf('clip:hi')).toBeLessThan(host.calls.indexOf('key:86:down:0'))
    expect(pasteUp).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(pasteUp)
    expect(host.calls.at(-1)).toBe('clip:previous')
    expect(host.calls).toContain('key:13:down:0')
    host.calls.length = 0
    await backend.typeText({ screen, position: [0, 0], text: 'x', replace: false, submit: false })
    expect(host.calls).not.toContain('key:65:down:0')
    expect(host.calls).not.toContain('key:13:down:0')
    expect(host.calls.at(-1)).toBe('clip:previous')
  })

  it('holds click modifiers only for that click', async () => {
    const host = ops()
    const screen = { index: 0, bounds, scale: 1 }
    const backend = createWindowsDesktopBackend(host)
    await backend.click({ screen, position: [0, 0], button: 'left', count: 1, modifiers: ['shift', 'control'] })
    expect(host.calls).toEqual([
      'key:16:down:0',
      'key:17:down:0',
      'move:10,20',
      'down',
      'up',
      'key:17:up:0',
      'key:16:up:0',
    ])
    host.calls.length = 0
    // The Win key carries the extended scan code, and is still released after the click.
    await backend.click({ screen, position: [0, 0], button: 'left', count: 1, modifiers: ['cmd'] })
    expect(host.calls).toEqual(['key:91:down:1', 'move:10,20', 'down', 'up', 'key:91:up:1'])
  })

  it('releases the button and every key when an input is cancelled mid-press', async () => {
    const screen = { index: 0, bounds, scale: 1 }

    // Cancelled during the button hold: the press still gets its release.
    const clickController = new AbortController()
    const clicking = ops({
      mouseButton: (_button, down) => {
        clicking.calls.push(down ? 'down' : 'up')
        if (down) clickController.abort()
      },
    })
    await expect(createWindowsDesktopBackend(clicking).click(
      { screen, position: [0, 0], button: 'left', count: 1 },
      clickController.signal,
    )).rejects.toThrow()
    expect(clicking.calls).toEqual(['move:10,20', 'down', 'up'])

    // Cancelled right after the press: the drag must not leave the left button down.
    const dragController = new AbortController()
    const dragging = ops({
      mouseButton: (_button, down) => {
        dragging.calls.push(down ? 'down' : 'up')
        if (down) dragController.abort()
      },
    })
    await expect(createWindowsDesktopBackend(dragging).drag({
      startScreen: screen, startPosition: [0, 0], endScreen: screen, endPosition: [1000, 1000],
    }, dragController.signal)).rejects.toThrow()
    expect(dragging.calls.filter((call) => call === 'down')).toEqual(['down'])
    expect(dragging.calls.at(-1)).toBe('up')

    // Cancelled on the modifier gap: the held modifier comes back up.
    const chordController = new AbortController()
    const chords = ops({
      key: (virtualKey, down, extended) => {
        chords.calls.push(`key:${String(virtualKey)}:${down ? 'down' : 'up'}:${extended ? '1' : '0'}`)
        if (down) chordController.abort()
      },
    })
    await expect(createWindowsDesktopBackend(chords).hotkey(
      { keys: ['ctrl', 'c'] },
      chordController.signal,
    )).rejects.toThrow()
    expect(chords.calls).toEqual(['key:17:down:0', 'key:17:up:0'])
  })

  it('posts extended navigation keys, modifier chords, and one wheel notch per level', async () => {
    const host = ops()
    const screen = { index: 0, bounds, scale: 1 }
    const backend = createWindowsDesktopBackend(host)
    await backend.hotkey({ keys: ['ctrl', 'c'] })
    expect(host.calls).toEqual([
      'key:17:down:0',
      'key:67:down:0',
      'key:67:up:0',
      'key:17:up:0',
    ])
    host.calls.length = 0
    await backend.hotkey({ keys: ['delete'] })
    expect(host.calls).toEqual(['key:46:down:1', 'key:46:up:1'])
    host.calls.length = 0
    await backend.hotkey({ keys: ['win'] })
    expect(host.calls).toEqual(['key:91:down:1', 'key:91:up:1'])
    host.calls.length = 0
    await backend.hotkey({ keys: [] })
    expect(host.calls).toEqual([])
    await backend.scroll({ screen, position: [0, 0], direction: 'down', scrollLevel: 2 })
    expect(host.calls).toEqual(['wheel:-120', 'wheel:-120'])
    host.calls.length = 0
    await backend.scroll({ screen, position: [0, 0], direction: 'up', scrollLevel: 1 })
    expect(host.calls).toEqual(['wheel:120'])
  })

  it('brings the observed window forward before a hotkey when focus is elsewhere', async () => {
    const ball = fact({ hwnd: 9, appName: 'electron', title: 'ball' })
    const host = ops({
      listWindows: () => shot([ball, fact()], 9),
      foregroundWindowId: () => 9,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return true
      },
    })
    const backend = createWindowsDesktopBackend(host)
    await runWithCaptureExcludeWindowIds([9], async () => {
      await backend.listScreens()
      await backend.hotkey({ keys: ['ctrl', 'w'], windowId: 5, appName: 'notepad' })
    })
    const focusAt = host.calls.indexOf('focus:5')
    expect(focusAt).toBeGreaterThan(-1)
    expect(focusAt).toBeLessThan(host.calls.indexOf('key:17:down:0'))
    expect(host.calls).toContain('key:87:down:0')
  })

  it('does not move focus when the foreground window is the owner or its menu', async () => {
    const menu = fact({
      hwnd: 11,
      pid: 99,
      className: '#32768',
      popup: true,
      title: '',
      frame: { x: 90, y: 20, width: 40, height: 40 },
    })
    const host = ops({
      listWindows: () => shot([fact(), menu], 11),
      foregroundWindowId: () => 11,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return true
      },
    })
    const backend = createWindowsDesktopBackend(host)
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: 'notepad',
      windowTitle: 'notes.txt',
    })
    await backend.listScreens()
    await backend.hotkey({ keys: ['ctrl', 'w'], windowId: 5, transientWindowIds: [11], appName: 'notepad' })
    expect(host.calls.some(call => call.startsWith('focus:'))).toBe(false)
    host.calls.length = 0
    const focused = ops({
      foregroundWindowId: () => 5,
      focusWindow: (hwnd) => {
        focused.calls.push(`focus:${String(hwnd)}`)
        return true
      },
    })
    const owning = createWindowsDesktopBackend(focused)
    await owning.listScreens()
    await owning.hotkey({ keys: ['escape'], windowId: 5, appName: 'notepad' })
    expect(focused.calls.some(call => call.startsWith('focus:'))).toBe(false)
    expect(focused.calls).toEqual(['key:27:down:0', 'key:27:up:0'])
  })

  it('posts no keys when the observed window cannot become foreground', async () => {
    const ball = fact({ hwnd: 9, appName: 'electron', title: 'ball' })
    const host = ops({
      listWindows: () => shot([ball, fact()], 9),
      foregroundWindowId: () => 9,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return false
      },
    })
    const backend = createWindowsDesktopBackend(host)
    await runWithCaptureExcludeWindowIds([9], async () => {
      await backend.listScreens()
      await expect(backend.hotkey({ keys: ['ctrl', 'w'], windowId: 5, appName: 'notepad' })).rejects.toThrow(
        'computer-use: keyboard focus could not be moved to notepad; click inside the window, then retry hotkey',
      )
    })
    expect(host.calls).toEqual(['focus:5'])
  })

  it('keeps a hotkey on the window its own observation selected', async () => {
    // Session A observed hwnd 5; a later listing (another session's screenshot) picks 9.
    let windows = shot([fact()], 5)
    const host = ops({
      listWindows: () => windows,
      foregroundWindowId: () => 0,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return true
      },
    })
    const backend = createWindowsDesktopBackend(host)
    const observed = await backend.listScreens()
    expect(observed[0]?.windowId).toBe(5)
    windows = shot([fact({ hwnd: 9, appName: 'electron', title: 'other' })], 9)
    await backend.listScreens()
    await backend.hotkey({
      keys: ['ctrl', 'w'],
      windowId: observed[0]?.windowId,
      appName: observed[0]?.appName,
    })
    // The passed window decides; the later listing never redirects the keys.
    expect(host.calls.filter(call => call.startsWith('focus:'))).toEqual(['focus:5'])
  })

  it('focuses the observed window through the capture wrapper, never the ball', async () => {
    const ball = fact({ hwnd: 9, appName: 'electron', title: 'ball' })
    const host = ops({
      listWindows: () => shot([ball, fact()], 9),
      foregroundWindowId: () => 9,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return true
      },
    })
    const backend = wrapDesktopBackend(createWindowsDesktopBackend(host), {
      withCapture: run => run({ excludeWindowIds: [9] }),
      withInput: run => run(),
      setObservationFrame: () => Promise.resolve(),
    })
    const observed = await backend.listScreens()
    expect(observed[0]?.windowId).toBe(5)
    await backend.hotkey({
      keys: ['ctrl', 'w'],
      windowId: observed[0]?.windowId,
      transientWindowIds: observed[0]?.transientWindowIds,
      appName: observed[0]?.appName,
    })
    expect(host.calls).toContain('focus:5')
    expect(host.calls).not.toContain('focus:9')
  })

  it('drags in steps and holds a long press', async () => {
    const host = ops()
    const screen = { index: 0, bounds, scale: 1 }
    const backend = createWindowsDesktopBackend(host)
    await backend.drag({
      startScreen: screen,
      startPosition: [0, 0],
      endScreen: screen,
      endPosition: [1000, 1000],
    })
    const moves = host.calls.filter(call => call.startsWith('move:'))
    expect(moves).toHaveLength(11)
    expect(moves[0]).toBe('move:10,20')
    expect(moves.at(-1)).toBe('move:110,100')
    expect(host.calls.filter(call => call === 'down')).toEqual(['down'])
    expect(host.calls.at(-1)).toBe('up')
    host.calls.length = 0
    await backend.longPress({ screen, position: [0, 0], durationSeconds: 0 })
    expect(host.calls).toEqual(['move:10,20', 'down', 'up'])
  })

  it('refuses a hotkey into the elevated observed window and opens Explorer for reveal', async () => {
    let blocked = true
    const host = ops({
      targetBlocksInput: (_hwnd) => blocked,
      activateApp: (name) => {
        if (name === 'stuck') throw new Error('computer-use: failed to activate stuck')
        return name === 'notepad'
      },
    })
    const backend = createWindowsDesktopBackend(host)
    // The check applies to the window an observation selected, not to the foreground.
    await backend.listScreens()
    await expect(backend.hotkey({ keys: ['ctrl', 'c'], windowId: 5 })).rejects.toThrow(/elevated/u)
    blocked = false
    await expect(backend.openApp({ name: 'notepad' })).resolves.toEqual({ kind: 'activated', name: 'notepad' })
    await expect(backend.openApp({ name: 'calc' })).resolves.toEqual({ kind: 'launched', name: 'calc' })
    expect(host.calls).toContain('launch:calc')
    await expect(backend.openApp({ name: 'stuck' })).rejects.toThrow(/failed to activate/u)
    await backend.openInFinder({ path: 'C:\\work\\a.txt', revealOnly: true })
    expect(host.calls).toContain('launch:explorer.exe')
    await backend.openInFinder({ path: 'C:\\work', revealOnly: false })
    expect(host.calls).toContain('launch:C:\\work')
    await backend.openInBrowser({})
    expect(host.calls).toContain('launch:https://')
    await backend.openInBrowser({ url: 'https://example.com' })
    expect(host.calls).toContain('launch:https://example.com')
    await backend.copyImageToClipboard({ path: 'C:\\shot.png', mediaType: 'image/png' })
    expect(host.calls).toContain('image:C:\\shot.png')
  })

  it('refuses a click whose point lands on an elevated window', async () => {
    const host = ops({
      windowFromPoint: () => 77,
      targetBlocksInput: (hwnd) => hwnd === 77,
    })
    const backend = createWindowsDesktopBackend(host)
    const screen = { index: 0, bounds, scale: 1 }
    await expect(backend.click({ screen, position: [0, 0], button: 'left', count: 1 })).rejects.toThrow(/elevated/u)
    // The pointer moved, but nothing was pressed.
    expect(host.calls).toEqual(['move:10,20'])
  })

  it('clicks when the point is on a normal window even though the foreground is elevated', async () => {
    const checked: number[] = []
    const host = ops({
      foregroundWindowId: () => 77,
      windowFromPoint: () => 12,
      targetBlocksInput: (hwnd) => {
        checked.push(hwnd)
        return hwnd === 77
      },
    })
    const backend = createWindowsDesktopBackend(host)
    const screen = { index: 0, bounds, scale: 1 }
    await backend.click({ screen, position: [0, 0], button: 'left', count: 1 })
    // The window under the point decides, exactly once per click.
    expect(checked).toEqual([12])
    expect(host.calls).toEqual(['move:10,20', 'down', 'up'])
  })

  it('refuses drag, scroll, long press, and typing into an elevated window', async () => {
    const host = ops({
      windowFromPoint: () => 77,
      targetBlocksInput: (hwnd) => hwnd === 77,
    })
    const backend = createWindowsDesktopBackend(host)
    const screen = { index: 0, bounds, scale: 1 }
    await expect(backend.drag({
      startScreen: screen, startPosition: [0, 0], endScreen: screen, endPosition: [1000, 1000],
    })).rejects.toThrow(/elevated/u)
    await expect(backend.scroll({ screen, position: [0, 0], direction: 'down', scrollLevel: 1 })).rejects.toThrow(/elevated/u)
    await expect(backend.longPress({ screen, position: [0, 0], durationSeconds: 0.1 })).rejects.toThrow(/elevated/u)
    await expect(backend.typeText({ screen, position: [0, 0], text: 'hi', replace: false, submit: false })).rejects.toThrow(/elevated/u)
    expect(host.calls).not.toContain('down')
    expect(host.calls).not.toContain('wheel:-120')
    expect(host.calls).not.toContain('clip:hi')
  })

  it('refuses a hotkey into an elevated observed window before moving focus', async () => {
    const host = ops({
      foregroundWindowId: () => 9,
      focusWindow: (hwnd) => {
        host.calls.push(`focus:${String(hwnd)}`)
        return true
      },
      targetBlocksInput: (hwnd) => hwnd === 5,
    })
    const backend = createWindowsDesktopBackend(host)
    await backend.listScreens()
    await expect(backend.hotkey({ keys: ['ctrl', 'c'], windowId: 5 })).rejects.toThrow(/elevated/u)
    // Focus never moved and no key was posted.
    expect(host.calls.some((call) => call.startsWith('focus:'))).toBe(false)
    expect(host.calls.some((call) => call.startsWith('key:'))).toBe(false)
  })

  it('posts keys without a target check when nothing was observed', async () => {
    const checked: number[] = []
    const host = ops({
      targetBlocksInput: (hwnd) => {
        checked.push(hwnd)
        return true
      },
    })
    const backend = createWindowsDesktopBackend(host)
    await backend.hotkey({ keys: ['escape'] })
    expect(checked).toEqual([])
    expect(host.calls).toEqual(['key:27:down:0', 'key:27:up:0'])
  })

  it('wraps capture failures and returns no screen when nothing is operable', async () => {
    const screen = { index: 0, bounds, scale: 1 }
    const prefixed = createWindowsDesktopBackend(ops({
      capturePng: () => { throw new Error('computer-use: denied') },
    }))
    await expect(prefixed.capture(screen)).rejects.toThrow('computer-use: denied')
    const wrapped = createWindowsDesktopBackend(ops({
      capturePng: () => { throw new Error('disk') },
    }))
    await expect(wrapped.capture(screen)).rejects.toThrow('computer-use: screen capture failed: disk')
    const unknown = createWindowsDesktopBackend(ops({
      capturePng: () => { throw 'disk' },
    }))
    await expect(unknown.capture(screen)).rejects.toThrow('computer-use: screen capture failed: disk')
    const backend = createWindowsDesktopBackend(ops({ listWindows: () => shot([]) }))
    await expect(backend.listScreens()).resolves.toEqual([])
    await expect(backend.inspectForeground()).resolves.toMatchObject({ appName: 'none' })
    await expect(backend.withGuiTurn(() => Promise.resolve(4))).resolves.toBe(4)
  })

  it('loads Win32 operations once when no host is injected', async () => {
    const backend = createWindowsDesktopBackend()
    await expect(backend.listScreens()).resolves.toEqual([])
    await expect(backend.listScreens()).resolves.toEqual([])
    expect(produced.count).toBe(1)
  })
})
