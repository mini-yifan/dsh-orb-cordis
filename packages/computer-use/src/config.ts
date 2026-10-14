/**
 * Validated Computer Use tunables from cordis.yml.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Loader-accepted Computer Use configuration. */
export interface Config {
  /**
   * Milliseconds to wait after a GUI action before inspect and pixel capture, so open menus are listed.
   * Default: 600.
   */
  readonly postActionWaitMs?: number
  /**
   * Screens Computer Use captured (GUI tool results and first-frame notices) that stay
   * visible to the model in one session. Older occurrences leave the request as
   * deterministic placeholder text while the session log and UI keep them; images the
   * user attached or another tool produced are never selected. Default: 25.
   */
  readonly imageWindow?: number
  /**
   * Whether a step keeps only its last GUI screenshot: intermediate screenshots
   * of sibling calls in one step never reach the model. Default: true.
   */
  readonly keepLastStepScreenshot?: boolean
}

/** Config after defaults and load-time validation. */
export interface ResolvedComputerUseConfig {
  readonly postActionWaitMs: number
  readonly imageWindow: number
  readonly keepLastStepScreenshot: boolean
}

/** Loader schema for the Computer Use plugin. */
export const Config: z<Config> = z.object({
  postActionWaitMs: z.number().default(600),
  imageWindow: z.number().default(25),
  keepLastStepScreenshot: z.boolean().default(true),
})

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number ≥ 0`)
  }
  return value
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer ≥ 1`)
  }
  return value
}

/**
 * Apply defaults and reject invalid tunables at load.
 * @param config - plugin config, possibly partial.
 * @returns resolved tunables.
 */
export function resolveComputerUseConfig(config: Config = {}): ResolvedComputerUseConfig {
  return {
    postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, 'postActionWaitMs'),
    imageWindow: requirePositiveInteger(config.imageWindow ?? 25, 'imageWindow'),
    keepLastStepScreenshot: config.keepLastStepScreenshot ?? true,
  }
}
