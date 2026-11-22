/**
 * Optional services Computer Use already looks up, plus the Access preset pinned on orb sessions.
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { isPermissionPreset, type PermissionPreset, type ProfileStore } from './preferences.ts'

interface SessionLike {
  readonly header?: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
}

interface ServiceContext {
  get(name: string): unknown
  provide(name: string, value: unknown): void
  on(name: 'session/created', listener: (session: SessionLike) => void): (() => void) | void
}

/**
 * Publish the two model/coordinate services for the life of the plugin.
 * @param ctx - host context. `provide` is called once.
 * @param store - profile preferences.
 */
export function installOrbServices(ctx: ServiceContext, store: ProfileStore): void {
  ctx.provide('orbCodeAgentModel', {
    currentSelection: () => store.models().background,
  })
  ctx.provide('orbCoordinateMode', {
    currentMode: () => store.coordinateMode(),
  })
}

/**
 * Pin the stored Access preset on Computer Use and background sessions under the
 * workspace the ball is using right now. `desktop` is the background desktop mode; `standard`
 * sessions under the workspace are the ones started before that mode existed. Read on each create, so a switch applies
 * to the next session without re-registering the listener.
 * @returns a disposer for the create listener.
 */
export function watchOrbPermissions(ctx: ServiceContext, store: ProfileStore): () => void {
  const dispose = ctx.on('session/created', (session) => {
    pinSession(ctx, session, store.permission(), store.workspaceDirectory())
  })
  return typeof dispose === 'function' ? dispose : () => {}
}

/**
 * Pin one already-open session when the chip or a reopen asks for it.
 * @param workspaceRoot - directory the floating-ball Agent is working in.
 */
export function pinSessionId(
  ctx: { get(name: string): unknown },
  sessionId: string,
  preset: PermissionPreset,
  workspaceRoot: string,
): void {
  const sessions = ctx.get('sessions') as { get?(id: string): SessionLike | undefined } | undefined
  const session = sessions?.get?.(sessionId)
  if (session) pinSession(ctx, session, preset, workspaceRoot)
}

function pinSession(
  ctx: { get(name: string): unknown },
  session: SessionLike,
  preset: PermissionPreset,
  workspaceRoot: string,
): void {
  if (!isOrbSession(session, workspaceRoot)) return
  const presets = ctx.get('permissionPresets') as { set?(session: SessionLike, name: string): void } | undefined
  if (typeof presets?.set !== 'function') return
  if (!isPermissionPreset(preset)) return
  try {
    presets.set(session, preset)
  } catch (error) {
    console.error(`dsh-orb: permission preset failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isOrbSession(session: SessionLike, workspaceRoot: string): boolean {
  const preset = session.header?.agentPreset
  const cwd = session.header?.cwd
  if ((preset !== 'computer-use' && preset !== 'standard' && preset !== 'desktop') || cwd === undefined) return false
  return isOrbWorkspace(cwd, workspaceRoot)
}

function isOrbWorkspace(cwd: string, orbCwd: string): boolean {
  const resolved = resolve(cwd)
  const orb = resolve(orbCwd)
  if (resolved === orb) return true
  const rel = relative(orb, resolved)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
