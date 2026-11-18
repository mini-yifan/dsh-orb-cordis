/**
 * Background desktop control for the orb.
 *
 * This plugin is mounted only inside the `desktop` agent preset. It gives a
 * background chat the ability to read and operate desktop apps through the
 * accessibility tree, without moving the pointer or taking keyboard focus —
 * and without ever asking the user a question.
 *
 * The native library never loads in this process: each session gets a child
 * (`host.ts`) that owns the adapter, so a wedged accessibility bridge costs one
 * child instead of the whole desktop app.
 * @module @dsh-orb/desktop
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { DesktopSessions } from './sessions.ts'
import { registerDesktopTools } from './tools.ts'
import { registerVisionTools } from './vision.ts'

export type { Config }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-orb-desktop'

/**
 * Services these tools need. `attachments` is required by the visual fallback,
 * which hands the model a picture instead of a file path. `llm` stays optional
 * and is read lazily so a preset without it still loads.
 */
export const inject = ['tools', 'attachments']

/**
 * Mount the desktop tools.
 * @param ctx - preset-scoped cordis context.
 * @param config - loader configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  if (!resolved.enabled) return

  const sessions = new DesktopSessions(resolved)
  ctx.effect(() => () => {
    void sessions.dispose()
  })
  registerDesktopTools(ctx, sessions, resolved)
  registerVisionTools(ctx, resolved)
}