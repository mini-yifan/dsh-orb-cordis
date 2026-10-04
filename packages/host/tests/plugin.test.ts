import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-plugin-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function host(profile: string) {
  const routes: { kind: string; path: string }[] = []
  const provided: string[] = []
  const listeners: { name: string; prepend?: boolean }[] = []
  let dispose: (() => void) | undefined
  const logs: string[] = []
  const ctx = {
    webServer: {
      port: 9,
      register(route: { kind: string; path: string }) {
        routes.push({ kind: route.kind, path: route.path })
        return () => {}
      },
    },
    connection: {
      authenticatedUrl: (base: string) => `${base}/?token=secret`,
      admit: () => ({ peer: {} }),
    },
    sessionController: {
      modelCatalog: () => ({ groups: [] }),
      create: async () => ({ sessionId: 'session-unused' }),
      prompt: async () => ({ accepted: true as const }),
      list: async () => ({ items: [] }),
      selectModel: async () => {},
      cancel: async () => {},
    },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'ws' } }) },
    sessions: { get: () => undefined },
    effect(run: () => void | (() => void)) { dispose = run() ?? undefined },
    get(service: string) {
      if (service === 'profileContext') return { dir: profile }
      return undefined
    },
    provide(service: string) { provided.push(service) },
    on(event: string, _listener: unknown, options?: { prepend?: boolean }) {
      listeners.push({ name: event, prepend: options?.prepend })
      return () => {}
    },
  }
  return { ctx, routes, provided, listeners, logs, stop: () => dispose?.() }
}

describe('orb-host plugin', () => {
  it('registers settings and Computer Use services without starting the helper', async () => {
    const profile = join(root, 'off')
    mkdirSync(profile, { recursive: true })
    const started = host(profile)
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      apply(started.ctx as never, { autoStart: false })
    } finally {
      console.error = original
    }
    assert.equal(name, 'orb-host')
    assert.deepEqual(inject, ['webServer', 'connection', 'sessionController', 'workspaceController', 'sessions', 'agentDefaultModel'])
    assert.deepEqual(started.routes, [{ kind: 'prefix', path: '/.dsh-orb' }])
    assert.deepEqual(started.provided, ['computerUseOverlayGuard', 'orbCodeAgentModel', 'orbCoordinateMode', 'computerUseExcludedPids'])
    assert.equal(started.listeners.some((item) => item.name === 'user-questions/request' && item.prepend === true), true)
    assert.equal(started.listeners.some((item) => item.name === 'session/created'), true)
    assert.equal(errors.some((line) => line.includes('token=') || line.includes('secret')), false)
    assert.equal(errors.some((line) => line.includes('helper socket')), false)
    started.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(errors.some((line) => line.includes('helper socket')), false)
  })

  it('keeps the helper down when ball-enabled.json is false', async () => {
    const profile = join(root, 'disabled')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'ball-enabled.json'), '{"enabled":false}\n')
    const started = host(profile)
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      apply(started.ctx as never)
    } finally {
      console.error = original
    }
    assert.equal(started.routes.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(errors.some((line) => line.includes('helper socket')), false)
    started.stop()
  })
})
