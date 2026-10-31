import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { absentVoiceModels } from '@dsh-orb/voice/manifest'
import { normalizeCatalog } from '../src/catalog.ts'
import { ProfileStore, MAX_AVATAR_BYTES } from '../src/preferences.ts'
import { orbSupported, registerOrbRoutes, tokensMatch, type OrbControl } from '../src/routes.ts'
import { TccMonitor } from '../src/tcc.ts'
import { EMPTY_UPDATE_STATE } from '../src/update.ts'
import { WHATS_NEW_VERSION } from '../src/whats-new.ts'

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
    writableEnded: false,
    writeHead(status: number) { this.status = status },
    end(chunk?: Buffer | string) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.writableEnded = true
    },
    on() { return this },
    off() { return this },
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
    let autoCheck = true
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() { calls.push('chrome') },
      async setOverlayModel(selection) { store.setOverlay(selection); calls.push(['overlay', selection]) },
      async setBackgroundModel(selection) { store.setBackground(selection); calls.push(['background', selection]) },
      async setSelectionEnabled(enabled) { store.setSelectionEnabled(enabled) },
      async setMillifractionEnabled(enabled) { store.setMillifractionEnabled(enabled) },
      async setObservationFrameEnabled(enabled) { store.setObservationFrameEnabled(enabled) },
      async setBallEnabled(enabled) { store.setBallEnabled(enabled) },
      helperPhase: () => 'downloading',
      updateState: () => ({
        currentVersion: '0.1.0',
        installedVersion: '0.1.0',
        latestVersion: '0.2.0',
        available: true,
        checking: false,
        updating: false,
        canUpdate: true,
        autoCheck,
        checkedAt: 1700000000000,
        restartRequired: false,
        error: null,
        pendingBuilds: [],
      }),
      async checkUpdate() { calls.push('check') },
      installUpdate(builds) { calls.push(['install', builds]) },
      setAutoCheck(enabled) { autoCheck = enabled; calls.push(['auto', enabled]) },
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
        get(name: string) {
          if (name !== 'attachments') return undefined
          return {
            readImage: async (ref: { mediaType: string }) => ({ data: png, mediaType: ref.mediaType }),
            readImageRequest: async () => ({ data: png, mediaType: 'image/png' }),
          }
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

    // Durable ids are content-addressed (`sha256:<hex>`): the colon must reach the store,
    // or the chip, the transcript thumbnail, and their preview all 404.
    const attachment = response()
    const attachmentId = `sha256:${'a'.repeat(64)}`
    await handler(request(
      'GET',
      `/.dsh-orb/attachment?id=${encodeURIComponent(attachmentId)}&mediaType=image%2Fjpeg&bytes=10&width=100&height=100&thumb=1`,
      undefined,
      { 'x-dsh-orb-helper': 'helper-secret' },
    ), attachment)
    assert.equal(attachment.status, 200)
    assert.equal(attachment.body.subarray(0, 8).toString('hex'), png.subarray(0, 8).toString('hex'))

    const wrong = response()
    await handler(request('GET', '/.dsh-orb/avatar', undefined, { 'x-dsh-orb-helper': 'nope' }), wrong)
    assert.equal(wrong.status, 401)

    const settings = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-user': 'ok' }), settings)
    const snapshot = JSON.parse(settings.body.toString('utf8')) as {
      avatarUrl: string
      ballEnabled: boolean
      helperPhase: string
      overlay: { model: string }
      supported: boolean
      permissionFallback: boolean
      update: { currentVersion: string; latestVersion: string; available: boolean; autoCheck: boolean }
    }
    assert.equal(settings.status, 200)
    assert.equal(snapshot.helperPhase, 'downloading', 'the settings page can show the runtime wait')
    assert.equal(snapshot.avatarUrl, '/.dsh-orb/avatar?v=0')
    assert.equal(snapshot.avatarUrl.includes('token'), false)
    assert.equal(snapshot.ballEnabled, true)
    assert.equal(snapshot.overlay.model, 'deepseek-flash')
    assert.equal(snapshot.supported, process.platform === 'darwin' || process.platform === 'win32')
    assert.equal(snapshot.permissionFallback, false)
    assert.deepEqual(snapshot.update, {
      currentVersion: '0.1.0',
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      available: true,
      checking: false,
      updating: false,
      canUpdate: true,
      autoCheck: true,
      checkedAt: 1700000000000,
      restartRequired: false,
      error: null,
      pendingBuilds: [],
    })

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

    const frame = response()
    await handler(request('POST', '/.dsh-orb/observation-frame', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), frame)
    assert.equal(JSON.parse(frame.body.toString('utf8')).observationFrameEnabled, false)
    assert.equal(store.observationFrameEnabled(), false)

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

    // The gallery the settings page links to serves GIFs up to ~2.6 MB, and the page's own
    // check uses the same number: a body at the cap is a real upload, not a rejection.
    assert.ok(MAX_AVATAR_BYTES > 2_600_000, 'the cap covers the largest gallery GIF')
    const atCap = Buffer.concat([Buffer.from('GIF89a', 'binary'), Buffer.alloc(2_600_000)])
    const accepted = response()
    await handler(request('POST', '/.dsh-orb/avatar', atCap, { 'x-dsh-user': 'ok' }), accepted)
    assert.equal(accepted.status, 200)
    assert.deepEqual(store.avatarSelection(), { kind: 'custom', mime: 'image/gif' })

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

    const voice = response()
    await handler(request('POST', '/.dsh-orb/voice', JSON.stringify({
      voiceEnabled: true,
      wakeEnabled: false,
      idleMs: 45_000,
      wakeReply: '在',
      dismissPhrases: ['退下吧'],
      questionPrompt: '你来选',
      interjectKeyword: '小肥鱼',
      ttsBackend: 'qwen',
      qwenApiKey: '  sk-test  ',
      qwenVoice: 'Eldric Sage',
      qwenSpeed: 1.84,
      ttsVolume: 1.37,
    }), { 'x-dsh-user': 'ok' }), voice)
    const voiceBody = JSON.parse(voice.body.toString('utf8')) as {
      voice: { voiceEnabled: boolean, wakeEnabled: boolean, idleMs: number, wakeReply: string, questionPrompt: string, ttsBackend: string, qwenApiKey: string, qwenVoice: string, qwenSpeed: number, ttsVolume: number }
      qwenVoices: { voice: string, label: string, group: string }[]
    }
    assert.equal(voice.status, 200)
    assert.equal(voiceBody.voice.voiceEnabled, true)
    assert.equal(voiceBody.voice.wakeEnabled, false)
    assert.equal(voiceBody.voice.idleMs, 45_000)
    assert.equal(voiceBody.voice.wakeReply, '在')
    assert.equal(voiceBody.voice.questionPrompt, '你来选')
    assert.equal(voiceBody.voice.ttsBackend, 'qwen')
    assert.equal(voiceBody.voice.qwenApiKey, 'sk-test')
    assert.equal(voiceBody.voice.qwenVoice, 'Eldric Sage')
    assert.equal(voiceBody.voice.qwenSpeed, 1.8)
    assert.equal(voiceBody.voice.ttsVolume, 1.37)
    assert.equal(voiceBody.qwenVoices.length, 48)
    const view = voiceBody.qwenVoices.find((item) => item.voice === 'Eldric Sage')
    assert.deepEqual(view, { voice: 'Eldric Sage', label: '沧明子 · 男 · 沉稳老者', group: 'standard' })
    assert.equal(voiceBody.qwenVoices.some((item) => item.voice === 'Jada' && item.group === 'dialect'), true)
    const savedVoice = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-user': 'ok' }), savedVoice)
    const savedSnapshot = JSON.parse(savedVoice.body.toString('utf8')) as { voice: { interjectKeyword: string, qwenApiKey: string } }
    assert.equal(savedVoice.status, 200)
    assert.equal(savedSnapshot.voice.interjectKeyword, '小肥鱼')
    assert.equal(savedSnapshot.voice.qwenApiKey, 'sk-test')
    const reloaded = new ProfileStore(profile)
    assert.equal(reloaded.voice().voiceEnabled, true)
    assert.equal(reloaded.voice().wakeEnabled, false)
    assert.equal(reloaded.voice().idleMs, 45_000)
    assert.deepEqual(reloaded.voice().dismissPhrases, ['退下吧'])
    assert.equal(reloaded.voice().interjectKeyword, '小肥鱼')
    assert.equal(reloaded.voice().ttsBackend, 'qwen')
    assert.equal(reloaded.voice().qwenVoice, 'Eldric Sage')
    assert.equal(reloaded.voice().qwenSpeed, 1.8)
    assert.equal(reloaded.voice().ttsVolume, 1.37)

    const blank = response()
    await handler(request('POST', '/.dsh-orb/voice', JSON.stringify({
      ttsBackend: 'qwen',
      qwenApiKey: '   ',
      qwenVoice: 'Eldric Sage',
      qwenSpeed: 1.8,
    }), { 'x-dsh-user': 'ok' }), blank)
    assert.equal(JSON.parse(blank.body.toString('utf8')).voice.qwenApiKey, '')
    dispose()
  })

  it('returns the current voice download instead of starting a second one', async () => {
    const profile = join(root, 'profile-voice-download')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    let starts = 0
    let downloading = false
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => EMPTY_UPDATE_STATE,
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
      voiceModels() {
        const models = absentVoiceModels()
        return { ...models, wake: { ...models.wake, downloading, progress: downloading ? 0.5 : 0 } }
      },
      downloadVoiceModel() {
        if (downloading) return 'busy'
        downloading = true
        starts += 1
        return 'started'
      },
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => {} } },
        connection: { admit: () => ({ peer: { id: 'local' } }) },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)
    const first = response()
    await handler(request('POST', '/.dsh-orb/voice/download', JSON.stringify({ kind: 'wake' })), first)
    const started = JSON.parse(first.body.toString('utf8')) as { voiceModels: { wake: { downloading: boolean, progress: number } } }
    assert.equal(starts, 1)
    assert.equal(started.voiceModels.wake.downloading, true)
    assert.equal(started.voiceModels.wake.progress, 0.5)
    const second = response()
    await handler(request('POST', '/.dsh-orb/voice/download', JSON.stringify({ kind: 'wake' })), second)
    assert.equal(starts, 1)
    assert.equal(JSON.parse(second.body.toString('utf8')).voiceModels.wake.progress, 0.5)
    const bad = response()
    await handler(request('POST', '/.dsh-orb/voice/download', JSON.stringify({ kind: 'nope' })), bad)
    assert.equal(bad.status, 400)
  })

  it('exposes the update state, the manual check, and the install request', async () => {
    const profile = join(root, 'profile-update')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const calls: unknown[] = []
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => ({ ...emptyUpdate, currentVersion: '0.1.0', installedVersion: '0.1.0' }),
      async checkUpdate() { calls.push('check') },
      installUpdate(builds) { calls.push(['install', builds]) },
      setAutoCheck(enabled) { calls.push(['auto', enabled]) },
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)

    const denied = response()
    await handler(request('GET', '/.dsh-orb/update'), denied)
    assert.equal(denied.status, 401)

    const state = response()
    await handler(request('GET', '/.dsh-orb/update', undefined, { 'x-dsh-user': 'ok' }), state)
    assert.equal(state.status, 200)
    assert.equal((JSON.parse(state.body.toString('utf8')) as { currentVersion: string }).currentVersion, '0.1.0')

    const checked = response()
    await handler(request('POST', '/.dsh-orb/update/check', '{}', { 'x-dsh-user': 'ok' }), checked)
    assert.equal(checked.status, 200)
    assert.equal(calls.includes('check'), true)
    assert.deepEqual((JSON.parse(checked.body.toString('utf8')) as { update: { currentVersion: string } }).update.currentVersion, '0.1.0')

    // The install answers at once with a snapshot: the page polls instead of waiting it out.
    const installed = response()
    await handler(request('POST', '/.dsh-orb/update/install', JSON.stringify({ approvedBuilds: ['koffi'] }), { 'x-dsh-user': 'ok' }), installed)
    assert.equal(installed.status, 200)
    assert.deepEqual(calls.at(-1), ['install', ['koffi']])

    const bare = response()
    await handler(request('POST', '/.dsh-orb/update/install', '{}', { 'x-dsh-user': 'ok' }), bare)
    assert.deepEqual(calls.at(-1), ['install', undefined])

    const auto = response()
    await handler(request('POST', '/.dsh-orb/update/auto', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), auto)
    assert.deepEqual(calls.at(-1), ['auto', false])

    const invalid = response()
    await handler(request('POST', '/.dsh-orb/update/auto', JSON.stringify({ enabled: 'yes' }), { 'x-dsh-user': 'ok' }), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body.toString('utf8')).error, 'invalid-auto-check')
    dispose()
  })

  it('offers the release note once, and remembers the dismissal on the profile', async () => {
    const profile = join(root, 'profile-whats-new')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    let installed = WHATS_NEW_VERSION
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => ({ ...emptyUpdate, currentVersion: installed, installedVersion: installed }),
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: { admit: () => ({ peer: { id: 'local' } }) },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)

    const first = response()
    await handler(request('GET', '/.dsh-orb/settings'), first)
    const opened = JSON.parse(first.body.toString('utf8')) as { whatsNew: { id: string; version: string } | null }
    assert.deepEqual(opened.whatsNew, orbSupported() ? { id: WHATS_NEW_VERSION, version: WHATS_NEW_VERSION } : null)

    const dismissed = response()
    await handler(request('POST', '/.dsh-orb/whats-new/dismiss', JSON.stringify({ id: WHATS_NEW_VERSION })), dismissed)
    assert.equal(dismissed.status, 200)
    assert.equal((JSON.parse(dismissed.body.toString('utf8')) as { whatsNew: unknown }).whatsNew, null)
    assert.equal(new ProfileStore(profile).whatsNewDismissed(WHATS_NEW_VERSION), true, 'the marker is on disk, not just in memory')

    const again = response()
    await handler(request('GET', '/.dsh-orb/settings'), again)
    assert.equal((JSON.parse(again.body.toString('utf8')) as { whatsNew: unknown }).whatsNew, null)

    const invalid = response()
    await handler(request('POST', '/.dsh-orb/whats-new/dismiss', JSON.stringify({ id: '0.1.9' })), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body.toString('utf8')).error, 'invalid-whats-new')

    // A host on an older version has nothing to offer, even with the marker missing.
    installed = '0.1.9'
    const old = response()
    await handler(request('GET', '/.dsh-orb/settings'), old)
    assert.equal((JSON.parse(old.body.toString('utf8')) as { whatsNew: unknown }).whatsNew, null)
    dispose()
  })

  it('exposes history retention, preview, cleanup, and the Agent workspace', async () => {
    const profile = join(root, 'profile-history')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const calls: unknown[] = []
    let retention = 0
    let workspace = { path: '/tmp/orb-default', defaultPath: '/tmp/orb-default', custom: false }
    const historyState = (): import('../src/history.ts').HistoryState => ({
      available: true,
      workspacePath: '/tmp/orb-workspace',
      retentionDays: retention,
      cleaning: false,
      phase: '',
      error: null,
      lastCleanupAt: null,
      lastDeletedSessions: 0,
      lastMovedBytes: 0,
      warning: '',
      warningSessions: 0,
    })
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => ({ ...emptyUpdate }),
      setAutoCheck() {},
      historyState,
      setHistoryRetention(days) { retention = days; calls.push(['retention', days]) },
      async previewHistory(days) {
        calls.push(['preview', days])
        return { days, cutoff: 0, roots: 2, members: 3, images: 4, bytes: 5, oldest: null, newest: null, skipped: { active: 0, pinned: 0, archived: 0, current: 0, unchanged: 0, unreadable: 0, restored: 0 }, sessions: [{ id: 'session-a', title: 'A', updatedAt: 1 }] }
      },
      cleanHistory() { calls.push('clean') },
      workspaceState: () => workspace,
      async pickWorkspaceDirectory() { return '/tmp/picked-workspace' },
      async setWorkspaceDirectory(path) {
        calls.push(['workspace', path])
        if (path === '/not-empty') throw new Error('workspace-not-empty')
        if (path === '/running') throw new Error('workspace-running')
        workspace = { path, defaultPath: '/tmp/orb-default', custom: path !== '/tmp/orb-default' }
      },
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)
    const answer = async (method: string, url: string, body?: string): Promise<{ status: number; json: any }> => {
      const res = response()
      await handler!(request(method, url, body, { 'x-dsh-user': 'ok' }), res)
      const text = res.body.toString('utf8')
      return { status: res.status, json: text === '' ? undefined : JSON.parse(text) }
    }

    const state = await answer('GET', '/.dsh-orb/history')
    assert.equal(state.status, 200)
    assert.equal(state.json.retentionDays, 0)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: 30 }))).status, 200)
    assert.deepEqual(calls.at(-1), ['retention', 30])
    const preview = await answer('POST', '/.dsh-orb/history/preview', JSON.stringify({ days: 30 }))
    assert.equal(preview.status, 200)
    assert.equal(preview.json.preview.roots, 2)
    assert.equal((await answer('POST', '/.dsh-orb/history/clean', '{}')).status, 200)
    assert.equal(calls.at(-1), 'clean')
    assert.equal((await answer('POST', '/.dsh-orb/history/trash/empty', '{}')).status, 404)
    assert.equal((await answer('POST', '/.dsh-orb/history/trash/restore', JSON.stringify({ batchId: 'batch-1' }))).status, 404)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: 60 }))).status, 200)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: 61 }))).status, 400)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: 2 }))).status, 400)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: 1.5 }))).status, 400)
    assert.equal((await answer('POST', '/.dsh-orb/history/retention', JSON.stringify({ days: '30' }))).status, 400)

    const settings = await answer('GET', '/.dsh-orb/settings')
    assert.equal(settings.json.workspace.path, '/tmp/orb-default')
    const picked = await answer('POST', '/.dsh-orb/workspace/pick', '{}')
    assert.equal(picked.status, 200)
    assert.equal(picked.json.path, '/tmp/picked-workspace')
    assert.equal((await answer('POST', '/.dsh-orb/workspace', JSON.stringify({ path: '/tmp/empty-workspace' }))).status, 200)
    assert.deepEqual(calls.at(-1), ['workspace', '/tmp/empty-workspace'])
    assert.equal(workspace.path, '/tmp/empty-workspace')
    const invalid = await answer('POST', '/.dsh-orb/workspace', JSON.stringify({ path: '/not-empty' }))
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error, 'workspace-not-empty')
    const running = await answer('POST', '/.dsh-orb/workspace', JSON.stringify({ path: '/running' }))
    assert.equal(running.status, 409)
    assert.equal(running.json.error, 'workspace-running')
    assert.equal((await answer('POST', '/.dsh-orb/workspace', JSON.stringify({ path: '' }))).status, 400)
    dispose()
  })

  it('hands a bookmark jump and a settings target to the main window once', async () => {
    let armed: string | undefined = 'session-agent-9'
    let settings: number | undefined = 4242
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => armed === undefined ? null : { sessionId: armed, at: 1234 },
      confirmJump(sessionId) {
        if (armed === sessionId) armed = undefined
      },
      takeSettingsOpen: () => settings === undefined ? null : { at: settings },
      confirmSettingsOpen(at) {
        if (settings === at) settings = undefined
      },
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => ({ ...emptyUpdate }),
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const profile = join(root, 'profile-jump')
    mkdirSync(profile, { recursive: true })
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store: new ProfileStore(profile),
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)

    const denied = response()
    await handler(request('GET', '/.dsh-orb/jump'), denied)
    assert.equal(denied.status, 401)

    const armed1 = response()
    await handler(request('GET', '/.dsh-orb/jump', undefined, { 'x-dsh-user': 'ok' }), armed1)
    assert.equal(armed1.status, 200)
    assert.equal((JSON.parse(armed1.body.toString('utf8')) as { sessionId: string }).sessionId, 'session-agent-9')

    const confirmed = response()
    await handler(request('POST', '/.dsh-orb/jump', JSON.stringify({ sessionId: 'session-agent-9' }), { 'x-dsh-user': 'ok' }), confirmed)
    assert.equal(confirmed.status, 200)

    const consumed = response()
    await handler(request('GET', '/.dsh-orb/jump', undefined, { 'x-dsh-user': 'ok' }), consumed)
    assert.equal((JSON.parse(consumed.body.toString('utf8')) as { sessionId: string | null }).sessionId, null)

    const invalidPost = response()
    await handler(request('POST', '/.dsh-orb/jump', '{}', { 'x-dsh-user': 'ok' }), invalidPost)
    assert.equal(invalidPost.status, 400)

    // The settings row rides the same bridge, with the arm timestamp as its identity.
    const settingsDenied = response()
    await handler(request('GET', '/.dsh-orb/settings-open'), settingsDenied)
    assert.equal(settingsDenied.status, 401)

    const armedSettings = response()
    await handler(request('GET', '/.dsh-orb/settings-open', undefined, { 'x-dsh-user': 'ok' }), armedSettings)
    assert.equal(armedSettings.status, 200)
    assert.equal((JSON.parse(armedSettings.body.toString('utf8')) as { at: number }).at, 4242)

    // Reading twice must not consume: the window may still be starting up.
    const reread = response()
    await handler(request('GET', '/.dsh-orb/settings-open', undefined, { 'x-dsh-user': 'ok' }), reread)
    assert.equal((JSON.parse(reread.body.toString('utf8')) as { at: number }).at, 4242)

    const invalidSettings = response()
    await handler(request('POST', '/.dsh-orb/settings-open', JSON.stringify({ at: 'now' }), { 'x-dsh-user': 'ok' }), invalidSettings)
    assert.equal(invalidSettings.status, 400)

    const confirmedSettings = response()
    await handler(request('POST', '/.dsh-orb/settings-open', JSON.stringify({ at: 4242 }), { 'x-dsh-user': 'ok' }), confirmedSettings)
    assert.equal(confirmedSettings.status, 200)

    const consumedSettings = response()
    await handler(request('GET', '/.dsh-orb/settings-open', undefined, { 'x-dsh-user': 'ok' }), consumedSettings)
    assert.equal((JSON.parse(consumedSettings.body.toString('utf8')) as { at: number | null }).at, null)
    dispose()
  })

  it('answers a malformed JSON body with 400 and an oversized avatar with 413', async () => {
    const profile = join(root, 'profile-bad-body')
    mkdirSync(profile, { recursive: true })
    const control: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => ({ ...emptyUpdate }),
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store: new ProfileStore(profile),
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)

    // A body that is not JSON used to reject the handler and hang the request.
    const bad = response()
    await handler(request('POST', '/.dsh-orb/update/auto', '{', { 'x-dsh-user': 'ok' }), bad)
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body.toString('utf8')).error, 'invalid-json')

    const huge = response()
    await handler(request('POST', '/.dsh-orb/avatar', Buffer.alloc(MAX_AVATAR_BYTES + 64), { 'x-dsh-user': 'ok' }), huge)
    assert.equal(huge.status, 413, 'the avatar limit keeps its own status')
    assert.equal(JSON.parse(huge.body.toString('utf8')).error, 'too-large')
    dispose()
  })

  it('restarts the runtime download on request, and says so on a host that cannot', async () => {
    const profile = join(root, 'profile-redownload')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    let redownloads = 0
    let phase = ''
    let failure = 'runtime-download'
    const base: OrbControl = {
      helperAuthorized: () => false,
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => null,
      confirmSettingsOpen() {},
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      helperStatus: () => failure,
      helperPhase: () => phase,
      updateState: () => ({ ...emptyUpdate }),
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
        connection: { admit: () => ({ peer: { id: 'local' } }) },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control: {
        ...base,
        async redownloadRuntime() {
          redownloads += 1
          // Same bookkeeping as the host: the failure goes away and a fresh attempt is armed
          // before the page reads its snapshot back.
          failure = ''
          phase = 'downloading'
        },
      },
    })
    assert.ok(handler)
    const fresh = response()
    await handler(request('POST', '/.dsh-orb/runtime/redownload', '{}'), fresh)
    assert.equal(fresh.status, 200)
    assert.equal(redownloads, 1, 'the route reaches the control')
    const body = JSON.parse(fresh.body.toString('utf8')) as { helperPhase: string; helperError: string }
    assert.equal(body.helperPhase, 'downloading', 'the snapshot the page reads back is the new attempt')
    assert.equal(body.helperError, '', 'the failure is gone the moment the redownload is armed')
    dispose()

    // An older host without the action answers 404 rather than pretending it worked.
    let oldHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const disposeOld = registerOrbRoutes({
      ctx: {
        webServer: { register(route) { oldHandler = route.handler; return () => { oldHandler = undefined } } },
        connection: { admit: () => ({ peer: { id: 'local' } }) },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control: { ...base },
    })
    assert.ok(oldHandler)
    const unsupported = response()
    await oldHandler(request('POST', '/.dsh-orb/runtime/redownload', '{}'), unsupported)
    assert.equal(unsupported.status, 404)
    disposeOld()
  })
})

/** Update state a host without a checker answers, for tests that only exercise one route. */
const emptyUpdate = {
  currentVersion: '',
  installedVersion: '',
  latestVersion: null,
  available: false,
  checking: false,
  updating: false,
  canUpdate: false,
  autoCheck: false,
  checkedAt: null,
  restartRequired: false,
  error: null,
  pendingBuilds: [],
}
