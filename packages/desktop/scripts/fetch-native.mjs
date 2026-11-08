/**
 * Download the pinned agent-desktop FFI libraries into `native/<platform>/`.
 *
 * The libraries are not committed: they are fetched once per release, verified
 * against the checksums from the same GitHub release, and packed into the
 * published bundle. `sha256` values below are copied from the release's
 * `checksums.txt` and must never be edited without bumping {@link VERSION}.
 *
 * Usage: node scripts/fetch-native.mjs [--force]
 * Env: AGENT_DESKTOP_RELEASE_MIRROR — a prefix proxy, e.g. https://gh-proxy.com/
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.2.0'
const REPO = 'vercel-labs/agent-desktop'

/** One archive per platform, with the release checksum and the files to keep. */
const TARGETS = {
  'darwin-arm64': {
    asset: `agent-desktop-ffi-v${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: '0bc54be43e1345cc13140a81e52645078599095c08c5c871a5893ad931088a40',
    files: ['libagent_desktop_ffi.dylib', 'agent-desktop-macos-helper'],
  },
  'darwin-x64': {
    asset: `agent-desktop-ffi-v${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: '11454c33665303f3e49a6ed96c1b172f1f0b6fe14d202e27e3ebb17bdea6b246',
    files: ['libagent_desktop_ffi.dylib', 'agent-desktop-macos-helper'],
  },
  'win32-x64': {
    asset: `agent-desktop-ffi-v${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '102078d8a0a567562cec9446f6bf48b81760517d4c58e5a9284f3aceff7afcdb',
    files: ['agent_desktop_ffi.dll'],
  },
  'win32-arm64': {
    asset: `agent-desktop-ffi-v${VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: '3fbe15bc05f671ab2bc483d37152e1a1ecd93f9b0e537465b1ee7201aee9b491',
    files: ['agent_desktop_ffi.dll'],
  },
}

/** The unmodified upstream CLI, used by the raw test preset. Same release, same checksums. */
const CLI_TARGETS = {
  'darwin-arm64': {
    asset: `agent-desktop-v${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: '219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82',
    files: ['agent-desktop', 'agent-desktop-macos-helper'],
  },
  'darwin-x64': {
    asset: `agent-desktop-v${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: 'd9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6',
    files: ['agent-desktop', 'agent-desktop-macos-helper'],
  },
  'win32-x64': {
    asset: `agent-desktop-v${VERSION}-x86_64-pc-windows-msvc.tar.gz`,
    sha256: 'a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8',
    files: ['agent-desktop.exe'],
  },
  'win32-arm64': {
    asset: `agent-desktop-v${VERSION}-aarch64-pc-windows-msvc.tar.gz`,
    sha256: 'd6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6',
    files: ['agent-desktop.exe'],
  },
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const nativeRoot = join(packageRoot, 'native')
const cacheRoot = join(nativeRoot, '.cache')
const force = process.argv.includes('--force')
const mirror = process.env.AGENT_DESKTOP_RELEASE_MIRROR ?? 'https://gh-proxy.com/'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Download with one retry through the mirror, because GitHub is unreachable for part of the audience. */
async function download(url, destination) {
  const sources = [url, `${mirror}${url}`]
  let lastError
  for (const source of sources) {
    try {
      const response = await fetch(source, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`could not download ${basename(url)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function extract(archive, directory) {
  if (archive.endsWith('.zip')) {
    execFileSync('unzip', ['-q', archive, '-d', directory], { stdio: 'pipe' })
    return
  }
  execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'pipe' })
}

/** Find one file anywhere under a directory. */
function findFile(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found !== undefined) return found
    } else if (entry.name === name) {
      return path
    }
  }
  return undefined
}

async function main() {
  mkdirSync(cacheRoot, { recursive: true })
  let failed = 0
  for (const [key, target] of Object.entries(TARGETS)) {
    const targetDir = join(nativeRoot, key)
    const marker = join(targetDir, '.source')
    if (!force && existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${VERSION} ${target.sha256}`) {
      console.log(`${key}: up to date`)
      continue
    }
    const archive = join(cacheRoot, target.asset)
    const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${target.asset}`
    console.log(`${key}: downloading ${target.asset}`)
    try {
      await download(url, archive)
      const digest = sha256(archive)
      if (digest !== target.sha256) {
        throw new Error(`checksum mismatch: ${digest} != ${target.sha256}`)
      }
      const staging = mkdtempSync(join(tmpdir(), 'dsh-orb-desktop-'))
      try {
        extract(archive, staging)
        rmSync(targetDir, { recursive: true, force: true })
        mkdirSync(targetDir, { recursive: true })
        for (const file of target.files) {
          const found = findFile(staging, file)
          if (found === undefined) throw new Error(`${file} is missing from the archive`)
          copyFileSync(found, join(targetDir, file))
          if (file !== 'agent_desktop_ffi.dll') {
            execFileSync('chmod', ['755', join(targetDir, file)])
          }
        }
        writeFileSync(marker, `${VERSION} ${target.sha256}\n`)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
      console.log(`${key}: ready`)
    } catch (error) {
      failed += 1
      console.error(`${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const [key, target] of Object.entries(CLI_TARGETS)) {
    const targetDir = join(nativeRoot, key, 'cli')
    const marker = join(targetDir, '.source')
    if (!force && existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${VERSION} ${target.sha256}`) {
      console.log(`${key} cli: up to date`)
      continue
    }
    const archive = join(cacheRoot, target.asset)
    const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${target.asset}`
    console.log(`${key} cli: downloading ${target.asset}`)
    try {
      await download(url, archive)
      const digest = sha256(archive)
      if (digest !== target.sha256) throw new Error(`checksum mismatch: ${digest} != ${target.sha256}`)
      const staging = mkdtempSync(join(tmpdir(), 'dsh-orb-desktop-cli-'))
      try {
        extract(archive, staging)
        rmSync(targetDir, { recursive: true, force: true })
        mkdirSync(targetDir, { recursive: true })
        for (const file of target.files) {
          const found = findFile(staging, file)
          if (found === undefined) throw new Error(`${file} is missing from the archive`)
          copyFileSync(found, join(targetDir, file))
          if (!file.endsWith('.exe')) execFileSync('chmod', ['755', join(targetDir, file)])
        }
        writeFileSync(marker, `${VERSION} ${target.sha256}\n`)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
      console.log(`${key} cli: ready`)
    } catch (error) {
      failed += 1
      console.error(`${key} cli: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failed > 0) {
    console.error(
      `\n${failed} platform(s) failed. Retry with AGENT_DESKTOP_RELEASE_MIRROR=<mirror> or download the archives `
      + `from https://github.com/${REPO}/releases/tag/v${VERSION} and unpack them into native/<platform>/.`,
    )
    process.exitCode = 1
  }
}

await main()