/**
 * Keep the Desktop Host out of the Dock.
 *
 * The Host is spawned with the DeepSeek Harness executable in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`), so it carries the same bundle identity as the app
 * that owns it — `com.deepseek.dsh`. That identity starts out invisible, but the
 * moment the process takes part in any UI transaction LaunchServices registers it
 * as a regular application and the Dock grows a second identical icon. Selecting
 * text is what triggers it: the toolbar geometry and the broadcast that feeds it
 * are Host-side work, so the first selection after launch is the moment the extra
 * tile appears, and it never goes away again.
 *
 * `NSApplication.setActivationPolicy(.prohibited)` makes the process one the
 * WindowServer never activates, which is what the Dock reads before creating a
 * tile. The policy is process-wide and permanent, so it is set once at plugin
 * start, before the socket opens or the helper launches.
 *
 * Only the Desktop Host needs it. `dsh web` is a plain terminal process with no
 * `NSApplication` at all, and every other platform has no such notion.
 */

import { requireKoffi } from './native-images.ts'

/** AppKit's `NSApplicationActivationPolicy` value for "never activate". */
const NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED = 2

/** The narrow slice of koffi this module uses. */
interface KoffiLibrary {
  func(signature: string): (...args: unknown[]) => unknown
}

export interface ActivationPolicyDeps {
  /** Platform gate override; tests pass a non-Darwin value on a Darwin machine. */
  platform?: NodeJS.Platform
  /** Whether this process is the Desktop Host rather than `dsh web`. */
  isHost?: () => boolean
  /** Loader override so tests need no real Objective-C runtime. */
  load?: () => PolicySetter | undefined
}

/** Sets the activation policy, returning whether the process is now prohibited. */
export type PolicySetter = (policy: number) => boolean

/** The slice of the koffi module this module uses. */
interface KoffiModule {
  load(path: string): KoffiLibrary
}

/** libobjc carries the runtime entry points; NSApplication itself is in the shared cache. */
const OBJC_RUNTIME = '/usr/lib/libobjc.A.dylib'

/**
 * Whether this process is the Desktop Host.
 *
 * `DSH_DESKTOP_NODE_EXECUTABLE` is injected by the desktop shell's package-manager
 * plumbing, and the packaged Host also runs from the app's own executable. Both
 * spellings are checked so an unpackaged run is covered too.
 */
export function isDesktopHostProcess(
  environment: NodeJS.ProcessEnv = process.env,
  executable = process.execPath,
): boolean {
  if (typeof environment.DSH_DESKTOP_NODE_EXECUTABLE === 'string' && environment.DSH_DESKTOP_NODE_EXECUTABLE !== '') {
    return true
  }
  return executable.includes('DeepSeek Harness')
}

/**
 * Reach `NSApplication` through the Objective-C runtime and return a setter.
 *
 * `NSApplication` and `objc_msgSend` live in the dyld shared cache, so they are
 * resolved by class and selector name rather than by loading AppKit by path.
 * @returns a setter, or undefined when there is no `NSApplication` to address.
 */
function loadPolicySetter(): PolicySetter | undefined {
  const koffi = requireKoffi<KoffiModule>(import.meta.url)
  const library = koffi.load(OBJC_RUNTIME)
  const getClass = library.func('void *objc_getClass(const char *name)')
  const registerName = library.func('void *sel_registerName(const char *name)')
  const sendVoid = library.func('void *objc_msgSend(void *self, void *op)')
  const sendBoolLong = library.func('bool objc_msgSend(void *self, void *op, long arg)')
  const sendLong = library.func('long objc_msgSend(void *self, void *op)')

  const applicationClass = getClass('NSApplication')
  if (applicationClass === null || applicationClass === undefined) return undefined
  const shared = sendVoid(applicationClass, registerName('sharedApplication'))
  // A bare `dsh web` node process has no bundle and no NSApplication. Asking for the
  // shared application here would create one, so the caller gates on host detection
  // first and this function only addresses what already exists.
  if (shared === null || shared === undefined) return undefined

  const setter = registerName('setActivationPolicy:')
  const reader = registerName('activationPolicy')
  return (policy) => {
    // AppKit answers NO when the policy did not change, which is the normal result
    // for a second call on an already-prohibited process. Read the live value back
    // rather than reporting that as a failure.
    const changed = sendBoolLong(shared, setter, policy) === true
    if (changed) return true
    try {
      return sendLong(shared, reader) === policy
    } catch {
      return false
    }
  }
}

/**
 * Stop the Dock from ever creating a tile for the Desktop Host.
 *
 * Best effort by design: a Host that cannot reach AppKit still runs, it only keeps
 * the cosmetic double icon. Failing the whole plugin over a Dock tile would cost
 * the ball, voice, and selection for a problem no user work depends on.
 * @param deps - platform, host detection, and loader seams for tests.
 * @returns whether the policy is now prohibited.
 */
export function suppressDockTile(deps: ActivationPolicyDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return false
  const isHost = deps.isHost ?? (() => isDesktopHostProcess())
  if (!isHost()) return false
  try {
    const set = deps.load === undefined ? loadPolicySetter() : deps.load()
    if (set === undefined) return false
    const ok = set(NS_APPLICATION_ACTIVATION_POLICY_PROHIBITED)
    if (!ok) console.error('dsh-orb: the Dock could not be told to stay hidden; a second icon may appear')
    return ok
  } catch (error) {
    console.error(`dsh-orb: Dock suppression unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
