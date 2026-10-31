/**
 * App-level provider for lasso capture and the lasso first-frame slot.
 *
 * Both services cross a preset boundary: the orb host (a top-level row) asks for a
 * capture and fills the seed, while the Computer Use preset consumes it. A provide
 * from inside that preset lands in the root realm, where the official preset-mount
 * audit rejects it ("Preset services require isolate realms"), so this row lives in
 * the Host configuration beside the orb host and the code-agent registry.
 * @module @dsh-orb/computer-use/src/lasso-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { createPlatformBackend, type DesktopBackend } from './backend.ts'
import { createLassoSeedStore, installLassoCapture } from './lasso.ts'
import type { OverlayExcludedRegionCapture } from './macos.ts'

/** Cordis plugin name for the app-level provider row in `cordis.patch.yml`. */
export const name = 'computer-use-lasso'

/**
 * Publish the capture service and the first-frame slot on the host scope.
 * @param ctx - app-level context, never an agent preset's.
 * @param backend - unwrapped platform backend, so a lasso capture lists no observation frame.
 */
export function installLassoServices(ctx: Context, backend: DesktopBackend): void {
  ctx.provide('computerUseLassoCapture', installLassoCapture(ctx, backend))
  ctx.provide('computerUseLassoSeed', createLassoSeedStore())
}

/**
 * Mount the provider with the host platform backend.
 * The overlay guard belongs to the orb host in the same scope; it is read when a
 * capture starts, so this row may mount before or after that plugin.
 * @param ctx - app-level registration scope.
 */
export function apply(ctx: Context): void {
  const excludedRegionCapture: OverlayExcludedRegionCapture = (input) => {
    const capture = ctx.get('computerUseOverlayGuard')?.captureExcludedRegion
    if (capture === undefined) {
      return Promise.reject(new Error('dsh desktop: overlay-exclude capture is not attached'))
    }
    const { signal, ...region } = input
    return capture(region, signal)
  }
  installLassoServices(ctx, createPlatformBackend(process.platform, excludedRegionCapture))
}
