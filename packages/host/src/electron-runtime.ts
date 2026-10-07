/**
 * Locate the generic Electron binary used to open the ball.
 * Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = '44.0.0'

const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`

/** Official SHASUMS256.txt for Electron 44.0.0. The download is rejected when it disagrees. */
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  'electron-v44.0.0-darwin-arm64.zip': '076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80',
  'electron-v44.0.0-darwin-x64.zip': '28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff',
  'electron-v44.0.0-linux-arm64.zip': '74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb',
  'electron-v44.0.0-linux-x64.zip': 'd65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446',
  'electron-v44.0.0-win32-arm64.zip': '984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368',
  'electron-v44.0.0-win32-x64.zip': 'e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9',
}

/** What {@link resolveElectronBinary} is busy with, for the settings page's progress line. */
export type ElectronRuntimePhase = 'downloading' | 'extracting'

/**
 * Resolve the helper executable.
 * `DSH_ORB_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
 * @param report - optional phase callback; fires only when a download is actually needed.
 * @returns absolute path to the Electron executable.
 */
export async function resolveElectronBinary(
  report?: (phase: ElectronRuntimePhase) => void,
): Promise<string> {
  const override = process.env.DSH_ORB_ELECTRON_PATH?.trim()
  if (override) {
    await access(override)
    return override
  }
  const dest = dshHomePath('dsh-orb', 'electron-runtime')
  const binary = join(dest, binaryRelative())
  const marker = join(dest, `.complete-${ELECTRON_VERSION}`)
  if (await exists(binary) && await exists(marker)) return binary
  await downloadRuntime(dest, binary, marker, report)
  return binary
}

async function downloadRuntime(
  dest: string,
  binary: string,
  marker: string,
  report?: (phase: ElectronRuntimePhase) => void,
): Promise<void> {
  const parent = dirname(dest)
  await mkdir(parent, { recursive: true })
  await withDownloadLock(parent, async () => {
    if (await exists(binary) && await exists(marker)) return
    const fileName = assetName()
    console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`)
    const sums = await fetchText('SHASUMS256.txt')
    const expected = expectedHash(sums, fileName)
    const stamp = randomBytes(8).toString('hex')
    const zipPath = join(parent, `.electron-${stamp}.zip`)
    const staging = join(parent, `.electron-staging-${stamp}`)
    try {
      report?.('downloading')
      await downloadVerifiedZip(fileName, expected, zipPath)
      report?.('extracting')
      await mkdir(staging, { recursive: true })
      await extractZip(zipPath, staging)
      const stagedBinary = join(staging, binaryRelative())
      if (process.platform === 'darwin') {
        await spawnChecked('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)
      }
      await chmod(stagedBinary, 0o755)
      await access(stagedBinary)
      await writeFile(join(staging, `.complete-${ELECTRON_VERSION}`), `${ELECTRON_VERSION}\n`)
      await replaceDirectory(staging, dest)
    } finally {
      await rm(zipPath, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
    console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`)
  })
}

/** `mkdir` is the lock. A dead owner, or a lock older than 20 minutes, can be taken over. */
async function withDownloadLock(parent: string, task: () => Promise<void>): Promise<void> {
  const lock = join(parent, 'electron-runtime.download.lock')
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    try {
      await mkdir(lock)
      await writeFile(join(lock, 'owner'), `${process.pid}\n${Date.now()}\n`)
      break
    } catch (error) {
      if (!isEexist(error)) throw error
      if (await lockExpired(lock)) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('dsh-orb: Electron download is locked by another process')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  try {
    await task()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function lockExpired(lock: string): Promise<boolean> {
  try {
    const text = await readFile(join(lock, 'owner'), 'utf8')
    const [pidText, startedText] = text.split('\n')
    const pid = Number(pidText)
    const started = Number(startedText)
    if (!Number.isInteger(pid) || pid <= 0) return true
    if (Number.isFinite(started) && Date.now() - started > 20 * 60 * 1000) return true
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

async function replaceDirectory(staging: string, dest: string): Promise<void> {
  const retired = `${dest}.retired-${randomBytes(4).toString('hex')}`
  let moved = false
  if (await exists(dest)) {
    await rename(dest, retired)
    moved = true
  }
  try {
    await rename(staging, dest)
  } catch (error) {
    if (moved) await rename(retired, dest).catch(() => undefined)
    throw error
  }
  if (moved) await rm(retired, { recursive: true, force: true }).catch(() => undefined)
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
}

function assetName(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`dsh-orb: unsupported platform ${platform}`)
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`dsh-orb: unsupported architecture ${arch}`)
  }
  return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
}

function binaryRelative(): string {
  if (process.platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  if (process.platform === 'win32') return 'electron.exe'
  return 'electron'
}

/** The hash written in source. `sums` must list the same value or the download stops. */
export function expectedHash(sums: string, fileName: string): string {
  const pinned = PINNED_SHA256[fileName]
  if (pinned === undefined) {
    throw new Error(`dsh-orb: ${fileName} has no pinned Electron ${ELECTRON_VERSION} checksum`)
  }
  const listed = hashFromSums(sums, fileName)
  if (listed !== pinned) {
    throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum list does not match the pinned hash for ${fileName}`)
  }
  return pinned
}

function hashFromSums(sums: string, fileName: string): string {
  for (const line of sums.split('\n')) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (match?.[2] === fileName) return match[1].toLowerCase()
  }
  throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`)
}

const CURL_HTTPS = ['--proto', '=https', '--proto-redir', '=https']

/** The Windows schannel backend aborts when a revocation check cannot complete
 * (common behind proxies); every download is checksum-verified anyway. Other
 * TLS backends ignore the flag. */
const CURL_TLS = process.platform === 'win32' ? ['--ssl-no-revoke'] : []

/** How long a dead host may burn before curl gives up and the next source is asked. */
const CONNECT_TIMEOUT_SECONDS = '5'

/**
 * Mirrors of an Electron release, in the order they are asked.
 * npmmirror goes first: github.com is unreachable for a large part of the audience,
 * and a silently dropped connection there would otherwise stall the first ball launch.
 * Every download is checked against the compiled-in SHA-256, so the order costs no trust.
 */
function releaseUrls(path: string): string[] {
  return [
    `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${path}`,
    `${RELEASE_BASE}/${path}`,
  ]
}

/** First source that answers wins; a dead host costs one connect timeout, not the whole transfer. */
async function fetchText(path: string): Promise<string> {
  let lastError: unknown
  for (const url of releaseUrls(path)) {
    try {
      const { stdout } = await run('curl', [
        '-fsSL', ...CURL_HTTPS, ...CURL_TLS,
        '--connect-timeout', CONNECT_TIMEOUT_SECONDS,
        '--max-time', '60', url,
      ])
      return stdout
    } catch (error) {
      lastError = error
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`dsh-orb: failed to download ${path}`)
}

async function downloadVerifiedZip(fileName: string, expected: string, dest: string): Promise<void> {
  // Official checksums decide what is accepted. The mirror only decides how fast it arrives.
  const urls = releaseUrls(fileName)
  let lastError: unknown
  for (const url of urls) {
    try {
      await rm(dest, { force: true })
      await run('curl', [
        '-fsSL', ...CURL_HTTPS, ...CURL_TLS, '--retry', '2', '--retry-delay', '1',
        '--connect-timeout', CONNECT_TIMEOUT_SECONDS,
        '--speed-limit', '100000', '--speed-time', '20',
        '--max-time', '300', '-o', dest, url,
      ])
      const actual = await sha256(dest)
      if (!sameHash(actual, expected)) {
        throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`)
      }
      return
    } catch (error) {
      lastError = error
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`dsh-orb: failed to download Electron ${ELECTRON_VERSION}`)
}

function run(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf8') })
        return
      }
      const detail = Buffer.concat(err).toString('utf8').trim()
      reject(new Error(`dsh-orb: ${command} exited ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function sameHash(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`
    await spawnChecked('powershell.exe', ['-NoProfile', '-Command', command])
    return
  }
  const unzip = process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip'
  await spawnChecked(unzip, ['-q', '-o', zipPath, '-d', dest])
}

function spawnChecked(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`dsh-orb: ${command} exited ${code ?? 'unknown'}`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
