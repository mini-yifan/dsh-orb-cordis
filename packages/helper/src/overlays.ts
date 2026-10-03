/**
 * Selection toolbar and observation frame.
 * Agent chrome rests captureable; the refcounted cloak below lifts it out of
 * captures while a Computer Use capture or HID interval is active.
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import type { NativeHandleWindow } from './chrome-windows.ts'
import { createAgentCloak, scheduleCloakAck } from './cloak.ts'
import {
  observationFrameCssScript,
  observationFramePlacement,
  pointInRect,
  SELECTION_TOOLBAR_SIZE,
  selectionToolbarBounds,
  selectionToolbarMenuBounds,
  type OverlayRect,
} from './overlay-geometry.ts'

interface OverlayDeps {
  ball: () => BrowserWindow | undefined
  write: (message: unknown) => void
  /**
   * Reports the ball window's click-through state whenever the capture/input cloak
   * changes it behind the transparent-chrome owner's back.
   */
  clickThrough?: (clickThrough: boolean) => void
}

/** Resolved appearance state mirrored onto the overlay pages. */
export interface OverlayAppearance {
  dark: boolean
  locale: 'zh' | 'en'
}

/**
 * Sessions whose permission handlers have already been decided.
 *
 * Every window here shares the default Electron session, so the last writer
 * would otherwise win: the toolbar/frame deny-all would clobber the ball's
 * microphone grant (or the reverse) depending on construction order. The first
 * decision per session is therefore kept.
 */
const permissionSessions = new WeakSet<object>()

export function denyWindowPermissions(created: BrowserWindow): void {
  const session = created.webContents.session
  if (permissionSessions.has(session)) return
  permissionSessions.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/** Reserve this session so a later window cannot replace its permission policy. */
export function claimPermissionSession(created: BrowserWindow): void {
  permissionSessions.add(created.webContents.session)
}

export async function attachOverlays(deps: OverlayDeps): Promise<{
  appearance(payload: OverlayAppearance): void
  deliver(message: unknown): boolean
  /** Toolbar and observation frame, for the host's capture exclusion list. */
  chromeWindows(): readonly (NativeHandleWindow | undefined)[]
}> {
  const preload = fileURLToPath(new URL('../selection-preload.cjs', import.meta.url))
  const toolbar = openToolbar(preload)
  const frame = openFrame()
  let barOrigin = { x: 0, y: 0 }
  let language: 'zh' | 'en' = 'zh'

  toolbar.webContents.on('did-finish-load', () => {
    toolbar.webContents.send('orb:selection-state', { language })
  })

  ipcMain.handle('orb:selection-size', (event, size) => {
    if (!fromToolbar(event, toolbar) || !isSize(size) || toolbar.isDestroyed()) return { menuAbove: false }
    const work = workAreaOf(barOrigin)
    const bounds = selectionToolbarMenuBounds(barOrigin, size, work)
    toolbar.setBounds(bounds)
    return { menuAbove: bounds.y < barOrigin.y }
  })

  ipcMain.on('orb:selection-action', (event, payload) => {
    if (!fromToolbar(event, toolbar)) return
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as { action?: unknown; language?: unknown }
    if (record.action !== 'search' && record.action !== 'translate'
      && record.action !== 'send' && record.action !== 'language') {
      return
    }
    deps.write({
      type: 'selection-action',
      action: record.action,
      ...record.language === 'zh' || record.language === 'en' ? { language: record.language } : {},
    })
  })

  await Promise.all([
    toolbar.loadFile(fileURLToPath(new URL('../assets/selection-toolbar.html', import.meta.url))),
    frame.loadFile(fileURLToPath(new URL('../assets/observation-frame.html', import.meta.url))),
  ])

  function ack(id: unknown): void {
    if (typeof id === 'string') deps.write({ type: 'overlay-ack', id })
  }

  function hideToolbar(): void {
    if (!toolbar.isDestroyed() && toolbar.isVisible()) toolbar.hide()
  }

  /**
   * The refcounted cloak from ./cloak.ts. Chrome windows rest captureable; each
   * `overlay-capture`/`overlay-input` interval lifts them out of screen captures,
   * and the observation frame keeps its Windows resting protection (it stays
   * visible around the observed region between captures).
   */
  const cloak = createAgentCloak(
    [
      { window: () => deps.ball(), resting: false },
      { window: () => toolbar, resting: false },
      { window: () => frame, resting: process.platform === 'win32' },
    ],
    () => deps.ball(),
    (clickThrough) => deps.clickThrough?.(clickThrough),
  )

  function raiseChrome(): void {
    if (!frame.isDestroyed()) frame.setAlwaysOnTop(true, 'floating')
    if (!toolbar.isDestroyed()) toolbar.setAlwaysOnTop(true, 'screen-saver')
    const ball = deps.ball()
    if (ball && !ball.isDestroyed()) ball.setAlwaysOnTop(true, 'screen-saver')
  }

  return {
    /** Mirror the ball's theme and UI language onto the selection toolbar. */
    appearance(payload: OverlayAppearance): void {
      if (!toolbar.isDestroyed()) toolbar.webContents.send('orb:appearance', payload)
    },
    chromeWindows(): readonly (NativeHandleWindow | undefined)[] {
      return [toolbar, frame]
    },
    deliver(message: unknown): boolean {
      if (typeof message !== 'object' || message === null) return false
      const record = message as {
        type?: unknown
        id?: unknown
        text?: unknown
        x?: unknown
        y?: unknown
        language?: unknown
        active?: unknown
        bounds?: unknown
      }
      if (record.type === 'selection') {
        if (typeof record.x !== 'number' || typeof record.y !== 'number') return true
        language = record.language === 'en' ? 'en' : 'zh'
        const work = workAreaOf({ x: record.x, y: record.y })
        const bounds = selectionToolbarBounds({ x: record.x, y: record.y }, SELECTION_TOOLBAR_SIZE, work)
        barOrigin = { x: bounds.x, y: bounds.y }
        if (!toolbar.isDestroyed()) {
          toolbar.setBounds(bounds)
          toolbar.showInactive()
          toolbar.webContents.send('orb:selection-state', { language })
          raiseChrome()
        }
        return true
      }
      if (record.type === 'selection-hide') {
        hideToolbar()
        return true
      }
      if (record.type === 'selection-pointer') {
        if (typeof record.x !== 'number' || typeof record.y !== 'number') return true
        if (toolbar.isDestroyed() || !toolbar.isVisible() || !pointInRect({ x: record.x, y: record.y }, toolbar.getBounds())) {
          hideToolbar()
        }
        return true
      }
      if (record.type === 'selection-language') {
        language = record.language === 'en' ? 'en' : 'zh'
        if (!toolbar.isDestroyed()) toolbar.webContents.send('orb:selection-state', { language })
        return true
      }
      if (record.type === 'selection-attach') {
        const ball = deps.ball()
        if (ball && !ball.isDestroyed() && typeof record.text === 'string') {
          ball.webContents.send('orb:attach', record.text)
          ball.showInactive()
        }
        hideToolbar()
        return true
      }
      if (record.type === 'overlay-capture') {
        if (record.active === false) cloak.end('capture')
        else cloak.begin('capture')
        ack(record.id)
        return true
      }
      if (record.type === 'overlay-input') {
        const begin = record.active === true
        if (begin) hideToolbar()
        if (begin) cloak.begin('input')
        else cloak.end('input')
        // The input-begin ack doubles as the host's green light for posted HID
        // events; hold it until WindowServer has committed the click-through.
        scheduleCloakAck(() => ack(record.id), 'input', begin ? 'begin' : 'end')
        return true
      }
      if (record.type === 'observation-frame') {
        showFrame(frame, record.bounds)
        raiseChrome()
        ack(record.id)
        return true
      }
      return false
    },
  }
}

function showFrame(frame: BrowserWindow, bounds: unknown): void {
  if (frame.isDestroyed()) return
  const region = readRect(bounds)
  if (region === undefined) {
    frame.hide()
    return
  }
  const dip = toDip(region)
  const work = workAreaOf({ x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 })
  const placement = observationFramePlacement(dip, work)
  frame.setBounds(placement.bounds)
  void frame.webContents.executeJavaScript(
    observationFrameCssScript(placement.glow, placement.stroke),
  ).catch(() => {
    // The next show replaces the padding.
  })
  frame.showInactive()
}

function toDip(region: OverlayRect): OverlayRect {
  if (process.platform !== 'win32') return region
  const dip = screen.screenToDipRect(null, {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  })
  return { x: dip.x, y: dip.y, width: dip.width, height: dip.height }
}

function workAreaOf(point: { readonly x: number; readonly y: number }): OverlayRect {
  const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea
  return { x: area.x, y: area.y, width: area.width, height: area.height }
}

function readRect(value: unknown): OverlayRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof record.x !== 'number' || typeof record.y !== 'number'
    || typeof record.width !== 'number' || typeof record.height !== 'number') {
    return undefined
  }
  if (![record.x, record.y, record.width, record.height].every(Number.isFinite)) return undefined
  if (record.width < 1 || record.height < 1) return undefined
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}

function fromToolbar(event: unknown, toolbar: BrowserWindow): boolean {
  if (toolbar.isDestroyed()) return false
  const sender = (event as { sender?: BrowserWindow['webContents'] }).sender
  return sender === toolbar.webContents
}

function isSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== 'object' || value === null) return false
  const size = value as { width?: unknown; height?: unknown }
  return typeof size.width === 'number' && typeof size.height === 'number'
    && Number.isFinite(size.width) && Number.isFinite(size.height)
    && size.width > 0 && size.height > 0 && size.width < 2000 && size.height < 2000
}

function openToolbar(preload: string): BrowserWindow {
  const created = new BrowserWindow({
    width: SELECTION_TOOLBAR_SIZE.width,
    height: SELECTION_TOOLBAR_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    ...process.platform === 'darwin' ? { type: 'panel' as const } : {},
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  protect(created, 'screen-saver')
  denyWindowPermissions(created)
  return created
}

function openFrame(): BrowserWindow {
  const created = new BrowserWindow({
    width: 32,
    height: 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    ...process.platform === 'darwin' ? { type: 'panel' as const } : {},
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  protect(created, 'floating')
  // The frame stays visible around the observed region between captures; on Windows it
  // rests out of captures (WDA_EXCLUDEFROMCAPTURE), matching the original observation frame.
  if (process.platform === 'win32') created.setContentProtection(true)
  denyWindowPermissions(created)
  created.setIgnoreMouseEvents(true, { forward: true })
  return created
}

function protect(created: BrowserWindow, level: 'screen-saver' | 'floating'): void {
  // 内容保护由 cloak.ts 按 capture/input 区间动态开关；平时保持可截图/可录屏。
  created.setAlwaysOnTop(true, level)
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
}
