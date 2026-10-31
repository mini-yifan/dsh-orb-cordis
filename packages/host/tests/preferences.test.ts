import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MODEL,
  ProfileStore,
  defaultMillifraction,
  defaultWorkspaceDirectory,
  profileDirectory,
  sniffAvatarMime,
} from '../src/preferences.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-prefs-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function dir(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

describe('profile preferences', () => {
  it('uses the shipped defaults when the profile files are missing', () => {
    const store = new ProfileStore(dir('empty'))
    assert.equal(store.permission(), 'danger-full-access')
    assert.equal(store.permissionFallback(), false)
    // No fallback installed yet: the shipped pair is what an unpicked track starts on.
    assert.deepEqual(store.models().overlay, DEFAULT_MODEL)
    assert.deepEqual(store.models().background, store.models().overlay)
    assert.equal(store.millifractionEnabled(), defaultMillifraction())
    assert.equal(store.coordinateMode(), defaultMillifraction() ? 'millifraction' : 'pixel')
    // The toolbar ships on: a profile with no selection file has never turned it off.
    assert.equal(store.selectionEnabled(), true)
    assert.equal(store.ballEnabled(), true)
    assert.equal(store.avatarVersion(), 0)
    assert.equal(store.readAvatar(), undefined)
    // Nothing has been checked yet: no remembered version, and the automatic check is on.
    assert.deepEqual(store.updateRecord(), { checkedAt: 0, latestVersion: '', notifiedVersion: '', autoCheck: true, lastError: '' })
  })

  it('follows the shared fallback on both tracks until the ball picks one', () => {
    const path = dir('follow')
    const account = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }
    const store = new ProfileStore(path)
    assert.deepEqual(store.models(), { overlay: DEFAULT_MODEL, background: DEFAULT_MODEL })
    // The runtime installed what the unpicked tracks follow: the account route.
    assert.equal(store.applyModelFallback(account), true)
    assert.deepEqual(store.models(), { overlay: account, background: account })
    assert.equal(store.applyModelFallback(account), false, 'the same fallback does not report a move')
    store.setOverlay({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    assert.deepEqual(store.models().overlay, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    assert.deepEqual(store.models().background, account, 'the untouched track keeps following')
    // Only the picked track is written, and it never reaches the fallback.
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'orb-agent-models.json'), 'utf8')), {
      overlay: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    const other = { provider: 'other', model: 'switched-in-the-main-window' }
    assert.equal(store.applyModelFallback(other), true)
    assert.deepEqual(store.models().overlay, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    assert.deepEqual(store.models().background, other, 'a later switch still reaches the free track')
    store.setBackground({ provider: 'background', model: 'chosen' })
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'orb-agent-models.json'), 'utf8')), {
      overlay: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      background: { provider: 'background', model: 'chosen' },
    })
    // Both tracks are explicit now: a fresh store keeps them and ignores the fallback,
    // which is memory only and therefore back to the shipped pair.
    assert.deepEqual(new ProfileStore(path).models(), {
      overlay: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      background: { provider: 'background', model: 'chosen' },
    })
  })

  it('keeps the shipped pair when the fallback or a stored track is unusable', () => {
    const stored = dir('follow-broken')
    writeFileSync(join(stored, 'orb-agent-models.json'), JSON.stringify({
      overlay: { provider: 'kept', model: 'kept' },
      background: { provider: '', model: '' },
    }))
    const empty = new ProfileStore(stored)
    assert.equal(empty.applyModelFallback({ provider: '', model: '' }), false)
    assert.deepEqual(empty.models(), {
      overlay: { provider: 'kept', model: 'kept' },
      background: DEFAULT_MODEL,
    })
  })

  it('remembers the last update check and survives a half-written file', () => {
    const path = dir('update')
    const store = new ProfileStore(path)
    store.setUpdateRecord({ checkedAt: 1700000000000, latestVersion: '0.2.0', notifiedVersion: '0.2.0' })
    const stored = JSON.parse(readFileSync(join(path, 'orb-update.json'), 'utf8')) as { autoCheck: boolean }
    assert.equal(stored.autoCheck, true, 'an untouched field keeps its default')
    assert.deepEqual(new ProfileStore(path).updateRecord(), {
      checkedAt: 1700000000000,
      latestVersion: '0.2.0',
      notifiedVersion: '0.2.0',
      autoCheck: true,
      lastError: '',
    })
    store.setUpdateRecord({ lastError: 'incompatible-version' })
    assert.equal(new ProfileStore(path).updateRecord().lastError, 'incompatible-version')
    store.setUpdateRecord({ autoCheck: false })
    assert.equal(new ProfileStore(path).updateRecord().autoCheck, false)
    writeFileSync(join(path, 'orb-update.json'), '{')
    assert.equal(new ProfileStore(path).updateRecord().latestVersion, '')
  })

  it('remembers a dismissed release note, one id at a time', () => {
    const path = dir('whats-new')
    const store = new ProfileStore(path)
    assert.equal(store.whatsNewDismissed('0.2.0'), false, 'a fresh profile has not seen it')
    store.dismissWhatsNew('0.2.0')
    assert.equal(store.whatsNewDismissed('0.2.0'), true)
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'orb-whats-new.json'), 'utf8')), { dismissed: ['0.2.0'] })
    // Closing it twice is a no-op, and a later note is kept next to it.
    store.dismissWhatsNew('0.2.0')
    store.dismissWhatsNew('0.2.1')
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'orb-whats-new.json'), 'utf8')), { dismissed: ['0.2.0', '0.2.1'] })
    const reloaded = new ProfileStore(path)
    assert.equal(reloaded.whatsNewDismissed('0.2.0'), true)
    assert.equal(reloaded.whatsNewDismissed('0.2.1'), true)
    // A half-written file is not a dismissal: the note must be offered again.
    writeFileSync(join(path, 'orb-whats-new.json'), '{')
    assert.equal(new ProfileStore(path).whatsNewDismissed('0.2.0'), false)
  })

  it('keeps the two model tracks and the selection language apart', () => {
    const path = dir('models')
    // A stored switch and language are both honored, in opposite directions on purpose.
    writeFileSync(join(path, 'selection-toolbar.json'), JSON.stringify({
      enabled: false,
      translateTargetLanguage: 'en',
    }))
    const store = new ProfileStore(path)
    assert.equal(store.selectionEnabled(), false)
    assert.equal(store.translateLanguage(), 'en')
    store.setOverlay({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    store.setBackground({ provider: 'other', model: 'background-model' })
    store.setSelectionEnabled(true)
    const models = JSON.parse(readFileSync(join(path, 'orb-agent-models.json'), 'utf8')) as {
      overlay: { model: string }
      background: { model: string; reasoningEffort?: string }
    }
    assert.equal(models.overlay.model, 'deepseek-pro')
    assert.equal(models.background.model, 'background-model')
    assert.equal(models.background.reasoningEffort, undefined)
    const selection = JSON.parse(readFileSync(join(path, 'selection-toolbar.json'), 'utf8')) as {
      enabled: boolean
      translateTargetLanguage: string
    }
    assert.equal(selection.enabled, true)
    assert.equal(selection.translateTargetLanguage, 'en')
    // With no profile file, the default follows the platform (pixel on macOS, millifraction on Windows).
    assert.equal(store.coordinateMode(), defaultMillifraction() ? 'millifraction' : 'pixel')
    store.setMillifractionEnabled(true)
    assert.equal(store.coordinateMode(), 'millifraction')
    assert.equal(JSON.parse(readFileSync(join(path, 'millifraction-coordinates.json'), 'utf8')).enabled, true)
  })

  it('keeps the observation ribbon on by default and remembers it switched off', () => {
    const path = dir('observation-frame')
    const store = new ProfileStore(path)
    assert.equal(store.observationFrameEnabled(), true)
    store.setObservationFrameEnabled(false)
    assert.equal(JSON.parse(readFileSync(join(path, 'observation-frame.json'), 'utf8')).enabled, false)
    assert.equal(new ProfileStore(path).observationFrameEnabled(), false)
  })

  it('turns the ball off in ball-enabled.json and accepts only gif, png, and webp avatars', () => {
    const path = dir('avatar')
    const store = new ProfileStore(path)
    store.setPermission('read-only')
    store.setBallEnabled(false)
    assert.equal(JSON.parse(readFileSync(join(path, 'orb-permission.json'), 'utf8')).preset, 'read-only')
    assert.equal(JSON.parse(readFileSync(join(path, 'ball-enabled.json'), 'utf8')).enabled, false)
    assert.equal(new ProfileStore(path).ballEnabled(), false)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    const gif = Buffer.from('GIF89a', 'ascii')
    const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii')
    assert.equal(sniffAvatarMime(png), 'image/png')
    assert.equal(sniffAvatarMime(gif), 'image/gif')
    assert.equal(sniffAvatarMime(webp), 'image/webp')
    assert.equal(sniffAvatarMime(Buffer.from('not-an-image')), undefined)
    store.writeAvatar(png, 'image/png')
    assert.equal(store.readAvatar()?.mime, 'image/png')
    assert.ok(store.avatarVersion() > 0)
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ mime: 'image/gif' }))
    assert.equal(new ProfileStore(path).readAvatar(), undefined)
    store.restoreAvatar()
    writeFileSync(join(path, 'orb-permission.json'), '{')
    const broken = new ProfileStore(path)
    assert.equal(broken.permission(), 'workspace-write')
    assert.equal(broken.permissionFallback(), true)
    writeFileSync(join(path, 'orb-permission.json'), JSON.stringify({ preset: 'nope' }))
    assert.equal(new ProfileStore(path).permissionFallback(), true)
    broken.setPermission('read-only')
    assert.equal(new ProfileStore(path).permission(), 'read-only')
    assert.equal(new ProfileStore(path).permissionFallback(), false)
    assert.equal(store.readAvatar(), undefined)
    assert.equal(store.avatarVersion(), 0)
  })

  it('keeps one avatar per profile: a built-in pick replaces the upload and the other way round', () => {
    const path = dir('avatar-preset')
    const store = new ProfileStore(path)
    assert.deepEqual(store.avatarSelection(), { kind: 'default' })

    store.selectAvatarPreset('heart')
    assert.deepEqual(store.avatarSelection(), { kind: 'preset', id: 'heart' })
    assert.equal(store.readAvatar(), undefined)
    assert.ok(store.avatarVersion() > 0)

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    store.writeAvatar(png, 'image/png')
    assert.deepEqual(store.avatarSelection(), { kind: 'custom', mime: 'image/png' })

    store.selectAvatarPreset('point')
    assert.equal(existsSync(join(path, 'orb-avatar')), false)
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'preset', id: 'point' })

    // A preset that this build no longer ships falls back to the shipped GIF.
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ kind: 'preset', preset: 'gone' }))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'default' })

    // Meta written by the older shape still means "uploaded image".
    writeFileSync(join(path, 'orb-avatar'), png)
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ mime: 'image/png' }))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'custom', mime: 'image/png' })

    // Half-written state: the meta claims an upload the disk does not have.
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ kind: 'custom', mime: 'image/png' }))
    rmSync(join(path, 'orb-avatar'))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'default' })

    store.restoreAvatar()
    assert.deepEqual(store.avatarSelection(), { kind: 'default' })
    assert.equal(store.avatarVersion(), 0)
  })

  it('reads the official profile directory', () => {
    assert.equal(profileDirectory({ get: () => ({ dir: '/tmp/dsh-profile' }) }), '/tmp/dsh-profile')
    const fallback = profileDirectory({ get: () => undefined })
    assert.equal(fallback, process.cwd())
    assert.equal(defaultMillifraction('win32'), true)
    assert.equal(defaultMillifraction('darwin'), false)
    assert.equal(defaultMillifraction('linux'), false)
  })

  it('keeps the history retention record, defaulting to forever', () => {
    const path = dir('history')
    const store = new ProfileStore(path)
    assert.deepEqual(store.history(), {
      retentionDays: 0,
      lastCleanupAt: 0,
      lastDeletedSessions: 0,
      lastMovedBytes: 0,
      restoredSessionIds: [],
    })
    store.setHistoryRecord({ retentionDays: 30, lastCleanupAt: 1700000000000, lastDeletedSessions: 2, lastMovedBytes: 4096, restoredSessionIds: ['session-restored'] })
    assert.deepEqual(new ProfileStore(path).history(), {
      retentionDays: 30,
      lastCleanupAt: 1700000000000,
      lastDeletedSessions: 2,
      lastMovedBytes: 4096,
      restoredSessionIds: ['session-restored'],
    })
    writeFileSync(join(path, 'orb-history.json'), JSON.stringify({ retentionDays: 99999, lastDeletedSessions: -1 }))
    assert.equal(new ProfileStore(path).history().retentionDays, 0)
    assert.equal(new ProfileStore(path).history().lastDeletedSessions, 0)
    writeFileSync(join(path, 'orb-history.json'), JSON.stringify({ restoredSessionIds: ['ok-id', '../bad', 4] }))
    assert.deepEqual(new ProfileStore(path).history().restoredSessionIds, ['ok-id'])
    writeFileSync(join(path, 'orb-history.json'), '{')
    assert.equal(new ProfileStore(path).history().retentionDays, 0)
  })

  it('uses the default floating-ball workspace until a profile names one', () => {
    const path = dir('workspace')
    const store = new ProfileStore(path)
    assert.equal(store.workspaceDirectory(), defaultWorkspaceDirectory())
    const custom = join(path, 'custom-workspace')
    store.setWorkspaceDirectory(custom)
    assert.equal(new ProfileStore(path).workspaceDirectory(), custom)
    store.setWorkspaceDirectory(null)
    assert.equal(store.workspaceDirectory(), defaultWorkspaceDirectory())
    assert.equal(existsSync(join(path, 'orb-workspace.json')), false)
    writeFileSync(join(path, 'orb-workspace.json'), JSON.stringify({ path: custom }))
    assert.equal(new ProfileStore(path).workspaceDirectory(), custom)
    writeFileSync(join(path, 'orb-workspace.json'), JSON.stringify({ path: 'relative/workspace' }))
    assert.equal(new ProfileStore(path).workspaceDirectory(), defaultWorkspaceDirectory())
    writeFileSync(join(path, 'orb-workspace.json'), JSON.stringify({ path: 42 }))
    assert.equal(new ProfileStore(path).workspaceDirectory(), defaultWorkspaceDirectory())
  })

  it('keeps voice settings across a new store and falls back when the file is bad', () => {
    const path = dir('voice')
    const store = new ProfileStore(path)
    assert.equal(store.voice().voiceEnabled, false, 'a profile without a voice file starts with voice off')
    assert.equal(store.voice().wakeEnabled, true)
    assert.equal(store.voice().idleMs, 30_000)
    assert.deepEqual(store.voice().wakeWords, ['你好大肥鱼'])
    store.setVoice({
      voiceEnabled: true,
      wakeEnabled: false,
      commandEnabled: false,
      ttsEnabled: true,
      idleMs: 45_000,
      wakeReply: '在',
      dismissPhrases: ['退下吧'],
      questionPrompt: '你来选',
      ttsSpeed: 2,
      ttsVolume: 0.55,
    })
    const again = new ProfileStore(path)
    assert.equal(again.voice().voiceEnabled, true)
    assert.equal(again.voice().wakeEnabled, false)
    assert.equal(again.voice().commandEnabled, false)
    assert.equal(again.voice().ttsEnabled, true)
    assert.equal(again.voice().idleMs, 45_000)
    assert.equal(again.voice().wakeReply, '在')
    assert.deepEqual(again.voice().dismissPhrases, ['退下吧'])
    assert.equal(again.voice().questionPrompt, '你来选')
    assert.equal(again.voice().ttsSpeed, 2)
    assert.equal(again.voice().ttsVolume, 0.55)
    assert.deepEqual(again.voice().wakeWords, ['你好大肥鱼'])
    writeFileSync(join(path, 'orb-voice.json'), '{')
    assert.equal(new ProfileStore(path).voice().voiceEnabled, false)
    assert.equal(new ProfileStore(path).voice().wakeEnabled, true)
    assert.equal(new ProfileStore(path).voice().idleMs, 30_000)
  })

  it('keeps the old effective state for a voice file written before the master switch', () => {
    const path = dir('legacy-voice')
    writeFileSync(join(path, 'orb-voice.json'), JSON.stringify({
      wakeEnabled: true,
      commandEnabled: false,
      ttsEnabled: false,
      idleMs: 45_000,
    }))
    const store = new ProfileStore(path)
    assert.equal(store.voice().voiceEnabled, true, 'a column was on, so voice comes back on')
    assert.equal(store.voice().wakeEnabled, true)
    assert.equal(store.voice().commandEnabled, false)
    assert.equal(store.voice().ttsEnabled, false)
    assert.equal(store.voice().idleMs, 45_000)

    const quiet = dir('legacy-voice-off')
    writeFileSync(join(quiet, 'orb-voice.json'), JSON.stringify({
      wakeEnabled: false,
      commandEnabled: false,
      ttsEnabled: false,
    }))
    assert.equal(new ProfileStore(quiet).voice().voiceEnabled, false, 'all three columns were off, so the master starts off')
  })
})
