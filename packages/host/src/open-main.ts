/**
 * Focus the official desktop window, or open the local web page.
 * The credentialed page address is never written to the log.
 */

import { spawn } from 'node:child_process'
import { isDesktopHost } from './tcc.ts'

interface OpenContext {
  readonly webServer: { readonly port: number }
  readonly connection: { authenticatedUrl(baseUrl: string): string }
}

/**
 * Desktop uses the app's `dsh://open` protocol.
 * `dsh web` has no main window, so the menu item stays disabled and this returns undefined.
 * The credentialed loopback URL is never passed to `open` or `cmd`.
 */
export function mainWindowTarget(_ctx: OpenContext, desktop = isDesktopHost()): string | undefined {
  if (desktop) return 'dsh://open'
  return undefined
}

/** Command used to focus that window. The target is never logged. */
export function openCommand(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] }
  if (platform === 'linux') return { command: 'xdg-open', args: [target] }
  return { command: 'open', args: [target] }
}

/**
 * Environment for the opener.
 * The desktop host runs under `ELECTRON_RUN_AS_NODE=1`, and a child that keeps it makes
 * Windows start the protocol handler in Node mode: the app never reaches its
 * single-instance forwarding, so `dsh://open` silently does nothing. The helper spawn
 * drops the same marker for the same reason. macOS launches through `open`, which starts
 * the app from LaunchServices and never sees this environment.
 * @param env - environment to copy, `process.env` by default.
 * @returns a copy without the Node-mode marker.
 */
export function openEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  return clean
}

/** Focus the desktop main window. Does nothing when this host is `dsh web`. */
export async function openMainWindow(ctx: OpenContext): Promise<void> {
  const target = mainWindowTarget(ctx)
  if (target === undefined) return
  await spawnOpen(target)
}

function spawnOpen(target: string): Promise<void> {
  const { command, args } = openCommand(target)
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, env: openEnvironment() })
    child.once('error', () => {
      console.error('dsh-orb: could not open the main window')
      resolve()
    })
    child.once('exit', (code) => {
      if (code !== 0) console.error('dsh-orb: could not open the main window')
      resolve()
    })
  })
}
