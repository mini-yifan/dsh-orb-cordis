/**
 * Download the wake and TTS models the plugin owns, and ask DeepSeek Harness
 * for the official ASR model. A second click while a transfer is running
 * reports the current one instead of starting another.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { finished } from 'node:stream/promises'
import {
  absentVoiceModels,
  ASR_MODEL_BYTES,
  TTS_EN_MODEL_SHA256,
  TTS_EN_REPO,
  TTS_EN_REVISION,
  TTS_MODEL_BYTES,
  TTS_ORIGINS,
  TTS_VOCODER_REVISION,
  TTS_VOCODER_SHA256,
  TTS_ZH_MODEL_SHA256,
  TTS_ZH_REPO,
  TTS_ZH_REVISION,
  WAKE_MODEL_NPM_MIRROR,
  WAKE_MODEL_NPM_OFFICIAL,
  WAKE_MODEL_SHA256,
  WAKE_MODEL_URL,
  type VoiceModelKind,
  type VoiceModels,
} from '@dsh-orb/voice/manifest'
import { TTS_EN_FILES, TTS_VOCODER, TTS_ZH_FILES } from './tts-files.ts'
import { asrPresent, kwsPresent, ttsPresent } from './voice-models.ts'

export interface VoiceModelPaths {
  readonly kws: string
  readonly asr: string
  readonly tts: string
}

interface Job {
  received: number
  total: number
  error: string
}

/** The slice of `ctx.speechToText` this plugin uses. It never calls `transcribe()`. */
export interface OfficialAsr {
  /** Undefined when `sensevoice-local` is not registered. */
  sources(): readonly string[] | undefined
  prepare(): void
  state(): { phase: string, completedBytes?: number, totalBytes?: number, message?: string }
}

const NO_OFFICIAL_ASR = '当前 DeepSeek Harness 没有官方语音识别服务，插件不会自己另下一份'

interface SpeechService {
  prepare?: (id: string) => void
  snapshot?: () => {
    providers?: readonly {
      id?: string
      downloadSources?: readonly string[]
      preparation?: { phase?: string, completedBytes?: number, totalBytes?: number, message?: string }
    }[]
  }
}

/** Reads `ctx.get('speechToText')`. A missing service is not an error; the page explains it. */
export function officialAsrFrom(service: unknown): OfficialAsr | undefined {
  if (!service || typeof service !== 'object') return undefined
  const speech = service as SpeechService
  if (typeof speech.prepare !== 'function' || typeof speech.snapshot !== 'function') return undefined
  const prepare = speech.prepare.bind(speech)
  const snapshot = speech.snapshot.bind(speech)
  return {
    sources() {
      const provider = snapshot().providers?.find((item) => item.id === 'sensevoice-local')
      if (!provider) return undefined
      return (provider.downloadSources ?? []).filter((item) => item !== '')
    },
    prepare() { prepare('sensevoice-local') },
    state() {
      const provider = snapshot().providers?.find((item) => item.id === 'sensevoice-local')
      const phase = provider?.preparation?.phase
      return {
        phase: typeof phase === 'string' ? phase : 'unprepared',
        completedBytes: provider?.preparation?.completedBytes,
        totalBytes: provider?.preparation?.totalBytes,
        message: provider?.preparation?.message,
      }
    },
  }
}

/** How a source ships the archive: the npm package is gzip, the GitHub release is bzip2. */
export type WakeArchiveFormat = 'tgz' | 'tbz2'

export interface WakeModelSource {
  readonly url: string
  readonly format: WakeArchiveFormat
  /**
   * Digest of the archive bytes. The npm package pins one, so a mirror cannot hand over a
   * different payload; the release is the authoritative copy and is checked by extracting it.
   */
  readonly sha256?: string
}

/**
 * Where the wake archive comes from, in order. The npm package is the copy mainland China
 * can actually reach (npmmirror first, then npmjs); the GitHub release stays as the last
 * resort, which is also the only source that still needs the bzip2 path.
 */
export function wakeModelSources(): readonly WakeModelSource[] {
  return [
    { url: WAKE_MODEL_NPM_MIRROR, format: 'tgz', sha256: WAKE_MODEL_SHA256 },
    { url: WAKE_MODEL_NPM_OFFICIAL, format: 'tgz', sha256: WAKE_MODEL_SHA256 },
    { url: WAKE_MODEL_URL, format: 'tbz2' },
  ]
}

export class VoiceDownloads {
  private readonly jobs = new Map<VoiceModelKind, Job>()
  private readonly errors = new Map<VoiceModelKind, string>()

  private readonly install: (kind: VoiceModelKind, paths: VoiceModelPaths, progress: (received: number, total: number) => void) => Promise<void>

  private asrTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly paths: () => VoiceModelPaths,
    install?: (kind: VoiceModelKind, paths: VoiceModelPaths, progress: (received: number, total: number) => void) => Promise<void>,
    private readonly onReady?: () => void,
    private readonly speech?: () => OfficialAsr | undefined,
  ) {
    this.install = install ?? installVoiceModel
  }

  view(): VoiceModels {
    const base = absentVoiceModels()
    const paths = this.paths()
    const listed = this.official()?.sources()
    return {
      wake: this.decorate(base.wake, 'wake', kwsPresent(paths.kws)),
      tts: this.decorate(base.tts, 'tts', ttsPresent(paths.tts)),
      asr: {
        ...this.decorate(base.asr, 'asr', asrPresent(paths.asr)),
        official: listed !== undefined,
        ...(listed && listed.length > 0 ? { sources: listed } : {}),
      },
    }
  }

  async begin(kind: VoiceModelKind): Promise<'started' | 'busy' | 'present'> {
    if (this.jobs.has(kind)) return 'busy'
    if (await this.current(kind)) return 'present'
    // Two clicks can both pass the checks above while `current()` hashes the TTS files.
    // Only the first may start the transfer.
    if (this.jobs.has(kind)) return 'busy'
    if (kind === 'asr') return this.beginAsr()
    this.errors.delete(kind)
    this.jobs.set(kind, { received: 0, total: 1, error: '' })
    void this.install(kind, this.paths(), (received, total) => {
      const job = this.jobs.get(kind)
      if (!job) return
      job.received = received
      job.total = Math.max(total, 1)
    }).then(() => {
      this.jobs.delete(kind)
      this.errors.delete(kind)
      this.onReady?.()
    }).catch((error: unknown) => {
      this.jobs.delete(kind)
      this.errors.set(kind, error instanceof Error ? error.message : String(error))
    })
    return 'started'
  }

  private beginAsr(): 'started' | 'busy' | 'present' {
    const speech = this.official()
    if (!speech || speech.sources() === undefined) {
      this.errors.set('asr', NO_OFFICIAL_ASR)
      return 'started'
    }
    this.errors.delete('asr')
    this.jobs.set('asr', { received: 0, total: ASR_MODEL_BYTES, error: '' })
    try {
      speech.prepare()
    } catch (error) {
      this.jobs.delete('asr')
      this.errors.set('asr', error instanceof Error ? error.message : String(error))
      return 'started'
    }
    this.watchAsr()
    return 'started'
  }

  private official(): OfficialAsr | undefined {
    try {
      return this.speech?.()
    } catch {
      return undefined
    }
  }

  private watchAsr(): void {
    if (this.asrTimer) clearInterval(this.asrTimer)
    this.pollAsr()
    this.asrTimer = setInterval(() => { this.pollAsr() }, 200)
  }

  private stopAsr(): void {
    if (!this.asrTimer) return
    clearInterval(this.asrTimer)
    this.asrTimer = undefined
  }

  private pollAsr(): void {
    if (!this.jobs.has('asr')) {
      this.stopAsr()
      return
    }
    const state = this.official()?.state()
    if (!state) return
    const job = this.jobs.get('asr')
    if (!job) return
    if (state.phase === 'downloading') {
      const total = state.totalBytes && state.totalBytes > 0 ? state.totalBytes : job.total
      job.received = state.completedBytes ?? 0
      job.total = total
      return
    }
    if (state.phase !== 'ready' && state.phase !== 'standby' && state.phase !== 'failed' && state.phase !== 'cancelled') return
    this.stopAsr()
    this.jobs.delete('asr')
    if (state.phase === 'failed' || state.phase === 'cancelled') {
      this.errors.set('asr', state.message && state.message !== '' ? state.message : '下载失败')
      return
    }
    if (asrPresent(this.paths().asr)) {
      this.errors.delete('asr')
      this.onReady?.()
      return
    }
    this.errors.set('asr', '官方语音识别模型不完整')
  }

  private decorate(base: VoiceModels['wake'], kind: VoiceModelKind, present: boolean): VoiceModels['wake'] {
    const job = this.jobs.get(kind)
    return {
      ...base,
      present: present && job === undefined,
      downloading: job !== undefined,
      progress: job === undefined || job.total <= 0 ? 0 : Math.min(1, job.received / job.total),
      error: this.errors.get(kind) ?? '',
    }
  }

  private async current(kind: VoiceModelKind): Promise<boolean> {
    const paths = this.paths()
    if (kind === 'wake') return kwsPresent(paths.kws)
    if (kind === 'asr') return asrPresent(paths.asr)
    if (!ttsPresent(paths.tts)) return false
    const zh = await sha256(join(paths.tts, 'matcha-icefall-zh-baker', 'model-steps-3.onnx'))
    const en = await sha256(join(paths.tts, 'matcha-icefall-en_US-ljspeech', 'model-steps-3.onnx'))
    const vocoder = await sha256(join(paths.tts, 'vocos-22khz-univ.onnx'))
    const known = (accepted: readonly string[], digest: string): boolean => (accepted as readonly string[]).includes(digest)
    return known(TTS_ZH_MODEL_SHA256, zh) && known(TTS_EN_MODEL_SHA256, en) && known(TTS_VOCODER_SHA256, vocoder)
  }
}

async function installVoiceModel(
  kind: VoiceModelKind,
  paths: VoiceModelPaths,
  progress: (received: number, total: number) => void,
): Promise<void> {
  if (kind === 'wake') {
    await installArchive(wakeModelSources(), paths.kws, progress)
    if (!kwsPresent(paths.kws)) throw new Error('语音唤醒模型不完整')
    return
  }
  await installTts(paths.tts, progress)
}

/** One repository's files, with the folder they land in and the commit they come from. */
interface TtsPart {
  readonly repo: string
  readonly revision: string
  readonly dir: string
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly local?: string }[]
}

const TTS_PARTS: readonly TtsPart[] = [
  { repo: TTS_ZH_REPO, revision: TTS_ZH_REVISION, dir: 'matcha-icefall-zh-baker', files: TTS_ZH_FILES },
  { repo: TTS_EN_REPO, revision: TTS_EN_REVISION, dir: 'matcha-icefall-en_US-ljspeech', files: TTS_EN_FILES },
  {
    repo: TTS_VOCODER.repo,
    revision: TTS_VOCODER_REVISION,
    dir: '',
    files: [{ path: TTS_VOCODER.path, bytes: TTS_VOCODER.bytes, local: TTS_VOCODER.local }],
  },
]

/** One Hub origin, with a breaker so a dead origin cannot stall hundreds of files. */
interface Origin {
  readonly base: string
  failures: number
  down: boolean
}

/** An HTTP answer worth retrying: the Hub replies 429 while it throttles a burst. */
class HubError extends Error {
  constructor(readonly status: number, url: string, readonly retryAfter?: number) {
    super(`${status} ${url}`)
  }
}

/**
 * File by file from the Hub. `hf-mirror.com` goes first because it is the only
 * origin fast from mainland China; huggingface.co covers everywhere else. A
 * throttled file is retried with backoff and then moved to the other origin,
 * so one 429 cannot sink a 360-file install.
 */
async function installTts(root: string, progress: (received: number, total: number) => void): Promise<void> {
  const staging = `${root}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    const origins = TTS_ORIGINS.map((base): Origin => ({ base, failures: 0, down: false }))
    await downloadTts(origins, staging, progress)
    await verifyTts(staging)
    await rm(root, { recursive: true, force: true })
    await mkdir(dirname(root), { recursive: true })
    await rename(staging, root)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function downloadTts(origins: readonly Origin[], root: string, progress: (received: number, total: number) => void): Promise<void> {
  const jobs = TTS_PARTS.flatMap((part) => part.files.map((file) => ({ part, file })))
  let received = 0
  progress(0, TTS_MODEL_BYTES)
  let failure: unknown
  const queue = [...jobs]
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift()
      if (job === undefined || failure !== undefined) return
      try {
        const local = job.file.local ?? job.file.path
        await downloadHubFile(origins, job.part.repo, job.part.revision, job.file, join(root, job.part.dir, local))
        received += job.file.bytes
        progress(received, TTS_MODEL_BYTES)
      } catch (error) {
        failure = error
        return
      }
    }
  }
  // Two at a time: a burst is what makes the mirror answer 429 on a 360-file set.
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker))
  if (failure !== undefined) throw failure
}

/** One file at a pinned commit. `main` moves; a commit's bytes do not. */
export function hubResolveUrl(base: string, repo: string, revision: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/${repo}/resolve/${revision}/${encoded}`
}

async function downloadHubFile(
  origins: readonly Origin[],
  repo: string,
  revision: string,
  file: { readonly path: string; readonly bytes: number },
  dest: string,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  let last: unknown
  for (const origin of origins) {
    if (origin.down) continue
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await fetchToFile(hubResolveUrl(origin.base, repo, revision, file.path), dest, file.bytes)
        origin.failures = 0
        return
      } catch (error) {
        last = error
        await rm(dest, { force: true })
        origin.failures += 1
        if (origin.failures >= 10) {
          origin.down = true
          break
        }
        if (attempt < 3) await sleep(retryDelay(error, attempt))
        else break
      }
    }
  }
  throw last instanceof Error ? last : new Error(`下载失败: ${file.path}`)
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof HubError && error.retryAfter !== undefined) return Math.min(error.retryAfter * 1000, 30_000)
  if (error instanceof HubError && error.status === 429) return 2_000 * attempt
  return 500 * attempt
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchToFile(url: string, dest: string, expected: number): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (response.status === 429 || response.status === 503) {
    const header = Number(response.headers.get('retry-after') ?? 0)
    throw new HubError(response.status, url, Number.isFinite(header) && header > 0 ? header : undefined)
  }
  if (!response.ok || response.body === null) throw new HubError(response.status, url)
  const file = createWriteStream(dest)
  let bytes = 0
  let broken = false
  try {
    const reader = response.body.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      const buffer = Buffer.from(chunk.value)
      bytes += buffer.length
      if (!file.write(buffer)) await onceDrain(file)
    }
  } catch (error) {
    broken = true
    file.destroy()
    throw error
  } finally {
    if (!broken && !file.destroyed) file.end()
  }
  await finished(file)
  if (bytes !== expected) throw new Error(`size ${bytes} != ${expected}: ${url}`)
}

async function verifyTts(root: string): Promise<void> {
  const checks: readonly (readonly [string, readonly string[]])[] = [
    [join(root, 'matcha-icefall-zh-baker', 'model-steps-3.onnx'), TTS_ZH_MODEL_SHA256],
    [join(root, 'matcha-icefall-en_US-ljspeech', 'model-steps-3.onnx'), TTS_EN_MODEL_SHA256],
    [join(root, 'vocos-22khz-univ.onnx'), TTS_VOCODER_SHA256],
  ]
  for (const [file, accepted] of checks) {
    const digest = await sha256(file).catch(() => '')
    if (!(accepted as readonly string[]).includes(digest)) {
      const expected = accepted.map((hash) => `${hash.slice(0, 8)}…`).join(' / ')
      throw new Error(`${relative(root, file)} 校验失败（实际 ${digest.slice(0, 8) || '无法读取'}，期望 ${expected}）`)
    }
  }
}

async function installArchive(sources: readonly WakeModelSource[], dest: string, progress: (received: number, total: number) => void): Promise<void> {
  const staging = `${dest}.staging`
  const archive = `${dest}.download`
  await rm(staging, { recursive: true, force: true })
  await rm(archive, { force: true })
  await mkdir(staging, { recursive: true })
  try {
    const source = await downloadFirst(sources, archive, progress)
    await extractArchive(archive, staging, source.format)
    const found = await findModelDir(staging)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dirname(dest), { recursive: true })
    await rename(found, dest)
  } finally {
    // A failed unpack must not leave half a model tree behind: the next click starts clean.
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Where the model root ended up. The GitHub release unpacks to `sherpa-onnx-kws-…/`, and the
 * npm tarball to `package/kws/`, so the search has to look two levels down, not one.
 */
async function findModelDir(root: string): Promise<string> {
  const { readdir } = await import('node:fs/promises')
  const level = [root]
  for (let depth = 0; depth <= 2 && level.length > 0; depth += 1) {
    for (const dir of level.splice(0)) {
      if (kwsPresent(dir)) return dir
      for (const name of await readdir(dir).catch(() => [] as string[])) level.push(join(dir, name))
    }
  }
  throw new Error('解压后没有找到唤醒模型')
}

/** No bytes for this long means the origin is gone, not that it is slow. */
const STALL_MS = 20_000
/** Past this mark, a source that is barely moving is worth abandoning for the next one. */
const SLOW_MS = 20_000
const SLOW_BPS = 24 * 1024

/** A 4xx that retrying cannot fix: the next source is the only way forward. */
class SourceGone extends Error {}

/**
 * Try each source in turn, three times each; the first one that lands a complete, digest-clean
 * archive wins. The last source is exempt from the speed floor: at that point a slow copy is
 * better than no copy at all.
 */
async function downloadFirst(
  sources: readonly WakeModelSource[],
  dest: string,
  progress: (received: number, total: number) => void,
): Promise<WakeModelSource> {
  let last = '下载失败'
  for (const [index, source] of sources.entries()) {
    const floor = index < sources.length - 1
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await downloadOne(source.url, dest, progress, floor)
        // A mirror that answers with the wrong bytes is a failed source, not a failed install.
        if (source.sha256 !== undefined) {
          const digest = await sha256(dest).catch(() => '')
          if (digest !== source.sha256) {
            await rm(dest, { force: true })
            throw new Error(`校验失败 ${source.url}`)
          }
        }
        return source
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
        // A version the mirror has not synced yet answers 404 every time; three attempts
        // with backoff would only make the user wait before the same fallback.
        if (error instanceof SourceGone) break
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
    await rm(dest, { force: true })
  }
  throw new Error(last)
}

async function downloadOne(url: string, dest: string, progress: (received: number, total: number) => void, floor: boolean): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  let already = 0
  try {
    already = (await stat(dest)).size
  } catch {
    already = 0
  }
  const headers: Record<string, string> = already > 0 ? { range: `bytes=${already}-` } : {}
  // One controller serves both limits: a dead socket and a source that is barely moving end
  // the same way, with an abort the caller can turn into "try the next origin".
  const controller = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const restart = (): void => {
    if (stall !== undefined) clearTimeout(stall)
    stall = setTimeout(() => { controller.abort(new Error(`stalled: ${url}`)) }, STALL_MS)
  }
  restart()
  try {
    const response = await fetch(url, { redirect: 'follow', headers, signal: controller.signal })
    const body = response.body
    if (response.status === 416 && already > 0) {
      progress(already, already)
      return
    }
    if (!response.ok || body === null) {
      const message = `${response.status} ${url}`
      throw response.status === 404 || response.status === 410 ? new SourceGone(message) : new Error(message)
    }
    const resume = response.status === 206 && already > 0
    const length = Number(response.headers.get('content-length') ?? 0)
    const total = resume ? already + length : length
    const file = createWriteStream(dest, { flags: resume ? 'a' : 'w' })
    const reader = body.getReader()
    let received = resume ? already : 0
    const started = Date.now()
    let moved = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        restart()
        const bytes = Buffer.from(chunk.value)
        if (!file.write(bytes)) await onceDrain(file)
        received += bytes.length
        moved += bytes.length
        progress(received, total > 0 ? total : received)
        if (floor && Date.now() - started > SLOW_MS && moved / ((Date.now() - started) / 1000) < SLOW_BPS) {
          controller.abort(new Error(`too slow: ${url}`))
        }
      }
      if (controller.signal.aborted) throw new Error(`下载超时或太慢 ${url}`)
    } catch (error) {
      file.destroy()
      throw error
    } finally {
      if (!file.destroyed) file.end()
    }
    await finished(file)
  } finally {
    if (stall !== undefined) clearTimeout(stall)
  }
}

function onceDrain(file: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => file.once('drain', () => resolve()))
}

function extractArchive(archive: string, dest: string, format: WakeArchiveFormat): Promise<void> {
  // Relative names and a cwd, never `C:\...` arguments: GNU tar (what Git for Windows
  // installs) reads a drive-letter path as a remote host and dies with "Cannot execute
  // remote shell". The archive and its staging folder are siblings, so both are relative
  // to the folder they already share.
  const cwd = dirname(archive)
  return new Promise((resolve, reject) => {
    // The registry serves gzip, the GitHub release bzip2. Everything else about the unpack
    // is shared: `tar` on Windows is bsdtar, which reads either.
    const child = spawn('tar', [format === 'tgz' ? '-xzf' : '-xjf', basename(archive), '-C', basename(dest)], { cwd })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `tar exited ${code}`))
    })
  })
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}
