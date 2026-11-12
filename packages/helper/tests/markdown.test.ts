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

  it('renders image syntax as a readable card instead of a bare path', () => {
    const html = renderMarkdown(String.raw`![记事本中的《静夜思》](<C:\Users\ASUS\.dsh\dsh_orb\li-bai.png>)`)
    assert.match(html, /<span class="md-image">/)
    assert.match(html, /class="md-image-alt">记事本中的《静夜思》<\/span>/)
    assert.match(html, /class="md-image-path">C:\\Users\\ASUS\\\.dsh\\dsh_orb\\li-bai\.png<\/code>/)
    assert.equal(html.includes('!['), false)
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

  it('emits a display-math placeholder for a $$ block, same line or fenced', () => {
    const oneLine = renderMarkdown('$$E = mc^2$$')
    assert.match(oneLine, /^<div class="md"><div class="md-math" data-math-display="true">E = mc\^2<\/div><\/div>$/)
    const fenced = renderMarkdown('$$\n\\rho\\left(\\frac{\\partial \\mathbf{u}}{\\partial t}\\right) = -\\nabla p\n$$')
    assert.match(fenced, /data-math-display="true">\\rho\\left\(\\frac\{\\partial \\mathbf\{u\}\}\{\\partial t\}\\right\) = -\\nabla p<\/div>/)
    // A paragraph never swallows the block: the formula is a sibling of the prose.
    assert.match(renderMarkdown('公式：\n\n$$a+b$$'), /<p>公式：<\/p><div class="md-math" data-math-display="true">a\+b<\/div>/)
    assert.match(renderMarkdown('\\[\nE = mc^2\n\\]'), /data-math-display="true">E = mc\^2<\/div>/)
  })

  it('emits an inline-math placeholder for $…$ and \\(…\\)', () => {
    assert.match(renderMarkdown('由 $E=mc^2$ 可得'), /<p>由 <span class="md-math" data-math-display="false">E=mc\^2<\/span> 可得<\/p>/)
    assert.match(renderMarkdown('设 \\(x \\in R\\)'), /<span class="md-math" data-math-display="false">x \\in R<\/span>/)
    assert.match(renderMarkdown('由 $$E=mc^2$$ 可得'), /<span class="md-math" data-math-display="false">E=mc\^2<\/span>/)
  })

  it('escapes the TeX source it parks in the placeholder', () => {
    assert.match(renderMarkdown('$$a < b & c$$'), /data-math-display="true">a &lt; b &amp; c<\/div>/)
  })

  it('keeps currency, escaped dollars, and code spans out of math', () => {
    assert.equal(renderMarkdown('价格 $100 与 $200 元').includes('md-math'), false)
    assert.equal(renderMarkdown('成本 \\$5 而已').includes('md-math'), false)
    assert.equal(renderMarkdown('用 `$x$` 表示').includes('md-math'), false)
    assert.equal(renderMarkdown('```latex\n$$x$$\n```').includes('md-math'), false)
    // An unterminated block delimiter is prose, not a formula.
    assert.equal(renderMarkdown('看这个 $$E = mc^2').includes('md-math'), false)
  })

  it('lets emphasis pair up across a formula', () => {
    assert.match(renderMarkdown('**粗 $x$ 体**'), /<p><strong>粗 <span class="md-math" data-math-display="false">x<\/span> 体<\/strong><\/p>/)
  })

  it('leaves TeX literal while the text is still streaming', () => {
    const live = renderMarkdown('由 $E=mc^2$ 可得\n\n$$\na+b\n$$', { live: true })
    assert.equal(live.includes('md-math'), false)
    assert.match(live, /<p>由 \$E=mc\^2\$ 可得<\/p>/)
    assert.match(live, /\$\$ a\+b \$\$|<p>\$\$ a\+b \$\$<\/p>/)
  })
})
