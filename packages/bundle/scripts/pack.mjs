/**
 * Build one installable tarball. The package is self-contained: `assemble.mjs` puts every
 * part inside it, and the runtime dependencies (`koffi`, `zod`) ship inside the tarball's
 * own `node_modules`, so an install fetches nothing from any registry. `@deepseek-ai/*`
 * peers stay undeclared-installed: the host resolves them from its own modules.
 *
 * `--version x.y.z` stamps the tarball's version (default: the manifest's own).
 */

import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(bundleRoot, '../..')

const versionIndex = process.argv.indexOf('--version')
const versionOverride = versionIndex === -1 ? undefined : process.argv[versionIndex + 1]

/** Platform prebuilds koffi loads as siblings of its own package. */
const KOFFI_PLATFORMS = ['@koromix/koffi-darwin-arm64', '@koromix/koffi-darwin-x64', '@koromix/koffi-win32-x64']

const stage = await mkdtemp(join(tmpdir(), 'dsh-orb-pack-'))
const pkgDir = join(stage, 'package')

try {
  // Assemble straight into the staging folder so a linked install keeps its own files.
  const assembled = spawnSync(process.execPath, [join(bundleRoot, 'scripts', 'assemble.mjs'), '--out', pkgDir], { stdio: 'inherit' })
  if (assembled.status !== 0) process.exit(assembled.status ?? 1)
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  // Declared dependencies would make pnpm resolve them from a registry and trip its
  // build-script gate (koffi). The copies shipped in `node_modules` below are the
  // dependency; the `@deepseek-ai/*` peers stay declared for the host's compatibility
  // check and resolve from the host's own modules.
  delete manifest.dependencies
  if (versionOverride !== undefined) manifest.version = versionOverride

  // Copy the runtime dependencies out of the workspace store into the package. `cp`
  // dereferences pnpm's symlinks, so real files land in the tarball. koffi's install
  // script (a cmake build) is stripped: the platform prebuilds it would produce are
  // shipped instead, and pnpm then has no script to ask about.
  const bundleRequire = (await import('node:module')).createRequire(join(bundleRoot, 'package.json'))
  /** The package root above an entry file: realpath first, then walk up. */
  const packageRoot = (entry) => {
    let dir = dirname(realpathSync(entry))
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) return dir
      dir = dirname(dir)
    }
    throw new Error(`pack: no package.json above ${entry}`)
  }
  /** A pnpm store directory for `<scope>/<name>@<any version>` under the workspace. */
  const storeDir = (name) => {
    const store = resolve(bundleRoot, '../../node_modules/.pnpm')
    const entry = readdirSync(store).find((candidate) => candidate.startsWith(`${name.replace('/', '+')}@`))
    if (entry === undefined) throw new Error(`pack: ${name} not found under ${store}`)
    return join(store, entry, 'node_modules', ...name.split('/'))
  }
  /** A platform prebuild fetched from npm when the store only holds this machine's. */
  const fetchPlatform = async (platform, version) => {
    const fetchDir = join(stage, 'fetch')
    // npmmirror: the prebuilds are pure tarballs, and the mirror is reachable where
    // registry.npmjs.org stalls. `DSH_ORB_PACK_REGISTRY` re-points it.
    const registry = process.env.DSH_ORB_PACK_REGISTRY?.trim() || 'https://registry.npmmirror.com/'
    // `npm` is `npm.cmd` on Windows: only a shell resolves it (and Node refuses .cmd
    // targets outright). One command string, no spaces in any token, and a relative
    // pack destination so a space in the temp path cannot split the line.
    const packed = spawnSync(`npm pack ${platform}@${version} --registry ${registry} --pack-destination .`, {
      cwd: fetchDir, stdio: 'pipe', encoding: 'utf8', timeout: 120_000, shell: true,
    })
    if (packed.status !== 0 || packed.error !== undefined) throw new Error(`pack: npm pack ${platform}@${version} failed: ${packed.stderr || packed.error}`)
    const tarball = join(fetchDir, packed.stdout.trim().split(/\r?\n/).pop())
    // GNU tar reads a drive-letter `C:\...` archive name as a remote host; a relative
    // name next to the cwd works for it and for the Windows bsdtar alike.
    const extracted = spawnSync('tar', ['-xzf', basename(tarball)], { cwd: fetchDir, stdio: 'pipe' })
    if (extracted.status !== 0) throw new Error(`pack: extracting ${tarball} failed`)
    return join(fetchDir, 'package')
  }
  const bundled = ['koffi', 'zod']
  for (const name of bundled) {
    const from = packageRoot(bundleRequire.resolve(name))
    await cp(from, join(pkgDir, 'node_modules', name), { recursive: true, dereference: true })
  }
  const koffiVersion = JSON.parse(await readFile(join(pkgDir, 'node_modules', 'koffi', 'package.json'), 'utf8')).version
  const fetchDir = join(stage, 'fetch')
  await (await import('node:fs/promises')).mkdir(fetchDir, { recursive: true })
  for (const platform of KOFFI_PLATFORMS) {
    let from
    try {
      from = storeDir(platform)
    } catch {
      from = await fetchPlatform(platform, koffiVersion)
    }
    await cp(from, join(pkgDir, 'node_modules', '@koromix', platform.split('/')[1]), { recursive: true, dereference: true })
  }
  const koffiManifestPath = join(pkgDir, 'node_modules', 'koffi', 'package.json')
  const koffiManifest = JSON.parse(await readFile(koffiManifestPath, 'utf8'))
  delete koffiManifest.scripts
  await writeFile(koffiManifestPath, `${JSON.stringify(koffiManifest, null, 2)}\n`)

  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // npm renders these on the package page; the build tree itself never holds them.
  for (const name of ['README.md', 'LICENSE']) {
    await cp(join(repoRoot, name), join(pkgDir, name))
  }

  // `tar` rather than `npm pack`: the packlist would drop the bundled `node_modules`,
  // and the whole point is a tarball that installs without touching any registry.
  // Everything tar sees stays relative — GNU tar (Git for Windows) reads a
  // drive-letter `C:\...` argument, even for `-C`, as a remote host.
  const tarball = join(repoRoot, `dsh-orb-${manifest.version}.tgz`)
  const staged = join(stage, 'package.tgz')
  // COPYFILE_DISABLE: macOS tar otherwise stores extended attributes as AppleDouble
  // `._*` entries, which the npm registry rejects at publish (415 invalid path).
  const packed = spawnSync('tar', ['-czf', basename(staged), 'package'], {
    cwd: stage, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
  try {
    await rename(staged, tarball)
  } catch (error) {
    // Temp and repo can sit on different volumes; tar must not see either absolute path.
    if (error.code !== 'EXDEV') throw error
    await copyFile(staged, tarball)
    await rm(staged)
  }
  if (packed.status !== 0) process.exit(packed.status ?? 1)
  console.log(`dsh-orb: packed ${tarball}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
