import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..')
const repo = join(bundle, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-orb-install-'))

after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** Plugin names the patch inserts that belong to this package. */
function ownNames() {
  const patch = readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8')
  const names = [...patch.matchAll(/^\s+name: '?(dsh-orb[^'\s]*)'?\s*$/gm)].map((match) => match[1])
  return [...new Set(names)]
}

/** The loader resolves a patch row from the profile root, the same as this. */
function resolveFromProfile(profile, specifier) {
  return createRequire(join(profile, 'package.json')).resolve(specifier)
}

function profileWith(install) {
  const profile = mkdtempSync(join(scratch, 'profile-'))
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  install(join(profile, 'node_modules', 'dsh-orb'))
  return profile
}

function checkInstalled(profile, root) {
  const names = ownNames()
  assert.deepEqual(names.sort(), ['dsh-orb', 'dsh-orb/computer-use', 'dsh-orb/computer-use/code-agent', 'dsh-orb/host'])
  for (const specifier of names) {
    const file = resolveFromProfile(profile, specifier)
    assert.ok(existsSync(file), `${specifier} -> ${file}`)
  }

  // dsh-client-modules: nearest manifest carries the package name, declares dsh.client, exports ./client.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-orb')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.equal(manifest.exports['./client'], './client.js')
  assert.match(readFileSync(join(root, 'client.js'), 'utf8'), /id: 'dsh-orb'/)

  // Files the host reaches by relative path.
  for (const rel of [
    'dist/helper/lib/main.js',
    'dist/helper/preload.cjs',
    'dist/helper/selection-preload.cjs',
    'dist/helper/assets/floating.html',
    'dist/helper/assets/deepseek-avatar-square.gif',
    // Every built-in avatar the host can offer has to be in the installed tree.
    ...readdirSync(join(repo, 'packages/helper/assets/avatars')).map((file) => `dist/helper/assets/avatars/${file}`),
    'dist/native-selection/src/index.js',
    'dist/native-selection/prebuilds/darwin-universal/libmacos-selection.dylib',
    'dist/computer-use/macos-sck-capture',
  ]) {
    assert.ok(existsSync(join(root, rel)), rel)
  }
  const host = readFileSync(join(root, 'dist/host/index.js'), 'utf8')
  assert.match(host, /new URL\("\.\.\/helper", import\.meta\.url\)/)
  assert.equal(host.includes('from "@dsh-orb/native-selection"'), false)
  assert.equal(readdirSync(join(root, 'dist/host')).includes('index.js'), true)
}

describe('dsh-orb install layout', () => {
  // Assembled into a scratch folder so a linked desktop install is never rewritten while it runs.
  const assembled = join(scratch, 'assembled')
  before(() => {
    const built = spawnSync(process.execPath, [join(bundle, 'scripts/assemble.mjs'), '--out', assembled], { stdio: 'pipe', encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    // A real link resolves dependencies from the package's own folder; give the copy the same view.
    symlinkSync(join(bundle, 'node_modules'), join(assembled, 'node_modules'), 'dir')
  })

  it('resolves every patch row from the profile root when the folder is linked', async () => {
    const profile = profileWith((target) => symlinkSync(assembled, target, 'dir'))
    checkInstalled(profile, join(profile, 'node_modules', 'dsh-orb'))
    const host = await import(pathToFileURL(resolveFromProfile(profile, 'dsh-orb/host')).href)
    assert.equal(typeof host.apply, 'function')
    assert.equal(host.name, 'orb-host')
  })

  it('resolves every patch row when the tarball is unpacked into the profile', () => {
    const packed = spawnSync(process.execPath, [join(bundle, 'scripts/pack.mjs')], { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const tarball = join(repo, 'dsh-orb-0.0.0.tgz')
    assert.ok(existsSync(tarball))
    try {
      const profile = profileWith((target) => {
        mkdirSync(target, { recursive: true })
        const untar = spawnSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], { encoding: 'utf8' })
        assert.equal(untar.status, 0, untar.stderr)
      })
      const root = join(profile, 'node_modules', 'dsh-orb')
      checkInstalled(profile, root)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      assert.equal(manifest.devDependencies, undefined)
      assert.equal(manifest.scripts, undefined)
      for (const spec of Object.values({ ...manifest.dependencies })) {
        assert.doesNotMatch(String(spec), /^(file|link|workspace):/)
      }
      // dbus-next drives the KWin session-bus bridge on Linux; koffi is the FFI core.
      assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['dbus-next', 'koffi', 'zod'])
    } finally {
      rmSync(tarball, { force: true })
    }
  })
})
