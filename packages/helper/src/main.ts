/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { request as httpRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { readAvatarChoice, type AvatarChoice } from './avatar.ts'
import { collectChromeWindowIds, type NativeHandleWindow } from './chrome-windows.ts'
import { AGENT_STRIP_WIDTH, FloatingPlacement, initialExpandDirection, initialWindowBounds, type Direction, type Rect } from './geometry.ts'
import { decideHover } from './hover.ts'
import { contextMenuTemplate } from './menu.ts'
import { attachOverlays, claimPermissionSession, denyWindowPermissions } from './overlays.ts'
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
  /** Newer published version the host found, or null when there is nothing to install. */
  update: string | null
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
  update: null,
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

let win: BrowserWindow | undefined
let tccWait: ((status: unknown) => void) | undefined
let overlays: {
  appearance(payload: { dark: boolean; locale: 'zh' | 'en' }): void
  deliver(message: unknown): boolean
  chromeWindows(): readonly (NativeHandleWindow | undefined)[]
} | undefined
let placement: FloatingPlacement | undefined
/** True while the ball rides a display edge as a tab; the cursor poll reads it. */
let ballDocked = false
/** Reserved bookmark-strip width the poll reads, so a strip hover keeps the panel open. */
let placementStrip = 0
let live: Socket | undefined
let quitting = false
/** Click-through last written to the OS; see applyClickThrough. */
let ballClickThrough = true
/** The capture cloak forces click-through over this while it holds an input interval. */
let cloakClickThrough = false
/** Panel state the cursor poll reads: true while the renderer shows the panel. */
let placementExpanded = false
/** Corner the ball is parked in; the poll needs it before the renderer reports one. */
let placementDirection: Direction = { horizontal: 'left', vertical: 'up' }
/** Last hover request sent, so a request the renderer refuses is not re-sent every tick. */
let lastRequest: 'expand' | 'collapse' | undefined
/** The hover half of the click-through decision; the cloak owns the other half. */
let cursorClickThrough = true
/** True while the page holds the ball: set from `orb:interactive` reports. */
let ballDragging = false
/** ~16 polls a second: smooth enough for a hover, cheap enough to leave running. */
const HOVER_POLL_MS = 60

/** The window fields of a placement answer, which is what the cursor poll tracks. */
interface PlacementAnswer {
  readonly horizontal: string
  readonly vertical: string
  readonly docked?: unknown
  readonly expanded?: boolean
  readonly strip?: unknown
}
// Corner the window was opened in; the renderer needs it before its first paint.
let initialDirection: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | undefined
let buffer = ''
/** Last bookmark payload, re-sent when the page reloads without a socket reconnect. */
let lastAgentItems: unknown[] = []

app.on('before-quit', () => {
  quitting = true
  live?.destroy()
})
app.on('window-all-closed', () => {
  app.quit()
})

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  win = openWindow()
  try {
    overlays = await attachOverlays({
      ball: () => win,
      write,
      clickThrough: (clickThrough) => setBallClickThrough(clickThrough),
    })
  } catch (error) {
    console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`)
  }
  placement = new FloatingPlacement(win, (point) => {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    return { bounds: display.bounds, workArea: display.workArea }
  }, () => screen.getAllDisplays().map((display) => display.bounds), initialDirection,
    // A drag across the screen centre flips the corner the ball is parked in, and the
    // window is re-anchored for it in the same call. The page paints the ball from its own
    // classes, so they have to be on their way out before the window moves: otherwise the
    // frame pairs the new origin with the old corner (a flash towards the old side) and the
    // cursor poll then aims at a rectangle the ball is not in (a ball that cannot be
    // hovered, clicked or expanded). Push and let the placement move on.
    (direction) => {
      try {
        win?.webContents.send('orb:direction', direction)
      } catch {
        // The window died between the check and the send; the move will fail too.
      }
    })
  // Restore hover expand and auto collapse that the panel-sized window took away: the page
  // only sees pointer events, and the pointer stays inside the window once it leaves the
  // ball, so the OS cursor is the only honest source. See ./hover.ts.
  setInterval(pollCursor, HOVER_POLL_MS)
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) win.showInactive()
    // The page may have loaded after the last appearance or bookmark change.
    pushAppearance()
    // The page may have loaded after the last direction or bookmark change.
    if (win && initialDirection) win.webContents.send('orb:direction', initialDirection)
    if (win && !win.isDestroyed() && lastAgentItems.length > 0) {
      win.webContents.send('orb:agents', lastAgentItems)
    }
  })
  // OS scheme flips ride through while the theme preference is `system`.
  nativeTheme.on('updated', () => { pushAppearance() })
  applyAppearance()
  await win.loadFile(fileURLToPath(new URL('../assets/floating.html', import.meta.url)))
  connect(0)
})

ipcMain.handle('orb:expand', (event, expanded) => {
  if (!fromBall(event) || !placement || typeof expanded !== 'boolean') {
    return { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined, strip: 0 }
  }
  return remember(placement.setExpanded(expanded))
})

ipcMain.handle('orb:move', (event, request) => {
  if (!fromBall(event) || !placement || !isMove(request)) return { docked: undefined }
  const ball = ballOriginForMove(request, { x: request.x, y: request.y })
  if (ball === undefined) return { docked: undefined }
  return remember(placement.move(ball.x, ball.y, request.canDock))
})

ipcMain.handle('orb:clamp', async (event, payload) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  const request = readClampRequest(payload)
  // A clamp carries the ball position the renderer measured, and optionally the grab.
  // With a grab the helper recomputes the release point from the real cursor; without
  // one the reported origin stands, which is what an older page sends.
  const ball = ballOriginForMove(request, request.origin)
  const result = await placement.clamp(request.canDock, ball)
  logDockDiagnostics(result, ball ?? request.origin)
  return remember(result)
})

/**
 * The ball origin a move or release asked for, in DIP screen coordinates.
 *
 * A drag reports where the cursor holds the ball, not where the ball should be: the
 * renderer's own window-relative numbers are measured against the window the drag is
 * moving, so a target built from them chases its own displacement and lands about half
 * way. The cursor reading here is absolute, and `screen.getCursorScreenPoint()` is the
 * freshest one available.
 *
 * `fallback` is the renderer's own estimate, used when no grab came with the call: an
 * older preload, a programmatic move, or a release that lost its pointer coordinates.
 */
function ballOriginForMove(
  request: { grab?: { x: number; y: number } },
  fallback?: { x: number; y: number },
): { x: number; y: number } | undefined {
  const grab = request.grab
  if (grab === undefined) return fallback
  const cursor = screen.getCursorScreenPoint()
  return { x: cursor.x - grab.x, y: cursor.y - grab.y }
}

/** The renderer offsets pointer coordinates by this instead of `event.screenX`. */
ipcMain.handle('orb:origin', (event) => {
  if (!fromBall(event) || !placement) return undefined
  return placement.screenOrigin()
})

ipcMain.handle('orb:unsnap', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return remember(await placement.unsnap())
})

/** Hand the answer back untouched, but let the cursor poll read it first. */
function remember<T extends PlacementAnswer>(state: T): T {
  setPlacementState(state)
  return state
}

/**
 * Click-through for the transparent chrome of the ball window.
 *
 * The window keeps FIXED_WINDOW_SIZE in every state so that expand/collapse never
 * moves its origin: a moved origin makes Windows copy the old client bitmap to the
 * new one and paints one stale frame, which is the expand flicker. Everything
 * outside the ball and the open panel is therefore transparent chrome that must
 * forward clicks to the window underneath. The main process decides that from its own
 * cursor poll ({@link decideHover}) instead of from a renderer report: while the
 * window is click-through the page sees no pointer move at all, so a report-driven
 * flag would be whatever was written before the pointer froze.
 */
ipcMain.on('orb:dragging', (event, dragging) => {
  if (!fromBall(event) || typeof dragging !== 'boolean') return
  // A drag owns the window: it stays interactive wherever the cursor goes, and the
  // poll stops second-guessing a rectangle it cannot keep up with.
  ballDragging = dragging
  pollCursor()
})

ipcMain.on('orb:interactive', (event, interactive) => {
  if (!fromBall(event) || typeof interactive !== 'boolean') return
  // The renderer still reports the region it believes the pointer is over, right after
  // every panel and dock change. The poll owns the answer now, so the report only has to
  // cut the wait for the next tick short — one authority, no second opinion to reconcile,
  // and a stale claim cannot leave the window swallowing clicks.
  pollCursor()
})

/** The capture cloak holds the ball click-through for the length of an input interval. */
function setBallClickThrough(clickThrough: boolean): void {
  cloakClickThrough = clickThrough
  applyClickThrough(currentClickThrough())
}

/**
 * The OS click-through the two writers agree on: the capture cloak while it holds an
 * input interval, otherwise the cursor poll's hover answer. Either one keeps it on;
 * neither writes the other's half off.
 */
function applyClickThrough(clickThrough: boolean): void {
  if (clickThrough === ballClickThrough) return
  ballClickThrough = clickThrough
  if (!win || win.isDestroyed()) return
  if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

function currentClickThrough(): boolean {
  return cloakClickThrough || cursorClickThrough
}

/**
 * One cursor tick: test the OS cursor against the window rectangle, then do the two
 * things the page can no longer do for itself.
 *
 * `placementExpanded` is true only while the panel is showing, and the ball keeps the
 * corner it was placed in through both states, so one rectangle serves both. The flag
 * decides whether the panel is hit-tested at all and whether a ball hover is a request.
 *
 * A request is sent when the answer changes, and the memory of it is dropped as soon as
 * there is no request at all. Keeping it through an "off" tick would latch: pin the panel,
 * walk the cursor off it, unpin, walk off again — the second leave would look like a repeat
 * of the refused first one and the panel would stay open. What the memory is really for is
 * the tick after a *refused* request: the renderer keeps every guard (pinned, running,
 * asking, dragging, suppressExpand), a refusal leaves the state unchanged, and re-sending
 * the identical request sixteen times a second would only be noise. `orb:expand` stays the
 * renderer's call alone, so a pinned panel is never forced open.
 */
function pollCursor(): void {
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return
  const bounds = win.getBounds()
  const decision = decideHover({
    cursor: screen.getCursorScreenPoint(),
    window: bounds,
    direction: placementDirection,
    expanded: placementExpanded,
    docked: ballDocked,
    dragging: ballDragging,
    strip: placementStrip,
  })
  cursorClickThrough = !decision.interactive
  applyClickThrough(currentClickThrough())
  const request = decision.request
  if (request === lastRequest) return
  lastRequest = request
  if (request === undefined) return
  win.webContents.send(request === 'expand' ? 'orb:hover' : 'orb:unhover')
}


/**
 * Keep the cursor poll's own view of the window in step with the placement.
 *
 * Only `orb:expand` answers carry `expanded`; a move or clamp leaves the flag as it was,
 * which is what the renderer does with the panel too.
 */
function setPlacementState(state: PlacementAnswer): void {
  if (typeof state.expanded === 'boolean') placementExpanded = state.expanded
  placementDirection = {
    horizontal: state.horizontal === 'left' ? 'left' : 'right',
    vertical: state.vertical === 'up' ? 'up' : 'down',
  }
  ballDocked = state.docked === 'left' || state.docked === 'right'
  if (typeof state.strip === 'number' && Number.isFinite(state.strip)) {
    placementStrip = Math.max(0, Math.round(state.strip))
  }
}

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

ipcMain.on('orb:agent-open', (event, sessionId) => {
  if (!fromBall(event)) return
  if (typeof sessionId === 'string') write({ type: 'agent-open', sessionId })
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

/**
 * Forward one recording to the host's `/.dsh-orb/transcribe` proxy.
 *
 * The helper holds no official credentials, so the official speech service is
 * reached over the same authenticated loopback surface as the avatar. Failures
 * resolve to a result object rather than rejecting, so the page can show a
 * localized message instead of an unhandled rejection.
 */
ipcMain.handle('orb:transcribe', async (event, payload) => {
  if (!fromBall(event)) return transcribeFailure('voice-unavailable', 'Not the ball')
  const request = readTranscribeRequest(payload)
  if (request === undefined) return transcribeFailure('invalid-audio', 'Audio is invalid')
  const response = await postTranscribe(request)
  return response ?? transcribeFailure('voice-unavailable', 'Speech recognition is not available')
})

function transcribeFailure(error: string, message: string): { ok: false; error: string; message: string } {
  return { ok: false, error, message }
}

/** Accept only a plausible base64 WAV payload from the renderer. */
function readTranscribeRequest(value: unknown): { audioBase64: string; audioSeconds: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { audioBase64?: unknown; audioSeconds?: unknown }
  if (typeof record.audioBase64 !== 'string' || record.audioBase64.length === 0) return undefined
  if (record.audioBase64.length > 8_000_000) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(record.audioBase64)) return undefined
  if (typeof record.audioSeconds !== 'number' || !Number.isFinite(record.audioSeconds) || record.audioSeconds < 0) {
    return undefined
  }
  return { audioBase64: record.audioBase64, audioSeconds: record.audioSeconds }
}

/** POST the recording to the host and decode its JSON answer. */
function postTranscribe(request: { audioBase64: string; audioSeconds: number }): Promise<
  { ok: true; text: string } | { ok: false; error: string; message: string } | undefined
> {
  const port = Number(webPort)
  if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(undefined)
  const body = Buffer.from(JSON.stringify(request))
  return new Promise((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/.dsh-orb/transcribe',
      method: 'POST',
      headers: {
        'x-dsh-orb-helper': token,
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_000_000) {
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          resolve(undefined)
          return
        }
        const record = parsed as { text?: unknown; error?: unknown; message?: unknown }
        if (res.statusCode === 200 && typeof record.text === 'string') {
          resolve({ ok: true, text: record.text })
          return
        }
        const code = typeof record.error === 'string' ? record.error : 'voice-failed'
        const message = typeof record.message === 'string' ? record.message : 'Speech recognition failed'
        resolve(transcribeFailure(code, message))
      })
    })
    req.setTimeout(120_000, () => {
      req.destroy()
      resolve(undefined)
    })
    req.on('error', () => resolve(undefined))
    req.end(body)
  })
}

function openWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea
  const bounds = initialWindowBounds(workArea)
  initialDirection = initialExpandDirection(workArea)
  // The cursor poll has to know the ball's corner before the renderer reports one: it
  // hit-tests the window from the very first tick, and the resting spot on a short work
  // area is not the default corner.
  placementDirection = initialDirection
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
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The ball rests captureable; overlays.ts syncCloak lifts it out of captures
  // for the duration of each Computer Use capture or HID interval.
  denyWindowPermissions(created)
  allowBallMicrophone(created)
  created.setAlwaysOnTop(true, 'screen-saver')
  // Fixed-size from the start, so most of the window is transparent chrome: open
  // click-through and let the renderer report the ball's region on its first move.
  created.setIgnoreMouseEvents(true, { forward: true })
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
 * Grant the microphone to this window's own `file:` page and nothing else.
 *
 * The ball shares Electron's default session with the selection toolbar and the
 * observation frame, which call `denyWindowPermissions`. This claims the session
 * first so that deny-all cannot overwrite the grant, then admits exactly one
 * permission for the ball's own origin. Both the request and the synchronous
 * check are covered, because Chromium consults the check handler for
 * `getUserMedia` too. Every other permission —and every other origin —still
 * gets `false`.
 */
function allowBallMicrophone(created: BrowserWindow): void {
  const session = created.webContents.session
  claimPermissionSession(created)
  /**
   * The ball's own page and nothing else.
   *
   * Identity against this window's webContents is the precise test: the
   * selection toolbar and observation frame are separate windows on the same
   * session and must stay denied. The URL check is a fallback for Electron
   * builds that pass a fresh wrapper object; note that a `file:` URL's
   * `origin` is the *string* `"null"`, so the protocol is compared instead.
   */
  const isBallPage = (contents: { getURL(): string } | null | undefined): boolean => {
    if (!contents) return false
    if (contents === created.webContents) return true
    try {
      return new URL(contents.getURL()).protocol === 'file:'
    } catch {
      return false
    }
  }
  session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && isBallPage(contents))
  })
  session.setPermissionCheckHandler((contents, permission) => {
    return permission === 'media' && isBallPage(contents)
  })
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
  if (record.type === 'update') {
    const text = updateStatusText(record as { state?: unknown; version?: unknown; reason?: unknown }, menuZh())
    if (text !== '') win.webContents.send('orb:status', text)
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
  if (record.type === 'agents') {
    const items = (record as { items?: unknown }).items
    lastAgentItems = Array.isArray(items) ? items : []
    win.webContents.send('orb:agents', lastAgentItems)
    applyStrip(lastAgentItems.length > 0)
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

/**
 * The bookmark strip lives beside the panel inside one transparent window, so
 * the window widens while bookmarks exist and shrinks back when they clear.
 * The renderer learns the applied geometry through `orb:expand-state`.
 */
function applyStrip(present: boolean): void {
  if (!placement) return
  // Deliberately NOT through `remember`: the cursor poll keeps its own copy of the
  // expand state, and letting a bookmark arriving refresh it would make the strip
  // respond to a bare hover. The strip has always been something you act on, and the
  // poll's picture of the ball and the panel is enough for the drag and hover it drives.
  const state = placement.setStrip(present ? AGENT_STRIP_WIDTH : 0)
  if (win && !win.isDestroyed()) win.webContents.send('orb:expand-state', state)
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

function isMove(value: unknown): value is { x: number; y: number; canDock: boolean; grab?: { x: number; y: number } } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown; canDock?: unknown; grab?: unknown }
  return typeof point.x === 'number' && typeof point.y === 'number'
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= 100_000 && Math.abs(point.y) <= 100_000
    && typeof point.canDock === 'boolean'
    && (point.grab === undefined || isGrab(point.grab))
}

/** A cursor offset inside the dragged element: small, finite, non-negative. */
function isGrab(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown }
  return typeof point.x === 'number' && typeof point.y === 'number'
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= -64 && point.x <= 512 && point.y >= -64 && point.y <= 512
}

/** Accepts the legacy bare `canDock` boolean and the `{ canDock, origin }` payload. */
function readClampRequest(value: unknown): {
  canDock: boolean
  origin?: { x: number; y: number }
  grab?: { x: number; y: number }
} {
  if (typeof value === 'boolean') return { canDock: value }
  if (typeof value !== 'object' || value === null) return { canDock: true }
  const record = value as { canDock?: unknown; origin?: unknown; grab?: unknown }
  const canDock = record.canDock !== false
  const origin = isPoint(record.origin) ? { x: record.origin.x, y: record.origin.y } : undefined
  const grab = isGrab(record.grab) ? { x: record.grab.x, y: record.grab.y } : undefined
  return { canDock, origin, grab }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown }
  return typeof point.x === 'number' && typeof point.y === 'number'
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= 100_000 && Math.abs(point.y) <= 100_000
}

/**
 * Docking diagnostics, off unless `DSH_ORB_DOCK_DEBUG` is set. One stderr line per
 * drag release: the window bounds (`setBounds`/`getBounds` path), the renderer's
 * drag coordinates, every display with its scaleFactor, and the decision. A
 * machine that will not dock reports here exactly which coordinate space drifted,
 * which is the only way to diagnose a display/DPI layout we cannot reproduce.
 */
function logDockDiagnostics(result: { docked?: 'left' | 'right' }, remoteOrigin?: { x: number; y: number }): void {
  if (process.env.DSH_ORB_DOCK_DEBUG !== '1') return
  if (!win || win.isDestroyed()) return
  const displays = screen.getAllDisplays().map((display) => ({
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  }))
  console.error(`[orb-dock] ${JSON.stringify({
    electron: process.versions.electron,
    window: win.getBounds(),
    remote: remoteOrigin ?? null,
    displays,
    docked: result.docked ?? null,
  })}`)
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
    update?: unknown
    catalog?: MenuCatalog
  }
  return {
    overlay: selectionOr(record.overlay, chrome.overlay),
    background: selectionOr(record.background, chrome.background),
    millifractionEnabled: record.millifractionEnabled === true,
    openMain: record.openMain === true,
    update: typeof record.update === 'string' && record.update !== '' ? record.update : null,
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
    update: () => { write({ type: 'update' }) },
    disable: () => { write({ type: 'disable' }) },
  })
  Menu.buildFromTemplate(template).popup({ window })
}

/** One line for the ball's status area: the update runs in the host, the ball only narrates it. */
function updateStatusText(message: { state?: unknown; version?: unknown; reason?: unknown }, zh: boolean): string {
  const version = typeof message.version === 'string' ? message.version : ''
  if (message.state === 'available') {
    return zh ? `发现新版本 ${version}，右键球可更新` : `Version ${version} is available — right-click the ball to update`
  }
  if (message.state === 'starting') {
    return zh ? `正在更新到 ${version}…` : `Updating to ${version}…`
  }
  if (message.state === 'done') {
    return zh ? `已更新到 ${version}，重启 DeepSeek Harness 后生效` : `Updated to ${version} — restart DeepSeek Harness to apply it`
  }
  if (message.state === 'failed') {
    return zh ? `更新失败：${updateFailureText(message.reason, true)}` : `Update failed: ${updateFailureText(message.reason, false)}`
  }
  return ''
}

function updateFailureText(reason: unknown, zh: boolean): string {
  if (reason === 'build-blocked') {
    return zh ? '安装脚本未获授权，请在设置页允许后重试' : 'install scripts need approval — allow them in settings and retry'
  }
  if (reason === 'incompatible-version') {
    return zh ? '当前 Harness 版本与新版不兼容' : 'the new version is incompatible with this Harness build'
  }
  if (typeof reason === 'string' && reason !== '') return reason
  return zh ? '未知错误' : 'unknown error'
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
