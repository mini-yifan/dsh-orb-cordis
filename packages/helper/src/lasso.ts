/**
 * Lasso overlays: the blue trail while the user draws, the adjustable confirm
 * frame that follows, and the screenshot preview opened from the transcript.
 * The satellite handle itself lives in the ball page so it cannot drift from
 * the ball.
 */

import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import type { NativeHandleWindow } from './chrome-windows.ts'
import { denyWindowPermissions } from './overlays.ts'
import { findLargestClosedRegion, type LassoRect, type Point } from './lasso-geometry.ts'

interface LassoDeps {
  write: (message: unknown) => void
  sendToBall: (channel: string, payload?: unknown) => void
}

export interface LassoAppearance {
  dark: boolean
  locale: 'zh' | 'en'
  /** The idle satellite's look, so the cursor follower matches it while drawing. */
  satellite: { skin: 'classic' | 'glass' | 'theme' | 'avatar'; length: number; avatarSrc: string }
}

export interface LassoDisplay {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

const ESC = 'Escape'
const TRAIL_FADE_MS = 260
const ACTION_TIMEOUT_MS = 20_000

export async function attachLasso(deps: LassoDeps): Promise<{
  appearance(payload: LassoAppearance): void
  deliver(message: unknown): boolean
  chromeWindows(): readonly (NativeHandleWindow | undefined)[]
  cloakWindows(): readonly { window: () => BrowserWindow | undefined }[]
  start(point: Point, display: LassoDisplay): void
  addPoint(point: Point): void
  end(): void
  cancel(): void
  close(): void
}> {
  const preload = fileURLToPath(new URL('../lasso-preload.cjs', import.meta.url))
  const trail = openTrail(preload)
  const confirm = openConfirmWindow(preload)
  const preview = openPreviewWindow(preload)
  let display: LassoDisplay = { x: 0, y: 0, width: 1, height: 1, scale: 1 }
  let points: Point[] = []
  let active = false
  let flowActive = false
  let strokeId = 0
  let confirmOpen = false
  let actionPending = false
  let actionTimer: ReturnType<typeof setTimeout> | undefined
  let locale: 'zh' | 'en' = 'zh'
  let dark = false
  let satellite: LassoAppearance['satellite'] = { skin: 'classic', length: 26, avatarSrc: '' }
  let fadeTimer: ReturnType<typeof setTimeout> | undefined

  await Promise.all([
    trail.loadFile(fileURLToPath(new URL('../assets/lasso-trail.html', import.meta.url))),
    confirm.loadFile(fileURLToPath(new URL('../assets/lasso-confirm.html', import.meta.url))),
    preview.loadFile(fileURLToPath(new URL('../assets/image-preview.html', import.meta.url))),
  ])

  function sendTrail(channel: string, payload?: unknown): void {
    if (!trail.isDestroyed()) trail.webContents.send(channel, payload)
  }

  function sendConfirm(channel: string, payload?: unknown): void {
    if (!confirm.isDestroyed()) confirm.webContents.send(channel, payload)
  }

  function sendPreview(channel: string, payload?: unknown): void {
    if (!preview.isDestroyed()) preview.webContents.send(channel, payload)
  }

  function setDisplayBounds(window: BrowserWindow, next: LassoDisplay): void {
    if (window.isDestroyed()) return
    window.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height })
  }

  function raise(window: BrowserWindow, level: 'screen-saver' | 'floating' = 'screen-saver'): void {
    if (window.isDestroyed()) return
    window.setAlwaysOnTop(true, level)
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    }
    window.showInactive()
  }

  function endAction(): void {
    if (actionTimer !== undefined) {
      clearTimeout(actionTimer)
      actionTimer = undefined
    }
    actionPending = false
  }

  function hideConfirm(): void {
    if (!confirm.isDestroyed()) confirm.hide()
    if (confirmOpen) {
      confirmOpen = false
      try {
        globalShortcut.unregister(ESC)
      } catch {
        // The shortcut may already be gone with the window.
      }
    }
    endAction()
  }

  function setFlowActive(next: boolean): void {
    if (flowActive === next) return
    flowActive = next
    // The host pauses the text-selection monitor for the whole lasso, drag through confirm
    // frame, so a stroke is never read as a selection.
    deps.write({ type: 'lasso-active', active: next })
  }

  function finishBallPage(): void {
    setFlowActive(false)
    deps.sendToBall('orb:lasso-done')
  }

  function clearTrail(): void {
    if (fadeTimer !== undefined) {
      clearTimeout(fadeTimer)
      fadeTimer = undefined
    }
    active = false
    points = []
    if (!trail.isDestroyed()) trail.hide()
  }

  function cancel(): void {
    if (actionPending) return
    clearTrail()
    hideConfirm()
    finishBallPage()
  }

  function start(point: Point, nextDisplay: LassoDisplay): void {
    if (active) return
    // A reject fade left over from the previous stroke must not hide this one or report it.
    if (fadeTimer !== undefined) {
      clearTimeout(fadeTimer)
      fadeTimer = undefined
    }
    strokeId += 1
    setFlowActive(true)
    active = true
    points = [{ x: point.x, y: point.y }]
    display = nextDisplay
    setDisplayBounds(trail, nextDisplay)
    raise(trail)
    sendTrail('lasso-trail-show', { point, display: nextDisplay, dark, locale, ball: satellite })
  }

  function addPoint(point: Point): void {
    if (!active) return
    const last = points[points.length - 1]
    if (last !== undefined && Math.hypot(point.x - last.x, point.y - last.y) < 2) return
    points.push({ x: point.x, y: point.y })
    sendTrail('lasso-trail-point', point)
  }

  function end(): void {
    if (!active) return
    const region = findLargestClosedRegion(points, { minAreaPx2: 4000 })
    const done = points
    points = []
    active = false
    if (region === undefined) {
      const stroke = strokeId
      sendTrail('lasso-trail-reject', done)
      fadeTimer = setTimeout(() => {
        fadeTimer = undefined
        if (!trail.isDestroyed()) trail.hide()
        if (strokeId !== stroke) return
        setFlowActive(false)
        deps.sendToBall('orb:lasso-reject')
      }, TRAIL_FADE_MS)
      return
    }
    sendTrail('lasso-trail-fade', done)
    fadeTimer = setTimeout(() => {
      fadeTimer = undefined
      if (!trail.isDestroyed()) trail.hide()
    }, TRAIL_FADE_MS)
    showConfirm(region.bounds)
  }

  function showConfirm(rect: LassoRect): void {
    if (confirmOpen) hideConfirm()
    confirmOpen = true
    endAction()
    setDisplayBounds(confirm, display)
    raise(confirm)
    sendConfirm('lasso-confirm-show', { rect, display, dark, locale })
    try {
      globalShortcut.register(ESC, () => { cancel() })
    } catch {
      // Esc is a convenience; the frame still has click-outside and ×.
    }
  }

  function showPreview(payload: unknown): void {
    if (preview.isDestroyed()) return
    const target = display.width > 1
      ? display
      : { ...screen.getPrimaryDisplay().bounds, scale: screen.getPrimaryDisplay().scaleFactor }
    setDisplayBounds(preview, target)
    preview.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      preview.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    }
    preview.show()
    preview.focus()
    const source = typeof payload === 'object' && payload !== null
      ? (payload as { src?: unknown }).src
      : undefined
    sendPreview('lasso-preview-image', {
      src: typeof source === 'string' ? source : '',
      locale,
    })
  }

  const onAction = (event: unknown, payload: unknown): void => {
    if (confirm.isDestroyed() || (event as { sender?: unknown }).sender !== confirm.webContents) return
    if (actionPending) return
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as { action?: unknown; rect?: unknown; display?: unknown }
    if (record.action !== 'send' && record.action !== 'translate' && record.action !== 'copy') return
    const rect = readRect(record.rect)
    const target = readDisplay(record.display) ?? display
    if (rect === undefined) return
    actionPending = true
    const physical = process.platform === 'win32'
      ? readRect(screen.dipToScreenRect?.(null, rect) ?? rect) ?? rect
      : rect
    const scaledDisplay = process.platform === 'win32' ? screen.dipToScreenRect?.(null, target) : undefined
    const physicalDisplay = scaledDisplay === undefined ? target : { ...scaledDisplay, scale: target.scale }
    deps.write({
      type: 'lasso-action',
      action: record.action,
      rect,
      physicalRect: physical,
      display: target,
      physicalDisplay,
    })
    if (actionTimer !== undefined) clearTimeout(actionTimer)
    actionTimer = setTimeout(() => {
      actionTimer = undefined
      actionPending = false
      sendConfirm('lasso-confirm-result', {
        action: record.action,
        ok: false,
        message: locale === 'zh' ? '操作超时，请重试' : 'The action timed out. Try again.',
      })
    }, ACTION_TIMEOUT_MS)
  }

  const onCancel = (event: unknown): void => {
    if (confirm.isDestroyed() || (event as { sender?: unknown }).sender !== confirm.webContents) return
    cancel()
  }

  const onPreviewClose = (event: unknown): void => {
    if (preview.isDestroyed() || (event as { sender?: unknown }).sender !== preview.webContents) return
    preview.hide()
  }

  ipcMain.on('lasso:action', onAction)
  ipcMain.on('lasso:cancel', onCancel)
  ipcMain.on('lasso:preview-close', onPreviewClose)

  return {
    appearance(payload) {
      dark = payload.dark
      locale = payload.locale
      if (payload.satellite !== undefined) satellite = payload.satellite
      sendConfirm('lasso-appearance', payload)
      sendTrail('lasso-appearance', payload)
      sendPreview('lasso-appearance', payload)
    },
    deliver(message) {
      if (typeof message !== 'object' || message === null) return false
      const record = message as {
        type?: unknown
        action?: unknown
        ok?: unknown
        message?: unknown
        image?: unknown
      }
      if (record.type === 'lasso-result') {
        if ((record.action === 'send' || record.action === 'translate') && record.ok === true) {
          endAction()
          hideConfirm()
          finishBallPage()
          return true
        }
        // Copy keeps the frame open; the page shows its own completion state.
        endAction()
        sendConfirm('lasso-confirm-result', record)
        return true
      }
      if (record.type === 'lasso-attach') {
        deps.sendToBall('orb:lasso-attach', record)
        return true
      }
      if (record.type === 'lasso-preview') {
        showPreview(record)
        return true
      }
      return false
    },
    chromeWindows() {
      return [trail, preview]
    },
    cloakWindows() {
      return [{ window: () => trail }, { window: () => preview }]
    },
    start,
    addPoint,
    end,
    cancel,
    close() {
      cancel()
      ipcMain.removeListener('lasso:action', onAction)
      ipcMain.removeListener('lasso:cancel', onCancel)
      ipcMain.removeListener('lasso:preview-close', onPreviewClose)
      if (!trail.isDestroyed()) trail.destroy()
      if (!confirm.isDestroyed()) confirm.destroy()
      if (!preview.isDestroyed()) preview.destroy()
    },
  }

  function openTrail(preloadPath: string): BrowserWindow {
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
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    created.setIgnoreMouseEvents(true, { forward: true })
    denyWindowPermissions(created)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', (event) => { event.preventDefault() })
    return created
  }

  function openConfirmWindow(preloadPath: string): BrowserWindow {
    return overlayWindow(preloadPath, false)
  }

  function openPreviewWindow(preloadPath: string): BrowserWindow {
    return overlayWindow(preloadPath, true)
  }

  function overlayWindow(preloadPath: string, focusable: boolean): BrowserWindow {
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
      focusable,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      roundedCorners: false,
      ...process.platform === 'darwin' ? { type: 'panel' as const } : {},
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    denyWindowPermissions(created)
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', (event) => { event.preventDefault() })
    return created
  }
}

function readRect(value: unknown): LassoRect | undefined {
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

function readDisplay(value: unknown): LassoDisplay | undefined {
  const rect = readRect(value)
  if (rect === undefined || typeof value !== 'object' || value === null) return undefined
  const scale = (value as { scale?: unknown }).scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return undefined
  return { ...rect, scale }
}
