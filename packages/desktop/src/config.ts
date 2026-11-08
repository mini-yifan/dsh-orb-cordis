/**
 * Loader-facing configuration and its resolved shape.
 * @module @dsh-orb/desktop/src/config
 */

import { DEFAULT_GUARD_CONFIG, type GuardConfig } from './guard.ts'

/** Loader-accepted configuration for the desktop plugin. */
export interface Config {
  /** Enable the desktop tools. Default: true. */
  readonly enabled?: boolean
  /** Most tree nodes rendered per snapshot. Default: 140. */
  readonly maxNodes?: number
  /** Most characters rendered per snapshot. Default: 6000. */
  readonly maxChars?: number
  /** Keep the operated window's ribbon on screen this long after the last action. Default: 4000. */
  readonly frameHoldMs?: number
  /** Refuse an identical action repeated within this window. Default: 12000. */
  readonly repeatWindowMs?: number
  /** Allow a denied semantic action to retry with physical input when the window is in front. Default: true. */
  readonly physicalFallback?: boolean
  /** A borrowed foreground is returned after this long. Default: 90000. */
  readonly raiseMaxMs?: number
  /** App lease lifetime. Default: 120000. */
  readonly leaseMs?: number
  /** A child with no traffic is stopped after this long. Default: 600000. */
  readonly idleCloseMs?: number
}

/** Configuration after defaults and validation. */
export interface ResolvedConfig extends GuardConfig {
  readonly enabled: boolean
  readonly maxNodes: number
  readonly maxChars: number
  readonly idleCloseMs: number
  readonly frameHoldMs: number
  readonly repeatWindowMs: number
  readonly physicalFallback: boolean
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be a positive number`)
  return resolved
}

/**
 * Apply defaults and reject impossible tunables at load.
 * @param config - partial loader configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    enabled: config.enabled !== false,
    maxNodes: positive(config.maxNodes, 140, 'maxNodes'),
    maxChars: positive(config.maxChars, 6000, 'maxChars'),
    idleCloseMs: positive(config.idleCloseMs, 600_000, 'idleCloseMs'),
    frameHoldMs: positive(config.frameHoldMs, 4_000, 'frameHoldMs'),
    repeatWindowMs: positive(config.repeatWindowMs, 12_000, 'repeatWindowMs'),
    physicalFallback: config.physicalFallback !== false,
    raiseMaxMs: positive(config.raiseMaxMs, DEFAULT_GUARD_CONFIG.raiseMaxMs, 'raiseMaxMs'),
    leaseMs: positive(config.leaseMs, DEFAULT_GUARD_CONFIG.leaseMs, 'leaseMs'),
  }
}