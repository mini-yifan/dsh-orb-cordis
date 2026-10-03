import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Small source-level regression for one shipped defect: `micState` could wedge
 * at 'requesting'/'transcribing' because a superseded generation `return`ed
 * bare after the transient state was set, permanently blocking
 * `scheduleCollapse` and disabling the mic button.
 *
 * This is intentionally a textual check of the shipped asset, not a timing
 * harness; the visuals are verified by eye.
 */

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')

/** The body of one `function name(...) { ... }` declaration, brace-matched. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} is missing`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  assert.fail(`${name} is not brace-balanced`)
}

describe('voice transient states always resolve', () => {
  it('has no bare early return after a transient state is set', () => {
    for (const name of ['startVoice', 'finishVoice']) {
      const body = functionBody(shell, name)
      assert.equal(
        /if\s*\(\s*generation\s*!==\s*micGeneration\s*\)\s*return\b/.test(body),
        false,
        `${name} must not return bare while micState may be transient`,
      )
    }
  })

  it('routes every superseded exit through the state reset', () => {
    for (const name of ['startVoice', 'finishVoice']) {
      const body = functionBody(shell, name)
      assert.match(body, /resetVoiceState\(/, `${name} must reset the voice state on its exits`)
      assert.match(
        shell,
        /async function resetVoiceState\([\s\S]*?await disposeMicCapture\(\)[\s\S]*?setMicState\(/,
        'resetVoiceState must dispose the capture before setting a sane state',
      )
    }
  })

  it('does not let a stuck transient state block collapse forever', () => {
    const schedule = functionBody(shell, 'scheduleCollapse')
    assert.equal(
      /micState\s*!==\s*'idle'/.test(schedule),
      false,
      'scheduleCollapse must not gate on a raw micState comparison',
    )
    assert.match(schedule, /micBlocksCollapse\(\)/)
    const guard = functionBody(shell, 'micBlocksCollapse')
    assert.match(guard, /MIC_TRANSIENT_STUCK_MS/, 'the wedge age must be enforced')
    assert.match(shell, /const MIC_TRANSIENT_STUCK_MS = 30_000/)
  })
})
