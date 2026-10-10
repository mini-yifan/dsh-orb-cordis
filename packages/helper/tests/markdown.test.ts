import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../assets/markdown.js'

describe('transcript markdown', () => {
  it('renders the Harness markdown DOM for headings, lists, and tables', () => {
    const html = renderMarkdown('# Title\n\n- a\n- b\n\n1. c\n\n| x | y |\n| --- | --- |\n| 1 | 2 |')
    assert.match(html, /<h1>Title<\/h1>/)
    assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/)
    assert.match(html, /<ol><li>c<\/li><\/ol>/)
    assert.match(html, /<div class="md-table-scroll md-table-fill"><table><thead><tr><th>x<\/th><th>y<\/th><\/tr><\/thead>/)
  })

  it('renders fenced code as a CodeBlock card with banner and escaped body', () => {
    const html = renderMarkdown('```ts\nconst a = "<b>"\n```')
    assert.match(html, /<div class="cb" data-code-wrap="true" data-code-lang="ts">/)
    assert.match(html, /<div class="cb-infostring">ts<\/div>/)
    assert.match(html, /<pre class="cb-plain"><code>const a = &quot;&lt;b&gt;&quot;<\/code><\/pre>/)
  })

  it('marks an unterminated fence as streaming', () => {
    const html = renderMarkdown('```py\nprint(1)')
    assert.match(html, /data-code-lang="py"/)
    assert.match(html, /data-code-streaming="true"/)
  })

  it('renders links as real anchors with safe hrefs', () => {
    const html = renderMarkdown('see [docs](https://example.com) and **bold**')
    assert.match(html, /<a href="https:\/\/example\.com">docs<\/a>/)
    assert.match(html, /<strong>bold<\/strong>/)
    const evil = renderMarkdown('[x](javascript:alert(1))')
    assert.equal(evil.includes('<a'), false)
    assert.match(evil, /x/)
  })

  it('keeps bare URLs and autolinks clickable', () => {
    const html = renderMarkdown('open https://example.com/a now')
    assert.match(html, /<a href="https:\/\/example\.com\/a">https:\/\/example\.com\/a<\/a>/)
  })

  it('does not format markup that sits inside inline code', () => {
    const html = renderMarkdown('use `**<b>` please')
    assert.equal(html.includes('<strong>'), false)
    assert.match(html, /<code>\*\*&lt;b&gt;<\/code>/)
  })

  it('renders blockquotes, hr, and task items', () => {
    const html = renderMarkdown('> quoted\n\n---\n\n- [x] done\n- [ ] open')
    assert.match(html, /<blockquote><div class="md"><p>quoted<\/p><\/div><\/blockquote>/)
    assert.match(html, /<hr>/)
    assert.match(html, /<input type="checkbox" disabled checked>/)
    assert.match(html, /<input type="checkbox" disabled>/)
  })

  it('joins soft line breaks with a space, except between CJK characters', () => {
    assert.match(renderMarkdown('Hello\nworld'), /<p>Hello world<\/p>/)
    assert.match(renderMarkdown('结果\nOK'), /<p>结果 OK<\/p>/)
    assert.match(renderMarkdown('注意\n如下'), /<p>注意如下<\/p>/)
    assert.match(renderMarkdown('第一句。\n第二句'), /<p>第一句。第二句<\/p>/)
    // Hard breaks keep their <br> and never gain a space.
    assert.match(renderMarkdown('a  \nb'), /<p>a<br>b<\/p>/)
  })

  it('reads a table glued directly under a prose line as a table', () => {
    const glued = renderMarkdown('结果如下\n| x | y |\n| --- | --- |\n| 1 | 2 |')
    assert.match(glued, /<p>结果如下<\/p>/)
    assert.match(glued, /<div class="md-table-scroll md-table-fill"><table><thead><tr><th>x<\/th><th>y<\/th><\/tr><\/thead>/)
    const spaced = renderMarkdown('注意\n\n| x | y |\n| --- | --- |\n| 1 | 2 |')
    assert.match(spaced, /<p>注意<\/p>/)
    assert.match(spaced, /<table>/)
  })

  it('applies the compact variant wrapper', () => {
    const html = renderMarkdown('text', { compact: true })
    assert.match(html, /^<div class="md md-compact"><p>text<\/p><\/div>$/)
  })
})
