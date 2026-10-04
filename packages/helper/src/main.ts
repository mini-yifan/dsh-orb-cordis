/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { request as httpRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { readAvatarChoice, type AvatarChoice } from './avatar.ts'
import { collectChromeWindowIds, type NativeHandleWindow } from './chrome-windows.ts'
import { BALL_WINDOW_SIZE, FloatingPlacement, initialWindowBounds } from './geometry.ts'
import { contextMenuTemplate } from './menu.ts'
import { attachOverlays, denyWindowPermissions } from './overlays.ts'
import { type MenuCatalog, type MenuSelection } from './model-menu.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''
const webPort = process.env.DSH_ORB_WEB_PORT ?? ''

/** Theme preference as stored by the official ui-theme settings section. */
type ThemeSource = 'light' | 'dark' | 'system'

interface Appearance {
  theme?: ThemeSource
  locale?: string
}

interface ChromeState {
  overlay: MenuSelection
  background: MenuSelection
  millifractionEnabled: boolean
  openMain: boolean
  catalog: MenuCatalog
}

const defaultSelection: MenuSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

let chrome: ChromeState = {
  overlay: defaultSelection,
  background: defaultSelection,
  millifractionEnabled: false,
  openMain: false,
  catalog: { groups: [] },
}
let avatarToken = 0
// Raw preferences as stored; `theme` resolves through nativeTheme, an absent
// locale falls back to the system languages.
let appearance: Appearance = readAppearanceEnv()

process.title = 'dsh-orb-helper'

if (!socketAddress || !token) {
  console.error('dsh-orb helper: socket environment is missing')
  process.exit(1)
}

if (process.platform === 'darwin') app.setActivationPolicy?.('accessory')

// KDE Wayland: a client cannot place its own toplevel and cannot keep it above
// other windows. The X11 (XWayland) backend can, so the ball is pinned to it
// rather than letting Chromium pick the native Wayland backend.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  app.commandLine.appendSwitch('enable-transparent-visuals')
}
let win: BrowserWindow | undefined
let tccWait: ((status: unknown) => void) | undefined
let overlays: {
  appearance(payload: { dark: boolean; locale: 'zh' | 'en' }): void
  deliver(message: unknown): boolean
  chromeWindows(): readonly (NativeHandleWindow | undefined)[]
} | undefined
let placement: FloatingPlacement | undefined
let live: Socket | undefined
let quitting = false
let buffer = ''

app.on('before-quit', () => {
  quitting = true
  live?.destroy()
})
app.on('window-all-closed', () => {
  app.quit()
})

/** How often the window is checked against the page's own idea of the panel. */
const PANEL_WATCHDOG_MS = 700
/** Rounded window sizes land a pixel over the nominal value. */
const SIZE_TOLERANCE = 2
/** Consecutive bad readings before the watchdog acts. */
const PANEL_WATCHDOG_STRIKES = 4
/** Minimum gap between two collapses. */
const PANEL_WATCHDOG_COOLDOWN_MS = 5000

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  win = openWindow()
  try {
    overlays = await attachOverlays({ ball: () => win, write })
  } catch (error) {
    console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`)
  }
  placement = new FloatingPlacement(win, (point) => {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    return { bounds: display.bounds, workArea: display.workArea }
  }, () => screen.getAllDisplays().map((display) => display.bounds))
  startPanelWatchdog()
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) win.showInactive()
    // The page may have loaded after the last appearance change.
    pushAppearance()
    // The ball starts collapsed. A page that opened the panel on boot would
    // leave the window at panel size with a 72px ball in the corner of it,
    // which is also what made dragging feel off: the pointer was moving a
    // 344x444 window while aiming at the ball inside it.
    if (placement !== undefined) {
      setTimeout(() => { placement?.setExpanded(false) }, 400).unref?.()
    }
  })
  // OS scheme flips ride through while the theme preference is `system`.
  nativeTheme.on('updated', () => { pushAppearance() })
  applyAppearance()
  await win.loadFile(fileURLToPath(new URL('../assets/floating.html', import.meta.url)))
  connect(0)
})

ipcMain.handle('orb:expand', async (event, expanded) => {
  const sender = ballSender(event)
  if (sender === undefined || !placement || typeof expanded !== 'boolean') {
    return { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined }
  }
  if (expanded) await prepareExpansion(sender)
  return placement.setExpanded(expanded)
})

/** The ball's webContents when the IPC came from it, otherwise undefined. */
function ballSender(event: unknown): BrowserWindow['webContents'] | undefined {
  if (!fromBall(event)) return undefined
  return (event as { sender: BrowserWindow['webContents'] }).sender
}

/** Resolves when the page has moved the ball into its expanded corner, or on timeout. */
let prepared: (() => void) | undefined

/** How long the page gets to acknowledge a layout change before the window moves anyway. */
const PREPARE_TIMEOUT_MS = 120

ipcMain.on('orb:prepared', (event) => {
  if (!fromBall(event)) return
  const resolve = prepared
  prepared = undefined
  resolve?.()
})

/**
 * Let the page repaint the ball into the corner it will occupy once the window
 * grows. The window keeps its collapsed size while this runs, so nothing is
 * visible yet; the point is that the very first frame drawn at panel size
 * already has the ball in the right place.
 */
function prepareExpansion(sender: BrowserWindow['webContents']): Promise<void> {
  if (placement === undefined) return Promise.resolve()
  const preview = placement.previewExpand()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      prepared = undefined
      resolve()
    }
    prepared = finish
    sender.send('orb:prepare', preview)
    setTimeout(() => {
      if (done) return
      // The resize goes through anyway: a page that never answers must not be
      // able to freeze the ball, and the frame it costs is the old behaviour.
      console.error('dsh-orb helper: page did not acknowledge the layout change')
      finish()
    }, PREPARE_TIMEOUT_MS).unref?.()
  })
}

ipcMain.handle('orb:move-by', (event, request) => {
  if (!fromBall(event) || !placement || !isDelta(request)) return { docked: undefined }
  return placement.moveBy(request.dx, request.dy, false)
})

ipcMain.handle('orb:clamp', async (event, canDock) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.clamp(canDock !== false)
})

ipcMain.handle('orb:unsnap', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.unsnap()
})

ipcMain.on('orb:prompt', (event, text) => {
  if (!fromBall(event)) return
  write({ type: 'prompt', text })
})

ipcMain.on('orb:question-answer', (event, payload) => {
  if (!fromBall(event)) return
  if (typeof payload !== 'object' || payload === null) return
  const record = payload as { id?: unknown; answers?: unknown }
  write({ type: 'question-answer', id: record.id, answers: record.answers })
})

ipcMain.on('orb:question-cancel', (event, id) => {
  if (!fromBall(event)) return
  write({ type: 'question-cancel', id })
})

ipcMain.on('orb:history', (event) => {
  if (!fromBall(event)) return
  write({ type: 'history' })
})

ipcMain.on('orb:open', (event, sessionId) => {
  if (!fromBall(event)) return
  if (typeof sessionId === 'string') write({ type: 'open', sessionId })
})

ipcMain.on('orb:new', (event) => {
  if (!fromBall(event)) return
  write({ type: 'new' })
})

ipcMain.on('orb:permission', (event, preset) => {
  if (!fromBall(event)) return
  if (typeof preset === 'string') write({ type: 'permission', preset })
})

ipcMain.on('orb:stop', (event) => {
  if (!fromBall(event)) return
  write({ type: 'stop' })
})

// Renderer clipboard APIs need a focused document; the ball rests unfocused,
// so writes go through the main process, which has no such gate.
ipcMain.on('orb:copy', (event, text) => {
  if (!fromBall(event)) return
  if (typeof text !== 'string' || text.length > 1_000_000) return
  clipboard.writeText(text)
})

ipcMain.handle('orb:menu', async (event) => {
  if (!fromBall(event) || !win) return
  write({ type: 'menu' })
  await showMenu(win)
})

ipcMain.on('orb:open-external', (event, url) => {
  if (!fromBall(event)) return
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 4000) return
  void shell.openExternal(url)
})

ipcMain.handle('orb:tcc-status', (event) => {
  if (!fromBall(event)) return tccUnavailable()
  return askTcc({ type: 'tcc' })
})

ipcMain.handle('orb:tcc-open', (event, right) => {
  if (!fromBall(event)) return tccUnavailable()
  if (right !== 'screen' && right !== 'accessibility') return tccUnavailable()
  return askTcc({ type: 'tcc-open', right })
})

function openWindow(): BrowserWindow {
  const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea)
  const created = new BrowserWindow({
    title: 'dsh-orb',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    ...process.platform === 'darwin' ? { type: 'panel' } : {},
    ...process.platform === 'linux' ? { type: 'utility' } : {},
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
    // KDE lists only normal windows in the task bar, and Electron's
    // `skipTaskbar` never reaches X11's `_NET_WM_STATE_SKIP_TASKBAR`: KWin
    // reports the ball as a normal window and shows it next to real apps.
    // A utility window is the shape KDE keeps out of the task bar while still
    // letting the client place itself.
  // The ball rests captureable; overlays.ts syncCloak lifts it out of captures
  // for the duration of each Computer Use capture or HID interval.
  denyWindowPermissions(created)
  created.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('context-menu', (event, params) => {
    // Editable text and an active selection get the native menu (Copy/Paste);
    // bare right-click still opens the ball's own menu.
    if (params?.isEditable || params?.hasSelection) return
    event.preventDefault()
    write({ type: 'menu' })
    setTimeout(() => { void showMenu(created) }, 30)
  })
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  created.on('closed', () => {
    if (!quitting) app.quit()
  })
  created.once('ready-to-show', () => {
    created.showInactive()
    const shown = created.getBounds()
    console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`)
  })
  return created
}

/**
 * Keep the window the size of the ball unless the panel is genuinely open.
 *
 * The panel and the ball share one window: opening grows it to 320x420, closing
 * shrinks it back. Every path that opens it has to remember to close it, and any
 * path that forgets leaves a 72px ball inside a 344x444 window. This asks the
 * page directly and puts the window back if the page says the panel is closed.
 *
 * It must never become a resize loop, so three guards apply before it acts: the
 * size comparison has a rounding tolerance (a collapsed window measures 96x97,
 * not 96x96), the bad state has to persist for several ticks, and the watchdog
 * gives up permanently after a handful of attempts — a window that keeps
 * coming back large is the page's decision, not a missed collapse.
 */
function startPanelWatchdog(): void {
  let strikes = 0
  let lastAttempt = 0
  const timer = setInterval(() => {
    if (win === undefined || win.isDestroyed() || placement === undefined) return
    const bounds = win.getBounds()
    if (bounds.width <= BALL_WINDOW_SIZE + SIZE_TOLERANCE && bounds.height <= BALL_WINDOW_SIZE + SIZE_TOLERANCE) {
      strikes = 0
      return
    }
    void win.webContents
      .executeJavaScript('document.body.classList.contains("expanded")')
      .then((open: unknown) => {
        if (open === true) {
          strikes = 0
          return
        }
        strikes += 1
        if (strikes < PANEL_WATCHDOG_STRIKES) return
        if (Date.now() - lastAttempt < PANEL_WATCHDOG_COOLDOWN_MS) return
        strikes = 0
        lastAttempt = Date.now()
        if (win === undefined || win.isDestroyed() || placement === undefined) return
        console.error(`dsh-orb helper: window was ${bounds.width}x${bounds.height} with the panel closed; collapsing`)
        placement.setExpanded(false)
      })
      .catch(() => undefined)
  }, PANEL_WATCHDOG_MS)
  timer.unref?.()
}

function connect(attempt: number): void {
  if (quitting) return
  const colon = socketAddress.lastIndexOf(':')
  const host = socketAddress.slice(0, colon)
  const port = Number(socketAddress.slice(colon + 1))
  const socket = createConnection({ host, port })
  socket.setEncoding('utf8')
  let opened = false
  socket.on('connect', () => {
    opened = true
    live = socket
    buffer = ''
    socket.write(`${JSON.stringify({ type: 'hello', token, pid: process.pid })}\n`)
    // The host's observation walk must skip the ball itself, or a click on the ball makes
    // it the window the agent believes the user is working in.
    const ids = chromeWindowIds()
    if (ids.length > 0) write({ type: 'chrome-windows', ids })
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(part)
      } catch {
        continue
      }
      deliver(message)
    }
  })
  socket.on('error', () => {
    // close follows and decides whether to retry.
  })
  socket.on('close', () => {
    if (live === socket) live = undefined
    if (quitting) return
    if (opened) {
      app.quit()
      return
    }
    if (attempt >= 30) {
      console.error('dsh-orb helper: host socket did not open')
      app.exit(1)
      return
    }
    setTimeout(() => connect(attempt + 1), 300)
  })
}

function deliver(message: unknown): void {
  if (overlays?.deliver(message)) return
  if (typeof message !== 'object' || message === null || !win) return
  const record = message as { type?: unknown }
  if (record.type === 'session') {
    win.webContents.send('orb:session', (record as { sessionId?: unknown }).sessionId)
    return
  }
  if (record.type === 'block') {
    win.webContents.send('orb:block', message)
    return
  }
  if (record.type === 'block-drop') {
    win.webContents.send('orb:block-drop', (record as { key?: unknown }).key)
    return
  }
  if (record.type === 'turn') {
    win.webContents.send('orb:turn', message)
    return
  }
  if (record.type === 'status') {
    win.webContents.send('orb:status', (record as { text?: unknown }).text)
    return
  }
  if (record.type === 'question') {
    win.webContents.send('orb:question', message)
    return
  }
  if (record.type === 'question-clear') {
    win.webContents.send('orb:question-clear', (record as { id?: unknown }).id)
    return
  }
  if (record.type === 'question-error') {
    win.webContents.send('orb:question-error', message)
    return
  }
  if (record.type === 'permission') {
    win.webContents.send('orb:permission', (record as { preset?: unknown }).preset)
    return
  }
  if (record.type === 'history') {
    win.webContents.send('orb:history', (record as { items?: unknown }).items)
    return
  }
  if (record.type === 'reset') {
    win.webContents.send('orb:reset')
    return
  }
  if (record.type === 'chrome') {
    chrome = readChrome(record)
    return
  }
  if (record.type === 'appearance') {
    const next = readAppearanceMessage(message)
    if (next.theme !== undefined) appearance.theme = next.theme
    if (next.locale !== undefined) appearance.locale = next.locale
    applyAppearance()
    return
  }
  if (record.type === 'avatar') {
    void loadAvatar(readAvatarChoice(record as Record<string, unknown>))
    return
  }
  if (record.type === 'tcc') {
    const wait = tccWait
    tccWait = undefined
    wait?.((record as { status?: unknown }).status)
  }
}

/** Ball plus overlays: the windows the host must skip when it picks an observation window. */
function chromeWindowIds(): number[] {
  return collectChromeWindowIds([win, ...(overlays?.chromeWindows() ?? [])], process.platform)
}

function fromBall(event: unknown): boolean {
  if (!win || win.isDestroyed()) return false
  return (event as { sender?: BrowserWindow['webContents'] }).sender === win.webContents
}

function tccUnavailable(): { applicable: false; appName: string; screen: 'granted'; accessibility: 'granted' } {
  return { applicable: false, appName: '', screen: 'granted', accessibility: 'granted' }
}

function askTcc(message: unknown): Promise<unknown> {
  const previous = tccWait
  tccWait = undefined
  previous?.(tccUnavailable())
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (tccWait !== finish) return
      tccWait = undefined
      resolve(tccUnavailable())
    }, 3000)
    const finish = (status: unknown) => {
      clearTimeout(timer)
      resolve(status ?? tccUnavailable())
    }
    tccWait = finish
    write(message)
  })
}

function write(message: unknown): void {
  if (!live) return
  live.write(`${JSON.stringify(message)}\n`)
}

function isDelta(value: unknown): value is { dx: number; dy: number } {
  if (typeof value !== 'object' || value === null) return false
  const step = value as { dx?: unknown; dy?: unknown }
  return typeof step.dx === 'number' && typeof step.dy === 'number'
    && Number.isFinite(step.dx) && Number.isFinite(step.dy)
    && Math.abs(step.dx) <= 10_000 && Math.abs(step.dy) <= 10_000
}

function zhLocale(): boolean {
  const locale = app.getLocale?.() ?? process.env.LANG ?? ''
  return locale.toLowerCase().startsWith('zh')
}

/** Appearance seed from the host: the preferences as of helper launch. */
function readAppearanceEnv(): Appearance {
  const raw = process.env.DSH_ORB_APPEARANCE
  if (typeof raw !== 'string' || raw.length > 200) return {}
  try {
    return readAppearanceMessage(JSON.parse(raw))
  } catch {
    return {}
  }
}

function themeSourceOr(value: unknown, fallback: ThemeSource | undefined): ThemeSource | undefined {
  return value === 'light' || value === 'dark' || value === 'system' ? value : fallback
}

/** Accept only well-formed preference fields; anything else keeps the current value. */
function readAppearanceMessage(value: unknown): Appearance {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as { theme?: unknown; locale?: unknown }
  const theme = themeSourceOr(record.theme, undefined)
  return {
    ...(theme === undefined ? {} : { theme }),
    ...(typeof record.locale === 'string' && record.locale.length > 0 && record.locale.length <= 35
      ? { locale: record.locale }
      : {}),
  }
}

/**
 * The UI language the ball mirrors: an explicit Host locale that names one of
 * the shipped languages wins, otherwise follow the system like the web client
 * falls back to its browser detection.
 */
function uiLanguage(): 'zh' | 'en' {
  const preference = typeof appearance.locale === 'string' ? appearance.locale.toLowerCase() : ''
  if (preference.startsWith('zh')) return 'zh'
  if (preference.startsWith('en')) return 'en'
  return zhLocale() ? 'zh' : 'en'
}

/** Menu and dialog copy follow the mirrored language, not the raw system locale. */
function menuZh(): boolean {
  return uiLanguage() === 'zh'
}

/** Point the helper's theme at the stored preference and push the resolved state. */
function applyAppearance(): void {
  nativeTheme.themeSource = appearance.theme ?? 'system'
  pushAppearance()
}

function pushAppearance(): void {
  const payload = { dark: nativeTheme.shouldUseDarkColors, locale: uiLanguage() }
  if (win && !win.isDestroyed()) win.webContents.send('orb:appearance', payload)
  overlays?.appearance(payload)
}

function readChrome(value: unknown): ChromeState {
  const record = value as {
    overlay?: MenuSelection
    background?: MenuSelection
    millifractionEnabled?: unknown
    openMain?: unknown
    catalog?: MenuCatalog
  }
  return {
    overlay: selectionOr(record.overlay, chrome.overlay),
    background: selectionOr(record.background, chrome.background),
    millifractionEnabled: record.millifractionEnabled === true,
    openMain: record.openMain === true,
    catalog: record.catalog ?? { groups: [] },
  }
}

function selectionOr(value: MenuSelection | undefined, fallback: MenuSelection): MenuSelection {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return fallback
  return value
}

async function showMenu(window: BrowserWindow): Promise<void> {
  const template = contextMenuTemplate(chrome, menuZh(), {
    openMain: () => { write({ type: 'open-main' }) },
    setOverlay: (selection) => { write({ type: 'set-overlay', selection }) },
    setBackground: (selection) => { write({ type: 'set-background', selection }) },
    setMillifraction: (enabled) => { void confirmMillifraction(window, enabled) },
    disable: () => { write({ type: 'disable' }) },
  })
  Menu.buildFromTemplate(template).popup({ window })
}

async function confirmMillifraction(window: BrowserWindow, enabled: boolean): Promise<void> {
  if (enabled === chrome.millifractionEnabled) return
  const zh = menuZh()
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    message: zh ? '新编码只在新对话中生效。' : 'The new encoding takes effect in a new conversation.',
    detail: zh
      ? '当前对话不变，仍可从历史记录打开。取消不写入、不新建。'
      : 'The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.',
    buttons: zh ? ['取消', '新建对话'] : ['Cancel', 'Create new conversation'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  })
  if (response !== 1) return
  write({ type: 'set-millifraction', enabled })
}

async function loadAvatar(choice: AvatarChoice): Promise<void> {
  const tokenId = ++avatarToken
  if (!win) return
  if (choice.kind === 'preset') {
    // A shipped GIF: the page loads the file itself, no socket payload involved.
    win.webContents.send('orb:avatar', choice.src)
    return
  }
  if (choice.kind === 'default') {
    win.webContents.send('orb:avatar', '')
    return
  }
  const image = await fetchAvatar(choice.version)
  if (tokenId !== avatarToken || !win || !image) return
  win.webContents.send('orb:avatar', `data:${image.mime};base64,${image.body.toString('base64')}`)
}

function fetchAvatar(version: number): Promise<{ mime: string; body: Buffer } | undefined> {
  const port = Number(webPort)
  if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/.dsh-orb/avatar?v=${Math.trunc(version)}`,
      method: 'GET',
      headers: { 'x-dsh-orb-helper': token },
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2_500_000) {
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(undefined)
          return
        }
        const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'].split(';')[0] : 'image/gif'
        resolve({ mime: mime ?? 'image/gif', body: Buffer.concat(chunks) })
      })
    })
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(undefined)
    })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}
