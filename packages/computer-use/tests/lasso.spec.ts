import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopBackend, ScreenInfo } from '../src/backend.ts'
import {
  createLassoSeedStore,
  installLassoCapture,
  lassoFirstFrameNotice,
  type LassoSeed,
} from '../src/lasso.ts'
import { installLassoServices } from '../src/lasso-service.ts'
import { FAKE_DESKTOP_PNG } from '../src/fake.ts'

function seed(): LassoSeed {
  return {
    screen: { index: 0, bounds: { x: 0, y: 0, width: 800, height: 600 }, scale: 2 },
    foreground: { appName: 'Pages' },
    image: {
      attachmentId: 'att-1' as never,
      mediaType: 'image/jpeg',
      bytes: 10,
      width: 1600,
      height: 1200,
    },
  }
}

describe('lasso services', () => {
  it('publishes capture and the first-frame slot on the app-level context', () => {
    const provided = new Map<string, unknown>()
    const ctx = {
      get: (name: string) => provided.get(name),
      provide: (name: string, value: unknown) => {
        provided.set(name, value)
        return () => { provided.delete(name) }
      },
    } as unknown as Context
    installLassoServices(ctx, backend([]).fake)
    // Both cross the preset boundary: the host reads the capture, the preset reads the
    // seed, so neither may be provided inside the preset itself.
    expect(provided.get('computerUseLassoCapture')).toBeDefined()
    expect(provided.get('computerUseLassoSeed')).toBeDefined()
  })
})

describe('lasso seed store', () => {
  it('takes a seed once and clears it', () => {
    let now = 1_000
    const store = createLassoSeedStore(() => now)
    store.set('session-1', seed())
    expect(store.peek('session-1')).toBeDefined()
    expect(store.take('session-1')).toBeDefined()
    expect(store.take('session-1')).toBeUndefined()
    store.set('session-1', seed())
    store.clear('session-1')
    expect(store.peek('session-1')).toBeUndefined()
    store.set('session-2', seed())
    now += 121_000
    expect(store.peek('session-2')).toBeUndefined()
  })

  it('names the bright region for both coordinate modes', () => {
    expect(lassoFirstFrameNotice('pixel')).toContain('pixel columns and rows')
    expect(lassoFirstFrameNotice('millifraction')).toContain('0–1000 fractions')
  })
})

function backend(screens: readonly ScreenInfo[]) {
  const calls: { bounds: unknown; cursor: unknown }[] = []
  const fake: DesktopBackend = {
    withGuiTurn: run => run(),
    listScreens: () => Promise.resolve(screens),
    capture: (screen, _signal, options) => {
      calls.push({ bounds: screen.bounds, cursor: options?.cursor })
      return Promise.resolve({ data: FAKE_DESKTOP_PNG, mediaType: 'image/png' })
    },
    inspectForeground: () => Promise.resolve({ appName: 'Pages' }),
    listApps: () => Promise.resolve([]),
    openApp: () => Promise.reject(new Error('unused')),
    click: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    hotkey: () => Promise.resolve(),
    longPress: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    openInBrowser: () => Promise.resolve(),
    openInFinder: () => Promise.resolve(),
    copyImageToClipboard: () => Promise.resolve(),
  }
  return { fake, calls }
}

function context(guard?: {
  withCapture: <T>(run: (session: { excludeWindowIds: readonly number[] }) => Promise<T>) => Promise<T>
}): Context {
  return { get: (name: string) => name === 'computerUseOverlayGuard' ? guard : undefined } as unknown as Context
}

const display = { x: 0, y: 0, width: 1000, height: 800, scale: 2 }
const screens: ScreenInfo[] = [
  { index: 0, bounds: { x: 100, y: 100, width: 400, height: 300 }, scale: 2, windowId: 7, appName: 'Pages' },
]

describe('lasso capture service', () => {
  it('captures the foreground window union without a cursor', async () => {
    const { fake, calls } = backend(screens)
    const service = installLassoCapture(context(), fake)
    const result = await service.capture({
      mode: 'highlight',
      rect: { x: 50, y: 50, width: 200, height: 100 },
      display,
    })
    expect(calls).toEqual([{ bounds: { x: 50, y: 50, width: 450, height: 350 }, cursor: false }])
    expect(result.screen.windowId).toBe(7)
    expect(result.screen.appName).toBe('Pages')
    expect(result.foreground.appName).toBe('Pages')
    expect(result.bounds).toEqual({ x: 50, y: 50, width: 450, height: 350 })
  })

  it('clamps a selection outside the display', async () => {
    const { fake, calls } = backend(screens)
    const service = installLassoCapture(context(), fake)
    const result = await service.capture({
      mode: 'highlight',
      rect: { x: 950, y: 790, width: 400, height: 300 },
      display,
    })
    expect(calls[0]?.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })

  it('captures exactly the crop rect and never lists windows', async () => {
    const { fake, calls } = backend(screens)
    let listed = 0
    const counted: DesktopBackend = { ...fake, listScreens: () => { listed += 1; return Promise.resolve(screens) } }
    const service = installLassoCapture(context(), counted)
    await service.capture({
      mode: 'crop',
      rect: { x: 20, y: 30, width: 120, height: 80 },
      display,
    })
    expect(listed).toBe(0)
    expect(calls[0]?.bounds).toEqual({ x: 20, y: 30, width: 120, height: 80 })
  })

  it('runs inside the overlay guard and passes its exclusion ids', async () => {
    const { fake, calls } = backend(screens)
    let ids: readonly number[] = []
    const original = fake.capture
    const guarded: DesktopBackend = {
      ...fake,
      capture: (screen, signal, options) => {
        ids = [42, 43]
        return original(screen, signal, options)
      },
    }
    const service = installLassoCapture(context({
      withCapture: run => run({ excludeWindowIds: [42, 43] }),
    }), guarded)
    await service.capture({ mode: 'crop', rect: { x: 0, y: 0, width: 10, height: 10 }, display })
    expect(ids).toEqual([42, 43])
    expect(calls.length).toBe(1)
  })
})
