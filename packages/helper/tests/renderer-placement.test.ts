import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it } from 'node:test'
import { BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement, type DisplayPair, type ExpandState, type Rect } from '../src/geometry.ts'

const primary = pair(0, 0, 1920, 1080)
const left = pair(-1463, 0, 1463, 914)
const upper = pair(0, -1080, 1920, 1080)
const shell = readFileSync(new URL('../assets/shell.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../assets/floating.css', import.meta.url), 'utf8')

describe('expanded placement through the renderer IPC consumers', () => {
  for (const mode of ['running', 'asking'] as const) {
    for (const target of [{ x: -821, y: 168 }, { x: 200, y: -800 }]) {
      it(`${mode}: keeps the visible ball at (${target.x}, ${target.y}) during a cross-display drag`, async () => {
        const f = fixture([left, upper, primary], 1848, 900)
        const renderer = rendererFixture(f, f.placement.setExpanded(true), mode)
        await renderer.moveBall(target.x, target.y)
        assert.deepEqual(renderer.ball(), target)
        await renderer.clampBall()
        assert.deepEqual(renderer.ball(), target)
      })
    }

    it(`${mode}: keeps the visible ball fixed when clamp recalculates direction after a work-area change`, async () => {
      const f = fixture([primary], 300, 300)
      const renderer = rendererFixture(f, f.placement.setExpanded(true), mode)
      const before = renderer.ball()
      f.displays = [{ ...primary, workArea: { x: 0, y: 0, width: 500, height: 1080 } }]
      await renderer.clampBall()
      assert.deepEqual(renderer.ball(), before)
    })
  }
})

function rendererFixture(f: ReturnType<typeof fixture>, state: ExpandState, mode: 'running' | 'asking') {
  const classes = new Set<string>()
  const ballSize = Number(css.match(/--ball:\s*(\d+)px;/)[1])
  const chrome = Number(css.match(/--chrome:\s*(\d+)px;/)[1])
  assert.match(css, /body\.expand-left #ball\s*\{[^}]*right:\s*var\(--chrome\)/)
  assert.match(css, /body\.expand-up #ball\s*\{[^}]*bottom:\s*var\(--chrome\)/)
  function extract(name: string) {
    const match = shell.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`))
    assert.ok(match, `renderer function ${name} exists`)
    return match[0]
  }
  const context = vm.createContext({
    document: { body: { classList: { toggle(name: string, enabled: boolean) { enabled ? classes.add(name) : classes.delete(name) } } } },
    api: {
      move: async (x: number, y: number, canDock: boolean) => {
        assert.equal(canDock, false)
        return f.placement.move(x, y, canDock)
      },
      clamp: async (canDock: boolean) => {
        assert.equal(canDock, false)
        return f.placement.clamp(canDock)
      },
    },
    running: mode === 'running', asking: () => mode === 'asking',
    // Both states disable docking, so its unrelated UI updates are excluded.
    applyDocked: (side: unknown) => { assert.equal(side, undefined) },
  })
  vm.runInContext(['applyDirection', 'applyDockedFrom', 'moveBall', 'clampBall'].map(extract).join('\n'), context)
  context.applyDirection(state)
  return {
    moveBall: context.moveBall,
    clampBall: context.clampBall,
    // Compute the visible ball from the actual CSS rules, independently of geometry's direction.
    ball: () => ({
      x: f.bounds.x + (classes.has('expand-left') ? f.bounds.width - chrome - ballSize : chrome),
      y: f.bounds.y + (classes.has('expand-up') ? f.bounds.height - chrome - ballSize : chrome),
    }),
  }
}

function pair(x: number, y: number, width: number, height: number): DisplayPair {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function fixture(displays: DisplayPair[], x: number, y: number) {
  const f = {
    displays,
    bounds: { x: x - CHROME_INSET, y: y - CHROME_INSET, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE },
    placement: undefined as unknown as FloatingPlacement,
  }
  f.placement = new FloatingPlacement({
    getBounds: () => ({ ...f.bounds }),
    setBounds: (next: Rect) => { f.bounds = { ...next } },
  }, (point) => {
    const contained = f.displays.find(({ bounds }) => point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height)
    assert.ok(contained, 'test ball belongs to a display')
    return contained
  }, () => f.displays.map(({ bounds }) => bounds))
  return f
}
