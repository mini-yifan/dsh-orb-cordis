import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { guardState } from '../src/guard.ts'
import { isSubmitAction, normalizeKey } from '../src/tools.ts'
import { RefBook } from '../src/sessions.ts'
import { registerDesktopTools } from '../src/tools.ts'

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

function harness(options: { frontmost?: string, denyHeadless?: boolean } = {}) {
  const tools = new Map<string, ToolLike>()
  const calls: { op: string, policy?: number }[] = []
  const activated: string[] = []
  const refs = new RefBook()
  const client = {
    alive: true,
    async request(request: { op: string, policy?: number }) {
      calls.push(request)
      switch (request.op) {
        case 'state': return { idleMs: 120_000, app: options.frontmost ?? 'Word', window: 'Doc' }
        case 'status':
          return { platform: 'macos', version: '1.2.0', permissions: { accessibility: { state: 'granted' } } }
        case 'apps': return [{ name: 'Notes', pid: 12, bundleId: 'com.apple.Notes' }]
        case 'snapshot': return snapshotData
        case 'act':
          if (options.denyHeadless === true && request.policy === 0) {
            throw Object.assign(new Error('Target is not actionable: supported_action'), {
              code: 'POLICY_DENIED',
              delivery: 'not_delivered',
            })
          }
          return { action: 'click', ref_id: '@s1:e2', disposition: { delivery: 'delivered_verified' } }
        case 'wait': return { found: true, elapsed_ms: 40 }
        default: return {}
      }
    },
    async close() {},
  }
  const sessions = {
    async entry() {
      return { client, refs, lastUsed: Date.now() }
    },
    async releaseForeground() {},
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
  registerDesktopTools(ctx as never, sessions as never, resolveConfig(), {
    activate: async (app: string) => {
      activated.push(app)
    },
  })
  const exec = { agent: { id: 'session-1' } }
  return { tools, calls, exec, activated }
}

test('registers the seven desktop tools', () => {
  const { tools } = harness()
  assert.deepEqual([...tools.keys()].sort(), [
    'desktop_act',
    'desktop_apps',
    'desktop_raise',
    'desktop_release',
    'desktop_snapshot',
    'desktop_status',
    'desktop_wait',
  ])
})

test('snapshot renders the tree and remembers its refs', async () => {
  const { tools, exec } = harness()
  const tool = tools.get('desktop_snapshot')
  assert.ok(tool)
  const result = await tool.execute({ app: 'Notes', depth: 2 }, exec)
  assert.match(result.text, /app "Notes"/)
  assert.match(result.text, /button "Save"/)
  const book = tools.get('desktop_act')
  assert.ok(book)
  const action = await tool.execute({ app: 'Notes', depth: 2 }, exec)
  assert.match(action.text, /snapshot s1/)
})

test('act refuses a ref that was never shown', async () => {
  const { tools, exec } = harness()
  const act = tools.get('desktop_act')
  assert.ok(act)
  const result = await act.execute({ ref: '@nope:e1', action: 'click' }, exec)
  assert.match(result.text, /UNKNOWN_REF/)
})

test('act refuses a snapshot ref the model never saw', async () => {
  const { tools, exec } = harness()
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e99', action: 'click' }, exec)
  assert.match(result.text, /REF_NOT_SHOWN/)
})

test('act runs a known ref and reports the disposition', async () => {
  const { tools, exec, calls } = harness()
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /ok · click · @s1:e2 · delivery=delivered_verified/)
  assert.ok(calls.some(call => call.op === 'act'))
})

test('act needs text for a typed action', async () => {
  const { tools, exec } = harness()
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  await assert.rejects(() => act.execute({ ref: '@s1:e2', action: 'type_text' }, exec), /needs text/)
})

test('status reports permission, front app and idle time', async () => {
  const { tools, exec } = harness()
  const status = tools.get('desktop_status')
  assert.ok(status)
  const result = await status.execute({}, exec)
  assert.match(result.text, /accessibility: granted/)
  assert.match(result.text, /frontmost: Word/)
  assert.match(result.text, /user idle: 120 s/)
})

test('apps lists running applications', async () => {
  const { tools, exec } = harness()
  const apps = tools.get('desktop_apps')
  assert.ok(apps)
  const result = await apps.execute({}, exec)
  assert.match(result.text, /Notes \(pid 12\)/)
})

test('wait reports what it matched', async () => {
  const { tools, exec } = harness()
  const wait = tools.get('desktop_wait')
  assert.ok(wait)
  const result = await wait.execute({ kind: 'window', title: 'Save', timeout_ms: 1000 }, exec)
  assert.match(result.text, /wait window finished · found=true/)
})

test('raise borrows the foreground when the user is away, without touching the real desktop', async () => {
  const { tools, exec, activated } = harness()
  const raise = tools.get('desktop_raise')
  assert.ok(raise)
  const result = await raise.execute({ app: 'Notes' }, exec)
  // The stub keeps reporting Word in front, so verification fails after the call.
  assert.match(result.text, /RAISE_FAILED: Notes did not come to the front/)
  assert.deepEqual(activated, ['Notes'])
})

test('release says when nothing was borrowed', async () => {
  const { tools, exec } = harness()
  const release = tools.get('desktop_release')
  assert.ok(release)
  const result = await release.execute({}, exec)
  assert.match(result.text, /nothing was borrowed/)
})

test('repeating the same action inside the guard window is refused', async () => {
  const { tools, exec } = harness()
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  const first = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(first.text, /^ok/)
  const second = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(second.text, /IDENTICAL_ACTION/)
})

test('a denied semantic action retries as physical input when the window is in front', async () => {
  const { tools, exec, calls } = harness({ frontmost: 'Notes', denyHeadless: true })
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /^ok/)
  assert.match(result.text, /physical input/)
  const policies = calls.filter(call => call.op === 'act').map(call => call.policy)
  assert.deepEqual(policies, [0, 2])
})

test('a denied semantic action stays denied when the window is not in front', async () => {
  const { tools, exec, calls } = harness({ frontmost: 'Word', denyHeadless: true })
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
  const result = await act.execute({ ref: '@s1:e2', action: 'click' }, exec)
  assert.match(result.text, /POLICY_DENIED/)
  assert.equal(calls.filter(call => call.op === 'act').length, 1)
})

test('submitting warns against pressing again', async () => {
  const { tools, exec } = harness()
  const snapshot = tools.get('desktop_snapshot')
  const act = tools.get('desktop_act')
  assert.ok(snapshot && act)
  await snapshot.execute({ app: 'Notes' }, exec)
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
