import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProfileStore,
  defaultMillifraction,
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
    assert.deepEqual(store.models().overlay, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    assert.deepEqual(store.models().background, store.models().overlay)
    assert.equal(store.millifractionEnabled(), defaultMillifraction())
    assert.equal(store.coordinateMode(), defaultMillifraction() ? 'millifraction' : 'pixel')
    assert.equal(store.selectionEnabled(), false)
    assert.equal(store.ballEnabled(), true)
    assert.equal(store.avatarVersion(), 0)
    assert.equal(store.readAvatar(), undefined)
    // Nothing has been checked yet: no remembered version, and the automatic check is on.
    assert.deepEqual(store.updateRecord(), { checkedAt: 0, latestVersion: '', notifiedVersion: '', autoCheck: true })
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
    })
    store.setUpdateRecord({ autoCheck: false })
    assert.equal(new ProfileStore(path).updateRecord().autoCheck, false)
    writeFileSync(join(path, 'orb-update.json'), '{')
    assert.equal(new ProfileStore(path).updateRecord().latestVersion, '')
  })

  it('keeps the two model tracks and the selection language apart', () => {
    const path = dir('models')
    // The selection toolbar is disabled everywhere: a stored enabled flag is ignored.
    writeFileSync(join(path, 'selection-toolbar.json'), JSON.stringify({
      enabled: true,
      translateTargetLanguage: 'en',
    }))
    const store = new ProfileStore(path)
    assert.equal(store.selectionEnabled(), false)
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
})
