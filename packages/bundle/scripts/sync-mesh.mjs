/**
 * Install the Orb Mesh plugin into this package's vendor directory.
 *
 * The release boundary is the committed `@dsh-mesh/plugin` tarball: the phone
 * and the desktop bundle install the same bytes, so a clean checkout produces a
 * working Orb without a second repository checked out next to this one. That
 * matters because the plugin carries connection-lifecycle fixes that are
 * invisible at the UI layer — a stale copy silently retires a machine's Host
 * control socket after one dropped connection.
 *
 * Two sources are supported, in this order:
 *
 *   DSH_MESH_BUNDLE   an explicit bundle/ directory, for local iteration
 *   DSH_MESH_TARBALL  an explicit tarball
 *   default           ../dsh-mesh/packages/mesh-plugin/dist-phone/*.tgz
 *                     (the committed artifact in the sibling checkout)
 *
 * A tarball uses the same layout the phone runtime extracts: entries live under
 * `package/lib/`. When several tarballs are present the highest version wins,
 * which is what `pack-phone.py` produces per release.
 */
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const target = join(bundleRoot, 'vendor', 'mesh')
const tarballDir = resolve(bundleRoot, '../../../dsh-mesh/packages/mesh-plugin/dist-phone')

function latestTarball() {
  if (!existsSync(tarballDir)) return undefined
  const candidates = execFileSync('ls', ['-1', tarballDir], { encoding: 'utf8' })
    .split('\n')
    .filter(name => name.endsWith('.tgz'))
    // Version-sort so dsh-mesh-plugin-0.1.10.tgz beats 0.1.9.tgz; a plain
    // string sort would pick the wrong artifact on the tenth patch release.
    .sort((a, b) => {
      const va = a.match(/(\d+)\.(\d+)\.(\d+)/)
      const vb = b.match(/(\d+)\.(\d+)\.(\d+)/)
      if (!va || !vb) return a.localeCompare(b)
      for (let i = 1; i <= 3; i += 1) {
        const diff = Number(va[i]) - Number(vb[i])
        if (diff !== 0) return diff
      }
      return 0
    })
  return candidates.length === 0 ? undefined : join(tarballDir, candidates[candidates.length - 1])
}

const explicitBundle = process.env.DSH_MESH_BUNDLE?.trim()
const explicitTarball = process.env.DSH_MESH_TARBALL?.trim()
const tarball = explicitTarball || (explicitBundle === undefined ? latestTarball() : undefined)
const bundle = explicitBundle || undefined

if (bundle === undefined && tarball === undefined) {
  throw new Error(
    `sync-mesh: no Orb Mesh artifact found. Expected a committed tarball in ${tarballDir}, `
    + 'or set DSH_MESH_BUNDLE to a built bundle/ directory.',
  )
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

if (bundle !== undefined) {
  if (!existsSync(join(bundle, 'index.mjs'))) {
    throw new Error(`sync-mesh: ${bundle}/index.mjs is missing. Build @dsh-mesh/plugin first.`)
  }
  let copied = 0
  for (const file of await readdir(bundle)) {
    if (!file.endsWith('.mjs')) continue
    await cp(join(bundle, file), join(target, file))
    copied += 1
  }
  console.log(`sync-mesh: ${bundle} (${copied} files) -> ${target}`)
} else {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-mesh-tgz-'))
  try {
    // tar with the committed mtimes is enough here; the tarball is already the
    // reproducible artifact, this only unpacks it.
    execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'pipe' })
    const lib = join(staging, 'package', 'lib')
    if (!existsSync(join(lib, 'index.mjs'))) {
      throw new Error(`sync-mesh: ${basename(tarball)} does not contain package/lib/index.mjs`)
    }
    let copied = 0
    for (const file of await readdir(lib)) {
      if (!file.endsWith('.mjs')) continue
      await cp(join(lib, file), join(target, file))
      copied += 1
    }
    console.log(`sync-mesh: ${basename(tarball)} (${copied} files) -> ${target}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
