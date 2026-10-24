/**
 * Text echo check. Acoustic echo cancellation is the real filter; this only
 * drops a transcript that is mostly the line we were just speaking.
 */

import { pinyin } from 'pinyin-pro'
import { containsAny, normalizeUtterance } from './dismiss.ts'

export interface SpokenLine {
  readonly text: string
  readonly startedAt: number
  /** Still playing when undefined. */
  readonly endedAt: number | undefined
}

/**
 * 这句转写是不是我们自己播出去的声音。
 * 取和 [from - 500ms, to] 有重叠的播报句，把双方都转成不带声调的拼音音节，
 * 求最长公共子序列。它占转写音节数的比例不低于 0.6，就算回声。
 * 转写不足 2 个音节时，不按回声处理。
 * 转写里带出了插话关键词或任意一条退下口令，而重叠的播报句里没有它，就不是回声。
 */
export function isEcho(
  utterance: string,
  spoken: readonly SpokenLine[],
  window: { readonly from: number, readonly to: number },
  commands: readonly string[],
): boolean {
  const heard = syllables(utterance)
  if (heard.length < 2) return false
  const overlapping = spoken.filter((line) => overlaps(line, window))
  if (overlapping.length === 0) return false
  for (const command of commands) {
    if (!containsAny(utterance, [command])) continue
    if (!overlapping.some((line) => containsAny(line.text, [command]))) return false
  }
  const played = syllables(overlapping.map((line) => line.text).join(''))
  if (played.length === 0) return false
  return longestCommon(heard, played) / heard.length >= 0.6
}

function overlaps(line: SpokenLine, window: { readonly from: number, readonly to: number }): boolean {
  const start = window.from - 500
  if (line.startedAt >= window.to) return false
  if (line.endedAt !== undefined && line.endedAt <= start) return false
  return true
}

function syllables(text: string): string[] {
  const cleaned = normalizeUtterance(text)
  if (!cleaned) return []
  const parts = pinyin(cleaned, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

function longestCommon(left: readonly string[], right: readonly string[]): number {
  const rows = left.length + 1
  const cols = right.length + 1
  const score = new Array<number>(cols).fill(0)
  for (let row = 1; row < rows; row += 1) {
    let previous = 0
    for (let col = 1; col < cols; col += 1) {
      const current = score[col] ?? 0
      if (left[row - 1] === right[col - 1]) score[col] = previous + 1
      else score[col] = Math.max(current, score[col - 1] ?? 0)
      previous = current
    }
  }
  return score[cols - 1] ?? 0
}

/**
 * Remove the part of a mixed transcript that came from the line we were
 * speaking. `isEcho` drops a transcript that is mostly echo; this keeps the
 * user's command when the recognizer returns `command + TTS tail` (or the
 * reverse). It compares tone-less pinyin syllables, so a homophone still
 * matches, and only trims a contiguous common span at the start or end.
 *
 * This is a display guard, not acoustic cancellation: it is the last line of
 * defence when the AEC leaves a little of our own voice in the recognizer.
 */
export function stripEcho(
  utterance: string,
  spoken: readonly SpokenLine[],
  window: { readonly from: number, readonly to: number },
  commands: readonly string[],
): string {
  const overlapping = spoken.filter((line) => overlaps(line, window))
  if (overlapping.length === 0) return utterance
  const played = tokenize(overlapping.map((line) => line.text).join(''))
  if (played.length < 4) return utterance
  let current = utterance
  for (let pass = 0; pass < 2; pass += 1) {
    const next = trimPass(current, played, commands)
    if (next === current) break
    current = next
  }
  return current.trim() || utterance
}

interface TextToken {
  readonly syllable: string
  readonly from: number
  readonly to: number
}

function trimPass(utterance: string, played: readonly TextToken[], commands: readonly string[]): string {
  const heard = tokenize(utterance)
  if (heard.length < 4) return utterance
  let best = { length: 0, heardAt: 0, playedAt: 0 }
  for (let i = 0; i < heard.length; i += 1) {
    for (let j = 0; j < played.length; j += 1) {
      let length = 0
      while (heard[i + length] && played[j + length]
        && heard[i + length]!.syllable === played[j + length]!.syllable) length += 1
      if (length > best.length) best = { length, heardAt: i, playedAt: j }
    }
  }
  if (best.length < 4) return utterance

  const atStart = best.heardAt === 0
  const atEnd = best.heardAt + best.length === heard.length
  const keywords = commands.filter((command) => command.trim() && utterance.includes(command))
  let result: string
  if (atStart && atEnd) {
    result = ''
  } else if (atStart) {
    const end = heard[best.length - 1]?.to ?? 0
    const keyword = keywords
      .map((item) => utterance.indexOf(item))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0]
    if (keyword !== undefined && keyword < end) return utterance
    result = utterance.slice(end)
    result = result.replace(/^[\s，,。.、！!？?；;：:]+/, '')
    // The ASR often glues a particle from the TTS boundary onto the command.
    if (/^的/.test(result) && keywords.some((item) => result.includes(item))) result = result.slice(1)
  } else if (atEnd) {
    const start = heard[best.heardAt]?.from ?? utterance.length
    const keywordEnd = keywords
      .map((item) => {
        const at = utterance.indexOf(item)
        return at >= 0 ? at + item.length : -1
      })
      .filter((index) => index >= 0)
      .sort((a, b) => b - a)[0]
    if (keywordEnd !== undefined && start < keywordEnd) return utterance
    result = utterance.slice(0, start).replace(/[\s，,。.、！!？?；;：:]+$/, '')
  } else {
    return utterance
  }
  const keptKeyword = keywords.some((item) => result.includes(item))
  if (keywords.length > 0 && !keptKeyword) return utterance
  return result
}

function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = []
  for (let i = 0; i < text.length;) {
    const char = text[i]!
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) {
      const part = pinyin(char, { toneType: 'none', type: 'array' })[0] ?? char
      tokens.push({ syllable: String(part).trim(), from: i, to: i + 1 })
      i += 1
      continue
    }
    if (/[A-Za-z0-9]/.test(char)) {
      let end = i
      while (end < text.length && /[A-Za-z0-9]/.test(text[end]!)) end += 1
      tokens.push({ syllable: text.slice(i, end).toLowerCase(), from: i, to: end })
      i = end
      continue
    }
    i += 1
  }
  return tokens
}

export interface KeywordCut {
  readonly text: string
  readonly matched: boolean
}

/** Everything after the interject keyword; the keyword and everything before it are dropped. */
export function cutAtKeyword(utterance: string, keyword: string): KeywordCut {
  const clean = keyword.trim()
  if (!clean) return { text: utterance, matched: false }
  const index = utterance.indexOf(clean)
  if (index >= 0) {
    return {
      text: afterCut(utterance.slice(index + clean.length)),
      matched: true,
    }
  }
  // The ASR may spell a homophone (「大肥于」 for 「大肥鱼」). Compare the
  // tone-less syllables too, but still require every syllable of the keyword.
  const wanted = tokenize(clean).map((token) => token.syllable)
  if (wanted.length < 2) return { text: utterance, matched: false }
  const heard = tokenize(utterance)
  for (let i = 0; i + wanted.length <= heard.length; i += 1) {
    let same = true
    for (let k = 0; k < wanted.length; k += 1) {
      if (heard[i + k]?.syllable !== wanted[k]) { same = false; break }
    }
    if (!same) continue
    const end = heard[i + wanted.length - 1]?.to ?? utterance.length
    return { text: afterCut(utterance.slice(end)), matched: true }
  }
  return { text: utterance, matched: false }
}

function afterCut(text: string): string {
  return text.replace(/^[\s，,。.、！!？?；;：:]+/, '')
}
