import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TTS_EN_REVISION, TTS_VOCODER_REPO, TTS_VOCODER_REVISION, TTS_ZH_REPO, TTS_ZH_REVISION, WAKE_MODEL_NPM_MIRROR, WAKE_MODEL_NPM_OFFICIAL, WAKE_MODEL_SHA256, WAKE_MODEL_URL } from '@dsh-orb/voice/manifest'
import { hubResolveUrl, VoiceDownloads, wakeModelSources } from '../src/voice-download.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-voice-download-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function kwsFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const name of ['tokens.txt', 'en.phone']) writeFileSync(join(dir, name), 'x')
  for (const chunk of [8, 16]) {
    const tag = `chunk-${chunk}`
    writeFileSync(join(dir, `encoder-epoch-13-avg-2-${tag}-left-64.int8.onnx`), 'x')
    writeFileSync(join(dir, `decoder-epoch-13-avg-2-${tag}-left-64.onnx`), 'x')
    writeFileSync(join(dir, `joiner-epoch-13-avg-2-${tag}-left-64.int8.onnx`), 'x')
  }
}

describe('voice model download', () => {
  it('reaches the npm mirror first, then npm, and keeps the GitHub release last', () => {
    const sources = wakeModelSources()
    assert.deepEqual(sources.map((source) => source.format), ['tgz', 'tgz', 'tbz2'])
    assert.equal(sources[0].url, WAKE_MODEL_NPM_MIRROR)
    assert.equal(sources[1].url, WAKE_MODEL_NPM_OFFICIAL)
    assert.equal(sources[2].url, WAKE_MODEL_URL)
    // Both registry URLs serve the same bytes, so one digest checks either of them.
    assert.ok(sources.slice(0, 2).every((source) => source.sha256 === WAKE_MODEL_SHA256))
    assert.equal(sources[2].sha256, undefined)
  })

  it('resolves every TTS file at a pinned commit instead of main', () => {
    const zh = hubResolveUrl('https://hf-mirror.com', TTS_ZH_REPO, TTS_ZH_REVISION, 'model-steps-3.onnx')
    assert.equal(zh, `https://hf-mirror.com/${TTS_ZH_REPO}/resolve/${TTS_ZH_REVISION}/model-steps-3.onnx`)
    assert.ok(!zh.includes('/resolve/main/'))
    const vocoder = hubResolveUrl(
      'https://huggingface.co',
      TTS_VOCODER_REPO,
      TTS_VOCODER_REVISION,
      'vocoder-models/vocos-22khz-univ.onnx',
    )
    assert.equal(
      vocoder,
      `https://huggingface.co/${TTS_VOCODER_REPO}/resolve/${TTS_VOCODER_REVISION}/vocoder-models/vocos-22khz-univ.onnx`,
    )
    for (const revision of [TTS_ZH_REVISION, TTS_EN_REVISION, TTS_VOCODER_REVISION]) {
      assert.match(revision, /^[0-9a-f]{40}$/)
    }
  })

  it('tells the settings dialog the wake model comes from the registry', () => {
    const downloads = new VoiceDownloads(() => ({ kws: join(root, 'none-kws'), asr: join(root, 'none-asr'), tts: join(root, 'none-tts') }))
    assert.deepEqual(downloads.view().wake.sources, [WAKE_MODEL_NPM_MIRROR, WAKE_MODEL_NPM_OFFICIAL])
  })

  it('advertises the Hub mirror for the TTS models', () => {
    const downloads = new VoiceDownloads(() => ({ kws: join(root, 'a'), asr: join(root, 'b'), tts: join(root, 'c') }))
    const sources = downloads.view().tts.sources
    assert.ok(sources.length > 0)
    assert.ok(sources.every((url) => url.startsWith('https://hf-mirror.com/')))
  })

  it('does not start a second transfer, and reports the model once the files land', async () => {
    const dir = join(root, 'kws')
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downloads = new VoiceDownloads(() => ({ kws: dir, asr: join(root, 'asr'), tts: join(root, 'tts') }), async (kind) => {
      assert.equal(kind, 'wake')
      calls += 1
      await gate
      kwsFiles(dir)
    })
    assert.equal(await downloads.begin('wake'), 'started')
    assert.equal(downloads.view().wake.downloading, true)
    assert.equal(await downloads.begin('wake'), 'busy')
    assert.equal(calls, 1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(downloads.view().wake.present, true)
    assert.equal(downloads.view().wake.downloading, false)
    assert.equal(await downloads.begin('wake'), 'present')
  })

  it('explains that ASR is not downloaded by the plugin when the files are missing', async () => {
    const downloads = new VoiceDownloads(() => ({ kws: join(root, 'no-kws'), asr: join(root, 'no-asr'), tts: join(root, 'no-tts') }))
    assert.equal(downloads.view().asr.official, false)
    assert.equal(await downloads.begin('asr'), 'started')
    assert.match(downloads.view().asr.error, /不会自己另下一份/)
    assert.equal(downloads.view().asr.downloading, false)
  })

  it('follows the official SenseVoice preparation instead of downloading a second copy', async () => {
    const asr = join(root, 'official-asr')
    let phase = 'unprepared'
    let completed = 0
    let prepares = 0
    const speech = {
      sources: () => ['https://hf-mirror.com'],
      prepare() {
        prepares += 1
        phase = 'downloading'
      },
      state() {
        if (phase === 'downloading') completed = 20
        return { phase, completedBytes: completed, totalBytes: 40 }
      },
    }
    let ready = 0
    const downloads = new VoiceDownloads(
      () => ({ kws: join(root, 'no-kws-2'), asr, tts: join(root, 'no-tts-2') }),
      undefined,
      () => { ready += 1 },
      () => speech,
    )
    assert.equal(downloads.view().asr.official, true)
    assert.deepEqual(downloads.view().asr.sources, ['https://hf-mirror.com'])
    assert.equal(await downloads.begin('asr'), 'started')
    assert.equal(prepares, 1)
    assert.equal(await downloads.begin('asr'), 'busy')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(downloads.view().asr.progress, 0.5)
    phase = 'failed'
    speech.state = () => ({ phase, message: 'download unavailable', completedBytes: 20, totalBytes: 40 })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(downloads.view().asr.downloading, false)
    assert.equal(downloads.view().asr.error, 'download unavailable')
    assert.equal(ready, 0)
    assert.equal(prepares, 1)
  })
})
