/** Transcript markdown. GFM block parser emitting the Harness MarkdownText
 * DOM: h1-h4, paragraphs, nested lists, task items, tables, blockquotes, hr,
 * and fenced code as CodeBlock cards. Links render as real anchors; the shell
 * routes clicks out through the host.
 *
 * TeX ($…$, $$…$$, \(…\), \[…\]) becomes a `.md-math` placeholder carrying its
 * source as text; math.js typesets the placeholders with the vendored KaTeX
 * bundle. Two arms, like the Harness chat: a settled document recognizes math,
 * a streaming one (`live`) leaves TeX as plain text — an incomplete `$` or a
 * half-arrived `\frac{` must not flash a typeset error mid-stream. */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i

function safeHref(url) {
  const trimmed = url.trim()
  return SAFE_URL.test(trimmed) ? escapeHtml(trimmed) : ''
}

/** Settled arm typesets TeX; the streaming arm leaves it literal. Set by
 * `renderMarkdown` and read by the inline pass, the way the Harness renderer
 * picks one of its two mdast grammars per arm. */
let settled = true

/** One formula placeholder: the TeX source stays as text so a page whose
 * typesetter has not landed yet (or never loads) still shows the source. */
function mathPlaceholder(tex, display) {
  const source = display ? tex.trim() : tex
  if (source === '') return ''
  const tag = display ? 'div' : 'span'
  return `<${tag} class="md-math" data-math-display="${display ? 'true' : 'false'}">${escapeHtml(source)}</${tag}>`
}

/** Index of the closing delimiter that ends a display-math line, or -1 when the
 * line does not close one. Only trailing whitespace may follow it, so `$$a$$ + b`
 * stays prose and the inline pass gets it. */
function closingTail(line, close) {
  for (let at = line.indexOf(close); at !== -1; at = line.indexOf(close, at + 1)) {
    if (line[at - 1] === '\\') continue
    if (line.slice(at + close.length).trim() === '') return at
  }
  return -1
}

const MATH_BLOCK_OPEN = /^ {0,3}(\$\$|\\\[)[ \t]*(.*)$/

/** A `$$`/`\[` line opening a display-math block, closed by `$$`/`\]` on the
 * same line or on a later one. Unterminated delimiters are prose. */
function renderMathBlock(lines, start) {
  if (!settled) return null
  const match = MATH_BLOCK_OPEN.exec(lines[start] ?? '')
  if (match === null) return null
  const close = match[1] === '$$' ? '$$' : '\\]'
  const head = match[2] ?? ''
  const sameLine = closingTail(head, close)
  if (sameLine !== -1) {
    return { html: mathPlaceholder(head.slice(0, sameLine), true), next: start + 1 }
  }
  const body = head === '' ? [] : [head]
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const at = closingTail(line, close)
    if (at !== -1) {
      body.push(line.slice(0, at))
      return { html: mathPlaceholder(body.join('\n'), true), next: index + 1 }
    }
    body.push(line)
    index += 1
  }
  return null
}

/** Index of the next `close` at or after `from` that can end an inline span, or
 * -1. An escaped delimiter and one that follows whitespace never close; a `$`
 * that merely lengthens a run is not a delimiter of its own. */
function closingMarker(text, close, from) {
  const dollar = close[0] === '$'
  for (let at = text.indexOf(close, from); at !== -1; at = text.indexOf(close, at + 1)) {
    if (text[at - 1] === '\\') continue
    if (/\s/.test(text[at - 1] ?? '')) continue
    if (dollar && (text[at - 1] === '$' || text[at + close.length] === '$')) continue
    return at
  }
  return -1
}

/** Inline TeX spans in one line of text: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`.
 * A `$` run opens only before non-space and closes only after non-space, which
 * is what keeps `$100 与 $200` prose. */
function mathSpans(text) {
  const spans = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next !== '(' && next !== '[') {
        index += 1
        continue
      }
      const close = next === '(' ? '\\)' : '\\]'
      const at = closingMarker(text, close, index + 2)
      if (at === -1) continue
      spans.push({ start: index, end: at + close.length, tex: text.slice(index + 2, at), display: false })
      index = at + close.length - 1
      continue
    }
    if (char !== '$') continue
    const size = text[index + 1] === '$' ? 2 : 1
    const from = index + size
    if (text.slice(from, from + 1).trim() === '') continue
    const at = closingMarker(text, text.slice(index, from), from)
    if (at === -1) continue
    spans.push({ start: index, end: at + size, tex: text.slice(from, at), display: false })
    index = at + size - 1
  }
  return spans
}

/** Inline pass: code spans first, then links/autolinks, strong, em, del. */
function renderInline(text, inLink = false) {
  const segments = String(text).split(/(`+)/)
  let html = ''
  for (let index = 0; index < segments.length; index += 1) {
    const fence = segments[index]
    if (index % 2 === 1) {
      const close = segments.indexOf(fence, index + 1)
      if (close !== -1) {
        const inner = segments.slice(index + 1, close).join(fence)
        html += `<code>${escapeHtml(inner.replace(/^ (.*) $/, '$1'))}</code>`
        index = close
      } else {
        html += escapeHtml(fence)
      }
      continue
    }
    html += renderInlineText(fence, inLink)
  }
  return html
}

const URL_PATTERN = /(\bhttps?:\/\/[^\s<>()\[\]{}"']+[^\s<>()\[\]{}"'.,!?:;])/g

/** Math first — its TeX stays literal — then links, autolinks, bare URLs, and
 * emphasis in the stretches between the formulas. A formula is masked while
 * those passes run, so emphasis around it (`**a $x$ b**`) still pairs up, and
 * the mask is swapped for the placeholder once the HTML is built. */
function renderInlineText(text, inLink = false) {
  const spans = settled ? mathSpans(text) : []
  if (spans.length === 0) return renderLinks(text, inLink)
  let masked = ''
  let cursor = 0
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    masked += text.slice(cursor, span.start) + mask(index)
    cursor = span.end
  }
  masked += text.slice(cursor)
  let html = renderLinks(masked, inLink)
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    html = html.split(mask(index)).join(mathPlaceholder(span.tex, span.display))
  }
  return html
}

/** Private-use delimiters: they survive HTML escaping and match no markdown. */
function mask(index) {
  return `\uE000${index}\uE001`
}

/** Image syntax is handled here because the Harness chat shows a readable
 * descriptor instead of loading arbitrary remote images. A second private-use
 * range keeps image masks from colliding with the math masks above. */
const IMAGE_PATTERN = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\n]+?))\s*\)/g
const IMAGE_MASK = (index) => `\uE200${index}\uE201`

function imageCard(alt, target) {
  const label = alt.trim()
  const path = target.trim()
  return '<span class="md-image">'
    + '<span class="md-image-icon" aria-hidden="true">🖼</span>'
    + (label === '' ? '' : `<span class="md-image-alt">${escapeHtml(label)}</span>`)
    + (path === '' ? '' : `<code class="md-image-path">${escapeHtml(path)}</code>`)
    + '</span>'
}

function renderLinks(text, inLink = false) {
  const images = []
  const masked = text.replace(IMAGE_PATTERN, (_token, alt, angled, bare) => {
    images.push({ alt, target: (angled ?? bare ?? '').trim() })
    return IMAGE_MASK(images.length - 1)
  })
  let html = ''
  let cursor = 0
  // Local: the pass re-enters itself through a link label, and a shared global
  // pattern's `lastIndex` would jump back into the enclosing text.
  const pattern = /(\[[^\]\n]*\]\([^)\s]+\))|(<https?:\/\/[^>\s]+>)/g
  for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
    html += renderDecorations(masked.slice(cursor, match.index), inLink)
    const token = match[0]
    if (match[1] !== undefined) {
      const split = token.indexOf('](')
      html += anchor(token.slice(1, split), token.slice(split + 2, -1))
    } else {
      html += anchor(token.slice(1, -1), token.slice(1, -1))
    }
    cursor = match.index + token.length
  }
  html += renderDecorations(masked.slice(cursor), inLink)
  for (let index = 0; index < images.length; index += 1) {
    html = html.split(IMAGE_MASK(index)).join(imageCard(images[index].alt, images[index].target))
  }
  return html
}

/** Bare URLs become anchors, and the rest takes emphasis markers. */
function renderDecorations(text, inLink = false) {
  let html = ''
  let cursor = 0
  if (!inLink) {
    URL_PATTERN.lastIndex = 0
    for (let match = URL_PATTERN.exec(text); match !== null; match = URL_PATTERN.exec(text)) {
      html += decorate(text.slice(cursor, match.index))
      html += anchor(match[1], match[1])
      cursor = match.index + match[1].length
    }
  }
  html += decorate(text.slice(cursor))
  return html
}

function decorate(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
}

function anchor(label, url) {
  const href = safeHref(url)
  if (href === '') return escapeHtml(label)
  return `<a href="${href}">${renderInline(label, true)}</a>`
}

function headingLevel(mark) {
  return `h${Math.min(mark.length, 6)}`
}

function isTableRow(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1
}

function splitRow(line) {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
}

function isSeparatorRow(line) {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function renderTable(lines, start) {
  const header = splitRow(lines[start])
  if (!isSeparatorRow(lines[start + 1] ?? '')) return null
  const rows = []
  let index = start + 2
  while (index < lines.length && isTableRow(lines[index])) {
    rows.push(splitRow(lines[index]))
    index += 1
  }
  const wide = header.length >= 4
  const cells = (row) => row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')
  const body = rows.map((row) => `<tr>${cells(row)}</tr>`).join('')
  const html = `<div class="md-table-scroll${wide ? ' md-table-wide' : ' md-table-fill'}"><table>`
    + `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`
    + `<tbody>${body}</tbody></table></div>`
  return { html, next: index }
}

const INDENT = /^(\s*)(.*)$/

function renderList(lines, start) {
  const [, indent, first] = INDENT.exec(lines[start])
  const ordered = /^(\d{1,9})[.)]\s+/.test(first)
  const marker = ordered ? /^(\d{1,9})[.)]\s+/ : /^[-*+]\s+/
  const items = []
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const lead = INDENT.exec(line)
    if (lead[2] === '') {
      // Blank line: continue only when the next line is another item at this level.
      if (index + 1 >= lines.length) break
      const upcoming = lines[index + 1] ?? ''
      const nextLead = INDENT.exec(upcoming)
      if (nextLead[1] !== indent || !marker.test(nextLead[2])) break
      index += 1
      continue
    }
    if (lead[1] !== indent) {
      if (lead[1].length > indent.length && items.length > 0 && marker.test(lead[2])) {
        const nested = renderList(lines, index)
        items[items.length - 1].push(nested.html)
        index = nested.next
        continue
      }
      break
    }
    if (!marker.test(lead[2])) break
    let content = lead[2].replace(marker, '')
    let task
    const checkbox = /^\[([ xX])\]\s+/.exec(content)
    if (checkbox !== null) {
      task = checkbox[1] !== ' '
      content = content.slice(checkbox[0].length)
    }
    const pieces = [task === undefined ? '' : `<input type="checkbox" disabled${task ? ' checked' : ''}>`, renderInline(content)]
    items.push(pieces)
    index += 1
  }
  const tag = ordered ? 'ol' : 'ul'
  const html = `<${tag}>${items.map((item) => `<li>${item.join('')}</li>`).join('')}</${tag}>`
  return { html, next: index }
}

function codeBlock(infoLine, body, streaming, copyLabel) {
  const lang = infoLine.trim().split(/\s+/)[0] ?? ''
  const info = escapeHtml(infoLine.trim())
  return `<div class="cb" data-code-wrap="true"${lang !== '' ? ` data-code-lang="${escapeHtml(lang.toLowerCase())}"` : ''}${streaming ? ' data-code-streaming="true"' : ''}>`
    + '<div class="cb-banner-wrap"><div class="cb-banner" data-code-block-banner>'
    + `<div class="cb-infostring">${info === '' ? 'text' : info}</div>`
    + `<div class="cb-action"><button type="button" class="cb-copy">${escapeHtml(copyLabel ?? 'Copy')}</button></div>`
    + '</div></div>'
    + '<div class="cb-content" data-code-block-content>'
    + `<pre class="cb-plain"><code>${escapeHtml(body)}</code></pre>`
    + '</div></div>'
}

/** Render one markdown document to the Harness chat DOM (HTML string). The
 * `live` option picks the arm: true while the text is still streaming. */
export function renderMarkdown(text, options = {}) {
  const outer = settled
  settled = options.live !== true
  try {
    return renderDocument(text, options)
  } finally {
    settled = outer
  }
}

/** Render into a DOM fragment for renderers that build nodes instead of
 * assigning HTML. `renderMarkdown` escapes every text run and only emits its
 * own anchors/classes, so the fragment carries no remote markup or handlers. */
export function renderMarkdownFragment(text, options = {}) {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(text, options)
  return template.content
}

function renderDocument(text, options) {
  const source = typeof text === 'string' ? text : ''
  const compact = options.compact === true
  const blocks = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = /^(```+|~~~+)\s*(.*)$/.exec(line)
    if (fence !== null) {
      const marker = fence[1]
      const info = fence[2] ?? ''
      const body = []
      index += 1
      let closed = false
      while (index < lines.length) {
        if ((lines[index] ?? '').trimEnd() === marker.trimEnd()) {
          closed = true
          index += 1
          break
        }
        body.push(lines[index] ?? '')
        index += 1
      }
      blocks.push(codeBlock(info, body.join('\n'), !closed, options.copyLabel))
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push(`<${headingLevel(heading[1])}>${renderInline(heading[2])}</${headingLevel(heading[1])}>`)
      index += 1
      continue
    }
    if (/^ {0,3}(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push('<hr>')
      index += 1
      continue
    }
    if (/^ {0,3}> /.test(line)) {
      const quoted = []
      while (index < lines.length && /^ {0,3}> /.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^ {0,3}> /, ''))
        index += 1
      }
      blocks.push(`<blockquote>${renderDocument(quoted.join('\n'), options)}</blockquote>`)
      continue
    }
    if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const list = renderList(lines, index)
      blocks.push(list.html)
      index = list.next
      continue
    }
    if (isTableRow(line) && index + 1 < lines.length && isSeparatorRow(lines[index + 1] ?? '')) {
      const table = renderTable(lines, index)
      if (table !== null) {
        blocks.push(table.html)
        index = table.next
        continue
      }
    }
    const math = renderMathBlock(lines, index)
    if (math !== null) {
      blocks.push(math.html)
      index = math.next
      continue
    }
    const paragraph = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim() === '') break
      if (paragraph.length > 0 && isBlockStart(next)) break
      // A table glued under a prose line is its own block; leave it to the table branch.
      if (paragraph.length > 0 && isTableRow(next) && isSeparatorRow(lines[index + 1] ?? '')) break
      paragraph.push(next)
      index += 1
    }
    blocks.push(`<p>${renderParagraph(paragraph)}</p>`)
  }
  const html = blocks.join('')
  return compact ? `<div class="md md-compact">${html}</div>` : `<div class="md">${html}</div>`
}

function isBlockStart(line) {
  return /^ {0,3}(?:#{1,6}\s|```|~~~|> )/.test(line)
    || /^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)
    || /^ {0,3}(?:\*{3,}|-{3,}|_{3,})\s*$/.test(line)
    || (settled && MATH_BLOCK_OPEN.test(line))
}

/**
 * CJK runs (ideographs, kana, hangul, and their punctuation) read as one unit:
 * a soft break inside them must not inject a space.
 */
const CJK_CHAR = /[\u2e80-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{2fa1f}]/u

/** CommonMark soft breaks render as a space, except between two CJK characters. */
function softBreakSpace(previous, next) {
  if (previous === '' || next === '' || /\s$/.test(previous)) return ''
  const left = [...previous].at(-1) ?? ''
  const right = [...next][0] ?? ''
  return CJK_CHAR.test(left) && CJK_CHAR.test(right) ? '' : ' '
}

function renderParagraph(lines) {
  let html = ''
  let previous
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position] ?? ''
    const hard = /(\s{2,}|\\)$/.test(line) && position < lines.length - 1
    const text = hard ? line.replace(/(\s{2,}|\\)$/, '') : line
    if (previous !== undefined && !previous.hard) html += softBreakSpace(previous.text, text)
    html += renderInline(text) + (hard ? '<br>' : '')
    previous = { text, hard }
  }
  return html
}
