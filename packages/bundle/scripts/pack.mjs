/**
 * Build one installable tarball. The package is self-contained: `assemble.mjs` puts every part inside it.
 * The tarball manifest drops workspace-only fields so a plain install resolves `koffi` and `zod` from npm.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(bundleRoot, '../..')

const stage = await mkdtemp(join(tmpdir(), 'dsh-orb-pack-'))
const pkgDir = join(stage, 'package')

try {
  // Assemble straight into the staging folder so a linked install keeps its own files.
  const assembled = spawnSync(process.execPath, [join(bundleRoot, 'scripts', 'assemble.mjs'), '--out', pkgDir], { stdio: 'inherit' })
  if (assembled.status !== 0) process.exit(assembled.status ?? 1)
  const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Windows ships `npm` only as an `npm.cmd` shim, and Node >= 18.20.2 refuses to spawn a `.cmd`
  // because of CVE-2024-27980, so the only route there is through the shell. The shell does not
  // quote for us: `repoRoot` comes from this script's own location rather than from input, and `"`
  // cannot occur in a Windows path, so quoting it here is sufficient. Node's DEP0190 warning about
  // `shell` is expected on Windows and harmless for these two static arguments.
  const isWindows = process.platform === 'win32'
  const packArgs = ['pack', '--pack-destination', repoRoot]
  const packed = spawnSync(
    isWindows ? 'npm.cmd' : 'npm',
    isWindows ? packArgs.map((arg) => `"${arg}"`) : packArgs,
    { cwd: pkgDir, stdio: 'inherit', ...(isWindows ? { shell: true } : {}) },
  )
  if (packed.error) {
    console.error(`pack: ${packed.error.message}`)
    process.exit(1)
  }
  if (packed.status !== 0) process.exit(packed.status ?? 1)
} finally {
  await rm(stage, { recursive: true, force: true })
}
