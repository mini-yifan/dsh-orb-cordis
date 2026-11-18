import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { guardState } from '../src/guard.ts'
import { isSubmitAction, normalizeKey, registerDesktopTools } from '../src/tools.ts'
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

function harness(options: { snapshot?: object, denyHeadless?: boolean } = {}) {
  const tools = new Map<string, ToolLike>()
  const calls: { op: string, policy?: number }[] = []
  const refs = new RefBook()
  const client = {
    alive: true,
    async request(request: { op: string, policy?: number }) {
      calls.push(request)
      switch (request.op) {
        case 'snapshot': return options.snapshot ?? snapshotData
        case 'act':
          if (options.denyHeadless === true && request.policy === 0) {
            throw Object.assign(new Error('Target is not actionable: supported_action'), {
              code: 'POLICY_DENIED',
              delivery: 'not_delivered',
            })
          }
          return { action: 'click', ref_id: '@s1:e2', disposition: { delivery: 'delivered_verified' } }
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
  registerDesktopTools(ctx as never, sessions as never, resolveConfig())
  const exec = { agent: { id: 'session-1' } }
  return { tools, calls, exec }
}

test('registers the accessibility pair and nothing else', () => {
  const { tools } = harness()
  assert.deepEqual([...tools.keys()].sort(), ['desktop_act', 'desktop_inspect'])
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

test('a control with no semantic path is not forced, and the picture route is named', async () => {
  const { tools, exec, calls } = harness({ snapshot: richSnapshot, denyHeadless: true })
  const inspect = tools.get('desktop_inspect')
  const act = tools.get('desktop_act')
  assert.ok(inspect && act)
  await inspect.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /POLICY_DENIED/)
  assert.match(result.text, /desktop_see and desktop_click/)
  // No physical escalation: one attempt, headless only.
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
