import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { guardState } from '../src/guard.ts'
import { isSubmitAction, normalizeKey, normalizeRef, registerDesktopTools } from '../src/tools.ts'
import { RefBook } from '../src/sessions.ts'

/**
 * The accessibility pair, exercised through its real execute path with a fake
 * context, so the refusals the model sees are the ones asserted here.
 *
 * Only the `app` path is tested: the `window_id` path spawns the real CLI, and a
 * unit test must not depend on a desktop session. Everything below is the
 * decision logic that decides whether a ref may be used and what the model is
 * told when it may not.
 */

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string }>
}

const snapshotData = {
  app: 'Notes',
  windowTitle: 'Untitled',
  snapshotId: 's1',
  refCount: 1,
  complete: true,
  tree: {
    role: 'window',
    name: 'Untitled',
    children: [{ role: 'button', name: 'Save', ref: '@s1:e2', actions: ['Click'] }],
  },
}

/** A tree with enough addressable elements that it is not called thin. */
const richSnapshot = {
  ...snapshotData,
  refCount: 4,
  tree: {
    role: 'window',
    name: 'Untitled',
    children: [
      { role: 'button', name: 'Save', ref: '@s1:e2', actions: ['Click'] },
      { role: 'button', name: 'Close', ref: '@s1:e3', actions: ['Click'] },
      { role: 'textfield', name: 'Title', ref: '@s1:e4', actions: ['SetValue'] },
      { role: 'button', name: 'Share', ref: '@s1:e5', actions: ['Click'] },
    ],
  },
}

function harness(options: {
  snapshot?: object
  denyHeadless?: boolean
  timeoutHeadless?: boolean
  accessible?: boolean
  frontmost?: string
  surfaces?: readonly string[]
  findResult?: import('../src/protocol.ts').FindResult
  bounds?: import('../src/protocol.ts').ElementBounds
} = {}) {
  const tools = new Map<string, ToolLike>()
  const calls: { op: string; policy?: number; action?: { kind?: string; text?: string; key?: string }; depth?: number; timeout_ms?: number }[] = []
  const cliCalls: readonly string[][] = []
  const snapshotCalls: { windowId: string; options: Record<string, unknown> }[] = []
  const refs = new RefBook()
  const client = {
    alive: true,
    async request(request: { op: string; policy?: number; action?: { kind?: string; text?: string; key?: string }; depth?: number; timeout_ms?: number }) {
      calls.push(request)
      switch (request.op) {
        case 'snapshot': return options.snapshot ?? snapshotData
        case 'state': return { idleMs: 120_000, app: options.frontmost ?? 'Word' }
        case 'act':
          if (options.denyHeadless === true && request.policy === 0) {
            throw Object.assign(new Error('Target is not actionable: supported_action'), {
              code: 'POLICY_DENIED',
              delivery: 'not_delivered',
            })
          }
          if (options.timeoutHeadless === true) {
            throw Object.assign(new Error('Target did not become actionable within the wait budget'), {
              code: 'TIMEOUT',
              delivery: 'not_delivered',
              details: {
                kind: 'actionability_timeout',
                checks: [{ check: 'enabled', status: 'fail', reason: 'readonly' }],
              },
            })
          }
          return { action: request.action?.kind ?? 'click', ref_id: '@s1:e2', disposition: { delivery: 'delivered_verified' } }
        default: return {}
      }
    },
    async close() {},
  }
  const sessions = {
    async entry() {
      return { client, refs, lastUsed: Date.now() }
    },
  }
  // One window, on screen, with a tree: the shape the tree-first path expects.
  const windows = [{
    id: 'w-1',
    title: 'Untitled',
    appName: 'Notes',
    pid: 12,
    focused: true,
    accessible: options.accessible !== false,
    visible: true,
    bounds: { x: 0, y: 0, width: 900, height: 700 },
  }]
  const disposers: (() => void)[] = []
  const ctx = {
    tools: { register: (definition: ToolLike) => { tools.set(definition.name, definition) } },
    effect: (register: () => () => void) => {
      const dispose = register()
      disposers.push(dispose)
      return { dispose }
    },
    get: (_name: string) => undefined,
  }
  guardState().leases.clear()
  guardState().raised = undefined
  registerDesktopTools(ctx as never, sessions as never, resolveConfig(), {
    listWindows: async () => ({ ok: true, data: windows }),
    snapshot: async (windowId, snapOptions) => {
      snapshotCalls.push({ windowId, options: snapOptions as Record<string, unknown> })
      return { ok: true, data: (options.snapshot ?? snapshotData) as never }
    },
    find: async () => ({
      ok: true,
      data: options.findResult ?? {
        snapshotId: 's_find',
        matches: [{ ref: '@s_find:e7', role: 'combobox', name: '默认网页浏览器', value: 'Google Chrome' }],
      },
    }),
    getBounds: async () => ({
      ok: true,
      data: options.bounds ?? { x: 400, y: 500, width: 120, height: 30, live: true },
    }),
    listSurfaces: async () => options.surfaces ?? [],
    runCli: async (args) => {
      ;(cliCalls as string[][]).push([...args])
      return { ok: true, data: {} as never }
    },
  })
  const exec = { agent: { id: 'session-1' }, signal: AbortSignal.timeout(5_000) }
  return { tools, calls, cliCalls, snapshotCalls, exec }
}

test('registers the enhanced accessibility toolset', () => {
  const { tools } = harness()
  assert.deepEqual([...tools.keys()].sort(), ['desktop_act', 'desktop_batch', 'desktop_find', 'desktop_inspect'])
})

test('inspect renders the tree and remembers its refs', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const tool = tools.get('desktop_inspect')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes', depth: 2 }, exec)
  assert.match(result.text, /app "Notes"/)
  assert.match(result.text, /button "Save"/)
  const again = await tool.execute({ app: 'Notes', depth: 2 }, exec)
  assert.match(again.text, /snapshot s1/)
})

test('a thin tree sends the model to the picture instead of another read', async () => {
  const { tools, exec } = harness()
  const tool = tools.get('desktop_inspect')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes' }, exec)
  assert.match(result.text, /tree_thin/)
  assert.match(result.text, /take desktop_see and point at what you see with desktop_click/)
  assert.doesNotMatch(result.text, /snapshot again/i)
})

test('inspect names the window and whether it has a tree', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const tool = tools.get('desktop_inspect')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes' }, exec)
  assert.match(result.text, /^window Notes w-1 900x700 front=yes tree=yes/)
})

test('a window with no tree is named as such before any read is attempted', async () => {
  const { tools, exec } = harness({ accessible: false })
  const tool = tools.get('desktop_inspect')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes' }, exec)
  assert.match(result.text, /tree=no/)
  assert.match(result.text, /use desktop_see with this window id/)
  assert.doesNotMatch(result.text, /button "Save"/, 'nothing should be read from a window with no tree')
})

test('inspect resolves the window when only an app name is given', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const tool = tools.get('desktop_inspect')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes' }, exec)
  assert.match(result.text, /w-1/)
  assert.match(result.text, /button "Save"/)
})

test('a ref copied with the tree braces still works', () => {
  // The renderer prints refs as {@s1:e4}; a model that copies one verbatim used
  // to be told it belonged to no snapshot and then abandoned the tree entirely.
  assert.equal(normalizeRef('{@s1:e4}'), '@s1:e4')
  assert.equal(normalizeRef('  @s1:e4  '), '@s1:e4')
  assert.equal(normalizeRef('"@s1:e4"'), '@s1:e4')
  assert.equal(normalizeRef('w-35573:e4'), 'w-35573:e4')
})

test('a braced ref the model was shown can be acted on', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '{@s1:e2}', action: 'click' }, exec)
  assert.match(result.text, /^ok/)
})

test('a malformed ref is told the prefix it should have used', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: 'w-1:e22', action: 'click' }, exec)
  assert.match(result.text, /UNKNOWN_REF/)
  assert.match(result.text, /snapshot s1/)
  assert.match(result.text, /@s1:e22/)
})

test('act refuses a ref that was never shown', async () => {
  const { tools, exec } = harness()
  const act = tools.get('desktop_act')
  assert.ok(act)
  const result = await act.execute({ ref: '@nope:e1', action: 'click' }, exec)
  assert.match(result.text, /UNKNOWN_REF/)
})

test('act refuses a snapshot ref the model never saw', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e99', action: 'click' }, exec)
  assert.match(result.text, /REF_NOT_SHOWN/)
})

test('act runs a known ref and reports the disposition', async () => {
  const { tools, exec, calls } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /ok · click · @s1:e2 · delivery=delivered_verified/)
  assert.ok(calls.some(call => call.op === 'act'))
})

test('act needs text for a typed action', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  await assert.rejects(() => act.execute({ ref: '@s1:e2', action: 'type_text' }, exec), /needs text/)
})

test('act returns the new tree so the next step needs no separate read', async () => {
  const { tools, exec, calls } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const before = calls.filter(call => call.op === 'snapshot').length
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  // One action, one observation: exactly one read, inside the same call.
  const after = calls.filter(call => call.op === 'snapshot').length
  assert.equal(after - before, 1, 'the act result should carry exactly one follow-up read')
  assert.match(result.text, /--- Notes now ---/)
  assert.match(result.text, /button "Save"/)
})

test('the follow-up read re-arms the ref book', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  // The refs from the follow-up read must be usable on the next call.
  const again = await act.execute({ ref: '@s1:e4', action: 'set_value', text: 'x' }, exec)
  assert.doesNotMatch(again.text, /UNKNOWN_REF|REF_NOT_SHOWN/)
})

test('a refused repeat still shows what the window looks like now', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  const repeat = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(repeat.text, /IDENTICAL_ACTION/)
  assert.match(repeat.text, /--- Notes now ---/, 'the refusal should say what the window looks like')
})

test('a control with no semantic action is clicked by its own frame instead of a guessed point', async () => {
  // Settings rows advertise no semantic action. The frame click is the precise
  // physical route — the model never has to guess a coordinate.
  const { tools, exec, calls } = harness({ snapshot: richSnapshot, denyHeadless: true, frontmost: 'Notes' })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /^ok/)
  assert.match(result.text, /clicked by its own frame/)
  assert.deepEqual(calls.filter(call => call.op === 'act').map(call => call.policy), [0, 2])
})

test('a control with no semantic action stays refused when the window is not in front', async () => {
  const { tools, exec, calls } = harness({ snapshot: richSnapshot, denyHeadless: true, frontmost: 'Word' })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /POLICY_DENIED/)
  assert.match(result.text, /retry this same ref/)
  assert.deepEqual(calls.filter(call => call.op === 'act').map(call => call.policy), [0])
})

test('submitting warns against pressing again', async () => {
  const { tools, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'press_key', key: 'Return' }, exec)
  assert.match(result.text, /submit was sent/)
  assert.doesNotMatch(result.text, /INVALID_ARGS/)
})

test('key aliases and submit detection', () => {
  assert.equal(normalizeKey('Return'), 'enter')
  assert.equal(normalizeKey('ESC'), 'escape')
  assert.equal(normalizeKey('s'), 's')
  assert.equal(isSubmitAction({ kind: 'press_key', key: 'enter' }), true)
  assert.equal(isSubmitAction({ kind: 'press_key', key: 'tab' }), false)
  assert.equal(isSubmitAction({ kind: 'click' }), false)
})

test('inspect surfaces open overlays and passes depth up to 32, skeleton, include_text, and root drill', async () => {
  const withSurfaces = { ...richSnapshot, windowId: 'w-1', surfaces: ['menu'] }
  const { tools, snapshotCalls, exec } = harness({ snapshot: withSurfaces })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)

  const res = await inspect.execute({ app: 'Notes', depth: 24, skeleton: true, include_text: true }, exec)
  assert.match(res.text, /overlay\(s\) now open: menu/)
  assert.equal(snapshotCalls[0]?.options.depth, 24)
  assert.equal(snapshotCalls[0]?.options.skeleton, true)
  assert.equal(snapshotCalls[0]?.options.interactive, false)

  // Follow-up read after act must preserve depth=24 (never collapse to depth 3).
  await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.equal(snapshotCalls[1]?.options.depth, 24)
  assert.equal(snapshotCalls[1]?.options.interactive, false)
})

test('desktop_inspect root drill keeps outer refs valid in RefBook', async () => {
  const { tools, exec } = harness({
    snapshot: {
      ...richSnapshot,
      windowId: 'w-1',
    },
  })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const drilled = await inspect.execute({ root: '@s1:e2', depth: 10 }, exec)
  assert.match(drilled.text, /^drilled @s1:e2/)
  // Outer ref @s1:e5 from the initial snapshot must still be usable.
  const acted = await act.execute({ ref: '@s1:e5', action: 'click' }, exec)
  assert.match(acted.text, /^ok/)
})

test('desktop_find registers refs for immediate desktop_act and shows roles_present on miss', async () => {
  const { tools, exec } = harness({
    findResult: {
      snapshotId: 's_find',
      matches: [
        { ref: '@s_find:e11', role: 'combobox', name: '默认网页浏览器', value: 'Google Chrome', states: ['readonly'] },
        { role: 'statictext', name: '默认网页浏览器', bounds: { x: 10, y: 20, width: 80, height: 18 } },
      ],
    },
  })
  const find = tools.get('desktop_find')
  const act = tools.get('desktop_act')
  assert.ok(find && act)

  const found = await find.execute({ app: 'Notes', query: '默认网页浏览器' }, exec)
  assert.match(found.text, /2 match\(es\)/)
  assert.match(found.text, /@s_find:e11/)
  assert.match(found.text, /\[bounds 10,20 80x18\]/)

  const selected = await act.execute({ ref: '@s_find:e11', action: 'select', text: 'Safari浏览器' }, exec)
  assert.match(selected.text, /^ok/)

  const missHarness = harness({
    findResult: { snapshotId: 's_empty', matches: [], rolesPresent: ['button', 'combobox'] },
  })
  const miss = await missHarness.tools.get('desktop_find')!.execute({ app: 'Notes', role: 'menu' }, exec)
  assert.match(miss.text, /0 matches/)
  assert.match(miss.text, /roles present: button, combobox/)
})

test('desktop_act requires text for select and supports submit=true on set_value', async () => {
  const { tools, calls, exec } = harness({ snapshot: richSnapshot })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)

  await assert.rejects(() => act.execute({ ref: '@s1:e2', action: 'select' }, exec), /select needs text/)

  const res = await act.execute({ ref: '@s1:e4', action: 'set_value', text: 'hello', submit: true }, exec)
  assert.match(res.text, /^ok/)
  assert.match(res.text, /submit was sent/)
  const actCalls = calls.filter(c => c.op === 'act')
  assert.equal(actCalls.length, 2)
  assert.equal(actCalls[0]?.action?.kind, 'set_value')
  assert.equal(actCalls[1]?.action?.kind, 'press_key')
  assert.equal(actCalls[1]?.action?.key, 'enter')
})

test('desktop_act escalates TIMEOUT on expand to scroll-to + exact AX bounds click', async () => {
  const withWindow = { ...richSnapshot, windowId: 'w-1' }
  const { tools, cliCalls, exec } = harness({
    snapshot: withWindow,
    timeoutHeadless: true,
    frontmost: 'Notes',
    bounds: { x: 400, y: 500, width: 120, height: 30, live: true },
  })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)

  const res = await act.execute({ ref: '@s1:e2', action: 'expand' }, exec)
  assert.match(res.text, /^ok/)
  assert.match(res.text, /exact AX bounds center at screen \(460,515\)/)
  assert.ok(cliCalls.some(args => args[0] === 'scroll-to' && args[1] === '@s1:e2'))
  assert.ok(cliCalls.some(args => args[0] === 'mouse-click' && args.includes('460,515')))
})

test('desktop_batch runs multiple steps with one follow-up read and blocks duplicate submits', async () => {
  const { tools, calls, snapshotCalls, exec } = harness({ snapshot: { ...richSnapshot, windowId: 'w-1' } })
  const inspect = tools.get('desktop_inspect')
  const batch = tools.get('desktop_batch')
  assert.ok(inspect && batch)
  await inspect.execute({ app: 'Notes' }, exec)
  const snapsBefore = snapshotCalls.length

  const res = await batch.execute({
    steps: [
      { ref: '@s1:e4', action: 'set_value', text: 'hi' },
      { ref: '@s1:e4', action: 'press_key', key: 'Return' },
      { ref: '@s1:e4', action: 'press_key', key: 'Return' },
    ],
  }, exec)
  assert.match(res.text, /\[1\] ok/)
  assert.match(res.text, /\[2\] ok/)
  assert.match(res.text, /\[3\] SUBMIT_GUARD/)
  assert.equal(snapshotCalls.length - snapsBefore, 1, 'batch should perform exactly one follow-up tree read')
  assert.equal(calls.filter(c => c.op === 'act').length, 2, 'second submit must never be dispatched')
})

test('desktop_act escalates Windows POLICY_DENIED on type_text and press_key to headed delivery', async () => {
  const { tools, calls, cliCalls, exec } = harness({
    snapshot: { ...richSnapshot, windowId: 'w-1' },
    denyHeadless: true,
    frontmost: 'Word',
  })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)

  const typed = await act.execute({ ref: '@s1:e4', action: 'type_text', text: 'hello' }, exec)
  assert.match(typed.text, /^ok/)
  assert.ok(cliCalls.some(args => args[0] === 'focus-window' && args.includes('w-1')))
  assert.deepEqual(calls.filter(c => c.op === 'act').map(c => c.policy), [0, 2])
})
