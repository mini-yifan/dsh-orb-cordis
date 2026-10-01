import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { OrbRuntime, type OrbContext } from '../src/orb.ts'
import { ProfileStore } from '../src/preferences.ts'
import type { TccRight, TccStatus } from '../src/tcc.ts'

const home = mkdtempSync(join(tmpdir(), 'orb-runtime-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'profile'), { recursive: true })
const orb = dshHomePath('dsh_orb')
const runtimes: OrbRuntime[] = []

after(() => {
  for (const runtime of runtimes) runtime.halt()
  rmSync(home, { recursive: true, force: true })
})

interface Row {
  sessionId: string
  cwd: string
  origin: string
  running?: boolean
  projections?: { values: Record<string, unknown> }
}

interface EventRow {
  type: string
  seq: number
  data: unknown
}

interface Harness {
  runtime: OrbRuntime
  store: ProfileStore
  profile: string
  calls: {
    create: { workspaceId?: string; sessionId?: string; agentPreset?: string }[]
    prompt: { sessionId?: string; content?: { text?: string }[] }[]
    cancel: { sessionId?: string }[]
    selectModel: { sessionId?: string; model?: string; reasoningEffort?: string; saveAsDefault?: boolean }[]
    workspace?: { path?: string }
  }
  savedDefaults: { provider: string; model: string; reasoningEffort?: string }[]
  listItems: Row[]
  pins: { preset: string; cwd?: string }[]
  inject: (sessionId: string, row: EventRow) => void
  stream: (sessionId: string, frame: Record<string, unknown>) => void
  question: (
    request: { agent?: { id?: string }; questions?: unknown },
    next: () => Promise<{ answers: { id: string; selected: string[] }[] }>,
  ) => Promise<{ answers: { id: string; selected: string[] }[] }>
  holdPrompt: () => void
  releasePrompt: () => void
  provided: Map<string, unknown>
}

function boot(extra: {
  tcc?: { status(): TccStatus; open(right: TccRight): Promise<void> }
} = {}): Harness {
  const profile = mkdtempSync(join(home, 'profile-'))
  const store = new ProfileStore(profile)
  const calls: Harness['calls'] = { create: [], prompt: [], cancel: [], selectModel: [] }
  const savedDefaults: Harness['savedDefaults'] = []
  const previousDefault = { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' }
  const sessions = new Map<string, { events: EventRow[]; header: { cwd: string; agentPreset: string } }>()
  const pins: Harness['pins'] = []
  const listItems: Row[] = []
  let promptGate = Promise.resolve()
  let releasePrompt = () => {}
  let question: Harness['question'] = async (_request, next) => next()
  let streamListener: ((payload: unknown) => void) | undefined
  const provided = new Map<string, unknown>()
  const replay: EventRow[] = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'notice' }, content: [{ type: 'text', text: '跳过' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [
            { type: 'text', text: '好' },
            { type: 'reasoning', text: '   ' },
            { type: 'tool-call', name: 'click', id: 'call-1' },
            { type: 'tool-call', name: 'click', id: 'call-2' },
          ],
        },
      },
    },
  ]
  const ctx = {
    webServer: { port: 9, register: () => () => {} },
    connection: {
      authenticatedUrl: (base: string) => `${base}/?token=secret`,
      admit: () => ({ peer: {} }),
    },
    workspaceController: {
      async create(request: { path: string }) {
        calls.workspace = request
        return { workspace: { workspaceId: 'ws-orb' } }
      },
    },
    sessionController: {
      async create(request: { workspaceId?: string; sessionId?: string; agentPreset?: string }) {
        calls.create.push(request)
        const sessionId = request.sessionId ?? `session-new-${calls.create.length}`
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            events: request.sessionId === 'session-keep' ? replay : [],
            header: { cwd: orb, agentPreset: 'computer-use' },
          })
        }
        return { sessionId }
      },
      async prompt(request: { sessionId?: string; content?: { text?: string }[] }) {
        calls.prompt.push(request)
        await promptGate
        return { accepted: true as const }
      },
      async list() {
        return { items: listItems }
      },
      async selectModel(request: Harness['calls']['selectModel'][number]) {
        calls.selectModel.push(request)
      },
      async cancel(request: { sessionId?: string }) {
        calls.cancel.push(request)
      },
      modelCatalog: () => ({
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }],
      }),
    },
    sessions: {
      get(id: string) {
        const row = sessions.get(id)
        if (!row) return undefined
        return { snapshotEvents: () => row.events, header: row.header }
      },
    },
    agentDefaultModel: {
      currentSelection: () => previousDefault,
      async saveSelection(selection: Harness['savedDefaults'][number]) {
        savedDefaults.push(selection)
      },
    },
    effect() {},
    get(name: string) {
      if (name === 'sessions') return ctx.sessions
      if (name === 'permissionPresets') {
        return {
          set(session: { header?: { cwd?: string } }, preset: string) {
            pins.push({ preset, cwd: session.header?.cwd })
          },
        }
      }
      return undefined
    },
    provide(name: string, value: unknown) {
      provided.set(name, value)
    },
    on(name: string, listener: (payload: unknown) => void, options?: { prepend?: boolean; global?: boolean }) {
      if (name === 'user-questions/request') {
        assert.equal(options?.prepend, true)
        question = listener as Harness['question']
      }
      if (name === 'agent/assistant-stream') {
        assert.equal(options?.global, true)
        streamListener = listener
      }
      return () => {}
    },
  }
  const runtime = new OrbRuntime(ctx as unknown as OrbContext, store, {
    startMonitor: () => undefined,
    ...extra.tcc === undefined ? {} : { tcc: extra.tcc },
  })
  runtime.attachQuestions()
  runtimes.push(runtime)
  return {
    runtime,
    store,
    profile,
    calls,
    savedDefaults,
    listItems,
    pins,
    inject(sessionId, row) {
      const row0 = sessions.get(sessionId)
      if (row0) row0.events.push(row)
    },
    stream(sessionId, frame) {
      streamListener?.({ agent: { session: { id: sessionId } }, frame })
    },
    get question() { return question },
    holdPrompt() {
      promptGate = new Promise((resolve) => { releasePrompt = resolve })
    },
    releasePrompt() { releasePrompt() },
    provided,
  }
}

async function connect(runtime: OrbRuntime) {
  const bound = await runtime.bind()
  const socket: Socket = createConnection({ host: '127.0.0.1', port: bound.port })
  const messages: Record<string, unknown>[] = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      const message = JSON.parse(part) as Record<string, unknown>
      messages.push(message)
      // Stand in for the helper's overlay ack, so a guard interval does not wait out its timeout.
      if (typeof message.type === 'string' && message.type.startsWith('overlay-') && typeof message.id === 'string') {
        socket.write(`${JSON.stringify({ type: 'overlay-ack', id: message.id })}\n`)
      }
    }
  })
  await once(socket, 'connect')
  socket.write(`${JSON.stringify({ type: 'hello', token: bound.token })}\n`)
  await waitFor(() => messages.some((message) => message.type === 'chrome'))
  return {
    messages,
    socket,
    send(message: unknown) { socket.write(`${JSON.stringify(message)}\n`) },
  }
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for the ball')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function keyOf(message: Record<string, unknown>): string {
  return typeof message.key === 'string' ? message.key : ''
}

function textOf(message: Record<string, unknown>): string {
  return typeof message.text === 'string' ? message.text : ''
}

describe('ball control socket', { concurrency: 1 }, () => {
  it('lists only Computer Use chats in dsh_orb and replays one when opened', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      for (let index = 0; index < 41; index += 1) {
        harness.listItems.push({
          sessionId: `session-row-${index}`,
          cwd: orb,
          origin: 'user',
          projections: { values: { agentPreset: 'computer-use', title: `标题${index}` } },
        })
      }
      harness.listItems.push(
        { sessionId: 'session-keep', cwd: orb, origin: 'user', running: false, projections: { values: { agentPreset: 'computer-use', title: '第一段' } } },
        { sessionId: 'session-sub', cwd: orb, origin: 'subagent', projections: { values: { title: '子代理' } } },
        { sessionId: 'session-else', cwd: '/tmp/nope', origin: 'user', projections: { values: { agentPreset: 'computer-use', title: '别处' } } },
        { sessionId: 'session-std', cwd: orb, origin: 'user', projections: { values: { agentPreset: 'standard', title: '标准' } } },
        { sessionId: 'session-child', cwd: join(orb, 'child'), origin: 'user', projections: { values: { agentPreset: 'computer-use', title: '子目录' } } },
        { sessionId: 'session-blank', cwd: orb, origin: 'user', running: true },
      )
      client.send({ type: 'history' })
      await waitFor(() => client.messages.some((message) => message.type === 'history'))
      const history = client.messages.find((message) => message.type === 'history') as { items: { sessionId: string; title: string }[] }
      assert.equal(history.items.length, 40)
      assert.equal(history.items.some((item) => item.sessionId === 'session-sub'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-else'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-std'), false)
      assert.equal(history.items.some((item) => item.sessionId === 'session-child'), false)
      assert.equal(history.items.some((item) => item.title === '子目录'), false)
      harness.listItems.splice(0, harness.listItems.length, harness.listItems.find((item) => item.sessionId === 'session-keep') as Row)
      const mark = client.messages.length
      client.send({ type: 'open', sessionId: 'session-keep' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'block' && message.text === 'click'))
      const blocks = client.messages.slice(mark).filter((message) => message.type === 'block')
      assert.deepEqual(blocks.map((message) => message.text), ['你好', '好', 'click', 'click'])
      assert.equal(blocks.some((message) => message.text === '跳过'), false)
      assert.equal(harness.calls.create.at(-1)?.sessionId, 'session-keep')
      assert.equal(harness.calls.create.at(-1)?.agentPreset, 'computer-use')
      const creates = harness.calls.create.length
      client.send({ type: 'open', sessionId: 'session-missing' })
      client.send({ type: 'open', sessionId: 'not-a-session' })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, creates)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('skips the helper chrome windows the helper reports', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      const guard = harness.provided.get('computerUseOverlayGuard') as {
        withCapture<T>(run: (session: { excludeWindowIds: readonly number[] }) => Promise<T>): Promise<T>
      }
      const exclusion = async (): Promise<readonly number[]> => {
        let ids: readonly number[] = []
        await guard.withCapture(async (session) => { ids = session.excludeWindowIds })
        return ids
      }
      const until = async (want: readonly number[]): Promise<void> => {
        const start = Date.now()
        for (;;) {
          const got = await exclusion()
          if (JSON.stringify(got) === JSON.stringify(want)) return
          if (Date.now() - start > 2000) throw new Error(`exclusion ids stayed ${JSON.stringify(got)}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      assert.deepEqual(await exclusion(), [])
      client.send({ type: 'chrome-windows', ids: [11, 22, 11] })
      await until([11, 22])
      // One bad entry drops the whole report: a partial list would leave some chrome skippable.
      client.send({ type: 'chrome-windows', ids: [11, -1] })
      await until([])
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('creates a session, changes both models and access, and starts a new chat when the coordinate mode changes', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const session = client.messages.find((message) => message.type === 'session') as { sessionId: string }
      assert.match(session.sessionId, /^session-/)
      assert.equal(harness.calls.create[0]?.agentPreset, 'computer-use')
      assert.equal(harness.calls.create[0]?.sessionId, undefined)
      assert.deepEqual(Object.keys(harness.calls.workspace ?? {}), ['path'])
      assert.equal(harness.calls.workspace?.path, orb)
      assert.equal(harness.calls.selectModel[0]?.saveAsDefault, undefined)
      assert.deepEqual(harness.savedDefaults.at(-1), {
        provider: 'deepseek-official',
        model: 'deepseek-v4',
        reasoningEffort: 'high',
      })
      assert.equal(harness.calls.selectModel[0]?.sessionId, session.sessionId)
      assert.equal(harness.calls.selectModel[0]?.model, 'deepseek-flash')
      assert.equal(harness.calls.selectModel[0]?.reasoningEffort, 'max')
      const saved = JSON.parse(readFileSync(join(home, 'dsh-orb', 'floating-session.json'), 'utf8')) as { sessionId: string }
      assert.equal(saved.sessionId, session.sessionId)
      assert.equal(harness.pins.at(-1)?.preset, 'danger-full-access')
      assert.equal(harness.pins.at(-1)?.cwd, orb)

      client.send({ type: 'permission', preset: 'read-only' })
      await waitFor(() => harness.store.permission() === 'read-only')
      assert.equal(JSON.parse(readFileSync(join(harness.profile, 'orb-permission.json'), 'utf8')).preset, 'read-only')
      assert.equal(harness.pins.at(-1)?.preset, 'read-only')

      const selected = harness.calls.selectModel.length
      client.send({ type: 'set-overlay', selection: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' } })
      await waitFor(() => harness.calls.selectModel.length > selected)
      assert.equal(harness.calls.selectModel.at(-1)?.model, 'deepseek-pro')
      assert.equal(harness.calls.selectModel.at(-1)?.reasoningEffort, 'high')
      assert.equal(harness.calls.selectModel.at(-1)?.saveAsDefault, undefined)
      assert.equal(harness.savedDefaults.at(-1)?.model, 'deepseek-v4')
      assert.equal(harness.calls.selectModel.at(-1)?.sessionId, session.sessionId)

      client.send({ type: 'set-background', selection: { provider: 'deepseek-official', model: 'background-model' } })
      await waitFor(() => harness.store.models().background.model === 'background-model')
      assert.equal(harness.calls.selectModel.every((call) => call.model !== 'background-model'), true)
      assert.equal(harness.store.models().overlay.model, 'deepseek-pro')

      const creates = harness.calls.create.length
      client.send({ type: 'set-selection', enabled: true })
      await waitFor(() => harness.store.selectionEnabled() === true)
      const selection = JSON.parse(readFileSync(join(harness.profile, 'selection-toolbar.json'), 'utf8')) as { enabled: boolean }
      assert.equal(selection.enabled, true)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(harness.calls.create.length, creates)

      // Toggling the coordinate mode restarts the chat, but only when the mode actually changes.
      // A fresh profile already defaults to millifraction on Windows, so ask for the other one.
      const toMillifraction = !harness.store.millifractionEnabled()
      client.send({ type: 'set-millifraction', enabled: toMillifraction })
      await waitFor(() => harness.calls.create.length === creates + 1)
      assert.equal(harness.store.millifractionEnabled(), toMillifraction)
      assert.equal(harness.store.coordinateMode(), toMillifraction ? 'millifraction' : 'pixel')
      assert.equal(harness.calls.create.at(-1)?.sessionId, undefined)
      assert.equal(harness.calls.create.at(-1)?.agentPreset, 'computer-use')
      const afterFraction = harness.calls.create.length
      client.send({ type: 'set-millifraction', enabled: toMillifraction })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, afterFraction)

      const beforeChrome = client.messages.filter((message) => message.type === 'chrome').length
      client.send({ type: 'menu' })
      await waitFor(() => client.messages.filter((message) => message.type === 'chrome').length > beforeChrome)
      const chrome = client.messages.filter((message) => message.type === 'chrome').at(-1) as {
        overlay: { model: string }
        background: { model: string }
        millifractionEnabled: boolean
        catalog: { groups: { id: string }[] }
      }
      assert.equal(chrome.overlay.model, 'deepseek-pro')
      assert.equal(chrome.background.model, 'background-model')
      assert.equal(chrome.millifractionEnabled, toMillifraction)
      assert.equal(chrome.catalog.groups[0]?.id, 'deepseek-official')
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('cancels only the ball session, answers a question, and disables the helper', async () => {
    const harness = boot()
    harness.holdPrompt()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'stop' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(harness.calls.cancel.length, 0)

      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      const mark = client.messages.length
      client.send({ type: 'prompt', text: '看一下屏幕' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'turn' && message.running === true))
      client.send({ type: 'stop' })
      await waitFor(() => harness.calls.cancel.length === 1)
      assert.deepEqual(harness.calls.cancel, [{ sessionId }])
      assert.equal(harness.calls.prompt[0]?.sessionId, sessionId)
      harness.releasePrompt()

      const answered = harness.question({
        agent: { id: sessionId },
        questions: [{ id: 'q1', question: '继续？', options: [{ label: '好' }] }],
      }, async () => { throw new Error('deferred') })
      await waitFor(() => client.messages.some((message) => message.type === 'question'))
      const card = client.messages.find((message) => message.type === 'question') as { id: string }
      client.send({ type: 'question-answer', id: card.id, answers: [{ id: 'q1', selected: ['好'] }] })
      assert.deepEqual(await answered, { answers: [{ id: 'q1', selected: ['好'] }] })

      let deferred = false
      await harness.question({
        agent: { id: 'session-other' },
        questions: [{ id: 'q2', question: '别的会话' }],
      }, async () => {
        deferred = true
        return { answers: [] }
      })
      assert.equal(deferred, true)

      const cancelled = harness.question({
        agent: { id: sessionId },
        questions: [{ id: 'q3', question: '取消？' }],
      }, async () => { throw new Error('deferred') })
      await waitFor(() => client.messages.filter((message) => message.type === 'question').length > 1)
      const second = client.messages.filter((message) => message.type === 'question').at(-1) as { id: string }
      client.send({ type: 'question-cancel', id: second.id })
      await assert.rejects(cancelled, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'UserQuestionError')
        assert.equal((error as { code?: string }).code, 'ASK_CANCELLED')
        return true
      })

      const closed = once(client.socket, 'close')
      client.send({ type: 'disable' })
      await closed
      assert.equal(harness.store.ballEnabled(), false)
      assert.equal(JSON.parse(readFileSync(join(harness.profile, 'ball-enabled.json'), 'utf8')).enabled, false)
    } finally {
      harness.releasePrompt()
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('closes a helper that sends the wrong token', async () => {
    const harness = boot()
    const bound = await harness.runtime.bind()
    const socket = createConnection({ host: '127.0.0.1', port: bound.port })
    try {
      await once(socket, 'connect')
      const closed = once(socket, 'close')
      socket.write(`${JSON.stringify({ type: 'hello', token: 'wrong' })}\n`)
      await closed
    } finally {
      socket.destroy()
      harness.runtime.halt()
    }
  })

  it('delivers the stored theme and locale to a connecting ball and on change', async () => {
    const harness = boot()
    harness.runtime.setAppearance({ theme: 'dark', locale: 'zh' })
    const client = await connect(harness.runtime)
    try {
      const initial = client.messages.find((message) => message.type === 'appearance')
      assert.deepEqual(initial, { type: 'appearance', theme: 'dark', locale: 'zh' })
      harness.runtime.setAppearance({ theme: 'light', locale: 'zh' })
      await waitFor(() => client.messages.some((message) => message.type === 'appearance' && message.theme === 'light'))
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('tells the ball which avatar to load, on connect and after a pick', async () => {
    const harness = boot()
    try {
      const shipped = await connect(harness.runtime)
      assert.deepEqual(shipped.messages.find((message) => message.type === 'avatar'), {
        type: 'avatar',
        kind: 'default',
        version: 0,
      })
      shipped.socket.destroy()

      harness.store.selectAvatarPreset('cheer')
      const picked = await connect(harness.runtime)
      const message = picked.messages.find((entry) => entry.type === 'avatar') as { kind: string; src: string; version: number }
      assert.equal(message.kind, 'preset')
      // The ball resolves this against its own document, so no bytes cross the socket.
      assert.equal(message.src, 'avatars/cheer.gif')
      assert.ok(message.version > 0)
      picked.socket.destroy()
    } finally {
      harness.runtime.halt()
    }
  })

  it('returns a pending question to the main window when the ball disconnects', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      const pending = harness.question({
        agent: { id: sessionId },
        questions: [{ id: 'q1', question: '继续？' }],
      }, async () => ({ answers: [{ id: 'q1', selected: ['主窗口'] }] }))
      await waitFor(() => client.messages.some((message) => message.type === 'question'))
      client.socket.end()
      assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['主窗口'] }] })
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('reports TCC status and opens a pane through the control socket', async () => {
    const opened: TccRight[] = []
    let screen: TccStatus['screen'] = 'missing'
    const harness = boot({
      tcc: {
        status: () => ({ applicable: true, appName: 'Test', screen, accessibility: 'granted' }),
        async open(right) {
          opened.push(right)
          screen = 'needsRelaunch'
        },
      },
    })
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'tcc' })
      await waitFor(() => client.messages.some((message) => message.type === 'tcc'))
      const first = client.messages.find((message) => message.type === 'tcc') as { status: TccStatus }
      assert.equal(first.status.appName, 'Test')
      assert.equal(first.status.screen, 'missing')
      client.send({ type: 'tcc-open', right: 'screen' })
      await waitFor(() => opened.length === 1)
      await waitFor(() => client.messages.filter((message) => message.type === 'tcc').length > 1)
      const second = client.messages.filter((message) => message.type === 'tcc').at(-1) as { status: TccStatus }
      assert.equal(second.status.screen, 'needsRelaunch')
      assert.deepEqual(opened, ['screen'])
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('streams assistant deltas live and settles them onto the streamed blocks', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '流式' })
      await waitFor(() => harness.calls.prompt.length > 0)
      // Real frame shape: only the start frame carries turn/step; chunk frames carry the block index.
      // Block indices arrive non-monotonic (reasoning@1 before text@0), matching BlockAssembler order [1, 0].
      harness.stream(sessionId, { type: 'start', attemptId: 'a1', revision: 0, turn: 1, step: 0 })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, chunk: { index: 1, type: 'reasoning-delta', text: '想' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'a1', revision: 2, index: 1, chunk: { index: 1, type: 'reasoning-delta', text: '一下' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'a1', revision: 3, index: 2, chunk: { index: 0, type: 'text-delta', text: '答案' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:1' && textOf(message) === '想一下'
      )))
      const reasoning = client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:1'
      )).at(-1) as Record<string, unknown>
      assert.equal(reasoning.running, true)
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '答案'
      )))
      assert.equal(client.messages.some((message) => keyOf(message).startsWith('b:0:0:')), false)

      harness.inject(sessionId, {
        type: 'assistant/message', seq: 1,
        data: {
          turn: 1, step: 0,
          message: {
            content: [
              { type: 'reasoning', text: '想一下' },
              { type: 'text', text: '答案完整' },
            ],
          },
        },
      })
      harness.inject(sessionId, { type: 'turn/end', seq: 2, data: {} })
      harness.releasePrompt()
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '答案完整'
      )))
      // The settled message lands on the streamed keys in place: nothing dropped, nothing duplicated.
      assert.equal(client.messages.some((message) => message.type === 'block-drop'), false)
      const settled = client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0'
      )).at(-1) as Record<string, unknown>
      assert.equal(settled.running, false)
      assert.equal(settled.text, '答案完整')
      const settledReasoning = client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:1'
      )).at(-1) as Record<string, unknown>
      assert.equal(settledReasoning.running, false)
      assert.equal(settledReasoning.text, '想一下')
      // The final text lives on exactly one block key (history repeats are the response re-flag).
      assert.equal(new Set(client.messages.filter((message) => (
        message.type === 'block' && textOf(message) === '答案完整'
      )).map(keyOf)).size, 1)
      assert.equal(settled.response, true)
      assert.equal(settledReasoning.response, true)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('drops the dead attempt blocks when the stream retries', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '重试' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.stream(sessionId, { type: 'start', attemptId: 'r1', revision: 0, turn: 1, step: 0 })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'r1', revision: 1, index: 0, chunk: { index: 0, type: 'text-delta', text: '半截' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '半截'
      )))
      harness.stream(sessionId, { type: 'start', attemptId: 'r2', revision: 2, turn: 1, step: 0 })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block-drop' && keyOf(message) === 'b:1:0:0'
      )))
      harness.stream(sessionId, { type: 'chunk', attemptId: 'r2', revision: 3, index: 0, chunk: { index: 0, type: 'text-delta', text: '重来' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '重来'
      )))
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 1,
        data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '重来答案' }] } },
      })
      harness.inject(sessionId, { type: 'turn/end', seq: 2, data: {} })
      harness.releasePrompt()
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '重来答案'
      )))
      const finals = client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0'
      ))
      assert.equal(textOf(finals.at(-1) as Record<string, unknown>), '重来答案')
      // The dropped partial never resurfaces after the retry.
      const dropIndex = client.messages.findIndex((message) => (
        message.type === 'block-drop' && keyOf(message) === 'b:1:0:0'
      ))
      assert.ok(dropIndex >= 0)
      assert.equal(client.messages.slice(dropIndex).some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message).includes('半截')
      )), false)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('settles each step onto its streamed blocks, including tool calls', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '多步' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.stream(sessionId, { type: 'start', attemptId: 'm0', revision: 0, turn: 1, step: 0 })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'm0', revision: 1, index: 0, chunk: { index: 1, type: 'text-delta', text: '先看' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'm0', revision: 2, index: 1, chunk: { index: 1, type: 'text-delta', text: '一下' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'm0', revision: 3, index: 2, chunk: { index: 0, type: 'tool-call-delta', id: 'call-x', name: 'bash', argumentsDelta: '{"command":"ls"}' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'tool:call-x'
      )))
      harness.stream(sessionId, { type: 'start', attemptId: 'm1', revision: 4, turn: 1, step: 1 })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'm1', revision: 5, index: 0, chunk: { index: 0, type: 'reasoning-delta', text: '嗯' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'm1', revision: 6, index: 1, chunk: { index: 1, type: 'text-delta', text: '好了' } })
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 1,
        data: {
          turn: 1, step: 0,
          message: {
            content: [
              { type: 'text', text: '先看一下' },
              { type: 'tool-call', name: 'bash', id: 'call-x', arguments: '{"command":"ls"}' },
            ],
          },
        },
      })
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 2,
        data: {
          turn: 1, step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '嗯' },
              { type: 'text', text: '好了' },
            ],
          },
        },
      })
      harness.inject(sessionId, { type: 'turn/end', seq: 3, data: {} })
      harness.releasePrompt()
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:1:1' && textOf(message) === '好了'
      )))
      // Every settled block landed on its streamed key: no drops, no stray copies.
      assert.equal(client.messages.some((message) => message.type === 'block-drop'), false)
      const texts = new Map<string, string>()
      for (const message of client.messages.filter((entry) => entry.type === 'block')) texts.set(keyOf(message), textOf(message))
      assert.deepEqual([...texts.keys()].filter((key) => key.startsWith('b:1:0:')), ['b:1:0:1'])
      assert.deepEqual([...texts.keys()].filter((key) => key.startsWith('b:1:1:')).sort(), ['b:1:1:0', 'b:1:1:1'])
      assert.equal(texts.get('b:1:0:1'), '先看一下')
      assert.equal(texts.get('b:1:1:0'), '嗯')
      assert.equal(texts.get('b:1:1:1'), '好了')
      assert.equal(texts.get('tool:call-x') !== undefined, true)
      // Only the turn's last message is the final answer: a folded turn keeps just it visible.
      const lastOf = (key: string) => client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === key
      )).at(-1) as Record<string, unknown>
      assert.equal(lastOf('b:1:1:0').response, true)
      assert.equal(lastOf('b:1:1:1').response, true)
      assert.equal(lastOf('b:1:0:1').response, undefined)
      assert.equal(lastOf('tool:call-x').response, undefined)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('rides the message usage on the closing reply block only', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '用量' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 1,
        data: {
          turn: 1, step: 0,
          message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '第一答' }] },
          usage: { inputTokens: 1200, outputTokens: 345, cacheReadTokens: 800, reasoningTokens: 120 },
        },
      })
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 2,
        data: {
          turn: 1, step: 1,
          message: { content: [{ type: 'text', text: '第二答' }] },
          usage: { inputTokens: 90, outputTokens: 8 },
        },
      })
      harness.inject(sessionId, { type: 'turn/end', seq: 3, data: {} })
      harness.releasePrompt()
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:1:0' && textOf(message) === '第二答'
      )))
      const lastOf = (key: string) => client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === key
      )).at(-1) as Record<string, unknown>
      // Usage lands on each message's closing reply; the reasoning block stays bare.
      assert.deepEqual(lastOf('b:1:1:0').usage, { inputTokens: 90, outputTokens: 8 })
      assert.deepEqual(lastOf('b:1:0:1').usage, {
        inputTokens: 1200, outputTokens: 345, cacheReadTokens: 800, reasoningTokens: 120,
      })
      assert.equal(lastOf('b:1:0:0').usage, undefined)
      // Demoting the earlier response keeps its usage attached.
      assert.equal(lastOf('b:1:0:1').response, undefined)
      const demoted = client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:1' && (message as { response?: true }).response === true
      )).at(-1) as Record<string, unknown>
      assert.equal(demoted.text, '第一答')
      assert.deepEqual(demoted.usage, {
        inputTokens: 1200, outputTokens: 345, cacheReadTokens: 800, reasoningTokens: 120,
      })
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('carries tool arguments, results, and interruption to the ball', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '看看' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.inject(sessionId, {
        type: 'tool/call', seq: 1,
        data: { turn: 1, step: 0, callId: 'call-9', name: 'bash', arguments: '{"command":"ls","description":"list"}' },
      })
      harness.inject(sessionId, {
        type: 'tool/result', seq: 2,
        data: {
          turn: 1, step: 0,
          message: { toolCallId: 'call-9', isError: true, content: [{ type: 'text', text: 'boom' }] },
          error: { name: 'ExecError', code: 'E1', reason: 'nope' },
        },
      })
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 3,
        data: { turn: 1, step: 0, interrupted: true, message: { content: [{ type: 'text', text: '部分' }] }, stream: [] },
      })
      harness.inject(sessionId, { type: 'turn/end', seq: 4, data: {} })
      harness.releasePrompt()
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && message.text === 'bash' && (message as { detail?: { result?: string } }).detail?.result === 'boom'
      )))
      const tool = client.messages.filter((message) => message.type === 'block' && message.text === 'bash').at(-1) as {
        detail?: { args: string; result: string; isError: boolean; error?: { name: string }; cwd: string }
      }
      assert.equal(tool.detail?.args, '{"command":"ls","description":"list"}')
      assert.equal(tool.detail?.isError, true)
      assert.equal(tool.detail?.error?.name, 'ExecError')
      assert.equal(tool.detail?.cwd, orb)
      const assistant = client.messages.filter((message) => message.type === 'block' && message.kind === 'assistant').at(-1) as { interrupted?: true }
      assert.equal(assistant.interrupted, true)
      await waitFor(() => client.messages.some((message) => (
        message.type === 'turn' && message.running === false && (message as { interrupted?: true }).interrupted === true
      )))
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('keeps draining the queued follow-up that starts right after the first turn ended', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      client.send({ type: 'prompt', text: '第一条' })
      await waitFor(() => client.messages.some((message) => message.type === 'turn' && message.running === true))
      const prompts = harness.calls.prompt.length

      // onPrompt always submits with mode:'queue', and the agent loop appends turn/end and then the
      // next turn/start back to back, so one drain sees both. finishTurn() stops the poll on
      // turn/end and nothing re-armed it, so the poll stayed dead for the whole follow-up turn.
      // `mark` matters: a plain `some(...)` would match the running:false that `new` already sent.
      const mark = client.messages.length
      harness.inject(sessionId, { type: 'turn/end', seq: 900, data: { turn: 1, reason: { kind: 'completed' } } })
      harness.inject(sessionId, { type: 'turn/start', seq: 901, data: { turn: 2 } })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'turn' && message.running === false))

      // The work of the follow-up turn arrives afterwards and needs the poll to still be running.
      harness.inject(sessionId, {
        type: 'assistant/message',
        seq: 902,
        data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '第二条的结果' }] } },
      })

      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'block' && message.text === '第二条的结果'))
      // A queued follow-up is not a second prompt: the agent loop is already running it.
      assert.equal(harness.calls.prompt.length, prompts)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('does not leave a running turn behind when the ball is halted mid-turn', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      client.send({ type: 'prompt', text: '干活' })
      await waitFor(() => client.messages.some((message) => message.type === 'turn' && message.running === true))

      // halt() stops the only poll that can observe turn/end, so the running flag has to be
      // cleared here. Otherwise the next ball inherits "running", spins forever, and the
      // selection toolbar stays paused because pausedReads() still sees a running session.
      harness.runtime.halt()
      const reconnected = await connect(harness.runtime)
      try {
        const turn = reconnected.messages.find((message) => message.type === 'turn') as { running: boolean }
        assert.equal(turn.running, false)
      } finally {
        reconnected.socket.end()
      }
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })
})
