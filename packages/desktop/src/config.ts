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
  /**
   * Most characters rendered per snapshot. Default: 12000.
   *
   * A chat window's message list alone can exceed the old 6000 before the input
   * box is reached, and the tool had no argument to raise it, so the model could
   * not find the control it needed no matter how it re-snapshotted.
   */
  readonly maxChars?: number
  /** Refuse an identical action repeated within this window. Default: 12000. */
  readonly repeatWindowMs?: number
  /**
   * Let a denied semantic action retry as a real click on the element's frame.
   * Default: true.
   *
   * Settings rows and custom popups advertise no semantic action, and the frame
   * click is far more accurate than a model guessing a point from a picture.
   */
  readonly physicalFallback?: boolean
  /**
   * How long to wait after an input before capturing the result. Default: 400.
   *
   * A click returns before the app has painted, so capturing immediately hands
   * the model a half-drawn window and it aims at a control that is still moving.
   * Computer Use uses 600 for the same reason; a slow machine can raise this.
   */
  readonly postActionWaitMs?: number
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
  readonly repeatWindowMs: number
  readonly postActionWaitMs: number
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
    maxChars: positive(config.maxChars, 12_000, 'maxChars'),
    idleCloseMs: positive(config.idleCloseMs, 600_000, 'idleCloseMs'),
    repeatWindowMs: positive(config.repeatWindowMs, 12_000, 'repeatWindowMs'),
    postActionWaitMs: positive(config.postActionWaitMs, 400, 'postActionWaitMs'),
    physicalFallback: config.physicalFallback !== false,
    raiseMaxMs: positive(config.raiseMaxMs, DEFAULT_GUARD_CONFIG.raiseMaxMs, 'raiseMaxMs'),
    leaseMs: positive(config.leaseMs, DEFAULT_GUARD_CONFIG.leaseMs, 'leaseMs'),
  }
}