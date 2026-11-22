/**
 * Who may touch which application, right now.
 *
 * Two rules carry the product promise:
 * - a background task never operates the app the user is working in;
 * - when it must borrow the foreground, it only does so while the user is idle,
 *   and gives it back the moment the user touches anything.
 *
 * Locks live on `globalThis` so the guard survives duplicate module copies in one
 * process, mirroring the existing screen mutex and screen-owner record.
 * @module @dsh-orb/desktop/src/guard
 */

const STATE_KEY = Symbol.for('dsh-orb.desktop-owner')
const SCREEN_LOCK_KEY = Symbol.for('dsh-orb.gui-lock')

/** Tunables. See `config.ts` for the loader-facing shape. */
export interface GuardConfig {
  /** A borrowed foreground is returned automatically after this long. */
  readonly raiseMaxMs: number
  /** How long one background session may hold an app lease without another call. */
  readonly leaseMs: number
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  raiseMaxMs: 90_000,
  leaseMs: 120_000,
}

/** A foreground this session borrowed. */
export interface RaisedApp {
  readonly app: string
  /** App that was in front before the raise, restored on release. */
  readonly previous?: string
  readonly owner: string
  readonly at: number
  readonly deadline: number
}

interface GuardState {
  readonly leases: Map<string, { owner: string; at: number }>
  raised?: RaisedApp | undefined
}

/** Anything the caller should refuse to do, with the words the model reads. */
export interface Denial {
  readonly code: string
  readonly message: string
  readonly suggestion?: string
}

export type Decision = { readonly allow: true } | ({ readonly allow: false } & Denial)

/** The shared record. */
export function guardState(): GuardState {
  const holder = globalThis as { [STATE_KEY]?: GuardState }
  holder[STATE_KEY] ??= { leases: new Map() }
  const state = holder[STATE_KEY]
  if (state.raised !== undefined && Date.now() > state.raised.deadline) {
    state.raised = undefined
  }
  return state
}

/** The foreground app this process borrowed, if any. */
export function raisedApp(): RaisedApp | undefined {
  return guardState().raised
}

/**
 * Record a borrowed foreground.
 * @param app - app brought to the front.
 * @param owner - session that borrowed it.
 * @param previous - app that was in front before.
 * @param config - decision tunables.
 */
export function markRaised(app: string, owner: string, previous: string | undefined, config: GuardConfig): RaisedApp {
  const now = Date.now()
  const raised: RaisedApp = {
    app,
    owner,
    at: now,
    deadline: now + config.raiseMaxMs,
    ...previous !== undefined && previous !== '' ? { previous } : {},
  }
  guardState().raised = raised
  return raised
}

/** Forget the borrowed foreground. */
export function clearRaised(): RaisedApp | undefined {
  const state = guardState()
  const raised = state.raised
  state.raised = undefined
  return raised
}

/**
 * The session that currently holds an app lease, if any.
 * @param app - app name.
 * @param config - lease tunables.
 * @returns owner id, or undefined when the app is free or the lease expired.
 */
export function leaseOwner(app: string, config: GuardConfig): string | undefined {
  const state = guardState()
  const lease = state.leases.get(app)
  if (lease === undefined) return undefined
  if (Date.now() - lease.at > config.leaseMs) {
    state.leases.delete(app)
    return undefined
  }
  return lease.owner
}

/**
 * Hold one app for one session, failing fast when another session has it.
 * @param app - app name.
 * @param owner - session id.
 * @param config - lease tunables.
 * @returns whether the lease is held.
 */
export function acquireLease(app: string, owner: string, config: GuardConfig): boolean {
  const state = guardState()
  const now = Date.now()
  for (const [key, lease] of state.leases) {
    if (now - lease.at > config.leaseMs) state.leases.delete(key)
  }
  const held = state.leases.get(app)
  if (held !== undefined && held.owner !== owner) return false
  state.leases.set(app, { owner, at: now })
  return true
}

/**
 * Touch a lease so a multi-step stretch does not expire under the caller.
 * @param app - app name.
 * @param owner - session id.
 */
export function refreshLease(app: string, owner: string): void {
  const lease = guardState().leases.get(app)
  if (lease !== undefined && lease.owner === owner) lease.at = Date.now()
}

/** Drop the caller's lease. */
export function releaseLease(app: string, owner: string): void {
  const state = guardState()
  const lease = state.leases.get(app)
  if (lease?.owner === owner) state.leases.delete(app)
}

/**
 * The owner of the process-global physical-input lock, when one is held.
 * The Computer Use tools take this lock around HID actions.
 * @returns owner id, `''` for an id-less holder, or undefined when free.
 */
export function screenLockOwner(): string | undefined {
  const holder = globalThis as {
    [SCREEN_LOCK_KEY]?: { held?: boolean; owner?: unknown }
  }
  const state = holder[SCREEN_LOCK_KEY]
  if (state?.held !== true) return undefined
  return typeof state.owner === 'string' ? state.owner : ''
}

/**
 * Whether one app may be operated by this session right now.
 * @param input - calling session, target app, what the OS reports, current state.
 * @returns allow, or the refusal the model reads.
 */
export function decideMutation(input: {
  readonly app: string
  readonly owner: string
  readonly leaseHolder: string | undefined
  readonly screenLockOwner: string | undefined
}): Decision {
  const { app, owner, leaseHolder, screenLockOwner: lockOwner } = input

  if (lockOwner !== undefined && lockOwner !== '' && lockOwner !== owner) {
    return {
      allow: false,
      code: 'SCREEN_BUSY',
      message: 'The foreground agent is operating the screen right now.',
      suggestion: 'Wait for it to finish; do not retry this action immediately.',
    }
  }
  if (leaseHolder !== undefined && leaseHolder !== owner) {
    return {
      allow: false,
      code: 'APP_BUSY',
      message: `Another background task is operating ${app}.`,
      suggestion: 'Leave this app alone for now and do something else, or finish without it.',
    }
  }
  return { allow: true }
}

/**
 * Whether this session may borrow the foreground for one app.
 * @param input - calling session, target app, OS state, current state.
 * @returns allow, or the refusal the model reads.
 */
export function decideRaise(input: {
  readonly app: string
  readonly owner: string
  readonly raised: RaisedApp | undefined
  readonly screenLockOwner: string | undefined
}): Decision {
  const { app, owner, raised, screenLockOwner: lockOwner } = input
  if (lockOwner !== undefined && lockOwner !== '' && lockOwner !== owner) {
    return {
      allow: false,
      code: 'SCREEN_BUSY',
      message: 'The foreground agent is operating the screen right now.',
      suggestion: 'Wait for it to finish.',
    }
  }
  if (raised !== undefined && raised.owner !== owner) {
    return {
      allow: false,
      code: 'SCREEN_BUSY',
      message: `Another background task borrowed the foreground for ${raised.app}.`,
      suggestion: 'Wait until it releases, or work without the screen.',
    }
  }
  return { allow: true }
}
