import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeCatalog } from '../src/catalog.ts'
import { ProfileStore } from '../src/preferences.ts'
import { orbSupported, registerOrbRoutes, tokensMatch, type OrbControl } from '../src/routes.ts'
import { TccMonitor } from '../src/tcc.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-routes-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

function request(method: string, url: string, body?: Buffer | string, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)
  const stream = Readable.from(payload.length === 0 ? [] : [payload])
  return Object.assign(stream, { method, url, headers }) as IncomingMessage
}

function response(): ServerResponse & { status: number; body: Buffer } {
  const res = {
    status: 0,
    body: Buffer.alloc(0),
    writeHead(status: number) { this.status = status },
    end(chunk?: Buffer | string) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    },
  }
  return res as ServerResponse & { status: number; body: Buffer }
}

describe('settings routes', () => {
  it('normalizes the official model catalog', () => {
    assert.deepEqual(normalizeCatalog({
      groups: [
        { id: '', name: 'skip' },
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            { id: 'plain', name: 'Plain' },
            { id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } },
            { id: 'bad' },
          ],
        },
        { id: 'empty', name: 'Empty', models: [] },
      ],
    }), {
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'plain', name: 'Plain' },
          { id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } },
        ],
      }],
    })
    assert.deepEqual(normalizeCatalog(null), { groups: [] })
    assert.equal(orbSupported('linux'), false)
    assert.equal(orbSupported('darwin'), true)
    assert.equal(orbSupported('win32'), true)
    assert.equal(tokensMatch('same-token', 'same-token'), true)
    assert.equal(tokensMatch('same-token', 'other-token'), false)
    assert.equal(tokensMatch('', ''), false)
  })

  it('serves the snapshot on the official port and lets the helper read only the avatar', async () => {
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const calls: unknown[] = []
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() { calls.push('chrome') },
      async setOverlayModel(selection) { store.setOverlay(selection); calls.push(['overlay', selection]) },
      async setBackgroundModel(selection) { store.setBackground(selection); calls.push(['background', selection]) },
      async setSelectionEnabled(enabled) { store.setSelectionEnabled(enabled) },
      async setMillifractionEnabled(enabled) { store.setMillifractionEnabled(enabled) },
      async setBallEnabled(enabled) { store.setBallEnabled(enabled) },
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            assert.equal(route.kind, 'prefix')
            assert.equal(route.path, '/.dsh-orb')
            handler = route.handler
            return () => { handler = undefined }
          },
        },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: {
          modelCatalog: () => ({ groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] }),
        },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)
    const denied = response()
    await handler(request('GET', '/.dsh-orb/settings'), denied)
    assert.equal(denied.status, 401)
    assert.equal(denied.body.length, 0)

    const helperSettings = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-orb-helper': 'helper-secret' }), helperSettings)
    assert.equal(helperSettings.status, 401)

    const avatar = response()
    await handler(request('GET', '/.dsh-orb/avatar?v=0', undefined, { 'x-dsh-orb-helper': 'helper-secret' }), avatar)
    assert.equal(avatar.status, 200)
    assert.equal(avatar.body.subarray(0, 6).toString('ascii'), 'GIF89a')

    const wrong = response()
    await handler(request('GET', '/.dsh-orb/avatar', undefined, { 'x-dsh-orb-helper': 'nope' }), wrong)
    assert.equal(wrong.status, 401)

    const settings = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-user': 'ok' }), settings)
    const snapshot = JSON.parse(settings.body.toString('utf8')) as {
      avatarUrl: string
      ballEnabled: boolean
      overlay: { model: string }
      supported: boolean
      permissionFallback: boolean
    }
    assert.equal(settings.status, 200)
    assert.equal(snapshot.avatarUrl, '/.dsh-orb/avatar?v=0')
    assert.equal(snapshot.avatarUrl.includes('token'), false)
    assert.equal(snapshot.ballEnabled, true)
    assert.equal(snapshot.overlay.model, 'deepseek-flash')
    assert.equal(snapshot.supported, process.platform === 'darwin' || process.platform === 'win32')
    assert.equal(snapshot.permissionFallback, false)

    const models = response()
    await handler(request('GET', '/.dsh-orb/models', undefined, { 'x-dsh-user': 'ok' }), models)
    assert.equal(JSON.parse(models.body.toString('utf8')).groups[0].models[0].id, 'deepseek-flash')

    const overlay = response()
    await handler(request('POST', '/.dsh-orb/overlay-model', JSON.stringify({
      provider: 'deepseek-official',
      model: 'deepseek-pro',
      reasoningEffort: 'high',
    }), { 'x-dsh-user': 'ok' }), overlay)
    assert.equal(JSON.parse(overlay.body.toString('utf8')).overlay.model, 'deepseek-pro')

    const background = response()
    await handler(request('POST', '/.dsh-orb/background-model', JSON.stringify({
      provider: 'deepseek-official',
      model: 'background',
    }), { 'x-dsh-user': 'ok' }), background)
    assert.equal(JSON.parse(background.body.toString('utf8')).background.model, 'background')
    assert.equal(JSON.parse(background.body.toString('utf8')).overlay.model, 'deepseek-pro')

    const selection = response()
    await handler(request('POST', '/.dsh-orb/selection', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), selection)
    assert.equal(JSON.parse(selection.body.toString('utf8')).selectionEnabled, false)

    const fraction = response()
    await handler(request('POST', '/.dsh-orb/millifraction', JSON.stringify({ enabled: true }), { 'x-dsh-user': 'ok' }), fraction)
    assert.equal(JSON.parse(fraction.body.toString('utf8')).millifractionEnabled, true)
    assert.equal(store.coordinateMode(), 'millifraction')

    const ball = response()
    await handler(request('POST', '/.dsh-orb/ball', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), ball)
    assert.equal(JSON.parse(ball.body.toString('utf8')).ballEnabled, false)
    assert.equal(store.ballEnabled(), false)

    const uploaded = response()
    await handler(request('POST', '/.dsh-orb/avatar', png, { 'x-dsh-user': 'ok' }), uploaded)
    const uploadedSnapshot = JSON.parse(uploaded.body.toString('utf8')) as { avatarUrl: string }
    assert.match(uploadedSnapshot.avatarUrl, /^\/\.dsh-orb\/avatar\?v=[1-9]/)
    const custom = response()
    await handler(request('GET', '/.dsh-orb/avatar?v=2', undefined, { 'x-dsh-user': 'ok' }), custom)
    assert.equal(custom.body.equals(png), true)

    const invalid = response()
    await handler(request('POST', '/.dsh-orb/avatar', Buffer.from('nope'), { 'x-dsh-user': 'ok' }), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body.toString('utf8')).error, 'invalid-type')

    const restored = response()
    await handler(request('POST', '/.dsh-orb/avatar/restore', '{}', { 'x-dsh-user': 'ok' }), restored)
    assert.equal(JSON.parse(restored.body.toString('utf8')).avatarUrl, '/.dsh-orb/avatar?v=0')
    assert.equal(calls.includes('chrome'), true)

    // Built-in avatars: the page lists them, reads their bytes, and picks one.
    const gallery = JSON.parse(settings.body.toString('utf8')) as {
      avatarPresetId: string | null
      avatarPresets: { id: string; url: string }[]
    }
    assert.equal(gallery.avatarPresetId, null)
    assert.equal(gallery.avatarPresets.length > 0, true)
    const [first] = gallery.avatarPresets
    assert.equal(first.url, `/.dsh-orb/avatar/preset/${first.id}`)

    const presetBytes = response()
    await handler(request('GET', first.url, undefined, { 'x-dsh-user': 'ok' }), presetBytes)
    assert.equal(presetBytes.status, 200)
    assert.equal(presetBytes.body.subarray(0, 6).toString('ascii'), 'GIF89a')
    assert.equal(presetBytes.body.length > 100_000, true)

    const anonymousPreset = response()
    await handler(request('GET', first.url), anonymousPreset)
    assert.equal(anonymousPreset.status, 401)

    const unknownPreset = response()
    await handler(request('GET', `/.dsh-orb/avatar/preset/${first.id}%2F..%2Frestore`, undefined, { 'x-dsh-user': 'ok' }), unknownPreset)
    assert.equal(unknownPreset.status, 404)

    const picked = response()
    await handler(request('POST', '/.dsh-orb/avatar/preset', JSON.stringify({ preset: first.id }), { 'x-dsh-user': 'ok' }), picked)
    const pickedSnapshot = JSON.parse(picked.body.toString('utf8')) as { avatarUrl: string; avatarPresetId: string | null }
    assert.equal(pickedSnapshot.avatarPresetId, first.id)
    assert.match(pickedSnapshot.avatarUrl, /^\/\.dsh-orb\/avatar\?v=[1-9]/)
    assert.equal(calls.includes('chrome'), true)

    // The ball's own route (and the settings preview) then serves the same bytes.
    const currentPreset = response()
    await handler(request('GET', pickedSnapshot.avatarUrl, undefined, { 'x-dsh-orb-helper': 'helper-secret' }), currentPreset)
    assert.equal(currentPreset.body.equals(presetBytes.body), true)

    const wrongPreset = response()
    await handler(request('POST', '/.dsh-orb/avatar/preset', JSON.stringify({ preset: 'gone' }), { 'x-dsh-user': 'ok' }), wrongPreset)
    assert.equal(wrongPreset.status, 400)
    assert.equal(JSON.parse(wrongPreset.body.toString('utf8')).error, 'invalid-preset')

    const missing = response()
    await handler(request('GET', '/.dsh-orb/nope', undefined, { 'x-dsh-user': 'ok' }), missing)
    assert.equal(missing.status, 404)
    dispose()
  })

  it('proxies a ball recording to the optional speech service and degrades cleanly', async () => {
    const profile = join(root, 'speech-profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setBallEnabled() {},
    }
    const seen: { audio: Buffer; language?: string }[] = []
    const speech = {
      listProviders: () => [{ id: 'sensevoice-local', name: 'SenseVoice', languages: ['auto'] }],
      resolve: (request: { audio: Buffer; language?: string }) => {
        seen.push(request)
        return { provider: { info: { id: 'sensevoice-local' } }, audio: request.audio, language: 'auto' }
      },
      transcribe: async () => ({ text: 'hello from the ball', audioSeconds: 1 }),
    }
    const handlers: { current?: (req: IncomingMessage, res: ServerResponse) => Promise<void> } = {}
    registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handlers.current = route.handler
            return () => { handlers.current = undefined }
          },
        },
        connection: { isAuthenticated: () => true },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
        get: (name) => (name === 'speechToText' ? speech : undefined),
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    const run = (req: IncomingMessage, res: ServerResponse) => handlers.current!(req, res)

    const bytes = canonicalWave(1)
    const ok = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: bytes.toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), ok)
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body.toString('utf8')).text, 'hello from the ball')
    assert.equal(seen[0].audio.equals(bytes), true)

    // The proxy is helper-only: a normal authenticated page cannot reach it.
    const page = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: bytes.toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-user': 'ok' }), page)
    assert.equal(page.status, 401)
    assert.equal(JSON.parse(page.body.toString('utf8')).error, 'unauthorized')

    const unauthenticated = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: bytes.toString('base64'),
      audioSeconds: 1,
    })), unauthenticated)
    assert.equal(unauthenticated.status, 401)

    // A malformed recording is refused before the provider sees it.
    const invalid = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: Buffer.from('not a wave').toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body.toString('utf8')).error, 'invalid-audio')

    // Valid base64 that is not a canonical WAV is still refused up front.
    const notWave = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: Buffer.from('A'.repeat(20_000)).toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), notWave)
    assert.equal(notWave.status, 400)
    assert.equal(JSON.parse(notWave.body.toString('utf8')).error, 'invalid-audio')

    // A body past the size limit is reported as oversize audio, not a host error.
    const oversized = response()
    await run(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: 'A'.repeat(6 * 1024 * 1024),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), oversized)
    assert.equal(oversized.status, 413)
    assert.equal(JSON.parse(oversized.body.toString('utf8')).error, 'invalid-audio')
  })

  it('answers voice-unavailable when the voice bundle is not mounted', async () => {
    const profile = join(root, 'no-voice-profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setBallEnabled() {},
    }
    const handlers: { current?: (req: IncomingMessage, res: ServerResponse) => Promise<void> } = {}
    registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handlers.current = route.handler
            return () => { handlers.current = undefined }
          },
        },
        connection: { isAuthenticated: () => true },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    const denied = response()
    await handlers.current!(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: canonicalWave(1).toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), denied)
    assert.equal(denied.status, 503)
    assert.equal(JSON.parse(denied.body.toString('utf8')).error, 'voice-unavailable')
  })

  it('answers voice-unavailable when no provider is registered', async () => {
    const profile = join(root, 'no-provider-profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setBallEnabled() {},
    }
    const handlers: { current?: (req: IncomingMessage, res: ServerResponse) => Promise<void> } = {}
    registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handlers.current = route.handler
            return () => { handlers.current = undefined }
          },
        },
        connection: { isAuthenticated: () => true },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
        get: (name) => (name === 'speechToText'
          ? {
            listProviders: () => [],
            resolve: () => { throw new Error('Speech provider is unavailable') },
            transcribe: async () => ({ text: '' }),
          }
          : undefined),
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    const denied = response()
    await handlers.current!(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: canonicalWave(1).toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), denied)
    assert.equal(denied.status, 503)
    assert.equal(JSON.parse(denied.body.toString('utf8')).error, 'voice-unavailable')
  })

  it('reports an unprepared provider as voice-not-ready, not a crash', async () => {
    const profile = join(root, 'not-ready-profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setBallEnabled() {},
    }
    const handlers: { current?: (req: IncomingMessage, res: ServerResponse) => Promise<void> } = {}
    registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handlers.current = route.handler
            return () => { handlers.current = undefined }
          },
        },
        connection: { isAuthenticated: () => true },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
        get: (name) => (name === 'speechToText'
          ? {
            listProviders: () => [{ id: 'sensevoice-local' }],
            resolve: () => { throw new Error('Prepare the local speech provider before recording') },
            transcribe: async () => ({ text: '' }),
          }
          : undefined),
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    const notReady = response()
    await handlers.current!(request('POST', '/.dsh-orb/transcribe', JSON.stringify({
      audioBase64: canonicalWave(1).toString('base64'),
      audioSeconds: 1,
    }), { 'x-dsh-orb-helper': 'helper-secret' }), notReady)
    assert.equal(notReady.status, 503)
    assert.equal(JSON.parse(notReady.body.toString('utf8')).error, 'voice-not-ready')
  })
})

/** One canonical 16 kHz mono PCM16 WAV with `seconds` of silence. */
function canonicalWave(seconds: number): Buffer {
  const samples = Math.round(seconds * 16_000)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}
