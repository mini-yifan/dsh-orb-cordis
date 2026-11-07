/**
 * Child-process host for the agent-desktop library.
 *
 * The library loads here, never in the desktop app's own process: a Rust panic,
 * a stuck platform call, or a wedged accessibility bridge must cost one child,
 * not the orb. The protocol is one JSON object per line on stdin/stdout.
 * @module @dsh-orb/desktop/src/host
 */

import { createInterface } from 'node:readline'
import type { HostError, HostResponse, SnapshotData } from './protocol.ts'
import { loadNative, type NativeError, type NativeLibrary } from './ffi.ts'

interface RawNode {
  role?: string
  name?: string
  value?: string
  ref_id?: string
  available_actions?: string[]
  states?: string[]
  children?: RawNode[]
  children_count?: number
  subtree_truncated?: boolean
}

interface SnapshotEnvelope {
  ok?: boolean
  data?: {
    app?: string
    window?: { id?: string; title?: string }
    snapshot_id?: string
    ref_count?: number
    complete?: boolean
    nodes_observed?: number
    tree?: RawNode
  }
  error?: { code?: string; message?: string; suggestion?: string }
}

function toError(error: NativeError): HostError {
  return {
    code: error.code,
    message: error.message,
    ...error.suggestion !== undefined ? { suggestion: error.suggestion } : {},
    resultCode: error.resultCode,
    ...error.delivery !== undefined ? { delivery: error.delivery } : {},
    ...error.retry !== undefined ? { retry: error.retry } : {},
  }
}

function normalizeNode(node: RawNode, depth: number): import('./protocol.ts').DesktopNode {
  const children = depth > 0 && Array.isArray(node.children)
    ? node.children.map(child => normalizeNode(child, depth - 1))
    : undefined
  return {
    role: typeof node.role === 'string' && node.role !== '' ? node.role : 'element',
    ...typeof node.name === 'string' && node.name !== '' ? { name: node.name } : {},
    ...typeof node.value === 'string' && node.value !== '' ? { value: node.value } : {},
    ...typeof node.ref_id === 'string' && node.ref_id !== '' ? { ref: node.ref_id } : {},
    ...Array.isArray(node.available_actions) && node.available_actions.length > 0
      ? { actions: node.available_actions }
      : {},
    ...Array.isArray(node.states) && node.states.length > 0 ? { states: node.states } : {},
    ...children !== undefined && children.length > 0 ? { children } : {},
    ...typeof node.children_count === 'number' ? { childrenCount: node.children_count } : {},
    ...node.subtree_truncated === true ? { subtreeTruncated: true } : {},
  }
}

function normalizeSnapshot(envelope: SnapshotEnvelope): SnapshotData {
  const data = envelope.data ?? {}
  const snapshotId = String(data.snapshot_id ?? '')
  return {
    app: String(data.app ?? ''),
    ...data.window?.id !== undefined ? { windowId: data.window.id } : {},
    ...data.window?.title !== undefined ? { windowTitle: data.window.title } : {},
    snapshotId,
    refCount: Number(data.ref_count ?? 0),
    complete: data.complete !== false,
    ...typeof data.nodes_observed === 'number' ? { nodesObserved: data.nodes_observed } : {},
    tree: normalizeNode(data.tree ?? { role: 'window' }, 64),
  }
}

function parseJson<T>(json: string | undefined): T | undefined {
  if (json === undefined) return undefined
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}

function main(): void {
  const libraryDir = process.env.DSH_ORB_DESKTOP_LIB
  const session = process.env.DSH_ORB_DESKTOP_SESSION
  if (libraryDir === undefined || libraryDir === '') {
    write({ ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'library folder missing', resultCode: 0 } })
    process.exit(2)
  }
  if (session === undefined || session === '') {
    write({ ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'session id missing', resultCode: 0 } })
    process.exit(2)
  }

  let native: NativeLibrary
  try {
    native = loadNative(libraryDir)
  } catch (error) {
    write({
      ok: false,
      error: {
        code: 'NATIVE_LOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
        resultCode: 0,
      },
    })
    process.exit(3)
  }

  const adapter = native.createAdapter(session)
  if (adapter === null || adapter === undefined) {
    write({ ok: false, error: { code: 'ADAPTER_FAILED', message: 'adapter creation failed', resultCode: 0 } })
    process.exit(4)
  }
  // A second, session-less adapter answers "what is in front" without touching
  // the agent's ref namespace.
  let probe: unknown | undefined

  function probeAdapter(): unknown {
    probe ??= native.createProbeAdapter()
    return probe
  }

  const writeLine = (value: HostResponse | { ok: false; error: HostError }): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  function write(value: { ok: false; error: HostError } | Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }

  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let request: { id?: number; op?: string } & Record<string, unknown>
    try {
      request = JSON.parse(trimmed) as typeof request
    } catch {
      write({ ok: false, error: { code: 'INVALID_ARGS', message: 'request is not JSON', resultCode: -10 } })
      return
    }
    const id = typeof request.id === 'number' ? request.id : 0
    try {
      handle(id, request)
    } catch (error) {
      writeLine({
        id,
        ok: false,
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
          resultCode: -12,
        },
      })
    }
  })
  lines.on('close', () => shutdown())

  function shutdown(): void {
    try {
      if (probe !== undefined) native.destroyAdapter(probe)
      native.destroyAdapter(adapter)
    } catch {
      // The process is leaving; a failed teardown changes nothing.
    }
    process.exit(0)
  }

  function handle(id: number, request: { op?: string } & Record<string, unknown>): void {
    switch (request.op) {
      case 'ping':
        writeLine({ id, ok: true, data: { pong: true, abi: native.abiVersion, version: native.libraryVersion } })
        return
      case 'status': {
        const result = native.status(adapter)
        if (!result.ok) return fail(id, result.error)
        writeLine({ id, ok: true, data: parseJson(result.json) })
        return
      }
      case 'apps': {
        const result = native.apps(adapter)
        if (!result.ok) return fail(id, result.error)
        writeLine({ id, ok: true, data: result.apps })
        return
      }
      case 'presence':
        writeLine({ id, ok: true, data: { idleMs: native.idleMs() ?? null } })
        return
      case 'windows': {
        const app = typeof request.app === 'string' ? request.app : ''
        if (app === '') return fail(id, { code: 'INVALID_ARGS', message: 'windows needs an app', resultCode: -10 })
        const result = native.windows(adapter, app)
        if (!result.ok) return fail(id, result.error)
        writeLine({ id, ok: true, data: result.windows })
        return
      }
      case 'state': {
        // One round trip for the guard: user quiet and the app in front.
        const idleMs = native.idleMs() ?? null
        const result = native.snapshot(probeAdapter(), null, 1, true, true)
        const envelope = result.ok ? parseJson<SnapshotEnvelope>(result.json) : undefined
        writeLine({
          id,
          ok: true,
          data: {
            idleMs,
            app: envelope?.data?.app ?? null,
            window: envelope?.data?.window?.title ?? null,
          },
        })
        return
      }
      case 'frontmost': {
        const result = native.snapshot(probeAdapter(), null, 1, true, true)
        if (!result.ok) {
          // Nothing focused (locked screen, no window): not an error the caller acts on.
          writeLine({ id, ok: true, data: {} })
          return
        }
        const envelope = parseJson<SnapshotEnvelope>(result.json)
        writeLine({
          id,
          ok: true,
          data: {
            app: envelope?.data?.app ?? null,
            window: envelope?.data?.window?.title ?? null,
          },
        })
        return
      }
      case 'snapshot': {
        const app = typeof request.app === 'string' ? request.app : null
        const depth = typeof request.depth === 'number' ? request.depth : 3
        const interactive = request.interactive !== false
        const compact = request.compact !== false
        const result = native.snapshot(adapter, app, depth, interactive, compact)
        if (!result.ok) return fail(id, result.error)
        const envelope = parseJson<SnapshotEnvelope>(result.json)
        if (envelope === undefined) {
          return fail(id, { code: 'INTERNAL', message: 'snapshot returned unreadable JSON', resultCode: -12 })
        }
        writeLine({ id, ok: true, data: normalizeSnapshot(envelope) })
        return
      }
      case 'act': {
        const ref = typeof request.ref === 'string' ? request.ref : ''
        const action = request.action
        if (ref === '' || action === undefined || typeof action !== 'object') {
          return fail(id, { code: 'INVALID_ARGS', message: 'act needs ref and action', resultCode: -10 })
        }
        const result = native.act(adapter, ref, action as import('./protocol.ts').ActionRequest)
        if (!result.ok) return fail(id, result.error)
        writeLine({ id, ok: true, data: parseJson(result.json) })
        return
      }
      case 'wait': {
        const wait = request.wait
        if (wait === undefined || typeof wait !== 'object') {
          return fail(id, { code: 'INVALID_ARGS', message: 'wait needs a mode', resultCode: -10 })
        }
        const result = native.wait(adapter, wait as import('./protocol.ts').WaitRequest)
        if (!result.ok) return fail(id, result.error)
        writeLine({ id, ok: true, data: parseJson(result.json) })
        return
      }
      case 'shutdown':
        writeLine({ id, ok: true, data: { bye: true } })
        shutdown()
        return
      default:
        fail(id, { code: 'INVALID_ARGS', message: `unknown op: ${String(request.op)}`, resultCode: -10 })
    }
  }

  function fail(id: number, error: NativeError | undefined): void {
    writeLine({
      id,
      ok: false,
      error: error !== undefined
        ? toError(error)
        : { code: 'INTERNAL', message: 'call failed without an error', resultCode: -12 },
    })
  }
}

main()