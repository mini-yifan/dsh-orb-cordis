/**
 * Official wake and TTS packages, and the official ASR download the dialog describes.
 * The dialog names these sources and sizes. A later update check compares hashes
 * against this list; it does not go looking for a newer filename.
 */

export type VoiceModelKind = 'wake' | 'tts' | 'asr'

export interface VoiceModelView {
  present: boolean
  downloading: boolean
  /** Bytes received divided by the offer size, from 0 to 1. */
  progress: number
  sources: readonly string[]
  bytes: number
  error: string
  /** Set on the download response when the files are already current. */
  notice?: 'present'
  /**
   * ASR only. False when this DeepSeek Harness has no official SenseVoice
   * provider, so the page explains that instead of starting a download.
   */
  official?: boolean
}

export interface VoiceModels {
  wake: VoiceModelView
  tts: VoiceModelView
  asr: VoiceModelView
}

export const WAKE_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2'

/**
 * The wake files also ship as their own npm package (`models/kws` at the repository root),
 * so a download is an 8.6 MB registry fetch instead of a 31 MB GitHub release.
 *
 * The version and the digest are pinned: the registry is immutable, so one tarball stays
 * valid forever, and the same bytes answer from the mirror and from npmjs.
 */
export const WAKE_MODEL_PACKAGE = 'dsh-orb-kws'
export const WAKE_MODEL_PACKAGE_VERSION = '2026.10.0'
export const WAKE_MODEL_SHA256 = '23d4055c0c20b9d440ab47aa05965780aba01e6852a2182987cca479ea91e9d3'

/** hf-mirror's counterpart for npm: the only registry origin that is fast from mainland China. */
export const WAKE_MODEL_NPM_MIRROR = `https://registry.npmmirror.com/${WAKE_MODEL_PACKAGE}/-/${WAKE_MODEL_PACKAGE}-${WAKE_MODEL_PACKAGE_VERSION}.tgz`
export const WAKE_MODEL_NPM_OFFICIAL = `https://registry.npmjs.org/${WAKE_MODEL_PACKAGE}/-/${WAKE_MODEL_PACKAGE}-${WAKE_MODEL_PACKAGE_VERSION}.tgz`

/** What the mirror serves, and what the progress bar divides by: 8.6 MB. */
export const WAKE_MODEL_BYTES = 9_024_132

/**
 * The Matcha engines and their vocoder are fetched file by file from the
 * Hugging Face Hub. Repository trees are immutable, so one pinned digest per
 * model stays valid, and the domestic mirror serves the same bytes as
 * huggingface.co. `hf-mirror` goes first because GitHub is unreachable from
 * mainland China while that mirror runs at several MB/s there.
 */
export const TTS_ZH_REPO = 'csukuangfj/matcha-icefall-zh-baker'
export const TTS_EN_REPO = 'csukuangfj/matcha-icefall-en_US-ljspeech'
export const TTS_VOCODER_REPO = 'k2-fsa/sherpa-onnx-models'

export const TTS_ORIGINS = ['https://hf-mirror.com', 'https://huggingface.co'] as const

/**
 * Every legitimate digest of the acoustic model. Upstream re-exported both
 * Matcha packages on 2026-10-24 without renaming them, so the previous build
 * and the current one both exist in the wild: the old one inside an already
 * installed folder, the new one on the Hub. Accepting either keeps an existing
 * install valid and lets a fresh download pass.
 *
 * The Chinese package was re-exported once more on 2026-10-29 04:01 UTC: same
 * name, same 75,624,188 bytes, different bytes. A release that only carries the
 * older digests fails every fresh download with "校验失败" and deletes the
 * staging tree, so this build has to accept the third one as well.
 */
export const TTS_ZH_MODEL_SHA256 = [
  '47e82b11454edeeb65adc4e44a24fd54c6715cd4d875cc2a20f75545ecc32d4d',
  'ff1cc7f7abdedc4eeec668a4a0dc2e72a0c314c5637d5fce885345b490bd08de',
  '78a9fd17e9a6c20198dca4e69d18f941303f8ab39ec61dde04cfc7595262ddfd',
] as const
export const TTS_EN_MODEL_SHA256 = [
  'f8e8bae6f731310a1cda0012871ed5e91b0d19f1e2ceff077f62922bba95e3c1',
  '4d7771c0ec063ca74f2fa92ba0ecfe14f73fa3f61c236d9469b92e102d8e9574',
] as const
export const TTS_VOCODER_SHA256 = [
  '0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081',
] as const

/** On-disk size the download dialog shows: about 197 MB. */
export const TTS_MODEL_BYTES = 206_100_276

/** Official SenseVoice int8 trio: model + tokens + silero. The dialog says about 230 MB. */
export const ASR_MODEL_BYTES = 239_233_841 + 315_894 + 1_807_522

export const ASR_SOURCES = ['https://huggingface.co', 'https://hf-mirror.com'] as const

/** What the settings page shows before any model file is on disk. */
export function absentVoiceModels(): VoiceModels {
  return {
    // The dialog names what the button actually reaches for. GitHub stays the last resort
    // but is not offered to the user as a source.
    wake: view([WAKE_MODEL_NPM_MIRROR, WAKE_MODEL_NPM_OFFICIAL], WAKE_MODEL_BYTES),
    tts: view([
      `${TTS_ORIGINS[0]}/${TTS_ZH_REPO}`,
      `${TTS_ORIGINS[0]}/${TTS_EN_REPO}`,
      `${TTS_ORIGINS[0]}/${TTS_VOCODER_REPO}`,
    ], TTS_MODEL_BYTES),
    asr: view(ASR_SOURCES, ASR_MODEL_BYTES),
  }
}

function view(sources: readonly string[], bytes: number): VoiceModelView {
  return { present: false, downloading: false, progress: 0, sources, bytes, error: '' }
}
