/**
 * Host-side Orb plugin.
 * The ball is a separate Electron process. This plugin owns the socket, the preferences, and the Computer Use session.
 */

import { TccMonitor } from './tcc.ts'
import { profileDirectory, ProfileStore } from './preferences.ts'
import { registerOrbRoutes } from './routes.ts'
import { installOrbServices, watchOrbPermissions } from './services.ts'
import { watchAppearance } from './appearance.ts'
import { OrbRuntime, type OrbContext } from './orb.ts'

/** Cordis plugin name. */
export const name = 'orb-host'

/** Official services this plugin reads. Missing ones keep it pending. */
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  'sessions',
  'agentDefaultModel',
]

export type { OrbContext }

/**
 * Register preferences, Computer Use services, and settings routes, then start the ball.
 * `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
 */
export function apply(ctx: OrbContext, config: { autoStart?: boolean } = {}): void {
  logWebPort(ctx)
  const store = new ProfileStore(profileDirectory(ctx))
  const tcc = new TccMonitor()
  const runtime = new OrbRuntime(ctx, store, { tcc })
  installOrbServices(ctx, store)
  console.error(`dsh-orb: profile ${store.dir}`)
  ctx.effect(() => {
    const detachQuestions = runtime.attachQuestions()
    const detachPermissions = watchOrbPermissions(ctx, store)
    const detachRoutes = registerOrbRoutes({ ctx, store, tcc, control: runtime })
    // Theme and locale follow the official settings document; a missing
    // settings service leaves the ball on its system defaults.
    const detachAppearance = watchAppearance(ctx, (appearance) => { runtime.setAppearance(appearance) })
    // Computer Use skips our own chrome windows: on Linux the ball is an ordinary
    // toplevel, so it would otherwise be captured as the frontmost window.
    ctx.provide('computerUseExcludedPids', () => runtime.excludedPids())
    const start = config.autoStart !== false && store.ballEnabled()
    if (start) {
      void runtime.start().catch((error: unknown) => {
        console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return () => {
      detachQuestions()
      detachPermissions()
      detachRoutes()
      detachAppearance()
      runtime.halt()
    }
  })
}

/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx: OrbContext): void {
  const port = ctx.webServer.port
  try {
    const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`)
    const hostname = new URL(authed).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      console.error('dsh-orb: authenticated URL is not loopback')
    }
  } catch {
    console.error('dsh-orb: authenticated URL is unavailable')
  }
  console.error(`dsh-orb: host web port ${port}`)
}
