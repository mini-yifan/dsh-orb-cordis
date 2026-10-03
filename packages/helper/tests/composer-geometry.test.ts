import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Regression test for the caret/hit-test offset inside the ball's composer.
 *
 * Proven root cause: `#prompt.prompt-empty::after` centres the placeholder by
 * giving it a line box of `--ball - 2 * --prompt-pad`, while the real editable
 * line box starts at `--prompt-pad` from the prompt's top. Those two agree only
 * when `--prompt-pad == (--ball - --prompt-line) / 2`. With the old hardcoded
 * `12px` the placeholder was painted at the pill centre but the caret a click
 * on it produced was 15px higher (pill centre 396 vs real text centre 381 on a
 * 72px ball). These tests evaluate the shipped CSS formulas and fail if the two
 * origins ever disagree again.
 */

const here = dirname(fileURLToPath(import.meta.url))
const rawCss = readFileSync(join(here, '..', 'assets', 'floating.css'), 'utf8')
// Strip comments first: the shipped CSS documents its own values in comments,
// and a `;` or `{` inside one would otherwise confuse the declaration lookups.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
const html = readFileSync(join(here, '..', 'assets', 'floating.html'), 'utf8')

/** Read one custom property's raw value from the `:root` block. */
function rootProperty(name: string): string {
  const match = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  assert.ok(match, `--${name} is not declared in floating.css`)
  return match[1].trim()
}

/** Read one declaration's raw value from a selector block. */
function declaration(selector: string, property: string): string {
  const block = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`))
  assert.ok(block, `${selector} block is missing from floating.css`)
  const found = block[1].match(new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+);`))
  assert.ok(found, `${property} is missing from ${selector}`)
  return found[1].trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Evaluate the `calc()` subset the composer uses over resolved variables.
 * Supports an optional `calc()` wrapper, `+ - * /`, parentheses, numbers with
 * CSS units, and `var(--x)` lookups.
 */
function evaluate(expression: string, variables: Record<string, number>): number {
  let source = expression.replace(/\s+/g, '')
  const calc = /^calc\((.*)\)$/.exec(source)
  if (calc) source = calc[1]
  let index = 0

  function parseExpression(): number {
    let value = parseTerm()
    while (source[index] === '+' || source[index] === '-') {
      const operator = source[index++]
      const right = parseTerm()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (source[index] === '*' || source[index] === '/') {
      const operator = source[index++]
      const right = parseFactor()
      value = operator === '*' ? value * right : value / right
    }
    return value
  }

  function parseFactor(): number {
    if (source[index] === '(') {
      index++
      const value = parseExpression()
      assert.equal(source[index], ')', `unbalanced parentheses in ${expression}`)
      index++
      return value
    }
    if (source.startsWith('var(', index)) {
      index += 4
      const end = source.indexOf(')', index)
      const name = source.slice(index, end).replace(/^--/, '')
      index = end + 1
      const value = variables[name]
      assert.ok(value !== undefined, `--${name} is not defined while evaluating ${expression}`)
      return value
    }
    const number = /^-?\d+(\.\d+)?/.exec(source.slice(index))
    assert.ok(number, `unexpected token in ${expression} at ${index}`)
    index += number[0].length
    // Skip a CSS unit suffix (px, em, ...) and the `deg` in `circle(36px at ...)`.
    while (index < source.length && /[a-z%]/i.test(source[index])) index++
    return Number(number[0])
  }

  const result = parseExpression()
  assert.equal(index, source.length, `trailing tokens in ${expression}`)
  return result
}

const BALL = Number.parseFloat(rootProperty('ball'))
const LINE = Number.parseFloat(rootProperty('prompt-line'))

/** Resolve every shipped composer variable, letting `overrides` stand in. */
function variables(overrides: Record<string, number> = {}): Record<string, number> {
  const base: Record<string, number> = { ball: BALL, 'prompt-line': LINE }
  // --prompt-pad is itself derived, so resolve it in terms of the primitives.
  base['prompt-pad'] = evaluate(rootProperty('prompt-pad'), base)
  return { ...base, ...overrides }
}

describe('composer text origin', () => {
  it('keeps the prompt padding derived from the ball, not hardcoded', () => {
    const pad = rootProperty('prompt-pad')
    assert.match(pad, /var\(--ball\)/, '--prompt-pad must reference --ball')
    assert.match(pad, /var\(--prompt-line\)/, '--prompt-pad must reference --prompt-line')
    assert.equal(/^\d/.test(pad), false, `--prompt-pad must not be a hardcoded length, found ${pad}`)
  })

  it('centres one line in the ball-height pill', () => {
    const pad = evaluate(rootProperty('prompt-pad'), variables())
    assert.equal(pad, (BALL - LINE) / 2)
    // The editable line box then starts and ends symmetrically inside the pill.
    assert.equal(pad + LINE + pad, BALL)
  })

  it('makes the empty-state line box exactly one editable line tall', () => {
    const pad = evaluate(rootProperty('prompt-pad'), variables())
    const after = declaration('#prompt.prompt-empty::after', 'line-height')
    assert.equal(
      evaluate(after, variables({ 'prompt-pad': pad })),
      LINE,
      'the placeholder line box must match --prompt-line or the caret drifts',
    )
  })

  it('agrees between the empty state and the typed state', () => {
    const pad = evaluate(rootProperty('prompt-pad'), variables())
    // Empty: the ::after line box spans [pad, pad + afterLineHeight].
    const afterHeight = evaluate(declaration('#prompt.prompt-empty::after', 'line-height'), variables({ 'prompt-pad': pad }))
    const emptyTop = pad
    const emptyCentre = emptyTop + afterHeight / 2
    // Typed: the first line box spans [pad, pad + --prompt-line].
    const typedTop = pad
    const typedCentre = typedTop + LINE / 2
    assert.equal(emptyTop, typedTop, 'both states must start at the same content origin')
    assert.equal(emptyCentre, typedCentre, 'the placeholder and the caret must share a centre line')
    assert.equal(emptyCentre, BALL / 2, 'that centre must be the pill centre')
  })

  it('keeps the ball-wrap spacer cancelling the padding exactly', () => {
    // `#prompt::before` is a ball-sized float whose negative top margin cancels
    // the prompt padding, so the ball stays flush with the pill. Changing the
    // padding without this formula would move the ball.
    const margin = declaration('#prompt::before', 'margin-top')
    assert.equal(evaluate(margin, variables()), -evaluate(rootProperty('prompt-pad'), variables()))
    assert.equal(declaration('#prompt::before', 'width'), 'var(--ball)')
    assert.equal(declaration('#prompt::before', 'height'), 'var(--composer-height)')
  })

  it('keeps the composer pill the full ball height', () => {
    assert.equal(declaration('#panel::after', 'height'), 'var(--composer-height)')
    assert.equal(declaration('#composer', 'height'), 'var(--composer-height)')
    assert.equal(rootProperty('composer-height'), 'var(--ball)')
  })
})

describe('microphone control', () => {
  it('is mounted inside the composer with every recording state', () => {
    assert.match(html, /<form id="composer">[\s\S]*<div id="mic"/, 'the mic control must live in the composer')
    assert.match(html, /id="mic-button"/)
    assert.match(html, /id="mic-cancel"/)
    assert.match(html, /id="mic-ring"/)
    assert.match(html, /id="mic-spinner"/)
    assert.match(html, /id="mic-retry"/)
  })

  it('sits at the pill end opposite the ball and never overlaps the wrap spacer', () => {
    // #prompt keeps `flex: 1` and the mic is `flex: none`, so the ball float
    // inside #prompt still wraps against the ball side of the pill.
    assert.equal(declaration('#prompt', 'flex'), '1')
    assert.match(declaration('#prompt', 'min-width'), /0/)
    assert.equal(declaration('#mic', 'flex'), 'none')
    // Row direction flips with the expansion so #prompt keeps the ball side.
    assert.match(css, /body\.expand-left #composer\s*\{[^}]*flex-direction:\s*row-reverse/)
    assert.match(css, /body\.expand-right #composer\s*\{[^}]*flex-direction:\s*row/)
  })

  it('keeps the microphone slot inside the placeholder line budget', () => {
    // Measured on the shipped assets: the empty prompt's content box is 224px,
    // the ball float plus its 8px shape-margin take 80px, and the localized
    // placeholder needs ~150px — so the mic slot must stay under ~24px or the
    // placeholder wraps into the pill's clipped second line. The composer gap
    // counts against the same budget and must stay 0.
    const micSize = evaluate(rootProperty('mic-size'), variables())
    assert.ok(micSize <= 24, `--mic-size is ${micSize}px; the placeholder needs the slot to stay <= 24px`)
    assert.ok(micSize >= 16, `--mic-size is ${micSize}px; smaller than a usable tap target`)
    assert.equal(declaration('#composer', 'gap'), '0')
    // The composer's horizontal padding must stay at the shipped 12px.
    assert.equal(declaration('#composer', 'padding'), '0 12px')
  })

  it('does not loosen the page CSP', () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)
    assert.ok(csp, 'floating.html must keep a Content-Security-Policy meta tag')
    const policy = csp[1]
    // Microphone capture needs no extra origin: no remote script or connect.
    assert.match(policy, /default-src 'self'/)
    assert.match(policy, /script-src 'self'/)
    assert.match(policy, /connect-src 'self' dsh-app:\/\/app/)
    assert.equal(/https?:\/\//.test(policy), false, 'the CSP must not gain a remote origin')
    assert.equal(/media-src/.test(policy), false, 'a media-src directive is not required for getUserMedia')
  })
})
