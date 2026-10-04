/**
 * Desktop backend for KDE Wayland.
 *
 * Three host facilities are composed here: KWin scripting answers what is on
 * screen, `spectacle` reads pixels, and `/dev/uinput` posts input. None of them
 * needs a portal prompt, and none of them is macOS- or Windows-shaped.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/desktop
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as dbus from 'dbus-next'
import type {
  CapturedScreen,
  ClickButton,
  ClickInput,
  CopyImageToClipboardInput,
  DesktopBackend,
  DesktopForeground,
  DragInput,
  HotkeyInput,
  LongPressInput,
  OpenAppInput,
  OpenAppResult,
  OpenInBrowserInput,
  OpenInFinderInput,
  ScreenInfo,
  ScrollInput,
  TypeInput,
} from './backend.ts'
import { FOCUS_FALLBACK_FOREGROUND, FOCUS_NOTE } from './backend.ts'
import { captureActiveWindow, captureRegion, imageSize } from './capture.ts'
import { mapNormalizedToGlobal } from './coordinates.ts'
import { createKWinBridge, type KWinBridge, type KWinSnapshot, type KWinWindow } from './kwin.ts'
import { desktopEnv, sessionEnv } from './session.ts'
import { createInputDevices, type InputDevices } from './uinput.ts'

/** Host processes whose windows never count as an observation surface. */
export interface LinuxDesktopOptions {
  /** Pids of the harness and its overlay helper. */
  readonly excludedPids?: () => readonly number[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Pids whose windows never count as an observation surface.
     * The Desktop Host provides it so the floating ball and the observation
     * ribbon are skipped when the agent looks for the frontmost window.
     */
    computerUseExcludedPids?: () => readonly number[]
  }
}

/** Delay that lets the compositor commit a pointer move before the button lands. */
const POINTER_SETTLE_MS = 70
/** Delay between drag steps so the receiving app sees motion, not a teleport. */
const DRAG_STEP_MS = 40
const DRAG_STEPS = 12

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How often our own windows are re-marked as task-bar-less.
 * The helper can be restarted at any time, and each restart is a new process
 * whose windows start out as ordinary toplevels again.
 */
const TASKBAR_GUARD_MS = 4000

/**
 * Build the Linux desktop backend.
 * @param options - host pids to skip when choosing the observation surface.
 * @returns capture and HID backed by KWin, spectacle, and uinput.
 */
export function createLinuxDesktopBackend(options: LinuxDesktopOptions = {}): DesktopBackend {
  const bridge = createKWinBridge()
  const devices = createInputDevices()
  let lastSnapshot: KWinSnapshot | undefined

  function excluded(): readonly number[] {
    return options.excludedPids?.() ?? []
  }

  /**
   * Keep the ball and the observation ribbon out of the task bar.
   *
   * Electron's `skipTaskbar` never reaches X11's `_NET_WM_STATE_SKIP_TASKBAR` —
   * KWin reports the ball as an ordinary window — and Plasma's task manager
   * filters on that state rather than on the window type, so a utility window
   * still gets an entry. Only the compositor can set it, and only while the
   * process is alive, so it is re-applied on a slow timer.
   */
  function guardTaskbar(): void {
    const targets = excluded().filter(pid => pid > 0 && pid !== process.pid)
    if (targets.length === 0) return
    void bridge.markSkipTaskbar(targets).catch(() => undefined)
  }

  void guardTaskbar()
  const taskbarGuard = setInterval(guardTaskbar, TASKBAR_GUARD_MS)
  taskbarGuard.unref()

  async function snapshot(signal?: AbortSignal): Promise<KWinSnapshot> {
    const value = await bridge.snapshot(signal)
    lastSnapshot = value
    return value
  }

  /** The surface the agent observes: the focused normal window, minus our own chrome. */
  function foreground(snap: KWinSnapshot): KWinWindow | undefined {
    const skip = new Set(excluded())
    const candidates = snap.windows.filter(window =>
      window.normalWindow
      && !window.minimized
      && (window.pid === null || !skip.has(window.pid)))
    return candidates.find(window => window.active) ?? candidates[0]
  }

  function scaleOf(snap: KWinSnapshot, window: KWinWindow): number {
    const centerX = window.frame.x + window.frame.width / 2
    const centerY = window.frame.y + window.frame.height / 2
    const hit = snap.outputs.find((output) =>
      centerX >= output.geometry.x && centerX < output.geometry.x + output.geometry.width
      && centerY >= output.geometry.y && centerY < output.geometry.y + output.geometry.height)
    return hit?.scale ?? 1
  }

  function screenFrom(snap: KWinSnapshot, window: KWinWindow): ScreenInfo {
    return { index: 0, bounds: window.frame, scale: scaleOf(snap, window) }
  }

  async function pointOf(screen: ScreenInfo, position: readonly [number, number], signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const snap = lastSnapshot ?? await snapshot(signal)
    await devices.prepare(snap.desktop)
    return mapNormalizedToGlobal(position, screen)
  }

  async function captureFile(): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const directory = join(tmpdir(), `dsh-orb-shot-${process.pid}`)
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${randomBytes(6).toString('hex')}.png`)
    const cleanup = async (): Promise<void> => {
      await rm(file, { force: true }).catch(() => undefined)
    }
    return { file, cleanup }
  }

  return {
    async listScreens(signal) {
      const snap = await snapshot(signal)
      await devices.prepare(snap.desktop)
      const window = foreground(snap)
      return window === undefined ? [] : [screenFrom(snap, window)]
    },

    async capture(screen, signal) {
      const snap = lastSnapshot ?? await snapshot(signal)
      const { file, cleanup } = await captureFile()
      try {
        // The window shortcut is much cheaper than a whole-desktop grab plus a
        // crop, and it is exactly the observed surface. It is only valid while
        // that window still holds focus, so the sizes are cross-checked.
        const target = foreground(snap)
        const active = snap.windows.find(window => window.active)
        if (target !== undefined && active?.id === target.id) {
          await captureActiveWindow(file, signal)
          const size = await imageSize(file, signal)
          const scaleX = size.width / target.frame.width
          const scaleY = size.height / target.frame.height
          if (Number.isFinite(scaleX) && Math.abs(scaleX - scaleY) < 0.02 && scaleX > 0.05) {
            const data = await readFile(file)
            return { data: new Uint8Array(data), mediaType: 'image/png' }
          }
        }
        await captureRegion({ bounds: screen.bounds, desktop: snap.desktop, output: file }, signal)
        const data = await readFile(file)
        return { data: new Uint8Array(data), mediaType: 'image/png' }
      } finally {
        await cleanup()
      }
    },

    async inspectForeground(signal) {
      const snap = await snapshot(signal)
      const window = foreground(snap)
      if (window === undefined) return FOCUS_FALLBACK_FOREGROUND
      const appName = appNameOf(window)
      return {
        appName,
        ...window.caption === null ? {} : { windowTitle: window.caption },
        ...appName === 'none' ? { focusNote: FOCUS_NOTE } : {},
      }
    },

    async listApps(signal) {
      const snap = await snapshot(signal)
      const skip = new Set(excluded())
      const names = new Set<string>()
      for (const window of snap.windows) {
        if (!window.normalWindow || window.skipTaskbar) continue
        if (window.pid !== null && skip.has(window.pid)) continue
        const name = appNameOf(window)
        if (name !== 'none') names.add(name)
      }
      return [...names]
    },

    async openApp(input: OpenAppInput, signal) {
      const snap = await snapshot(signal)
      const wanted = input.name.trim().toLowerCase()
      const running = snap.windows.find(window =>
        window.normalWindow
        && matchesApp(window, wanted))
      if (running !== undefined) {
        const activated = await bridge.activate(running.id, signal)
        if (activated) return { kind: 'activated', name: appNameOf(running) }
      }
      await launchApp(input.name, signal)
      return { kind: 'launched', name: input.name }
    },

    async click(input: ClickInput, signal) {
      const point = await pointOf(input.screen, input.position, signal)
      devices.moveTo(point.x, point.y)
      await sleep(POINTER_SETTLE_MS)
      await devices.chord(input.modifiers ?? [], () => { devices.click(input.button, input.count) })
    },

    async typeText(input: TypeInput, signal) {
      const point = await pointOf(input.screen, input.position, signal)
      devices.moveTo(point.x, point.y)
      await sleep(POINTER_SETTLE_MS)
      devices.click('left', 1)
      await sleep(POINTER_SETTLE_MS)
      await writeClipboardText(input.text, signal)
      if (input.replace) await devices.chord(['ctrl'], () => devices.tap('a', 30))
      await sleep(30)
      await devices.chord(['ctrl'], () => devices.tap('v', 30))
      await sleep(120)
      if (input.submit) await devices.tap('enter', 30)
    },

    async scroll(input: ScrollInput, signal) {
      const point = await pointOf(input.screen, input.position, signal)
      devices.moveTo(point.x, point.y)
      await sleep(POINTER_SETTLE_MS)
      devices.scroll(input.direction, Math.max(1, Math.round(input.scrollLevel)))
    },

    async hotkey(input: HotkeyInput, signal) {
      const snap = lastSnapshot ?? await snapshot(signal)
      await devices.prepare(snap.desktop)
      const keys = input.keys.map(token => token.trim().toLowerCase()).filter(token => token.length > 0)
      const plain = keys.filter(token => !MODIFIER_TOKENS.has(token))
      await devices.chord(keys, async () => {
        for (const token of plain) await devices.tap(token, 30)
      })
    },

    async longPress(input: LongPressInput, signal) {
      const point = await pointOf(input.screen, input.position, signal)
      devices.moveTo(point.x, point.y)
      await sleep(POINTER_SETTLE_MS)
      await devices.chord([], async () => {
        devices.press('left')
        await sleep(Math.max(200, Math.round(input.durationSeconds * 1000)))
        devices.release('left')
      })
    },

    async drag(input: DragInput, signal) {
      const from = await pointOf(input.startScreen, input.startPosition, signal)
      const to = await pointOf(input.endScreen, input.endPosition, signal)
      devices.moveTo(from.x, from.y)
      await sleep(POINTER_SETTLE_MS)
      await devices.chord([], async () => {
        devices.press('left')
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          const ratio = step / DRAG_STEPS
          devices.moveTo(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)
          await sleep(DRAG_STEP_MS)
        }
        await sleep(POINTER_SETTLE_MS)
        devices.release('left')
      })
    },

    async openInBrowser(input: OpenInBrowserInput, signal) {
      await openCommand(input.url ?? 'https://www.bing.com', signal)
    },

    async openInFinder(input: OpenInFinderInput, signal) {
      if (input.revealOnly) {
        await openCommand(input.path, signal, ['dolphin', '--select'])
        return
      }
      await openCommand(input.path, signal)
    },

    async copyImageToClipboard(input: CopyImageToClipboardInput, signal) {
      await writeClipboardImage(input.path, input.mediaType, signal)
    },

    async withGuiTurn(run) {
      return run()
    },
  }
}

const MODIFIER_TOKENS = new Set([
  'cmd', 'command', 'meta', 'win', 'windows', 'super',
  'shift', 'option', 'alt', 'control', 'ctrl',
])

function appNameOf(window: KWinWindow): string {
  const desktop = window.desktopFileName
  if (desktop !== null) {
    const base = desktop.replace(/\.desktop$/u, '').split('.').pop() ?? desktop
    return base
  }
  if (window.resourceClass !== null) return window.resourceClass
  if (window.resourceName !== null) return window.resourceName
  return 'none'
}

function matchesApp(window: KWinWindow, wanted: string): boolean {
  const candidates = [appNameOf(window), window.resourceClass, window.resourceName, window.desktopFileName, window.caption]
  return candidates.some(value => value !== null && value !== undefined && value.toLowerCase().includes(wanted))
}

/** Launch a desktop application by desktop-file id, executable name, or raw command. */
async function launchApp(name: string, signal?: AbortSignal): Promise<void> {
  const trimmed = name.trim()
  const desktopId = trimmed.replace(/\.desktop$/u, '')
  try {
    await run('gtk-launch', [desktopId], signal)
    return
  } catch {
    // Not a desktop id; fall through to the KDE launcher.
  }
  try {
    await run('kioclient6', ['exec', trimmed], signal)
    return
  } catch {
    // Not a URL or desktop id; treat the name as an executable.
  }
  await openCommand(trimmed, signal)
}

/** Open a path or URL with the desktop's default handler, optionally through a specific tool. */
async function openCommand(target: string, signal?: AbortSignal, prefix: readonly string[] = []): Promise<void> {
  const [command, ...args] = prefix
  if (command !== undefined) {
    await run(command, [...args, target], signal)
    return
  }
  await run('xdg-open', [target], signal)
}

/** Replace the clipboard with plain text so the next paste lands it in the focused field. */
async function writeClipboardText(text: string, signal?: AbortSignal): Promise<void> {
  if (await tryRun('wl-copy', ['--type', 'text/plain'], signal, text)) return
  await klipperSetContents(text, signal)
}

/** Put an encoded image on the clipboard. */
async function writeClipboardImage(path: string, mediaType: string, signal?: AbortSignal): Promise<void> {
  const data = await readFile(path)
  if (!await tryRun('wl-copy', ['--type', mediaType], signal, data)) {
    throw new Error(
      'computer-use: putting an image on the clipboard needs wl-clipboard on KDE Wayland; install it with "sudo pacman -S wl-clipboard"',
    )
  }
}

/** KDE's clipboard manager is the only always-present text clipboard on Plasma. */
async function klipperSetContents(text: string, signal?: AbortSignal): Promise<void> {
  const connection = dbus.sessionBus({ busAddress: sessionEnv().dbusSessionBusAddress })
  try {
    const proxy = await connection.getProxyObject('org.kde.klipper', '/klipper')
    // dbus-next's generated proxy has no callback form: every argument becomes a
    // body element, so a trailing function is marshalled as a second string and
    // the `s` signature rejects the whole call. The method always returns a promise.
    const iface = proxy.getInterface('org.kde.klipper.klipper') as unknown as {
      setClipboardContents(value: string): Promise<unknown>
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { reject(new Error('computer-use: clipboard write aborted')) }
      const settle = (): void => { signal?.removeEventListener('abort', onAbort) }
      signal?.addEventListener('abort', onAbort, { once: true })
      iface.setClipboardContents(text).then(
        () => { settle(); resolve() },
        (error: unknown) => {
          settle()
          reject(error instanceof Error ? error : new Error(`computer-use: klipper rejected the clipboard write: ${String(error)}`))
        },
      )
    })
  } catch (error) {
    throw new Error(`computer-use: no clipboard writer is available (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    connection.disconnect()
  }
}

function run(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: string | Buffer,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: desktopEnv() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout })
          return
        }
        if (signal?.aborted === true) {
          reject(new Error('computer-use: aborted'))
          return
        }
        const detail = stderr.trim() === '' ? error.message : stderr.trim()
        reject(new Error(`computer-use: ${command} failed: ${detail}`))
      },
    )
    if (input === undefined) {
      child.stdin?.end()
      return
    }
    child.stdin?.end(input)
  })
}

/** Run a command whose absence is expected, feeding it `input`. */
async function tryRun(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  input: string | Buffer,
): Promise<boolean> {
  try {
    await run(command, args, signal, input)
    return true
  } catch {
    return false
  }
}
