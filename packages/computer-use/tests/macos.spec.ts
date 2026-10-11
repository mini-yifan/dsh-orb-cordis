import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FAKE_DESKTOP_PNG } from '../src/fake.ts'
import {
  createMacosDesktopBackend,
  FINDER_FOLDER_SCRIPT,
  inspectForegroundScript,
  isFinderApp,
  LIST_APPS_SCRIPT,
  DEFAULT_BROWSER_SCRIPT,
  macosSckCaptureHelperPath,
  MIN_LAYER0_WINDOW_EDGE,
  CHROME_WINDOW_LAYERS,
  CHROME_WINDOW_OWNERS,
  CROSS_PID_TRANSIENT_LAYERS,
  CROSS_PID_TRANSIENT_PAD,
  openAppScript,
  runCommand,
  sanitizeExcludeWindowIds,
  writeCaptureFile,
  type CommandRunner,
} from '../src/macos.ts'
import { FOCUS_FALLBACK_FOREGROUND } from '../src/backend.ts'
import { runWithCaptureExcludeWindowIds } from '../src/capture-exclude.ts'

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    appName: 'Pages',
    windowId: 42,
    windowTitle: 'Untitled',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    scale: 2,
    ...overrides,
  })
}

function runner(options: {
  screens?: string
  capture?: Uint8Array | Error
  osascript?: Error
  inspect?: string | Error
  finderFolder?: string | Error
  defaultBrowser?: string | Error
  apps?: string | Error
  openApp?: string | Error
  scripts?: string[]
  files?: string[]
  args?: string[][]
}): CommandRunner {
  const scripts = options.scripts ?? []
  const files = options.files ?? []
  const capturedArgs = options.args
  return async (file, args) => {
    files.push(file)
    capturedArgs?.push([...args])
    if (file === '/usr/bin/osascript') {
      const flag = args.indexOf('-e')
      const script = flag >= 0
        ? (args[flag + 1] ?? '')
        : await readFile(String(args.at(-1)), 'utf8')
      scripts.push(script)
      if (options.osascript) throw options.osascript
      if (script === DEFAULT_BROWSER_SCRIPT) {
        if (options.defaultBrowser instanceof Error) throw options.defaultBrowser
        return { stdout: options.defaultBrowser ?? JSON.stringify('com.apple.Safari'), stderr: '' }
      }
      if (script === LIST_APPS_SCRIPT) {
        if (options.apps instanceof Error) throw options.apps
        return { stdout: options.apps ?? JSON.stringify(['Pages', 'Safari']), stderr: '' }
      }
      if (script.includes('activateWithOptions_')) {
        if (options.openApp instanceof Error) throw options.openApp
        return { stdout: options.openApp ?? JSON.stringify({ kind: 'activated', name: 'Pages' }), stderr: '' }
      }
      if (script.includes('CGWindowListCopyWindowInfo')) {
        if (options.inspect instanceof Error) throw options.inspect
        return { stdout: options.inspect ?? inspectJson(), stderr: '' }
      }
      if (script.includes('tell application "Finder"')) {
        if (options.finderFolder instanceof Error) throw options.finderFolder
        return { stdout: options.finderFolder ?? '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    if (file === '/usr/sbin/screencapture' || file === macosSckCaptureHelperPath()) {
      if (options.capture instanceof Error) throw options.capture
      const output = file === macosSckCaptureHelperPath()
        ? args.find(arg => arg.startsWith('--out='))?.slice('--out='.length)
        : args.at(-1)
      if (typeof output !== 'string') throw new Error('missing capture path')
      await writeCaptureFile(output, options.capture ?? FAKE_DESKTOP_PNG)
      return { stdout: '', stderr: '' }
    }
    if (file === '/usr/bin/open') {
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected command ${file}`)
  }
}

interface PostedEvent {
  kind: 'key' | 'mouse' | 'wheel'
  flags: number
  code?: number
  down?: boolean
  type?: number
  x?: number
  y?: number
}

/**
 * Run one generated JXA HID script against stubbed CGEvent calls and record what it posted,
 * so the flags each key transition carries can be asserted without real Accessibility input.
 */
function runHid(script: string): {
  readonly keys: { code: number; down: boolean; flags: number }[]
  readonly mouse: { type: number; flags: number; x: number; y: number }[]
} {
  const keys: { code: number; down: boolean; flags: number }[] = []
  const mouse: { type: number; flags: number; x: number; y: number }[] = []
  const sandbox = {
    ObjC: { import: () => undefined },
    $: {
      CGEventSourceCreate: () => ({}),
      CGPointMake: (x: number, y: number) => ({ x, y }),
      CGEventCreateMouseEvent: (_source: unknown, type: number, point: { x: number; y: number }): PostedEvent =>
        ({ kind: 'mouse', type, x: point.x, y: point.y, flags: 0 }),
      CGEventCreateKeyboardEvent: (_source: unknown, code: number, down: boolean): PostedEvent =>
        ({ kind: 'key', code, down, flags: 0 }),
      CGEventCreateScrollWheelEvent2: (): PostedEvent => ({ kind: 'wheel', flags: 0 }),
      CGEventSetIntegerValueField: () => undefined,
      CGEventSetFlags: (event: PostedEvent, flags: number) => { event.flags = flags },
      CGEventSetLocation: (event: PostedEvent, point: { x: number; y: number }) => {
        event.x = point.x
        event.y = point.y
      },
      CGEventPost: (_hid: unknown, event: PostedEvent) => {
        if (event.kind === 'key') keys.push({ code: event.code ?? 0, down: event.down === true, flags: event.flags })
        if (event.kind === 'mouse') mouse.push({ type: event.type ?? 0, flags: event.flags, x: event.x ?? 0, y: event.y ?? 0 })
      },
      NSThread: { sleepForTimeInterval: () => undefined },
    },
  }
  runInNewContext(script, sandbox)
  return { keys, mouse }
}

describe('runCommand', () => {
  it('captures stdout from a short Node process', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])
    expect(result.stdout).toBe('ok')
  })

  it('names the binary when the process fails', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(1)'])).rejects.toThrow(/failed/u)
  })
})

describe('macOS backend with an injected runner', () => {
  it('lists the overlay-skipped frontmost window from JXA JSON', async () => {
    const backend = createMacosDesktopBackend(runner({}))
    await expect(backend.listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      scale: 2,
      windowId: 42,
      appName: 'Pages',
    }])
  })

  it('returns no surface when inspect JSON is empty or unusable', async () => {
    await expect(createMacosDesktopBackend(runner({ inspect: 'null' })).listScreens())
      .resolves.toEqual([])
    await expect(createMacosDesktopBackend(runner({ inspect: 'not-json' })).listScreens())
      .resolves.toEqual([])
    await expect(createMacosDesktopBackend(runner({ inspect: '{}' })).listScreens())
      .resolves.toEqual([])
    await expect(createMacosDesktopBackend(runner({ inspect: '[null]' })).listScreens())
      .resolves.toEqual([])
    await expect(createMacosDesktopBackend(runner({})).withGuiTurn(() => Promise.resolve(9)))
      .resolves.toBe(9)
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ width: 0, height: 1 }),
    })).listScreens()).resolves.toEqual([])
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ x: 12, y: 34, width: 10, height: 20, scale: 1, windowId: 7 }),
    })).listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: 12, y: 34, width: 10, height: 20 },
      scale: 1,
      windowId: 7,
      appName: 'Pages',
    }])
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({
        x: 10,
        y: 20,
        width: 400,
        height: 300,
        transients: [99, 100],
      }),
    })).listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: 10, y: 20, width: 400, height: 300 },
      scale: 2,
      windowId: 42,
      transientWindowIds: [99, 100],
      appName: 'Pages',
    }])
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ transients: 'x' }),
    })).listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      scale: 2,
      windowId: 42,
      appName: 'Pages',
    }])
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ transients: [0, -1, 1.5] }),
    })).listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      scale: 2,
      windowId: 42,
      appName: 'Pages',
    }])
  })

  it('captures the observed rectangle with one screencapture region call', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({ files, args }))
    const [screen] = await backend.listScreens()
    files.length = 0
    args.length = 0
    const captured = await backend.capture(screen!)
    expect(captured.mediaType).toBe('image/png')
    expect(captured.data).toEqual(FAKE_DESKTOP_PNG)
    expect(files).toEqual(['/usr/sbin/screencapture'])
    expect(args[0]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '0,0,100,50'])
    expect(args[0]?.slice(4, 6)).toEqual(['-t', 'jpg'])
  })

  it('captures a screen rectangle when inspect reports open menus', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      args,
      inspect: inspectJson({
        x: 10,
        y: 20,
        width: 400,
        height: 300,
        transients: [99],
      }),
    }))
    const [screen] = await backend.listScreens()
    files.length = 0
    args.length = 0
    await backend.capture(screen!)
    expect(files).toEqual(['/usr/sbin/screencapture'])
    expect(args[0]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '10,20,400,300'])
  })

  it('captures a screen rectangle when the surface has no window id', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({ files, args }))
    await backend.capture({
      index: 0, bounds: { x: 0, y: 0, width: 100, height: 50 }, scale: 2,
    })
    expect(files).toEqual(['/usr/sbin/screencapture'])
    expect(args[0]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '0,0,100,50'])
  })

  it('keeps a secondary-display rectangle in global coordinates instead of the main display', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      args,
      inspect: inspectJson({
        x: -218,
        y: -1080,
        width: 1920,
        height: 1080,
        scale: 1,
        screen: { x: -218, y: -1080, width: 1920, height: 1080 },
      }),
    }))
    const [screen] = await backend.listScreens()
    expect(screen).toEqual({
      index: 0,
      bounds: { x: -218, y: -1080, width: 1920, height: 1080 },
      scale: 1,
      windowId: 42,
      appName: 'Pages',
    })
    files.length = 0
    args.length = 0
    await backend.capture(screen!)
    expect(files).toEqual(['/usr/sbin/screencapture'])
    expect(args[0]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '-218,-1080,1920,1080'])
  })

  it('clips the observed rectangle to the display that owns the window', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      args,
      inspect: inspectJson({
        x: -100,
        y: 900,
        width: 400,
        height: 300,
        scale: 1,
        screen: { x: -1920, y: 0, width: 1920, height: 1080 },
      }),
    }))
    const [screen] = await backend.listScreens()
    expect(screen?.bounds).toEqual({ x: -100, y: 900, width: 100, height: 180 })
    files.length = 0
    args.length = 0
    await backend.capture(screen!)
    expect(args[0]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '-100,900,100,180'])
  })

  it('reports no surface when the observed rectangle misses its display', async () => {
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({
        x: 5000,
        y: 5000,
        screen: { x: 0, y: 0, width: 1470, height: 956 },
      }),
    }))
    await expect(backend.listScreens()).resolves.toEqual([])
  })

  it('ignores an unusable display frame and keeps the raw window rectangle', async () => {
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({ x: -40, y: -60, screen: { x: 'nope', width: 0 } }),
    }))
    await expect(backend.listScreens()).resolves.toEqual([{
      index: 0,
      bounds: { x: -40, y: -60, width: 100, height: 50 },
      scale: 2,
      windowId: 42,
      appName: 'Pages',
    }])
  })

  it('captures JPEG bytes as image/jpeg', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff])
    const backend = createMacosDesktopBackend(runner({ capture: jpeg }))
    const [screen] = await backend.listScreens()
    const captured = await backend.capture(screen!)
    expect(captured.mediaType).toBe('image/jpeg')
  })

  it('uses the ScreenCaptureKit helper when overlay window ids are active', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({ files, args }))
    const [screen] = await backend.listScreens()
    files.length = 0
    args.length = 0
    const captured = await runWithCaptureExcludeWindowIds([4242], () => backend.capture(screen!))
    expect(captured.mediaType).toBe('image/png')
    expect(files).toEqual([macosSckCaptureHelperPath()])
    expect(args[0]).toEqual([
      '--region=0,0,100,50',
      '--exclude=4242',
      expect.stringMatching(/^--out=/u),
    ])
  })

  it('uses ScreenCaptureKit region capture for menus when overlay ids are active', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      args,
      inspect: inspectJson({
        x: 10,
        y: 20,
        width: 400,
        height: 300,
        transients: [99],
      }),
    }))
    const [screen] = await backend.listScreens()
    files.length = 0
    args.length = 0
    await runWithCaptureExcludeWindowIds([4242], () => backend.capture(screen!))
    expect(files).toEqual([macosSckCaptureHelperPath()])
    expect(args[0]).toEqual([
      '--region=10,20,400,300',
      '--exclude=4242',
      expect.stringMatching(/^--out=/u),
    ])
  })

  it('uses overlay-guard captureExcludedRegion instead of the helper when provided', async () => {
    const files: string[] = []
    const captured: Array<{
      region: string
      excludeWindowIds: readonly number[]
      output: string
    }> = []
    const backend = createMacosDesktopBackend(runner({ files }), async (input) => {
      captured.push({
        region: input.region,
        excludeWindowIds: input.excludeWindowIds,
        output: input.output,
      })
      await writeCaptureFile(input.output, FAKE_DESKTOP_PNG)
    })
    const [screen] = await backend.listScreens()
    files.length = 0
    const result = await runWithCaptureExcludeWindowIds([4242], () => backend.capture(screen!))
    expect(result.mediaType).toBe('image/png')
    expect(files).toEqual([])
    expect(captured).toEqual([{
      region: '0,0,100,50',
      excludeWindowIds: [4242],
      output: expect.stringMatching(/screen\.jpg$/u),
    }])
  })

  it('starts AppKit on the main actor before ScreenCaptureKit window capture', async () => {
    const source = await readFile(new URL('../src/macos-sck-capture.swift', import.meta.url), 'utf8')
    expect(source).toContain('import AppKit')
    expect(source).toContain('@MainActor')
    expect(source).toContain('NSApplication.shared')
    expect(source).toContain('setActivationPolicy(.prohibited)')
    expect(source).toContain('desktopIndependentWindow')
    expect(source).toContain('--region=')
    expect(source).toContain('excludingWindows')
    expect(source).toContain('sourceRect')
    expect(source).toContain('#if DSH_SCK_CLI')
    expect(source).toContain('startCliApplication: true')
    expect(source).toContain('@_cdecl("dsh_macos_sck_capture")')
    const cdecl = source.slice(source.indexOf('@_cdecl("dsh_macos_sck_capture")'))
    expect(cdecl).toContain('startCliApplication: false')
    expect(cdecl).not.toContain('setActivationPolicy')
    const build = await readFile(new URL('../scripts/build-macos-sck-capture.mjs', import.meta.url), 'utf8')
    expect(build).toContain("'AppKit'")
    expect(build).toContain('-emit-library')
    expect(build).toContain('libmacos-sck-capture.dylib')
  })

  it('does not fall back to screencapture when overlay-exclude capture fails', async () => {
    const files: string[] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      capture: new Error('window missing'),
    }))
    const [screen] = await backend.listScreens()
    files.length = 0
    await expect(runWithCaptureExcludeWindowIds([7], () => backend.capture(screen!)))
      .rejects.toThrow(/overlay-exclude capture failed/u)
    expect(files).toEqual([macosSckCaptureHelperPath()])
  })

  it('does not fall back to screencapture when overlay-exclude region capture fails', async () => {
    const files: string[] = []
    const backend = createMacosDesktopBackend(runner({
      files,
      capture: new Error('region missing'),
      inspect: inspectJson({
        x: 10,
        y: 20,
        width: 400,
        height: 300,
        transients: [99],
      }),
    }))
    const [screen] = await backend.listScreens()
    files.length = 0
    await expect(runWithCaptureExcludeWindowIds([7], () => backend.capture(screen!)))
      .rejects.toThrow(/overlay-exclude capture failed/u)
    expect(files).toEqual([macosSckCaptureHelperPath()])
  })

  it('interpolates overlay window ids as integer JXA keys', () => {
    expect(sanitizeExcludeWindowIds([4242, 7, 1.5, -1, 0, Number.NaN])).toEqual([4242, 7])
    expect(inspectForegroundScript([])).toContain("ObjC.bindFunction('CGWindowListCopyWindowInfo', ['@', ['I', 'I']])")
    expect(inspectForegroundScript([])).toContain(`var minEdge = ${String(MIN_LAYER0_WINDOW_EDGE)}`)
    expect(inspectForegroundScript([])).toContain(`const pad = ${String(CROSS_PID_TRANSIENT_PAD)}`)
    expect(inspectForegroundScript([])).toContain('found.transients = transients')
    expect(inspectForegroundScript([])).toContain('function screenAt(x, y, w, h)')
    expect(inspectForegroundScript([])).toContain(
      'found.screen = { x: owner.x, y: owner.y, width: owner.width, height: owner.height }',
    )
    expect(inspectForegroundScript([])).toContain('var sy = primaryHeight - f.origin.y - f.size.height')
    expect(inspectForegroundScript([])).toContain('function relatedOwner(a, b)')
    expect(inspectForegroundScript([])).toContain("b.indexOf(a + ' ') === 0")
    expect(inspectForegroundScript([])).toContain("a.indexOf(b + ' ') === 0")
    expect(CROSS_PID_TRANSIENT_LAYERS).toContain(101)
    expect(CHROME_WINDOW_LAYERS).toEqual([20, 24])
    expect(inspectForegroundScript([])).toContain('101: true')
    expect(inspectForegroundScript([])).toContain('20: true')
    expect(inspectForegroundScript([])).toContain('24: true')
    expect(inspectForegroundScript([])).not.toContain('25: true')
    expect(CHROME_WINDOW_OWNERS).toContain('Dock')
    expect(inspectForegroundScript([])).toContain('"Dock": true')
    expect(inspectForegroundScript([])).toContain('chromeOwners[tOwner]')
    expect(inspectForegroundScript([])).toContain('function familyPids(ownerPid)')
    expect(inspectForegroundScript([])).toContain('$.NSWorkspace.sharedWorkspace.runningApplications.js')
    expect(inspectForegroundScript([])).toContain('function relatedBundle(a, b)')
    expect(inspectForegroundScript([])).toContain("b.indexOf(a + '.') === 0")
    expect(inspectForegroundScript([])).toContain("a.indexOf(b + '.') === 0")
    expect(inspectForegroundScript([])).toContain('family[tPid] || relatedOwner(found.appName, tOwner)')
    expect(inspectForegroundScript([])).toContain('if (!inFamily)')
    expect(inspectForegroundScript([])).toContain('if (!crossPidLayers[tLayer]) continue')
    expect(inspectForegroundScript([])).toContain(
      'overlaps(found.x, found.y, found.width, found.height, tx, ty, tw, th, pad)',
    )
    expect(inspectForegroundScript([])).not.toContain('samePid || relatedOwner(found.appName, tOwner)')
    expect(inspectForegroundScript([4242, 7])).toContain('4242: true')
    expect(inspectForegroundScript([4242, 7])).toContain('7: true')
    expect(inspectForegroundScript([1.5, -1])).toBe(inspectForegroundScript([]))
    expect(openAppScript('Pages')).toContain('activateWithOptions_(2)')
    expect(isFinderApp('Finder')).toBe(true)
    expect(isFinderApp('访达')).toBe(true)
    expect(isFinderApp('Google Chrome')).toBe(false)
  })

  it('unwraps CGWindowListCopyWindowInfo as an array on Darwin', async () => {
    const bind = "ObjC.bindFunction('CGWindowListCopyWindowInfo', ['@', ['I', 'I']])"
    expect(inspectForegroundScript([])).toContain(bind)
    if (process.platform !== 'darwin') return
    const result = await runCommand('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('CoreGraphics')\n${bind}\nconst windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)) || []\nJSON.stringify(windows instanceof Array)`,
    ])
    expect(JSON.parse(result.stdout)).toBe(true)
  })

  it('skips overlay window ids and reports the next owner', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({
      scripts,
      inspect: inspectJson({ appName: 'Google Chrome', windowTitle: 'Inbox' }),
    }))
    await expect(runWithCaptureExcludeWindowIds([4242, 7], () => backend.inspectForeground()))
      .resolves.toEqual({ appName: 'Google Chrome', windowTitle: 'Inbox' })
    expect(scripts.some(script => script.includes('4242: true') && script.includes('7: true'))).toBe(true)
    expect(scripts.some(script => script.includes('CGWindowListCopyWindowInfo'))).toBe(true)
    expect(scripts).not.toContain(FINDER_FOLDER_SCRIPT)
  })

  it('adds Finder folder when the remaining app is Finder', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({
      scripts,
      inspect: inspectJson({ appName: 'Finder' }),
      finderFolder: '/Users/tester/Documents/\n',
    }))
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: 'Finder',
      windowTitle: 'Untitled',
      finderFolder: '/Users/tester/Documents/',
    })
    expect(scripts).toContain(FINDER_FOLDER_SCRIPT)
  })

  it('adds Finder folder when the remaining app is 访达', async () => {
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({ appName: '访达', windowTitle: 'Desktop' }),
      finderFolder: '/Users/tester/Desktop',
    }))
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: '访达',
      windowTitle: 'Desktop',
      finderFolder: '/Users/tester/Desktop',
    })
  })

  it('omits Finder folder when the path lookup fails', async () => {
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({ appName: 'Finder' }),
      finderFolder: new Error('timeout'),
    }))
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: 'Finder',
      windowTitle: 'Untitled',
    })
  })

  it('omits Finder folder when AppleScript returns empty', async () => {
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({ appName: 'Finder' }),
      finderFolder: '',
    }))
    await expect(backend.inspectForeground()).resolves.toEqual({
      appName: 'Finder',
      windowTitle: 'Untitled',
    })
  })

  it('returns focus fallback when no remaining window has an owner', async () => {
    const backend = createMacosDesktopBackend(runner({ inspect: 'null' }))
    await expect(backend.inspectForeground()).resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
  })

  it('returns focus fallback when inspect JSON is unusable', async () => {
    const backend = createMacosDesktopBackend(runner({ inspect: 'not-json' }))
    await expect(backend.inspectForeground()).resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
    await expect(createMacosDesktopBackend(runner({ inspect: '42' })).inspectForeground())
      .resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
    await expect(createMacosDesktopBackend(runner({ inspect: '{"appName":1}' })).inspectForeground())
      .resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
    await expect(createMacosDesktopBackend(runner({ inspect: '{"appName":"  "}' })).inspectForeground())
      .resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
    await expect(createMacosDesktopBackend(runner({ inspect: '' })).inspectForeground())
      .resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ windowTitle: undefined }),
    })).inspectForeground()).resolves.toEqual({ appName: 'Pages' })
    await expect(createMacosDesktopBackend(runner({
      inspect: inspectJson({ windowTitle: '  ' }),
    })).inspectForeground()).resolves.toEqual({ appName: 'Pages' })
  })

  it('returns focus fallback when the window-list osascript fails', async () => {
    const backend = createMacosDesktopBackend(runner({ inspect: new Error('denied') }))
    await expect(backend.inspectForeground()).resolves.toEqual(FOCUS_FALLBACK_FOREGROUND)
  })

  it('rethrows abort from the window-list query', async () => {
    const abort = new Error('stopped')
    abort.name = 'AbortError'
    const backend = createMacosDesktopBackend(runner({ inspect: abort }))
    await expect(backend.inspectForeground()).rejects.toThrow('stopped')
  })

  it('rethrows abort from Finder folder lookup', async () => {
    const abort = new Error('stopped')
    abort.name = 'AbortError'
    const backend = createMacosDesktopBackend(runner({
      inspect: inspectJson({ appName: 'Finder' }),
      finderFolder: abort,
    }))
    await expect(backend.inspectForeground()).rejects.toThrow('stopped')
  })

  it('rethrows inspect errors when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    const backend = createMacosDesktopBackend(runner({ inspect: new Error('denied') }))
    await expect(backend.inspectForeground(controller.signal)).rejects.toThrow(/denied/u)
  })

  it('lists regular apps and activates or launches by name', async () => {
    const files: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({ files, args }))
    await expect(backend.listApps()).resolves.toEqual(['Pages', 'Safari'])
    await expect(backend.openApp({ name: 'Pages' })).resolves.toEqual({
      kind: 'activated',
      name: 'Pages',
    })
    files.length = 0
    args.length = 0
    const launching = createMacosDesktopBackend(runner({
      files,
      args,
      openApp: JSON.stringify({ kind: 'launch', name: 'TextEdit' }),
    }))
    await expect(launching.openApp({ name: 'TextEdit' })).resolves.toEqual({
      kind: 'launched',
      name: 'TextEdit',
    })
    expect(files).toContain('/usr/bin/open')
    expect(args.at(-1)).toEqual(['-a', 'TextEdit'])
    files.length = 0
    args.length = 0
    const bundled = createMacosDesktopBackend(runner({
      files,
      args,
      openApp: JSON.stringify({ kind: 'launch', name: 'com.apple.TextEdit' }),
    }))
    await expect(bundled.openApp({ name: 'com.apple.TextEdit' })).resolves.toEqual({
      kind: 'launched',
      name: 'com.apple.TextEdit',
    })
    expect(args.at(-1)).toEqual(['-b', 'com.apple.TextEdit'])
  })

  it('names ambiguous or empty open_app matches without attaching a desktop', async () => {
    const ambiguous = createMacosDesktopBackend(runner({
      openApp: JSON.stringify({ kind: 'ambiguous', names: ['TextEdit', 'Textual'] }),
    }))
    await expect(ambiguous.openApp({ name: 'Text' }))
      .rejects.toThrow(/matches multiple applications: TextEdit, Textual/u)
    await expect(createMacosDesktopBackend(runner({})).openApp({ name: '  ' }))
      .rejects.toThrow(/requires a name/u)
    await expect(createMacosDesktopBackend(runner({ apps: 'not-json' })).listApps())
      .rejects.toThrow(/failed to list apps/u)
    await expect(createMacosDesktopBackend(runner({ apps: '{}' })).listApps())
      .rejects.toThrow(/failed to list apps/u)
    await expect(createMacosDesktopBackend(runner({ apps: JSON.stringify([1]) })).listApps())
      .rejects.toThrow(/failed to list apps/u)
    await expect(createMacosDesktopBackend(runner({
      apps: JSON.stringify(['', 'Pages', 'Pages']),
    })).listApps()).resolves.toEqual(['Pages'])
    await expect(createMacosDesktopBackend(runner({ openApp: 'not-json' })).openApp({ name: 'Pages' }))
      .rejects.toThrow(/unreadable activate result/u)
    await expect(createMacosDesktopBackend(runner({ openApp: 'null' })).openApp({ name: 'Pages' }))
      .rejects.toThrow(/unreadable activate result/u)
    await expect(createMacosDesktopBackend(runner({
      openApp: JSON.stringify({ kind: 'activated' }),
    })).openApp({ name: 'Pages' })).rejects.toThrow(/unreadable activate result/u)
    await expect(createMacosDesktopBackend(runner({
      openApp: JSON.stringify({ kind: 'ambiguous' }),
    })).openApp({ name: 'Text' })).rejects.toThrow(/matches multiple applications: Text/u)
    await expect(createMacosDesktopBackend(runner({
      openApp: new Error('osascript crashed'),
    })).openApp({ name: 'Pages' })).rejects.toThrow(/open_app failed for Pages/u)
  })

  it('names Screen Recording when capture fails', async () => {
    const backend = createMacosDesktopBackend(runner({ capture: new Error('denied') }))
    const [screen] = await backend.listScreens()
    await expect(backend.capture(screen!)).rejects.toThrow(/Screen Recording permission/u)
  })

  it('rejects unsupported capture bytes', async () => {
    const backend = createMacosDesktopBackend(runner({ capture: Buffer.from('not-an-image') }))
    const [screen] = await backend.listScreens()
    await expect(backend.capture(screen!)).rejects.toThrow(/unsupported image/u)
  })

  it('posts click, type, scroll, and hotkey JXA', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({ scripts }))
    const [screen] = await backend.listScreens()
    scripts.length = 0
    await backend.click({ screen: screen!, position: [0, 0], button: 'right', count: 2 })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('clickAt(0, 0, 1, 2)')
    expect(scripts[0]).toContain('CGEventSourceCreate(1)')
    expect(scripts[0]).toContain('CGPointMake')
    expect(scripts[0]).toContain('sleep(80)')
    scripts.length = 0
    await backend.click({ screen: screen!, position: [0, 0], button: 'left', count: 1 })
    expect(scripts[0]).toContain('clickAt(0, 0, 0, 1)')
    scripts.length = 0
    await backend.typeText({
      screen: screen!, position: [500, 500], text: 'hi', replace: true, submit: true,
    })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('clickAt(50, 25, 0, 1)')
    expect(scripts[0]).toContain('sleep(120)')
    expect(scripts[0]).toContain('selectAll()')
    expect(scripts[0]).toContain('pasteText("hi")')
    expect(scripts[0]).toContain('pressEnter()')
    expect(scripts[0]).toContain('var discarded = pb.clearContents')
    expect(scripts[0]).not.toContain('pb.clearContents()')
    expect(scripts[0]).not.toContain('KeyboardSetUnicodeString')
    // Every pasteboard type is snapshotted and restored, not just the text.
    expect(scripts[0]).toContain('clipboardSnapshot(pb)')
    expect(scripts[0]).toContain('dataForType')
    expect(scripts[0]).toContain('restoreClipboard(pb, previous)')
    expect(scripts[0]).not.toContain('stringWithString(previous)')
    scripts.length = 0
    await backend.typeText({
      screen: screen!, position: [0, 0], text: '', replace: false, submit: false,
    })
    expect(scripts.join('\n')).toContain('clickAt(0, 0, 0, 1)')
    expect(scripts.join('\n')).not.toContain('pasteText("')
    scripts.length = 0
    await backend.scroll({ screen: screen!, position: [10, 10], direction: 'down', scrollLevel: 3 })
    expect(scripts.join('\n')).toContain('CGEventCreateScrollWheelEvent2')
    expect(scripts.join('\n')).toContain('scrollAt(1, 1, -3)')
    scripts.length = 0
    await backend.scroll({ screen: screen!, position: [10, 10], direction: 'up', scrollLevel: 2 })
    expect(scripts.join('\n')).toContain('scrollAt(1, 1, 2)')
    scripts.length = 0
    await backend.hotkey({ keys: ['cmd', 'c'] })
    expect(scripts.join('\n')).toContain('chord([55,8])')
    expect(scripts.join('\n')).toContain('CGEventSetFlags')
    scripts.length = 0
    await backend.longPress({ screen: screen!, position: [0, 0], durationSeconds: 3 })
    expect(scripts.join('\n')).toContain('longPressAt(0, 0, 3000)')
    scripts.length = 0
    await backend.drag({
      startScreen: screen!, startPosition: [0, 0],
      endScreen: screen!, endPosition: [1000, 1000],
    })
    expect(scripts.join('\n')).toContain('dragFromTo(0, 0, 100, 50)')
    expect(scripts.join('\n')).toContain('const LEFT_DRAGGED = 6')
    expect(scripts.join('\n')).toContain('postMouse(LEFT_DRAGGED,')
  })

  it('holds click modifiers then releases them in one JXA script', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({ scripts }))
    const [screen] = await backend.listScreens()
    scripts.length = 0
    await backend.click({
      screen: screen!, position: [0, 0], button: 'left', count: 1, modifiers: ['cmd', 'shift'],
    })
    expect(scripts[0]).toContain('clickWithModifiers(0, 0, 0, 1, [55,56])')
    expect(scripts[0]).toContain('if (flags) $.CGEventSetFlags(event, flags)')
    expect(scripts[0]).toContain('postKey(mods[m], true, flags)')
    expect(scripts[0]).toContain('postKey(mods[r], false, heldFlags(mods, r))')
    scripts.length = 0
    await backend.click({ screen: screen!, position: [0, 0], button: 'left', count: 1 })
    expect(scripts[0]).toContain('clickAt(0, 0, 0, 1)')
    expect(scripts[0]).not.toContain('clickWithModifiers(0, 0, 0, 1')
  })

  it('flags the Fn key and releases modifiers with the flags that remain held', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({ scripts }))
    scripts.length = 0
    await backend.hotkey({ keys: ['fn', 'c'] })
    const fn = runHid(scripts[0]!)
    // kCGEventFlagMaskSecondaryFn is 0x00800000; 0x8000 is not a Fn flag.
    expect(fn.keys[0]).toEqual({ code: 63, down: true, flags: 0x00800000 })
    expect(fn.keys.at(-1)).toEqual({ code: 63, down: false, flags: 0 })

    scripts.length = 0
    await backend.hotkey({ keys: ['cmd', 'shift'] })
    const chord = runHid(scripts[0]!)
    // Shift comes up with Cmd still reported as held; only the last release reports 0.
    expect(chord.keys).toEqual([
      { code: 55, down: true, flags: 0x00100000 | 0x00020000 },
      { code: 56, down: true, flags: 0x00100000 | 0x00020000 },
      { code: 56, down: false, flags: 0x00100000 },
      { code: 55, down: false, flags: 0 },
    ])

    scripts.length = 0
    await backend.click({
      screen: (await backend.listScreens())[0]!, position: [0, 0], button: 'left', count: 1, modifiers: ['cmd', 'shift'],
    })
    const click = runHid(scripts.at(-1)!)
    expect(click.keys.map(key => key.flags)).toEqual([0x00100000 | 0x00020000, 0x00100000 | 0x00020000, 0x00100000, 0])
  })

  it('maps f4 and forwards delete on macOS', async () => {
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({ scripts }))
    scripts.length = 0
    await backend.hotkey({ keys: ['f4'] })
    expect(scripts[0]).toContain('chord([118])')
    scripts.length = 0
    await backend.hotkey({ keys: ['delete'] })
    expect(scripts[0]).toContain('chord([117])')
    scripts.length = 0
    await backend.hotkey({ keys: ['backspace'] })
    expect(scripts[0]).toContain('chord([51])')
  })

  it('captures and clicks the same rounded rectangle for fractional window bounds', async () => {
    const scripts: string[] = []
    const args: string[][] = []
    const backend = createMacosDesktopBackend(runner({
      scripts,
      args,
      capture: Buffer.from([0xff, 0xd8, 0xff]),
      inspect: inspectJson({ x: 100.4, y: 0, width: 200.4, height: 10, scale: 1, windowTitle: 'Fractional' }),
    }))
    const [screen] = await backend.listScreens()
    expect(screen?.bounds).toEqual({ x: 100, y: 0, width: 200, height: 10 })
    const numberedArgs = args.length
    await backend.capture(screen!)
    expect(args[numberedArgs]?.slice(0, 4)).toEqual(['-x', '-C', '-R', '100,0,200,10'])
    scripts.length = 0
    await backend.click({ screen: screen!, position: [250, 0], button: 'left', count: 1 })
    // 25% of the captured raster is 100 + 0.25 * 200 = 150; the unrounded frame would say 151.
    expect(scripts.join('\n')).toContain('clickAt(150, 0, 0, 1)')
  })

  it('releases every key and mouse button when a HID script is cancelled', async () => {
    const releases: string[] = []
    const signals: (AbortSignal | undefined)[] = []
    const hids: string[] = []
    const controller = new AbortController()
    const base = runner({})
    const backend = createMacosDesktopBackend(async (file, args, options) => {
      const flag = args.indexOf('-e')
      const inline = flag >= 0 ? args[flag + 1] ?? '' : ''
      if (file === '/usr/bin/osascript' && inline.includes('postMouseUp(LEFT_UP')) {
        releases.push(inline)
        signals.push(options?.signal)
        return { stdout: '', stderr: '' }
      }
      if (file === '/usr/bin/osascript' && flag < 0) {
        // The HID script runs from a temp file; cancellation kills osascript mid-script.
        hids.push(await readFile(String(args.at(-1)), 'utf8'))
        controller.abort()
        const abort = new Error('killed')
        abort.name = 'AbortError'
        throw abort
      }
      return base(file, args, options)
    })
    const [screen] = await backend.listScreens()
    await expect(backend.click(
      { screen: screen!, position: [0, 0], button: 'left', count: 1 },
      controller.signal,
    )).rejects.toThrow(/pointer input failed/u)
    expect(hids).toHaveLength(1)
    expect(releases).toHaveLength(1)
    expect(releases[0]).toContain('postMouseUp(RIGHT_UP')
    expect(releases[0]).toContain('postKeyUp(KEY_CMD)')
    expect(releases[0]).toContain('postKeyUp(KEY_FN)')
    // The release never carries the aborted signal, or it would be killed by the same cancel.
    expect(signals).toEqual([undefined])
  })

  it('opens URLs, the default browser, Desktop files, and Finder reveals', async () => {
    const files: string[] = []
    const args: string[][] = []
    const scripts: string[] = []
    const backend = createMacosDesktopBackend(runner({ files, args, scripts }))
    files.length = 0
    args.length = 0
    await backend.openInBrowser({ url: 'https://example.com/search/刘谦' })
    expect(files).toEqual(['/usr/bin/open'])
    expect(args).toEqual([['https://example.com/search/刘谦']])
    files.length = 0
    args.length = 0
    scripts.length = 0
    await backend.openInBrowser({})
    expect(scripts).toContain(DEFAULT_BROWSER_SCRIPT)
    expect(files.filter(file => file === '/usr/bin/open')).toEqual(['/usr/bin/open'])
    expect(args.at(-1)).toEqual(['-b', 'com.apple.Safari'])
    files.length = 0
    args.length = 0
    await backend.openInFinder({ path: '/Users/tester/Desktop', revealOnly: false })
    expect(files).toEqual(['/usr/bin/open'])
    expect(args).toEqual([['/Users/tester/Desktop']])
    files.length = 0
    args.length = 0
    await backend.openInFinder({ path: '/Users/tester/Desktop/notes.txt', revealOnly: true })
    expect(args).toEqual([['-R', '/Users/tester/Desktop/notes.txt']])
  })

  it('copies a written image file onto the pasteboard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-clip-'))
    try {
      const file = join(dir, 'shot.png')
      await writeCaptureFile(file, FAKE_DESKTOP_PNG)
      const scripts: string[] = []
      const backend = createMacosDesktopBackend(runner({ scripts }))
      await backend.copyImageToClipboard({ path: file, mediaType: 'image/png' })
      expect(scripts.at(-1)).toContain('setDataForType')
      expect(scripts.at(-1)).toContain('public.png')
      expect(scripts.at(-1)).toContain(JSON.stringify(file))
      const failing = createMacosDesktopBackend(runner({ osascript: new Error('denied') }))
      await expect(failing.copyImageToClipboard({ path: file, mediaType: 'image/jpeg' }))
        .rejects.toThrow(/clipboard copy failed/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names the path or URL when open fails and refuses a missing default browser', async () => {
    const mixed: CommandRunner = async (file, args, options) => {
      if (file === '/usr/bin/open') throw new Error('denied')
      return runner({})(file, args, options)
    }
    const backend = createMacosDesktopBackend(mixed)
    await expect(backend.openInBrowser({ url: 'https://example.com' }))
      .rejects.toThrow(/open failed for https:\/\/example.com/u)
    await expect(backend.openInFinder({ path: '/Users/tester/Desktop', revealOnly: false }))
      .rejects.toThrow(/open failed for \/Users\/tester\/Desktop/u)
    await expect(createMacosDesktopBackend(runner({ defaultBrowser: 'null' })).openInBrowser({}))
      .rejects.toThrow(/could not resolve the default browser/u)
    await expect(createMacosDesktopBackend(runner({ defaultBrowser: '' })).openInBrowser({}))
      .rejects.toThrow(/could not resolve the default browser/u)
    await expect(createMacosDesktopBackend(runner({ defaultBrowser: 'not-json' })).openInBrowser({}))
      .rejects.toThrow(/could not resolve the default browser/u)
    await expect(createMacosDesktopBackend(runner({ defaultBrowser: JSON.stringify('  ') })).openInBrowser({}))
      .rejects.toThrow(/could not resolve the default browser/u)
  })

  it('rejects unknown hotkeys before posting', async () => {
    const backend = createMacosDesktopBackend(runner({}))
    await expect(backend.hotkey({ keys: ['not-a-key'] })).rejects.toThrow(/unknown key "not-a-key"/u)
  })

  it('names Accessibility when HID posting fails', async () => {
    const mixed: CommandRunner = async (file, args, options) => {
      if (file === '/usr/bin/osascript' && args[2] !== '-e') {
        throw new Error('denied')
      }
      return runner({})(file, args, options)
    }
    const hid = createMacosDesktopBackend(mixed)
    const [screen] = await hid.listScreens()
    await expect(hid.click({
      screen: screen!, position: [0, 0], button: 'left', count: 1,
    })).rejects.toThrow(/Accessibility permission/u)
    await expect(hid.typeText({
      screen: screen!, position: [0, 0], text: 'a', replace: false, submit: false,
    })).rejects.toThrow(/Accessibility permission/u)
    await expect(hid.scroll({
      screen: screen!, position: [0, 0], direction: 'up', scrollLevel: 1,
    })).rejects.toThrow(/Accessibility permission/u)
    await expect(hid.hotkey({ keys: ['c'] })).rejects.toThrow(/Accessibility permission/u)
    await expect(hid.longPress({
      screen: screen!, position: [0, 0], durationSeconds: 3,
    })).rejects.toThrow(/Accessibility permission/u)
    await expect(hid.drag({
      startScreen: screen!, startPosition: [0, 0],
      endScreen: screen!, endPosition: [10, 10],
    })).rejects.toThrow(/Accessibility permission/u)
  })

  it('stringifies non-Error HID failures', async () => {
    const mixed: CommandRunner = async (file, args, options) => {
      if (file === '/usr/bin/osascript' && args[2] !== '-e') {
        throw 'denied'
      }
      return runner({})(file, args, options)
    }
    const hid = createMacosDesktopBackend(mixed)
    const [screen] = await hid.listScreens()
    await expect(hid.click({
      screen: screen!, position: [0, 0], button: 'left', count: 1,
    })).rejects.toThrow(/Accessibility permission is required\): denied/u)
    await expect(hid.typeText({
      screen: screen!, position: [0, 0], text: 'a', replace: false, submit: false,
    })).rejects.toThrow(/Accessibility permission is required\): denied/u)
    await expect(hid.scroll({
      screen: screen!, position: [0, 0], direction: 'up', scrollLevel: 1,
    })).rejects.toThrow(/Accessibility permission is required\): denied/u)
    await expect(hid.hotkey({ keys: ['c'] })).rejects.toThrow(/Accessibility permission is required\): denied/u)
    await expect(hid.longPress({
      screen: screen!, position: [0, 0], durationSeconds: 3,
    })).rejects.toThrow(/Accessibility permission is required\): denied/u)
    await expect(hid.drag({
      startScreen: screen!, startPosition: [0, 0],
      endScreen: screen!, endPosition: [10, 10],
    })).rejects.toThrow(/Accessibility permission is required\): denied/u)
  })

  it('stringifies non-Error capture failures', async () => {
    const mixed: CommandRunner = async (file, args, options) => {
      if (file === '/usr/sbin/screencapture') throw 'denied'
      return runner({})(file, args, options)
    }
    const backend = createMacosDesktopBackend(mixed)
    const [screen] = await backend.listScreens()
    await expect(backend.capture(screen!)).rejects.toThrow(/Screen Recording permission is required\): denied/u)
  })
})

describe('writeCaptureFile', () => {
  it('writes the bytes a capture runner would emit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-cap-'))
    const file = join(dir, 'out.jpg')
    await writeCaptureFile(file, FAKE_DESKTOP_PNG)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(file)).toEqual(FAKE_DESKTOP_PNG)
  })
})
