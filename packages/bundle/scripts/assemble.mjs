/**
 * Assemble the single installable `dsh-orb` package from the workspace builds.
 *
 * The official loader resolves every plugin name from the profile root, so sub-packages nested inside
 * `dsh-orb/node_modules` are invisible to it. Everything ships inside this one package and is reached
 * through subpath exports: `dsh-orb`, `dsh-orb/host`, `dsh-orb/computer-use`, `dsh-orb/computer-use/code-agent`.
 *
 * Output (all generated, none committed; swapped in atomically so a linked install never sees a partial build):
 *   lib/index.js, lib/index.d.ts   settings page, host half   (from client-settings)
 *   client.js                      settings page, browser half (from client-settings)
 *   dist/host/                     @dsh-orb/host
 *   dist/computer-use/             @dsh-orb/computer-use, including the ScreenCaptureKit helper
 *   dist/helper/                   Electron entry, preload scripts, assets
 *   dist/native-selection/         selection monitor sources and prebuilt library
 */

import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packages = resolve(bundleRoot, '..')

const OLD_CLIENT_ID = "id: '@dsh-orb/client-ui-settings-orb'"
const NEW_CLIENT_ID = "id: 'dsh-orb'"
const SELECTION_SPECIFIER = '"@dsh-orb/native-selection"'
const SELECTION_RELATIVE = '"../native-selection/src/index.js"'

/** Copy a workspace folder or file. A missing source is a build-order mistake, so fail loudly. */
async function copyFrom(pkg, source, target) {
  const from = join(packages, pkg, source)
  if (!existsSync(from)) throw new Error(`assemble: ${from} is missing. Run \`pnpm build\` first.`)
  await mkdir(join(target, '..'), { recursive: true })
  await cp(from, target, { recursive: true })
}

/** Replace exactly `expected` occurrences of `from`. Anything else means the build output changed shape. */
async function rewrite(file, from, to, expected) {
  const text = await readFile(file, 'utf8')
  const count = text.split(from).length - 1
  if (count !== expected) {
    throw new Error(`assemble: expected ${expected} of ${from} in ${file}, found ${count}`)
  }
  await writeFile(file, text.split(from).join(to))
}

// `--out <dir>` assembles somewhere else (tests, packing) and leaves the linked install untouched.
const outIndex = process.argv.indexOf('--out')
const outRoot = outIndex === -1 ? bundleRoot : resolve(process.argv[outIndex + 1] ?? '')
const inPlace = outRoot === bundleRoot

// Build in a staging folder, then swap. A live `link:` install never sees a half-built package.
await mkdir(outRoot, { recursive: true })
const stage = await mkdtemp(join(outRoot, '.assemble-'))
const lib = join(stage, 'lib')
const dist = join(stage, 'dist')
const clientFile = join(stage, 'client.js')

// Settings page.
await copyFrom('client-settings', 'lib', lib)
await copyFrom('client-settings', 'client.js', clientFile)
await rewrite(clientFile, OLD_CLIENT_ID, NEW_CLIENT_ID, 1)

// Host and Computer Use are flat copies of their lib folders.
await copyFrom('host', 'lib', join(dist, 'host'))
await copyFrom('computer-use', 'lib', join(dist, 'computer-use'))
await chmod(join(dist, 'computer-use', 'macos-sck-capture'), 0o755)

// The host reaches the helper at ../helper/lib/main.js and the selection monitor at ../native-selection/src.
await copyFrom('helper', 'lib', join(dist, 'helper', 'lib'))
await copyFrom('helper', 'preload.cjs', join(dist, 'helper', 'preload.cjs'))
await copyFrom('helper', 'selection-preload.cjs', join(dist, 'helper', 'selection-preload.cjs'))
await copyFrom('helper', 'assets', join(dist, 'helper', 'assets'))

await copyFrom('native-selection', 'src', join(dist, 'native-selection', 'src'))
await copyFrom('native-selection', 'prebuilds/darwin-universal', join(dist, 'native-selection', 'prebuilds', 'darwin-universal'))

// The host forks this beside itself: dist/host/index.js -> ../voice/child.js.
// The whole lib folder travels: the child and the TTS worker share a hashed
// speak-text chunk, and a missing chunk only fails when the child is forked.
await copyFrom('voice', 'lib', join(dist, 'voice'))

// The child spawns the capture helper from ./prebuilds next to itself. Without
// the helper it falls back to node-cpal, which reports aec:false and makes the
// host stop listening while our own TTS is playing, so interjection goes dead.
await copyFrom('voice', 'prebuilds', join(dist, 'voice', 'prebuilds'))
for (const binary of [
  'darwin-universal/dsh-orb-voice-capture',
  'darwin-universal/dsh-orb-system-audio',
  'win32-x64/dsh-orb-voice-capture.exe',
]) {
  const file = join(dist, 'voice', 'prebuilds', binary)
  if (existsSync(file)) await chmod(file, 0o755)
}

await rewrite(join(dist, 'host', 'index.js'), SELECTION_SPECIFIER, SELECTION_RELATIVE, 1)

if (!inPlace) {
  await cp(join(bundleRoot, 'package.json'), join(stage, 'package.json'))
  await cp(join(bundleRoot, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'))
}

const retired = await mkdtemp(join(outRoot, '.retired-'))
for (const entry of ['lib', 'dist', 'client.js']) {
  const target = join(outRoot, entry)
  if (existsSync(target)) await rename(target, join(retired, entry))
  await rename(join(stage, entry), target)
}
if (!inPlace) {
  for (const entry of ['package.json', 'cordis.patch.yml']) await rename(join(stage, entry), join(outRoot, entry))
}
await rm(stage, { recursive: true, force: true })
await rm(retired, { recursive: true, force: true })

console.log(`assemble: dsh-orb is ready in ${outRoot}`)
