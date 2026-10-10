/** Transcript markdown. GFM block parser emitting the Harness MarkdownText
 * DOM: h1-h4, paragraphs, nested lists, task items, tables, blockquotes, hr,
 * and fenced code as CodeBlock cards. Links render as real anchors; the shell
 * routes clicks out through the host. */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i

function safeHref(url) {
  const trimmed = url.trim()
  return SAFE_URL.test(trimmed) ? escapeHtml(trimmed) : ''
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

function renderInlineText(text, inLink = false) {
  let html = ''
  let cursor = 0
  const patterns = /(\[[^\]\n]*\]\([^)\s]+\))|(<https?:\/\/[^>\s]+>)/g
  for (let match = patterns.exec(text); match !== null; match = patterns.exec(text)) {
    html += renderDecorations(text.slice(cursor, match.index), inLink)
    const token = match[0]
    if (match[1] !== undefined) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const url = token.slice(split + 2, -1)
      html += anchor(label, url)
    } else {
      html += anchor(token.slice(1, -1), token.slice(1, -1))
    }
    cursor = match.index + token.length
  }
  html += renderDecorations(text.slice(cursor), inLink)
  return html
}

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

/** Render one markdown document to the Harness chat DOM (HTML string). */
export function renderMarkdown(text, options = {}) {
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
      blocks.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`)
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
