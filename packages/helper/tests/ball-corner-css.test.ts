import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_ANCHOR, CHROME_INSET, PANEL_INSET } from '../src/geometry.ts'

/**
 * The renderer's half of the fixed-origin contract, checked against the real stylesheet.
 *
 * The window is one 1008x792 rectangle in every direction and the ball is parked at
 * `BALL_ANCHOR` inside it, so `#ball` must NOT vary with the expand direction at all.
 * What varies is the PANEL: each `body.expand-*` rule contributes exactly one of
 * `--panel-left` / `--panel-top`, and `#panel` reads them.
 *
 * The specificity guard below is the important half, and it is not theoretical. When
 * each rule set BOTH axes, all four selectors had equal specificity, so the last rule in
 * the file won the axis it did not own. `expand-down` is last, so `left`+`down` (the
 * top-right of the screen) and `right`+`up` (the bottom-left) painted the ball on the
 * wrong edge while the two same-side corners looked correct. The ball then sat outside
 * the rectangle the helper hit-tests: no hover, no click, no expand - a picture.
 */

const here = dirname(fileURLToPath(import.meta.url))
const rawCss = readFileSync(join(here, '..', 'assets', 'floating.css'), 'utf8')
// Comments document the shipped values and would confuse declaration lookups.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

const DIRECTIONS = ['left', 'right', 'up', 'down'] as const

/** The declaration block of one `body.expand-*` rule matching `suffix`. */
function rule(axis: string, suffix: string): string | undefined {
  const pattern = new RegExp(`body\\.expand-${axis}${suffix}\\s*\\{([^}]*)\\}`)
  const match = css.match(pattern)
  return match?.[1]
}

/** Every `body.expand-*` block in the file, with the selector that owns it. */
function expandRules(): { selector: string; block: string }[] {
  const found: { selector: string; block: string }[] = []
  const pattern = /body\.expand-(left|right|up|down)([^{]*)\{([^}]*)\}/g
  for (const match of css.matchAll(pattern)) {
    found.push({ selector: `body.expand-${match[1]}${match[2].trim()}`, block: match[3] })
  }
  return found
}

/** True when the block declares `property` at all. */
function sets(block: string, property: string): boolean {
  return new RegExp(`(^|;|\\s)${property}\\s*:`).test(block)
}

/** The declared value of one custom property, trimmed. */
function value(block: string, property: string): string {
  const match = block.match(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`))
  assert.ok(match, `${property} is not declared`)
  return match[1].trim()
}

/** The block of the `#ball` rule itself, excluding any `body.*` descendant rules. */
function ballBaseRule(): string {
  const match = css.match(/(?:^|\n)#ball\s*\{([^}]*)\}/)
  assert.ok(match, '#ball is not declared in floating.css')
  return match[1]
}

describe('the ball never varies with the expand direction', () => {
  it('has no body.expand-* #ball rule at all', () => {
    for (const axis of DIRECTIONS) {
      assert.equal(
        rule(axis, ' #ball'),
        undefined,
        `body.expand-${axis} #ball still exists: the ball is direction-independent now, ` +
          'so a per-direction override can only move it off its anchor',
      )
    }
  })

  it('pins the ball to the anchor with direction-independent declarations', () => {
    const block = ballBaseRule()
    // The ball sits at BALL_ANCHOR (468,360) in the free window and never moves with the
    // direction: that fixed position is what lets the window origin stay put on a
    // direction flip, which is what removes the stale frame. Written as literal pixels
    // derived from the shared constants rather than from --chrome, because the anchor is
    // the window's centre and no longer a chrome inset. It must not be moved by an
    // `auto` side or a transform.
    assert.equal(value(block, 'left'), `${BALL_ANCHOR.x}px`)
    assert.equal(value(block, 'top'), `${BALL_ANCHOR.y}px`)
    assert.ok(!sets(block, 'right'), '#ball must not also set `right`')
    assert.ok(!sets(block, 'bottom'), '#ball must not also set `bottom`')
    assert.ok(!sets(block, 'transform'), '#ball must not be offset by a transform')
  })
})

describe('each direction rule owns exactly one panel offset', () => {
  it('declares exactly one of --panel-left / --panel-top per expansion rule', () => {
    let checked = 0
    for (const { selector, block } of expandRules()) {
      const left = sets(block, '--panel-left')
      const top = sets(block, '--panel-top')
      if (!left && !top) continue
      checked += 1
      // The regression: one rule owning both axes wins the other axis by source order,
      // because every `body.expand-*` selector has identical specificity.
      assert.equal(
        Number(left) + Number(top),
        1,
        `${selector} sets ${left ? '--panel-left' : ''}${left && top ? ' and ' : ''}${top ? '--panel-top' : ''}: ` +
          'exactly one axis per rule, or the last rule in the file silently wins the other',
      )
      // And it must not take over the ball's own box either.
      for (const property of ['left', 'top', 'right', 'bottom']) {
        assert.ok(
          !sets(block, property),
          `${selector} must not set \`${property}\`: it would move the ball`,
        )
      }
    }
    assert.equal(checked, 4, 'expected one panel offset from each of the four directions')
  })

  it('resolves the four panel offsets to the contracted values', () => {
    // `left` opens the panel on the LEFT, so its near edge is one strip reserve in from
    // the window edge; `right` puts the panel's near edge on the ball. Vertically nothing
    // changed: the strip is horizontal only.
    const expected: Record<string, string> = {
      left: `${PANEL_INSET}px`,
      right: `${BALL_ANCHOR.x}px`,
      up: `${CHROME_INSET}px`,
      down: `${BALL_ANCHOR.y}px`,
    }
    for (const [axis, wanted] of Object.entries(expected)) {
      const block = rule(axis, '')
      assert.ok(block, `body.expand-${axis} is not declared`)
      const property = axis === 'left' || axis === 'right' ? '--panel-left' : '--panel-top'
      assert.equal(
        value(block, property),
        wanted,
        `body.expand-${axis} must set ${property}: ${wanted}, i.e. the panel edge that abuts the ball`,
      )
    }
  })

  it('keeps --chrome at the inset geometry.ts uses', () => {
    const chrome = css.match(/--chrome\s*:\s*([^;]+);/)
    assert.ok(chrome, '--chrome is not declared in floating.css')
    assert.equal(chrome[1].trim(), '12px')
    assert.equal(CHROME_INSET, 12)
    // The anchor the four offsets are expressed against, from the shared constants: the
    // ball is the window's centre, with a panel and a strip slot to either side.
    assert.equal(BALL_ANCHOR.x, 468)
    assert.equal(BALL_ANCHOR.y, 360)
    assert.equal(PANEL_INSET, 220)
  })

  it('positions the panel from those two variables', () => {
    const block = rule('left', ' #panel') ?? css.match(/(?:^|\n)#panel\s*\{([^}]*)\}/)?.[1]
    assert.ok(block, '#panel is not declared')
    assert.ok(
      sets(block, 'left') || sets(block, 'inset'),
      '#panel has to consume `--panel-left` through `left` (or `inset`)',
    )
    assert.ok(
      /var\(--panel-(left|top)\)/.test(css),
      'no rule reads `--panel-left`/`--panel-top`: the per-direction offsets are dead',
    )
  })
})