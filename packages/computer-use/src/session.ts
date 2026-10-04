/**
 * Desktop session coordinates for the Linux backends.
 * The Host runs from a system service whose environment carries `PATH` and `HOME`
 * only, so the Wayland socket, the session bus, and the X11 authority are resolved
 * from the standard runtime paths rather than from `process.env` alone.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/session
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Display-server coordinates for one login session. */
export interface SessionEnv {
  /** Per-user runtime directory holding the Wayland socket and the session bus. */
  readonly xdgRuntimeDir: string
  /** Wayland compositor socket name, when a Wayland session is reachable. */
  readonly waylandDisplay?: string
  /** Session bus address; the standard per-user socket when the environment omits it. */
  readonly dbusSessionBusAddress: string
  /** X11 display used by XWayland, when that socket exists. */
  readonly display?: string
  /** X11 authority file, when the compositor published one. */
  readonly xauth?: string
}

/** Cached coordinates: the paths do not change while a session lives. */
let cached: SessionEnv | undefined

/**
 * Resolve the desktop session coordinates, honoring an explicit environment first.
 * @param env - environment to read; defaults to `process.env`.
 * @returns the resolved coordinates. Missing sockets stay `undefined` instead of throwing.
 */
export function resolveSessionEnv(env: NodeJS.ProcessEnv = process.env): SessionEnv {
  const runtime = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${process.getuid?.() ?? 1000}`
  // WAYLAND_DISPLAY is a socket name and DISPLAY is `:N`, but XAUTHORITY is a
  // path: the same directory scan produces two different shapes.
  const wayland = env.WAYLAND_DISPLAY?.trim() || firstEntry(runtime, /^wayland-[0-9]+$/)
  const display = env.DISPLAY?.trim() || firstEntry('/tmp/.X11-unix', /^X[0-9]+$/)?.replace(/^X/, ':')
  const xauth = env.XAUTHORITY?.trim() || firstEntryPath(runtime, /^xauth_/)
  const bus = env.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${join(runtime, 'bus')}`
  return {
    xdgRuntimeDir: runtime,
    dbusSessionBusAddress: bus,
    ...wayland === undefined ? {} : { waylandDisplay: wayland },
    ...display === undefined ? {} : { display },
    ...xauth === undefined ? {} : { xauth },
  }
}

/**
 * Resolve the cached session coordinates.
 * @returns the same object on repeated calls.
 */
export function sessionEnv(): SessionEnv {
  cached ??= resolveSessionEnv()
  return cached
}

/**
 * Environment for spawning a desktop client such as `spectacle`.
 * The Host inherits a service environment, so the display variables are added
 * explicitly instead of being passed through.
 * @param env - session coordinates to export.
 * @returns a copy of `process.env` with the session variables set.
 */
export function desktopEnv(env: SessionEnv = sessionEnv()): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: env.xdgRuntimeDir,
    DBUS_SESSION_BUS_ADDRESS: env.dbusSessionBusAddress,
    ...env.waylandDisplay === undefined ? {} : { WAYLAND_DISPLAY: env.waylandDisplay },
    ...env.display === undefined ? {} : { DISPLAY: env.display },
    ...env.xauth === undefined ? {} : { XAUTHORITY: env.xauth },
  }
}

/**
 * True when this process can reach a desktop session at all.
 * @param env - session coordinates to test.
 * @returns whether a Wayland or X11 socket was found.
 */
export function hasDesktopSession(env: SessionEnv = sessionEnv()): boolean {
  return env.waylandDisplay !== undefined || env.display !== undefined
}

function firstEntry(directory: string, pattern: RegExp): string | undefined {
  try {
    return readdirSync(directory).find(name => pattern.test(name))
  } catch {
    return undefined
  }
}

/** First matching entry as a full path, for variables that take a filename rather than a name. */
function firstEntryPath(directory: string, pattern: RegExp): string | undefined {
  const name = firstEntry(directory, pattern)
  return name === undefined ? undefined : join(directory, name)
}
