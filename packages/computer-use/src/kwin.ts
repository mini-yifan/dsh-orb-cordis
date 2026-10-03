/**
 * KWin scripting bridge: the only source of window geometry, foreground app,
 * and pointer position on KDE Wayland. Wayland exposes none of these to
 * clients, but KWin runs JavaScript plugins that can read its own workspace
 * model and hand the result back over the session bus.
 *
 * Each request writes a one-shot script, loads it through
 * `org.kde.kwin.Scripting`, and waits for that script to `callDBus` the answer
 * back to the interface exported here. Requests are serialized, because one
 * scripting interface can only host one pending script at a time.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/kwin
 */

import * as dbus from 'dbus-next'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { sessionEnv } from './session.ts'

/** Rectangle in compositor logical coordinates. */
export interface KWinRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One toplevel as KWin models it. */
export interface KWinWindow {
  /** Stable per-session id (`internalId`). */
  readonly id: string
  /** Wayland app id / X11 `WM_CLASS` class part. */
  readonly resourceClass: string | null
  /** X11 `WM_CLASS` name part. */
  readonly resourceName: string | null
  /** Desktop file name reported by the client, when it set one. */
  readonly desktopFileName: string | null
  /** Window title. */
  readonly caption: string | null
  /** Owning process id, when KWin knows it. */
  readonly pid: number | null
  /** Whether this window holds keyboard focus. */
  readonly active: boolean
  /** Whether this is a normal user window rather than a shell surface. */
  readonly normalWindow: boolean
  /** Whether the client asked to stay out of the task bar. */
  readonly skipTaskbar: boolean
  readonly minimized: boolean
  /** Frame rectangle including decorations. */
  readonly frame: KWinRect
  /** Client rectangle excluding decorations. */
  readonly client: KWinRect
}

/** One output as KWin models it. */
export interface KWinOutput {
  readonly name: string
  readonly geometry: KWinRect
  readonly scale: number
}

/** One consistent read of the compositor workspace. */
export interface KWinSnapshot {
  /** Pointer position in logical coordinates. */
  readonly cursor: { readonly x: number; readonly y: number }
  readonly outputs: readonly KWinOutput[]
  /** Union of every output: the coordinate space absolute HID maps onto. */
  readonly desktop: KWinRect
  readonly windows: readonly KWinWindow[]
}

/** Bridge to KWin's scripting interface. */
export interface KWinBridge {
  /**
   * Read the workspace once.
   * @param signal - cooperative cancellation.
   * @returns outputs, windows, and pointer position from a single script run.
   */
  snapshot(signal?: AbortSignal): Promise<KWinSnapshot>
  /**
   * Give keyboard focus to one window.
   * @param windowId - `internalId` from a snapshot.
   * @param signal - cooperative cancellation.
   * @returns whether the window was found and activated.
   */
  activate(windowId: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Keep every window owned by these processes out of the task bar.
   *
   * Electron's `skipTaskbar` never reaches X11's `_NET_WM_STATE_SKIP_TASKBAR`,
   * and KWin reports the ball as an ordinary window because of it; a utility
   * window type is not enough either, because Plasma's task manager filters on
   * the skip-taskbar state. Compositor-side is the one place that works.
   * @param pids - owner processes whose windows should be hidden from the task bar.
   * @param signal - cooperative cancellation.
   * @returns how many windows were marked.
   */
  markSkipTaskbar(pids: readonly number[], signal?: AbortSignal): Promise<number>
  /** Drop the bus connection and any script files. */
  dispose(): Promise<void>
}

/** Error raised when this session has no KWin scripting interface to talk to. */
export const KWIN_UNAVAILABLE_MESSAGE =
  'computer-use: KWin is not reachable on the session bus; desktop control on Linux requires KDE Plasma'

const PATH = '/org/dsh/orb/Bridge'
const REQUEST_TIMEOUT_MS = 8000
const SNAPSHOT_TTL_MS = 150
/** The service name is per-process so two harness instances can coexist. */
const SERVICE = `org.dsh.OrbBridge.p${process.pid}`
const IFACE = 'org.dsh.OrbBridge'

/** The one method KWin scripts call back into. */
class OrbReporter extends dbus.interface.Interface {
  constructor(private readonly onReport: (requestId: string, payload: string) => void) {
    super(IFACE)
  }

  /** Receive one script result. The return value is the (empty) D-Bus reply. */
  Report(requestId: string, payload: string): void {
    this.onReport(requestId, payload)
  }
}

OrbReporter.configureMembers({ methods: { Report: { inSignature: 'ss' } } })

interface ScriptingReply {
  readonly body: readonly unknown[]
  readonly type: number
}

/**
 * Build a KWin bridge.
 * @returns the bridge; the session bus connects on first use.
 */
export function createKWinBridge(): KWinBridge {
  let bus: dbus.MessageBus | undefined
  let connected = false
  let waiter: ((payload: string) => void) | undefined
  let waiterId = ''
  let cached: { at: number; value: KWinSnapshot } | undefined
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * `org.kde.kwin.Scripting` declares `loadScript` twice (with and without a
   * plugin name). A generated proxy keeps only the first signature, so the calls
   * are built as raw messages with the signature spelled out.
   */
  async function callScripting(member: string, signature: string, body: readonly unknown[]): Promise<unknown> {
    const active = bus
    if (active === undefined) throw new Error(KWIN_UNAVAILABLE_MESSAGE)
    const reply = await active.call(new dbus.Message({
      destination: 'org.kde.KWin',
      path: '/Scripting',
      interface: 'org.kde.kwin.Scripting',
      member,
      signature,
      body: [...body],
    })) as ScriptingReply | null
    if (reply === null) throw new Error(`computer-use: KWin scripting ${member} produced no reply`)
    if (reply.type === dbus.MessageType.ERROR) {
      throw new Error(`computer-use: KWin scripting ${member} failed: ${String(reply.body[0] ?? '')}`)
    }
    return reply.body[0]
  }

  async function connect(): Promise<void> {
    if (connected) return
    const env = sessionEnv()
    const created = dbus.sessionBus({ busAddress: env.dbusSessionBusAddress })
    created.on('error', () => { reset() })
    const reporter = new OrbReporter((requestId, payload) => {
      if (requestId !== waiterId) return
      waiter?.(payload)
    })
    created.export(PATH, reporter)
    await created.requestName(SERVICE, dbus.NameFlag.REPLACE_EXISTING | dbus.NameFlag.DO_NOT_QUEUE)
    try {
      await created.getProxyObject('org.kde.KWin', '/Scripting')
    } catch (error) {
      created.disconnect()
      throw new Error(KWIN_UNAVAILABLE_MESSAGE, { cause: error })
    }
    bus = created
    connected = true
  }

  function reset(): void {
    const current = bus
    bus = undefined
    connected = false
    waiter = undefined
    try {
      current?.disconnect()
    } catch {
      // The socket is already gone; nothing to release.
    }
  }

  async function once(build: (requestId: string) => string, signal?: AbortSignal): Promise<unknown> {
    await connect()
    const requestId = randomBytes(8).toString('hex')
    const directory = join(tmpdir(), `dsh-orb-kwin-${process.pid}`)
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${requestId}.js`)
    await writeFile(file, build(requestId), 'utf8')
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = undefined
        reject(new Error('computer-use: KWin scripting did not answer in time'))
      }, REQUEST_TIMEOUT_MS)
      const onAbort = (): void => {
        clearTimeout(timer)
        waiter = undefined
        reject(signal?.reason instanceof Error ? signal.reason : new Error('computer-use: aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiterId = requestId
      waiter = (payload) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        waiter = undefined
        resolve(payload)
      }
    })
    try {
      await callScripting('loadScript', 'ss', [file, requestId])
      await callScripting('start', '', [])
      return await answer
    } finally {
      waiter = undefined
      await callScripting('unloadScript', 's', [requestId]).catch(() => undefined)
      await rm(file, { force: true }).catch(() => undefined)
    }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    snapshot(signal?: AbortSignal): Promise<KWinSnapshot> {
      const fresh = cached
      if (fresh !== undefined && Date.now() - fresh.at < SNAPSHOT_TTL_MS) return Promise.resolve(fresh.value)
      return enqueue(async () => {
        try {
          const value = parseSnapshot(await once(snapshotScript, signal))
          cached = { at: Date.now(), value }
          return value
        } catch (error) {
          reset()
          cached = undefined
          throw error
        }
      })
    },
    activate(windowId: string, signal?: AbortSignal): Promise<boolean> {
      return enqueue(async () => {
        try {
          const payload = await once(id => activateScript(id, windowId), signal)
          cached = undefined
          return readActivated(payload)
        } catch (error) {
          reset()
          cached = undefined
          throw error
        }
      })
    },
    markSkipTaskbar(pids: readonly number[], signal?: AbortSignal): Promise<number> {
      const targets = pids.filter(pid => Number.isInteger(pid) && pid > 0)
      if (targets.length === 0) return Promise.resolve(0)
      return enqueue(async () => {
        try {
          const payload = await once(id => skipTaskbarScript(id, targets), signal)
          return readMarked(payload)
        } catch (error) {
          reset()
          throw error
        }
      })
    },
    async dispose(): Promise<void> {
      reset()
      cached = undefined
      await queue.catch(() => undefined)
    },
  }
}

function readMarked(payload: unknown): number {
  if (typeof payload !== 'string') return 0
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return 0
    const marked = (parsed as { marked?: unknown }).marked
    return typeof marked === 'number' && Number.isFinite(marked) ? marked : 0
  } catch {
    return 0
  }
}

/**
 * The one-shot script that hides one process's windows from the task bar.
 * @param requestId - request token echoed back through the bus.
 * @param pids - owner process ids.
 * @returns JavaScript source for KWin's QJSEngine.
 */
function skipTaskbarScript(requestId: string, pids: readonly number[]): string {
  return `(function () {
  var REQUEST = ${JSON.stringify(requestId)}
  var PIDS = ${JSON.stringify(pids)}
  var marked = 0
  try {
    var list = []
    if (typeof workspace.windowList === 'function') list = workspace.windowList()
    else if (typeof workspace.clientList === 'function') list = workspace.clientList()
    for (var i = 0; i < list.length; i++) {
      var w = list[i]
      if (PIDS.indexOf(w.pid) === -1) continue
      if (w.skipTaskbar === true) continue
      w.skipTaskbar = true
      marked++
    }
  } catch (error) {
    marked = -1
  }
  callDBus(${JSON.stringify(SERVICE)}, ${JSON.stringify(PATH)}, ${JSON.stringify(IFACE)}, 'Report', REQUEST, JSON.stringify({ request: REQUEST, marked: marked }))
})()
`
}

function readActivated(payload: unknown): boolean {
  if (typeof payload !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return false
    return (parsed as { activated?: unknown }).activated === true
  } catch {
    return false
  }
}

/**
 * The one-shot script that focuses one window.
 * @param requestId - request token echoed back through the bus.
 * @param windowId - `internalId` of the window to activate.
 * @returns JavaScript source for KWin's QJSEngine.
 */
function activateScript(requestId: string, windowId: string): string {
  return `(function () {
  var REQUEST = ${JSON.stringify(requestId)}
  var TARGET = ${JSON.stringify(windowId)}
  var activated = false
  try {
    var list = []
    if (typeof workspace.windowList === 'function') list = workspace.windowList()
    else if (typeof workspace.clientList === 'function') list = workspace.clientList()
    for (var i = 0; i < list.length; i++) {
      var w = list[i]
      if (String(w.internalId || '') !== TARGET) continue
      if (w.minimized === true) w.minimized = false
      workspace.activeWindow = w
      activated = true
      break
    }
  } catch (error) {
    activated = false
  }
  callDBus(${JSON.stringify(SERVICE)}, ${JSON.stringify(PATH)}, ${JSON.stringify(IFACE)}, 'Report', REQUEST, JSON.stringify({ request: REQUEST, activated: activated }))
})()
`
}

/**
 * The one-shot script KWin runs. Kept as a single string so the generated file
 * is the whole program; unqualified `workspace` is KWin's workspace object.
 * @param requestId - request token echoed back through the bus.
 * @returns JavaScript source for KWin's QJSEngine.
 */
function snapshotScript(requestId: string): string {
  return `(function () {
  var REQUEST = ${JSON.stringify(requestId)}
  var SERVICE = ${JSON.stringify(SERVICE)}
  var PATH = ${JSON.stringify(PATH)}
  var IFACE = ${JSON.stringify(IFACE)}

  function round(value) {
    return Math.round(value * 1000) / 1000
  }

  function rect(value) {
    if (!value) return null
    return { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height) }
  }

  function text(value) {
    return (typeof value === 'string' && value.length > 0) ? value : null
  }

  function windows() {
    var list = []
    if (typeof workspace.windowList === 'function') list = workspace.windowList()
    else if (typeof workspace.clientList === 'function') list = workspace.clientList()
    var out = []
    for (var i = 0; i < list.length; i++) {
      var w = list[i]
      var frame = rect(w.frameGeometry)
      var client = rect(w.clientGeometry)
      if (!frame || !client) continue
      out.push({
        id: String(w.internalId || ''),
        resourceClass: text(w.resourceClass),
        resourceName: text(w.resourceName),
        desktopFileName: text(w.desktopFileName),
        caption: text(w.caption),
        pid: (typeof w.pid === 'number' && w.pid > 0) ? w.pid : null,
        active: w.active === true,
        normalWindow: w.normalWindow === true,
        skipTaskbar: w.skipTaskbar === true,
        minimized: w.minimized === true,
        frame: frame,
        client: client
      })
    }
    return out
  }

  function outputs() {
    var screens = workspace.screens
    var out = []
    if (!screens) return out
    for (var i = 0; i < screens.length; i++) {
      var s = screens[i]
      var geometry = rect(s.geometry)
      if (!geometry) continue
      out.push({
        name: String(s.name || ''),
        geometry: geometry,
        scale: (typeof s.devicePixelRatio === 'number' && s.devicePixelRatio > 0) ? s.devicePixelRatio : 1
      })
    }
    return out
  }

  function desktop(list) {
    if (list.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
    var left = list[0].geometry.x
    var top = list[0].geometry.y
    var right = left + list[0].geometry.width
    var bottom = top + list[0].geometry.height
    for (var i = 1; i < list.length; i++) {
      var g = list[i].geometry
      left = Math.min(left, g.x)
      top = Math.min(top, g.y)
      right = Math.max(right, g.x + g.width)
      bottom = Math.max(bottom, g.y + g.height)
    }
    return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) }
  }

  function send(payload) {
    callDBus(SERVICE, PATH, IFACE, 'Report', REQUEST, JSON.stringify(payload))
  }

  try {
    var cursor = workspace.cursorPos
    var outs = outputs()
    send({
      request: REQUEST,
      cursor: cursor ? { x: round(cursor.x), y: round(cursor.y) } : { x: 0, y: 0 },
      outputs: outs,
      desktop: desktop(outs),
      windows: windows()
    })
  } catch (error) {
    send({ request: REQUEST, error: String(error) })
  }
})()
`
}

function parseSnapshot(payload: unknown): KWinSnapshot {
  if (typeof payload !== 'string') throw new Error('computer-use: KWin answered with a non-string payload')
  const parsed: unknown = JSON.parse(payload)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('computer-use: KWin answered with an unreadable payload')
  const record = parsed as Record<string, unknown>
  if (typeof record.error === 'string') throw new Error(`computer-use: KWin scripting failed: ${record.error}`)
  return {
    cursor: readPoint(record.cursor),
    outputs: readArray(record.outputs, readOutput),
    desktop: readRect(record.desktop) ?? { x: 0, y: 0, width: 1, height: 1 },
    windows: readArray(record.windows, readWindow),
  }
}

function readArray<T>(value: unknown, read: (item: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const parsed = read(item)
    if (parsed !== undefined) out.push(parsed)
  }
  return out
}

function readPoint(value: unknown): { readonly x: number; readonly y: number } {
  if (typeof value !== 'object' || value === null) return { x: 0, y: 0 }
  const record = value as { x?: unknown; y?: unknown }
  return { x: numberOr(record.x, 0), y: numberOr(record.y, 0) }
}

function readRect(value: unknown): KWinRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof record.x !== 'number' || typeof record.y !== 'number') return undefined
  if (typeof record.width !== 'number' || typeof record.height !== 'number') return undefined
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}

function readOutput(value: unknown): KWinOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { name?: unknown; geometry?: unknown; scale?: unknown }
  const geometry = readRect(record.geometry)
  if (geometry === undefined) return undefined
  return { name: typeof record.name === 'string' ? record.name : '', geometry, scale: numberOr(record.scale, 1) }
}

function readWindow(value: unknown): KWinWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const frame = readRect(record.frame)
  const client = readRect(record.client)
  if (frame === undefined || client === undefined) return undefined
  return {
    id: typeof record.id === 'string' ? record.id : '',
    resourceClass: nullableString(record.resourceClass),
    resourceName: nullableString(record.resourceName),
    desktopFileName: nullableString(record.desktopFileName),
    caption: nullableString(record.caption),
    pid: typeof record.pid === 'number' ? record.pid : null,
    active: record.active === true,
    normalWindow: record.normalWindow === true,
    skipTaskbar: record.skipTaskbar === true,
    minimized: record.minimized === true,
    frame,
    client,
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
