import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cutAtKeyword, isEcho, stripEcho, type SpokenLine } from '../src/echo.ts'

const commands = ['大肥鱼', '你退下吧', '退下吧']

function line(text: string, startedAt: number, endedAt?: number): SpokenLine {
  return { text, startedAt, endedAt }
}

describe('text echo filter', () => {
  it('drops a transcript that is the line being spoken', () => {
    const spoken = [line('我去查一下今天的天气', 0)]
    assert.equal(isEcho('我去查一下今天天气', spoken, { from: 100, to: 800 }, commands), true)
  })

  it('keeps an interjection spoken over the same line', () => {
    const spoken = [line('我去查一下今天的天气', 0)]
    assert.equal(isEcho('大肥鱼，把明天的也查一下', spoken, { from: 100, to: 800 }, commands), false)
  })

  it('keeps a mixed sentence that brings a command the playback does not contain', () => {
    const spoken = [line('我去查一下今天的天气', 0)]
    assert.equal(isEcho('我去查一下今天的天气大肥鱼停一下', spoken, { from: 100, to: 900 }, commands), false)
  })

  it('drops a playback line that itself contains the keyword', () => {
    const spoken = [line('大肥鱼会帮你查', 0)]
    assert.equal(isEcho('大肥鱼会帮你查', spoken, { from: 100, to: 800 }, commands), true)
  })

  it('keeps the same words once the playback has been over for two seconds', () => {
    const spoken = [line('我去查一下今天的天气', 0, 1000)]
    assert.equal(isEcho('我去查一下今天的天气', spoken, { from: 3000, to: 3600 }, commands), false)
  })

  it('judges each queued recognition by its own window', () => {
    const spoken = [line('我去查一下今天的天气', 0, 1000)]
    assert.equal(isEcho('我去查一下今天的天气', spoken, { from: 100, to: 900 }, commands), true)
    assert.equal(isEcho('我去查一下今天的天气', spoken, { from: 4000, to: 4600 }, commands), false)
  })

  it('treats a homophone of the playback as echo', () => {
    const spoken = [line('我去查一下今天的天气', 0)]
    assert.equal(isEcho('我去差一下今天的天气', spoken, { from: 100, to: 800 }, commands), true)
  })

  it('does not treat a one-syllable transcript as echo', () => {
    const spoken = [line('好的，再见', 0)]
    assert.equal(isEcho('好', spoken, { from: 100, to: 400 }, commands), false)
  })
})

describe('echo text trimming', () => {
  it('removes a playback prefix and keeps the user command', () => {
    const spoken = [line('今天天气不错，我们来测试一下回声消除。', 0)]
    const text = stripEcho('今天天气不错，我的大肥鱼帮我查一下天气。', spoken, { from: 0, to: 5000 }, commands)
    assert.equal(text, '大肥鱼帮我查一下天气。')
  })

  it('removes a playback suffix and keeps the user command', () => {
    const spoken = [line('今天天气不错，我们来测试一下回声消除。', 0)]
    const text = stripEcho('大肥鱼，打开插画，今天天气不错我们来测试一下回声消除。', spoken, { from: 0, to: 5000 }, commands)
    assert.equal(text, '大肥鱼，打开插画')
  })

  it('leaves a command that does not overlap the playback alone', () => {
    const spoken = [line('今天天气不错，我们来测试一下回声消除。', 0)]
    assert.equal(stripEcho('大肥鱼，把明天的也查一下', spoken, { from: 0, to: 5000 }, commands), '大肥鱼，把明天的也查一下')
  })

  it('trims a mixed sentence down to the interjection', () => {
    const spoken = [line('我去查一下今天的天气', 0)]
    assert.equal(stripEcho('我去查一下今天的天气大肥鱼停一下', spoken, { from: 100, to: 900 }, commands), '大肥鱼停一下')
  })

  it('does not remove the only interject keyword', () => {
    const spoken = [line('大肥鱼会帮你查', 0)]
    assert.equal(stripEcho('大肥鱼会帮你查大肥鱼停一下', spoken, { from: 100, to: 900 }, commands), '大肥鱼会帮你查大肥鱼停一下')
  })

  it('leaves a transcript alone when no playback overlaps its window', () => {
    const spoken = [line('今天天气不错，我们来测试一下回声消除。', 0, 1000)]
    assert.equal(stripEcho('大肥鱼打开插画今天天气不错', spoken, { from: 4000, to: 5000 }, commands), '大肥鱼打开插画今天天气不错')
  })
})

describe('interject keyword cut', () => {
  it('drops the keyword and everything before it', () => {
    assert.deepEqual(cutAtKeyword('今天天气不错，大肥鱼，打开插画', '大肥鱼'), { text: '打开插画', matched: true })
  })

  it('marks a keyword with no command as matched and empty', () => {
    assert.deepEqual(cutAtKeyword('大肥鱼，', '大肥鱼'), { text: '', matched: true })
  })

  it('leaves text alone when the keyword was not heard', () => {
    assert.deepEqual(cutAtKeyword('打开插画', '大肥鱼'), { text: '打开插画', matched: false })
  })

  it('cuts at an ASR homophone of the keyword', () => {
    assert.deepEqual(cutAtKeyword('今天天气不错，大肥于，打开插画', '大肥鱼'), { text: '打开插画', matched: true })
  })
})
