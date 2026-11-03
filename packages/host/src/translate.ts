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

/** One saved screenshot the translation call can see. */
export interface TranslationImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** The slice of the official `llm` service this module needs. */
export interface TranslationLlm {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: never
    /**
     * Routing id some providers require per conversation. OpenCode Go rejects a request
     * without `x-opencode-session`, and the adapter fills that header only from this field.
     */
    sessionId?: string
    messages: readonly {
      readonly role: 'user'
      readonly content: readonly (
        | { readonly type: 'text'; readonly text: string }
        | { readonly type: 'image'; readonly attachment: TranslationImage }
      )[]
    }[]
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
  /** Current conversation id, for providers that route requests by session header. */
  readonly sessionId?: string
  /** Receives the whole answer so far, each time it grows. */
  onText(text: string): void
}

/** A terminal failure carried by a `finish` chunk instead of thrown by the stream. */
interface TranslationFailure {
  readonly message?: unknown
  readonly code?: unknown
}

interface TranslationFinish {
  readonly kind?: unknown
  readonly failure?: TranslationFailure
}

/**
 * Consume one translation stream.
 *
 * `llm.stream` reports adapter, auth, routing, and empty-response failures as a terminal
 * `finish` chunk; it does not throw them. Ignoring that chunk left the bubble with a question
 * and no answer, and no reason on screen, so every terminal failure becomes a thrown error here.
 * @param answer - the model chunk stream.
 * @param signal - the caller's abort signal; an abort keeps the text already shown.
 * @param onText - receives the whole answer so far, each time it grows.
 * @returns the translated text.
 */
async function collectTranslation(
  answer: AsyncIterable<unknown>,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  let out = ''
  for await (const chunk of answer) {
    // The transport honours the signal too; checking here keeps a stopped translation from
    // painting one more delta if a chunk was already in flight.
    if (signal.aborted) break
    const record = chunk as { type?: unknown; text?: unknown; reason?: unknown }
    // Only body text belongs in the bubble. Reasoning stays invisible on purpose: a
    // translation has nothing to think about that the reader wants to see.
    if (record.type === 'text-delta') {
      if (typeof record.text === 'string') {
        out += record.text
        onText(out)
      }
      continue
    }
    if (record.type !== 'finish') continue
    const reason = record.reason as TranslationFinish | undefined
    if (reason?.kind === 'aborted' && signal.aborted) break
    if (reason?.kind === 'error' || reason?.kind === 'aborted') throw translationFailure(reason.failure)
    // `stop`, `max-tokens`, and `tool-calls` all end the stream; keep whatever text arrived.
    break
  }
  if (out === '' && !signal.aborted) throw new Error('模型没有返回译文（EMPTY_RESPONSE）。')
  return out
}

/** Turn a provider failure payload into the message the ball shows. */
function translationFailure(failure: TranslationFailure | undefined): Error {
  const message = typeof failure?.message === 'string' && failure.message !== ''
    ? failure.message
    : '翻译请求失败。'
  const code = typeof failure?.code === 'string' && failure.code !== '' ? `（${failure.code}）` : ''
  return new Error(`${message}${code}`)
}

/**
 * Run one translation and report the answer as it grows.
 * @param request - source text, target language, route, and the delta sink.
 * @returns the final text; empty only when the caller aborted it.
 */
export async function runTranslation(request: TranslationRequest): Promise<string> {
  const { text } = clipTranslationText(request.source)
  const answer = request.llm.stream({
    provider: request.route.provider,
    model: request.route.model,
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    system: translationSystemPrompt(request.target),
    signal: request.signal,
  })
  return collectTranslation(answer, request.signal, request.onText)
}

const IMAGE_SYSTEM_PROMPT_ZH = '你是一名翻译。读出用户截图中的文字，忠实翻译成中文，只输出译文本身，不要描述图片、不要解释、不要加引号、不要重复原文。保留原有换行、列表与 Markdown 结构。'
const IMAGE_SYSTEM_PROMPT_EN = 'You are a translator. Read the text in the user screenshot and translate it faithfully into English. Output only the translation: no description of the image, no commentary, no quotation marks, no repetition of the source. Preserve line breaks, lists, and Markdown structure.'

export const IMAGE_TRANSLATION_PROMPT_ZH = '把这张截图里的文字翻译成中文：'
export const IMAGE_TRANSLATION_PROMPT_EN = 'Translate the text in this screenshot into English:'

/** User bubble that heads an image translation. */
export function imageTranslationPrompt(target: TranslationTarget): string {
  return target === 'en' ? IMAGE_TRANSLATION_PROMPT_EN : IMAGE_TRANSLATION_PROMPT_ZH
}

/** System prompt for the throwaway image call. */
export function imageTranslationSystemPrompt(target: TranslationTarget): string {
  return target === 'en' ? IMAGE_SYSTEM_PROMPT_EN : IMAGE_SYSTEM_PROMPT_ZH
}

export interface ImageTranslationRequest {
  readonly image: TranslationImage
  readonly target: TranslationTarget
  readonly route: TranslationRoute
  readonly llm: TranslationLlm
  readonly signal: AbortSignal
  /** Current conversation id, for providers that route requests by session header. */
  readonly sessionId?: string
  onText(text: string): void
}

/**
 * Translate the text in one screenshot through the ball's overlay route.
 * The image is an ordinary attachment; nothing here touches the session.
 */
export async function runImageTranslation(request: ImageTranslationRequest): Promise<string> {
  const answer = request.llm.stream({
    provider: request.route.provider,
    model: request.route.model,
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: imageTranslationPrompt(request.target) },
        { type: 'image', attachment: request.image },
      ],
    }],
    system: imageTranslationSystemPrompt(request.target),
    signal: request.signal,
  })
  return collectTranslation(answer, request.signal, request.onText)
}
