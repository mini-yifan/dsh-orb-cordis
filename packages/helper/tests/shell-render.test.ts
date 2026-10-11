import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The ball page is a browser-only module (window/document at import time), so
 * these rendering fixes are pinned at the source level, the way drag-input and
 * transcript-model guard shell.js. Comments are stripped: only live code counts.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const code = shell.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
const highlight = readFileSync(join(here, '../assets/highlight.js'), 'utf8')

describe('ball page render guards', () => {
  it('appends the web-fetch meta without the undefined url reference', () => {
    assert.match(code, /fetch\.append\(meta\)/)
    assert.equal(code.includes('fetch.append(url'), false)
  })

  it('keeps drawing the rest of a frame when one item fails', () => {
    assert.match(code, /for \(const item of list\) \{\s*try \{/)
    assert.match(code, /catch \(error\) \{\s*console\.error\(/)
  })

  it('builds chip icons as nodes instead of innerHTML strings', () => {
    assert.match(code, /status\.replaceChildren\(icon\(/)
    assert.equal(code.includes('status.innerHTML = icon('), false)
  })

  it('keeps the card expander mounted while it toggles the hidden rows', () => {
    assert.equal(code.includes('expand.remove()'), false)
    assert.match(code, /target\.insertBefore\(row, expand\)/)
    assert.match(code, /expand\.textContent = open \? chatLabels\.collapse/)
  })

  it('copies the rows the tool cards show, read at click time', () => {
    // The reader runs on click, so the clipboard follows the cap and the expander.
    assert.match(code, /copyText\(copy, \(\) => terminalCopyText\(/)
    assert.match(code, /querySelectorAll\('\.term-line'\)/)
    assert.match(code, /copyText\(copy, \(\) => readCopyText\(/)
    assert.match(code, /querySelectorAll\('\.read-content'\)/)
    assert.match(code, /copyText\(copy, \(\) => searchCopyText\(/)
    assert.match(code, /querySelectorAll\('\.search-file-path, \.search-line'\)/)
  })

  it('re-upgrades tracked roots once a lazy grammar lands', () => {
    assert.match(highlight, /const root = ref\.deref\(\)/)
    assert.match(highlight, /upgradeCodeBlocks\(root, \{ track: false \}\)/)
  })
})
