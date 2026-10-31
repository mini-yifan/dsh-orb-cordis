import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clipTranslationText,
  runTranslation,
  TRANSLATION_TEXT_LIMIT,
  translationPrompt,
  translationSystemPrompt,
  translationUserText,
  type TranslationLlm,
} from '../src/translate.ts'

/** A fake `llm.stream` that emits the given deltas, one chunk each. */
function fakeLlm(deltas: readonly string[]): { llm: TranslationLlm; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  const llm: TranslationLlm = {
    stream(options) {
      calls.push(options as unknown as Record<string, unknown>)
      return (async function* emit() {
        for (const text of deltas) yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
  return { llm, calls }
}

describe('translation text', () => {
  it('heads the bubble with the instruction in the target language', () => {
    assert.equal(translationPrompt('zh'), '把下面这段文字翻译成中文：')
    assert.equal(translationPrompt('en'), 'Translate the following into English:')
    assert.match(translationSystemPrompt('zh'), /译文/)
    assert.match(translationSystemPrompt('en'), /translation/i)
    assert.equal(translationUserText('你好', 'en', false, '…'), 'Translate the following into English:\n\n你好')
  })

  it('marks a source that had to be cut, and leaves a short one alone', () => {
    assert.deepEqual(clipTranslationText('short'), { text: 'short', truncated: false })
    const long = 'x'.repeat(TRANSLATION_TEXT_LIMIT + 10)
    const clipped = clipTranslationText(long)
    assert.equal(clipped.truncated, true)
    assert.equal(clipped.text.length, TRANSLATION_TEXT_LIMIT)
    // The same budget as the ball's own composer: a longer selection is cut, not sent whole.
    assert.equal(TRANSLATION_TEXT_LIMIT, 8000)
    assert.match(translationUserText('abc', 'zh', true, '[cut]'), /abc\[cut\]$/)
  })
})

describe('translation call', () => {
  it('streams deltas and keeps only body text', async () => {
    const { llm, calls } = fakeLlm(['你好', '，', '世界'])
    const seen: string[] = []
    const answer = await runTranslation({
      source: 'hello, world',
      target: 'zh',
      route: { provider: 'p', model: 'm' },
      truncatedMark: '…',
      llm,
      signal: new AbortController().signal,
      onText: (text) => { seen.push(text) },
    })
    assert.equal(answer, '你好，世界')
    // Every intermediate state reached the panel, so the answer grows visibly.
    assert.deepEqual(seen, ['你好', '你好，', '你好，世界'])
    // One throwaway call, routed at the ball's own model, with no tools attached: this is
    // what keeps a translation from paying for the Computer Use policy.
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.provider, 'p')
    assert.equal(calls[0]?.model, 'm')
    assert.equal('tools' in (calls[0] ?? {}), false)
    assert.deepEqual(calls[0]?.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello, world' }] }])
  })

  it('keeps an over-long source inside the budget before it reaches the model', async () => {
    const { llm, calls } = fakeLlm(['ok'])
    await runTranslation({
      source: 'y'.repeat(TRANSLATION_TEXT_LIMIT + 500),
      target: 'en',
      route: { provider: 'p', model: 'm' },
      truncatedMark: '…',
      llm,
      signal: new AbortController().signal,
      onText() {},
    })
    const messages = calls[0]?.messages as { content: { text: string }[] }[]
    assert.equal(messages[0]?.content[0]?.text.length, TRANSLATION_TEXT_LIMIT)
  })

  it('stops delivering once the signal aborts', async () => {
    const abort = new AbortController()
    const llm: TranslationLlm = {
      stream: () => (async function* emit() {
        yield { type: 'text-delta', index: 0, text: 'first' }
        abort.abort()
        yield { type: 'text-delta', index: 0, text: 'second' }
      })(),
    }
    const seen: string[] = []
    const answer = await runTranslation({
      source: 'x',
      target: 'zh',
      route: { provider: 'p', model: 'm' },
      truncatedMark: '…',
      llm,
      signal: abort.signal,
      onText: (text) => { seen.push(text) },
    })
    // The chunk already in flight is dropped, so the stopped answer is what was on screen.
    assert.equal(answer, 'first')
    assert.deepEqual(seen, ['first'])
  })
})
