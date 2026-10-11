import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deferredDir, type DeferredInstall } from '../src/deferred-install.ts'
import { ProfileStore } from '../src/preferences.ts'
import { AUTO_CHECK_INTERVAL_MS, compareVersions, exemptReleaseAge, installRegistry, installSpec, ownPackage, registryTarballUrl, releaseTarballUrl, UpdateChecker, versionFromRegistry, versionFromRelease, withReleaseAgeExclusion } from '../src/update.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-update-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

let counter = 0
function store(): ProfileStore {
  counter += 1
  const path = join(root, `profile-${counter}`)
  mkdirSync(path, { recursive: true })
  return new ProfileStore(path)
}

/** A manager that records the spec it was handed and answers with a scripted result. */
function manager(result: Record<string, unknown> = { application: 'restart-required' }) {
  const specs: string[] = []
  const registries: Array<string | undefined> = []
  return {
    specs,
    registries,
    service: {
      async installBundle(spec: string, options?: { registry?: string }) {
        specs.push(spec)
        registries.push(options?.registry)
        return result
      },
    },
  }
}

function checker(options: {
  store: ProfileStore
  own?: { name: string; version: string } | undefined
  latest?: string | undefined
  result?: Record<string, unknown>
  notify?: (version: string) => void
  mapped?: string[]
}) {
  const fake = manager(options.result)
  const announced: string[] = []
  const deferred: DeferredInstall[] = []
  const update = new UpdateChecker({
    store: options.store,
    manager: () => fake.service,
    notify: (version) => { announced.push(version); options.notify?.(version) },
    fetchLatest: async () => options.latest,
    own: 'own' in options ? options.own : { name: 'dsh-orb', version: '0.1.0' },
    mappedImages: () => options.mapped ?? [],
    deferInstall: (job) => { deferred.push(job) },
  })
  return { update, announced, specs: fake.specs, registries: fake.registries, deferred }
}

/** A local http mock answering `routes[path]` with `[status, body]`; other paths hang up. */
async function mockServer(routes: Record<string, [number, string]>): Promise<{ base: string; close(): void }> {
  const server = createServer((request, response) => {
    const hit = routes[request.url ?? '']
    if (hit === undefined) { response.destroy(); return }
    response.writeHead(hit[0], { 'content-type': 'application/json' })
    response.end(hit[1])
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.close() } }
}

/** Sets env vars for the duration of `run`, restoring or clearing them after. */
async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Nothing listens here, so curl fails fast: a source that is down. */
const DEAD_SOURCE = 'http://127.0.0.1:1'

describe('update versions', () => {
  it('orders releases, patches, and prereleases', () => {
    assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
    assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numeric, not lexicographic')
    assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing segment counts as zero')
    assert.equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1, 'a prerelease precedes its release')
    assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.9'), 1)
    assert.equal(compareVersions('0.2.0-beta', '0.2.0-rc'), -1)
  })

  it('reads the installed manifest and refuses to guess one', () => {
    assert.deepEqual(ownPackage(), undefined, 'running from packages/host/lib finds no manifest')
  })

  it('derives the release tag and tarball address from a version', () => {
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0"}'), '0.2.0')
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0-rc.1"}'), '0.2.0-rc.1')
    assert.equal(versionFromRelease('{"name":"unrelated"}'), undefined)
    assert.equal(versionFromRelease('not json'), undefined)
    assert.equal(
      releaseTarballUrl('0.2.0'),
      'https://github.com/mini-yifan/dsh-orb-cordis/releases/download/plugin-v0.2.0/dsh-orb-0.2.0.tgz',
    )
    process.env.DSH_ORB_UPDATE_URL = 'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz'
    assert.equal(releaseTarballUrl('0.2.0'), 'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz')
    delete process.env.DSH_ORB_UPDATE_URL
  })
})

describe('release-age exemption', () => {
  it('replaces a versioned rule with the bare name, written first', () => {
    const before = 'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - dsh-orb@0.1.0\n'
    assert.equal(
      withReleaseAgeExclusion(before, 'dsh-orb'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - dsh-orb\n',
    )
  })

  it('adds the key when the file has none', () => {
    assert.equal(
      withReleaseAgeExclusion('packages:\n  - .\n', 'dsh-orb'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n',
    )
  })

  it('keeps quiet when the package is already exempt by name', () => {
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-orb\n', 'dsh-orb'), undefined)
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-orb\n  - other\n', 'dsh-orb'), undefined)
  })

  it('collapses every rule a profile collected for one package into the first bare name', () => {
    // The shape pnpm leaves behind: it appends one `name@version` rule per young
    // release, and reads only the first rule per name, so the bare entry in the
    // middle exempts nothing (pnpm #732) — which is what blocked uninstalls.
    const before =
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb@0.1.0\n  - dsh-orb@0.1.2\n  - dsh-orb\n  - dsh-orb@0.1.4\n  - dsh-orb@0.1.3\n  - other@1.0.0 || 2.0.0\n'
    assert.equal(
      withReleaseAgeExclusion(before, 'dsh-orb'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n  - other@1.0.0 || 2.0.0\n',
    )
  })

  it('drops a rule pnpm appends behind the bare name', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-orb\n  - dsh-orb@0.1.4\n', 'dsh-orb'),
      'minimumReleaseAgeExclude:\n  - dsh-orb\n',
    )
  })

  it('quotes a scoped name and leaves other entries untouched', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n\t- other\n', '@scope/orb'),
      "minimumReleaseAgeExclude:\n\t- '@scope/orb'\n\t- other\n",
    )
  })

  it('adds the bare name even when only versioned entries exist', () => {
    assert.equal(
      withReleaseAgeExclusion('minimumReleaseAgeExclude:\n  - dsh-orb@0.1.2\n', 'dsh-orb'),
      'minimumReleaseAgeExclude:\n  - dsh-orb\n',
    )
  })

  it('leaves an unfamiliar file shape alone', () => {
    assert.equal(withReleaseAgeExclusion('minimumReleaseAgeExclude: [dsh-orb]\n', 'dsh-orb'), undefined)
  })

  it('writes the exemption into the profile before installing', async () => {
    const profile = store()
    writeFileSync(
      join(profile.dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb@0.1.0\n',
    )
    const { update } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    await update.install()
    assert.equal(
      readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'),
      'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n',
    )
  })

  it('repairs the profile at start, whatever route installed the version', () => {
    const profile = store()
    // What the market's or the plugin manager's own `pnpm add` leaves behind:
    // pnpm's appended rule sits behind the first rule, which keeps governing.
    const broken = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb@0.1.4\n  - dsh-orb@0.1.5\n'
    writeFileSync(join(profile.dir, 'pnpm-workspace.yaml'), broken)
    exemptReleaseAge(profile.dir, 'dsh-orb')
    const repaired = 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-orb\n'
    assert.equal(readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'), repaired)
    // Idempotent: starting again changes nothing.
    exemptReleaseAge(profile.dir, 'dsh-orb')
    assert.equal(readFileSync(join(profile.dir, 'pnpm-workspace.yaml'), 'utf8'), repaired)
  })

  it('leaves a profile without a workspace file alone', () => {
    const profile = store()
    exemptReleaseAge(profile.dir, 'dsh-orb')
    assert.equal(existsSync(join(profile.dir, 'pnpm-workspace.yaml')), false)
  })
})

describe('update sources', () => {
  it('reads a registry dist-tag document and its tarball address', () => {
    assert.equal(versionFromRegistry('{"name":"dsh-orb","version":"0.2.0"}'), '0.2.0')
    assert.equal(versionFromRegistry('{"name":"dsh-orb","version":"v0.2.0-rc.1"}'), '0.2.0-rc.1')
    assert.equal(versionFromRegistry('{"name":"dsh-orb"}'), undefined)
    assert.equal(versionFromRegistry('not json'), undefined)
    assert.equal(
      registryTarballUrl('https://registry.npmmirror.com', 'dsh-orb', '0.2.0'),
      'https://registry.npmmirror.com/dsh-orb/-/dsh-orb-0.2.0.tgz',
    )
    assert.equal(installSpec('0.2.0', 'dsh-orb'), 'dsh-orb@0.2.0')
    assert.equal(installSpec('v0.2.0-rc.1', 'dsh-orb'), 'dsh-orb@0.2.0-rc.1')
    assert.equal(
      installRegistry(undefined),
      'https://registry.npmmirror.com',
      'an unknown source asks the primary mirror first',
    )
    assert.equal(installRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org')
    process.env.DSH_ORB_UPDATE_URL = 'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz'
    assert.equal(
      installSpec('0.2.0', 'dsh-orb'),
      'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz',
      'the env override wins over the version spec',
    )
    delete process.env.DSH_ORB_UPDATE_URL
  })

  it('prefers a registry that answers and installs that version from it, over real HTTP', async () => {
    const registry = await mockServer({ '/dsh-orb/latest': [200, '{"name":"dsh-orb","version":"0.3.0"}'] })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: registry.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.3.0'])
        assert.equal(update.state().error, null)
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-orb@0.3.0'])
        assert.deepEqual(fake.registries, [registry.base])
      })
    } finally {
      registry.close()
    }
  })

  it('moves down the registry chain when one is unreachable', async () => {
    const registry = await mockServer({ '/dsh-orb/latest': [200, '{"name":"dsh-orb","version":"0.4.0"}'] })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: `${DEAD_SOURCE},${registry.base}` }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.4.0'], 'the second registry answered')
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-orb@0.4.0'])
        assert.deepEqual(fake.registries, [registry.base])
      })
    } finally {
      registry.close()
    }
  })

  it('falls back to GitHub when no registry knows the package', async () => {
    const registry = await mockServer({ '/dsh-orb/latest': [404, '{"error":"not found"}'] })
    const github = await mockServer({ '/releases/latest': [200, '{"tag_name":"plugin-v0.2.0"}'] })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: registry.base, DSH_ORB_UPDATE_API: github.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.2.0'], 'the release answered after the registry 404ed')
        await update.install()
        assert.deepEqual(fake.specs, ['dsh-orb@0.2.0'])
        assert.deepEqual(fake.registries, ['https://registry.npmmirror.com'], 'the version still installs from the primary mirror')
      })
    } finally {
      registry.close()
      github.close()
    }
  })
})

describe('update checker', () => {
  it('reports an available version once and remembers it', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.2.0' })
    assert.equal(update.state().available, false, 'nothing is known before the first check')
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const state = update.state()
    assert.equal(state.currentVersion, '0.1.0')
    assert.equal(state.installedVersion, '0.1.0')
    assert.equal(state.latestVersion, '0.2.0')
    assert.equal(state.available, true)
    assert.equal(state.error, null)
    assert.equal(update.availableVersion(), '0.2.0')
    assert.deepEqual(profile.updateRecord(), {
      checkedAt: profile.updateRecord().checkedAt,
      latestVersion: '0.2.0',
      notifiedVersion: '0.2.0',
      autoCheck: true,
    })
    // A second check on the same version stays quiet, and a restart does too.
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const restarted = checker({ store: profile, latest: '0.2.0' })
    await restarted.update.check()
    assert.deepEqual(restarted.announced, [])
  })

  it('stays quiet when the published version is not newer', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.1.0' })
    await update.check()
    assert.deepEqual(announced, [])
    assert.equal(update.state().available, false)
    assert.equal(update.state().error, null)
  })

  it('reports a network failure when every mirror 404s and GitHub is unreachable', async () => {
    // A mirror that has not synced yet answers 404: that is not an answer about the
    // version, so a transfer failure on the remaining source stays a network error.
    const registry = await mockServer({ '/dsh-orb/latest': [404, '{"error":"not found"}'] })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: registry.base, DSH_ORB_UPDATE_API: DEAD_SOURCE }, async () => {
        const profile = store()
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: () => {},
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        const state = update.state()
        assert.equal(state.error, 'network')
        assert.equal(state.checkedAt, null, 'a failed check does not start the quiet period')
      })
    } finally {
      registry.close()
    }
  })

  it('reports an install in progress instead of offering the version again', () => {
    const profile = store()
    const dir = deferredDir(profile.dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'status.json'), JSON.stringify({
      phase: 'installing',
      spec: 'dsh-orb@0.2.0',
      pid: process.pid,
      startedAt: Date.now(),
    }))
    const { update } = checker({ store: profile, latest: '0.2.0' })
    const state = update.state()
    assert.equal(state.deferred, true, 'the settings page shows the running install')
    assert.equal(state.available, false, 'the update button does not queue it a second time')
  })

  it('records a network failure without dropping the version it already knew', async () => {    const profile = store()
    const first = checker({ store: profile, latest: '0.2.0' })
    await first.update.check()
    const offline = checker({ store: profile, latest: undefined })
    await offline.update.check(true)
    assert.equal(offline.update.state().error, 'network')
    assert.equal(offline.update.state().latestVersion, '0.2.0')
    assert.equal(offline.update.state().available, true)
  })

  it('reads a repository without releases as checked and quiet, over real HTTP', async () => {
    // The GitHub API answers 404 for /releases/latest until the first release ships.
    const github = await mockServer({
      '/releases/latest': [404, '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'],
    })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: DEAD_SOURCE, DSH_ORB_UPDATE_API: github.base }, async () => {
        const profile = store()
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: () => {},
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        const state = update.state()
        assert.equal(state.error, null, 'no release published yet is not a failure')
        assert.equal(state.available, false)
        assert.equal(state.latestVersion, null)
        assert.ok(state.checkedAt !== null, 'the throttle still records the answer')
      })
    } finally {
      github.close()
    }
  })

  it('resolves the latest version through curl end to end', async () => {
    const github = await mockServer({ '/releases/latest': [200, '{"tag_name":"plugin-v0.2.0","name":"0.2.0"}'] })
    try {
      await withEnv({ DSH_ORB_UPDATE_REGISTRIES: DEAD_SOURCE, DSH_ORB_UPDATE_API: github.base }, async () => {
        const profile = store()
        const announced: string[] = []
        const fake = manager()
        const update = new UpdateChecker({
          store: profile,
          manager: () => fake.service,
          notify: (version) => announced.push(version),
          own: { name: 'dsh-orb', version: '0.1.0' },
        })
        await update.check(true)
        assert.deepEqual(announced, ['0.2.0'])
        assert.equal(update.state().available, true)
        assert.equal(update.state().error, null)
      })
    } finally {
      github.close()
    }
  })

  it('throttles the automatic check but not a manual one', async () => {
    const profile = store()
    const { update } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    const checkedAt = profile.updateRecord().checkedAt
    assert.ok(Date.now() - checkedAt < AUTO_CHECK_INTERVAL_MS)
    // A fresh checker sees the same throttle: the timestamp is on disk, not in memory.
    let asked = 0
    const second = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.3.0' },
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await second.check()
    assert.equal(asked, 0)
    await second.check(true)
    assert.equal(asked, 1)
    assert.equal(second.state().latestVersion, '0.3.0')
  })

  it('skips the automatic check when the preference is off', async () => {
    const profile = store()
    profile.setUpdateRecord({ autoCheck: false })
    let asked = 0
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.2.0' },
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await update.check()
    assert.equal(asked, 0)
    assert.equal(update.state().autoCheck, false)
    await update.check(true)
    assert.equal(asked, 1)
    update.setAutoCheck(true)
    assert.equal(update.state().autoCheck, true)
  })

  it('installer falls back to the primary mirror when no check source is known', async () => {
    const profile = store()
    const { update, specs, registries } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-orb@0.2.0'])
    assert.deepEqual(registries, ['https://registry.npmmirror.com'], 'no check source still asks the primary mirror')
    const state = update.state()
    assert.equal(state.updating, false)
    assert.equal(state.error, null)
    assert.equal(state.installedVersion, '0.2.0')
    assert.equal(state.available, false, 'nothing is left to install')
    assert.equal(state.restartRequired, true, 'the running process still holds the old code')
    assert.equal(update.availableVersion(), null)
  })

  it('reports how an install failed instead of throwing', async () => {
    const profile = store()
    const failed = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', error: { code: 'incompatible-version' } },
    })
    await failed.update.check()
    await failed.update.install()
    assert.equal(failed.update.state().error, 'incompatible-version')
    assert.equal(failed.update.state().installedVersion, '0.1.0')
    assert.equal(failed.update.availableVersion(), '0.2.0', 'the offer survives for a retry')

    const blocked = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', pendingBuilds: ['koffi'] },
    })
    await blocked.update.check()
    await blocked.update.install()
    assert.equal(blocked.update.state().error, 'build-blocked')
    assert.deepEqual(blocked.update.state().pendingBuilds, ['koffi'])

    const diagnosed = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          diagnostic: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION: 1 version does not meet the minimumReleaseAge constraint\ndetail below',
        },
      },
    })
    await diagnosed.update.check()
    await diagnosed.update.install()
    assert.equal(
      diagnosed.update.state().error,
      'ERR_PNPM_NO_MATURE_MATCHING_VERSION: 1 version does not meet the minimumReleaseAge constraint',
      'a codeless pnpm failure keeps its first diagnostic line',
    )

    const wrapped = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          code: 'operation-error',
          diagnostic: 'Progress: resolved 1, reused 0, downloaded 0, added 0\n[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "dsh-orb@https://example.invalid/dsh-orb.tgz"\nmore',
        },
      },
    })
    await wrapped.update.check()
    await wrapped.update.install()
    assert.equal(
      wrapped.update.state().error,
      '[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "dsh-orb@https://example.invalid/dsh-orb.tgz"',
      'the generic operation-error wrapper yields to the pnpm line',
    )
  })

  it('waits for the app to quit instead of replacing a package whose addon is loaded', async () => {
    const profile = store()
    const { update, specs, deferred } = checker({ store: profile, latest: '0.2.0', mapped: ['node_modules/koffi/build/koffi.node'] })
    await update.check()
    await update.install(['koffi'])
    assert.deepEqual(specs, [], 'pnpm never sees a package it cannot replace')
    assert.deepEqual(deferred, [{
      profileDir: profile.dir,
      spec: 'dsh-orb@0.2.0',
      registry: 'https://registry.npmmirror.com',
      parentPid: process.pid,
      approvedBuilds: ['koffi'],
    }])
    const state = update.state()
    assert.equal(state.error, null)
    assert.equal(state.deferred, true)
    assert.equal(state.restartRequired, true)
    assert.equal(state.available, false, 'the button does not queue the same version twice')
    assert.equal(state.installedVersion, '0.1.0', 'nothing is on disk yet')
    await update.install()
    assert.equal(deferred.length, 1)
  })

  it('hands a locked-file failure to the after-exit install', async () => {
    const profile = store()
    const { update, specs, deferred } = checker({
      store: profile,
      latest: '0.2.0',
      result: {
        application: 'failed',
        error: {
          code: 'operation-error',
          diagnostic: '[ERR_PNPM_EPERM] [importPackage C:\\p\\node_modules\\dsh-orb] EPERM, Permission denied: \\\\?\\C:\\p\\node_modules\\dsh-orb_tmp_1_1\\node_modules',
        },
      },
    })
    await update.check()
    await update.install()
    assert.deepEqual(specs, ['dsh-orb@0.2.0'])
    assert.equal(deferred.length, 1, 'the half-replaced package is repaired once the app quits')
    assert.equal(update.state().error, null)
    assert.equal(update.state().deferred, true)
  })

  it('reports a deferred install that failed after the app quit', () => {
    const profile = store()
    mkdirSync(deferredDir(profile.dir), { recursive: true })
    const result = join(deferredDir(profile.dir), 'result.json')
    writeFileSync(result, JSON.stringify({ spec: 'dsh-orb@0.2.0', ok: false, detail: 'ERR_PNPM_FETCH_404 not found' }))
    const { update } = checker({ store: profile, latest: '0.2.0' })
    assert.equal(update.state().error, 'ERR_PNPM_FETCH_404 not found')
    assert.equal(existsSync(result), false, 'the outcome is reported once')
    assert.equal(checker({ store: profile, latest: '0.2.0' }).update.state().error, null)
  })

  it('keeps working without the official plugin manager', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '0.2.0',
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await update.check()
    assert.equal(update.state().available, true, 'the notice needs no manager')
    assert.equal(update.state().canUpdate, false)
    await update.install()
    assert.equal(update.state().installedVersion, '0.1.0', 'nothing was installed')
  })

  it('has nothing to offer without a readable version', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '9.9.9',
      own: undefined,
    })
    await update.check()
    const state = update.state()
    assert.equal(state.currentVersion, '')
    assert.equal(state.available, false)
    assert.equal(state.canUpdate, false)
  })
})
