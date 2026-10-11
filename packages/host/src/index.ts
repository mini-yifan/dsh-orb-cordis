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
import { exemptReleaseAge, ownPackage, UpdateChecker } from './update.ts'
import { DEFERRED_INSTALL_CEILING_MS, deferredInstallInProgress } from './deferred-install.ts'
import { KOFFI_DIR_ENV, ownPackageRoot, removeStaleStages, stageKoffi } from './native-images.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

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
 * Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
 */
export function apply(ctx: OrbContext, config: { autoStart?: boolean } = {}): void {
  logWebPort(ctx)
  const own = ownPackage()
  const profile = profileDirectory(ctx)
  const installing = deferredInstallInProgress(profile)
  if (installing) {
    // The after-exit script is replacing this package right now. Staging koffi, loading it,
    // or starting the helper would fight the running pnpm, so the ball waits for the outcome.
    console.error('dsh-orb: an update install is running; the ball waits for it to finish')
  } else if (process.platform === 'win32' && own !== undefined) {
    // Before anything loads koffi: a loaded addon inside the package locks it against
    // the next update on Windows (see native-images.ts).
    stageNativeImages()
  }
  const store = new ProfileStore(profile)
  // pnpm appends a `name@version` rule for every young release it installs and reads
  // only the first rule per package name, so a profile that installed this plugin
  // through the market or `dsh plugin install` holds an exemption that shadows the
  // installed version — and then removing ANY other plugin fails with
  // ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED. Re-canonicalise the list at
  // start, whatever route installed the version.
  if (own !== undefined) exemptReleaseAge(store.dir, own.name)
  const tcc = new TccMonitor()
  const runtime = new OrbRuntime(ctx, store, { tcc })
  installOrbServices(ctx, store)
  // The official plugin manager mounts after this plugin, so it is read live and an
  // absent one only costs the one-click upgrade: the check and the notice stay.
  const updater = new UpdateChecker({
    store,
    manager: () => ctx.get('pluginManager'),
    notify: (version) => { runtime.setUpdateAvailable(version) },
  })
  runtime.useUpdater(updater)
  console.error(`dsh-orb: profile ${store.dir}`)
  console.error(`dsh-orb: version ${updater.state().currentVersion || 'unknown'}`)
  ctx.effect(() => {
    const detachQuestions = runtime.attachQuestions()
    const detachPermissions = watchOrbPermissions(ctx, store)
    const detachRoutes = registerOrbRoutes({ ctx, store, tcc, control: runtime })
    // Theme and locale follow the official settings document; a missing
    // settings service leaves the ball on its system defaults.
    const detachAppearance = watchAppearance(ctx, (appearance) => { runtime.setAppearance(appearance) })
    const detachUpdates = updater.start()
    const start = process.platform !== 'linux' && config.autoStart !== false && store.ballEnabled()
    let cancelled = false
    if (installing) {
      void waitForInstall(store.dir, () => cancelled).then(() => {
        if (cancelled) return
        // The outcome (and a stalled status) is collected the way every start collects it.
        updater.adoptDeferredOutcome()
        if (!start) return
        return runtime.start().catch((error: unknown) => {
          console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    } else if (start) {
      void runtime.start().catch((error: unknown) => {
        console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return () => {
      cancelled = true
      detachQuestions()
      detachPermissions()
      detachRoutes()
      detachAppearance()
      detachUpdates()
      runtime.halt()
    }
  })
}

/**
 * Wait for the after-exit install to write its outcome, at most as long as the script itself
 * can run. A status file past that ceiling is collected as a failed outcome by
 * {@link deferredInstallInProgress}, so the wait always ends.
 * @param profileDir - profile that scheduled the install.
 * @param cancelled - true once the plugin was disposed; the wait then stops without starting.
 */
async function waitForInstall(profileDir: string, cancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + DEFERRED_INSTALL_CEILING_MS
  while (!cancelled() && Date.now() < deadline && deferredInstallInProgress(profileDir)) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Point every koffi loader at a copy outside the package and clear what failed updates left. */
function stageNativeImages(): void {
  const root = ownPackageRoot()
  try {
    const dir = stageKoffi(root, dshHomePath('dsh-orb', 'native'))
    if (dir !== undefined) process.env[KOFFI_DIR_ENV] = dir
  } catch (error) {
    console.error(`dsh-orb: koffi stays in the package: ${error instanceof Error ? error.message : String(error)}`)
  }
  removeStaleStages(root)
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
