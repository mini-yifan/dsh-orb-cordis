/**
 * Background desktop control for the orb.
 *
 * This plugin is mounted only inside the `desktop` agent preset. It gives a
 * background chat the ability to operate desktop apps: `desktop` looks at one
 * window, acts once, and hands back the next picture; `desktop_inspect` and
 * `desktop_act` are the accessibility route for the cases a picture cannot
 * settle.
 *
 * The visual route is the default because it is what a real task measured
 * faster. It moves the real pointer and raises the window it acts on, so this
 * preset does disturb whoever is at the machine — the accessibility route does
 * not, and is one call away when that matters.
 *
 * The native library never loads in this process: each session gets a child
 * (`host.ts`) that owns the adapter, so a wedged accessibility bridge costs one
 * child instead of the whole desktop app.
 * @module @dsh-orb/desktop
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { DesktopSessions } from './sessions.ts'
import { registerGuiTools } from './gui.ts'
import { registerDesktopTools } from './tools.ts'

export type { Config }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-orb-desktop'

/**
 * Services these tools need. `attachments` is required by the visual route,
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
  registerGuiTools(ctx, resolved)
  registerDesktopTools(ctx, sessions, resolved)
}
