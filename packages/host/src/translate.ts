/**
 * The selection toolbar's Translate action: one throwaway model call, rendered in the ball.
 *
 * This turn deliberately stays out of the session. It never touches `sessionController`, so
 * nothing reaches the transcript log and no later turn pays for it — the ball shows the pair,
 * the conversation history does not. That is why it speaks to `llm.stream` directly instead of
 * prompting the agent: the agent route would carry the whole Computer Use policy, the GUI tool
 * schemas, and a screenshot, all of which a translation has no use for.
 *
 * @module dsh-orb/host/translate
 */

/** Longest selection the toolbar will translate. Mirrors the ball composer's own limit. */
export const TRANSLATION_TEXT_LIMIT = 8_000

/** What the user sees above the answer: the instruction, then the text being translated. */
export const TRANSLATION_PROMPT_ZH = '把下面这段文字翻译成中文：'
export const TRANSLATION_PROMPT_EN = 'Translate the following into English:'

const SYSTEM_PROMPT_ZH = '你是一名翻译。把用户给出的文字忠实译成中文，只输出译文本身，不要解释、不要加引号、不要重复原文。保留原文的段落、列表与 Markdown 结构。'
const SYSTEM_PROMPT_EN = 'You are a translator. Translate the user text into English faithfully. Output only the translation: no commentary, no quotation marks, no repetition of the source. Preserve paragraphs, lists, and Markdown structure.'

export type TranslationTarget = 'zh' | 'en'

/** The instruction line that heads the user bubble. */
export function translationPrompt(target: TranslationTarget): string {
  return target === 'en' ? TRANSLATION_PROMPT_EN : TRANSLATION_PROMPT_ZH
}

/** System prompt for the throwaway call. */
export function translationSystemPrompt(target: TranslationTarget): string {
  return target === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH
}

/**
 * Cut the selection to the toolbar's budget.
 * @param text - the selected text.
 * @param limit - characters allowed; the shipped limit is {@link TRANSLATION_TEXT_LIMIT}.
 * @returns the text to translate and whether it was cut.
 */
export function clipTranslationText(
  text: string,
  limit: number = TRANSLATION_TEXT_LIMIT,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** The user bubble: the instruction, then the source, marked when it had to be cut. */
export function translationUserText(
  source: string,
  target: TranslationTarget,
  truncated: boolean,
  truncatedMark: string,
): string {
  const body = truncated ? `${source}${truncatedMark}` : source
  return `${translationPrompt(target)}\n\n${body}`
}

/** Model route a translation call runs on. */
export interface TranslationRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The slice of the official `llm` service this module needs. */
export interface TranslationLlm {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: never
    messages: readonly { readonly role: 'user'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }[]
    system: string
    signal: AbortSignal
  }): AsyncIterable<unknown>
}

export interface TranslationRequest {
  readonly source: string
  readonly target: TranslationTarget
  readonly route: TranslationRoute
  readonly truncatedMark: string
  readonly llm: TranslationLlm
  readonly signal: AbortSignal
  /** Receives the whole answer so far, each time it grows. */
  onText(text: string): void
}

/**
 * Run one translation and report the answer as it grows.
 * @param request - source text, target language, route, and the delta sink.
 * @returns the final text; empty when the model produced nothing.
 */
export async function runTranslation(request: TranslationRequest): Promise<string> {
  const { text } = clipTranslationText(request.source)
  const answer = request.llm.stream({
    provider: request.route.provider,
    model: request.route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    system: translationSystemPrompt(request.target),
    signal: request.signal,
  })
  let out = ''
  for await (const chunk of answer) {
    // The transport honours the signal too; checking here keeps a stopped translation from
    // painting one more delta if a chunk was already in flight.
    if (request.signal.aborted) break
    const record = chunk as { type?: unknown; text?: unknown }
    // Only body text belongs in the bubble. Reasoning stays invisible on purpose: a
    // translation has nothing to think about that the reader wants to see.
    if (record.type !== 'text-delta' || typeof record.text !== 'string') continue
    out += record.text
    request.onText(out)
  }
  return out
}
