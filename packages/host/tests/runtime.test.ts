import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { OrbRuntime, scheduleBlankSweep, type OrbContext } from '../src/orb.ts'
import { ProfileStore } from '../src/preferences.ts'
import type { TccRight, TccStatus } from '../src/tcc.ts'
import type { UpdateChecker } from '../src/update.ts'

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
  /** Official list mark: the conversation holds no turn yet. */
  blank?: boolean
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
    resolve: string[]
    prompt: { sessionId?: string; mode?: string; content?: { text?: string }[] }[]
    cancel: { sessionId?: string }[]
    selectModel: { sessionId?: string; model?: string; reasoningEffort?: string; saveAsDefault?: boolean }[]
    workspace?: { path?: string }
  }
  savedDefaults: { provider: string; model: string; reasoningEffort?: string }[]
  /** The main window's default model; a test can move it to imitate a sign-in. */
  setHostDefault: (selection: { provider: string; model: string; reasoningEffort?: string }) => void
  /** The advertised catalog; a test can widen it to imitate a provider appearing. */
  setCatalog: (groups: { id: string; name: string; models: { id: string; name: string }[] }[]) => void
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
  /** Hold the next cancel open so a test can act while stopTurn awaits it. */
  holdCancel: () => void
  releaseCancel: () => void
  failCancel: (error: Error) => void
  /** The next `prompt` calls throw, after they are recorded. */
  failPrompt: (error: Error) => void
  provided: Map<string, unknown>
}

function boot(extra: {
  tcc?: { status(): TccStatus; open(right: TccRight): Promise<void> }
  /** Pre-seed the coordinate mode: without it the default is millifraction on Windows. */
  millifraction?: boolean
  /** The code-agent plugin's bookmark registry, as `ctx.get('codeAgentRegistry')` returns it. */
  agentRegistry?: unknown
  /**
   * The `llm` service a selection translation calls. Absent means the host has no model
   * service, which is what the other tests want: they never translate.
   */
  llm?: { stream(options: unknown): AsyncIterable<unknown> }
  /** Capture the selection monitor's handlers instead of starting a real hook. */
  monitorHandlers?: (handlers: { onEvent(event: unknown): void }) => void
} = {}): Harness {
  const profile = mkdtempSync(join(home, 'profile-'))
  if (extra.millifraction !== undefined) {
    writeFileSync(join(profile, 'millifraction-coordinates.json'), JSON.stringify({ enabled: extra.millifraction }))
  }
  // A track the ball never picked follows the fallback `model-defaults` resolves from
  // this catalog and this product default, so both are what the tests move.
  let previousDefault = { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'high' }
  let catalogGroups = [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4', name: 'V4' }, { id: 'deepseek-flash', name: 'Flash' }],
  }]
  const store = new ProfileStore(profile)
  const calls: Harness['calls'] = { create: [], resolve: [], prompt: [], cancel: [], selectModel: [] }
  const savedDefaults: Harness['savedDefaults'] = []
  const sessions = new Map<string, { events: EventRow[]; header: { cwd: string; agentPreset: string } }>()
  const pins: Harness['pins'] = []
  const listItems: Row[] = []
  let promptGate = Promise.resolve()
  let releasePrompt = () => {}
  let cancelGate: Promise<void> | undefined
  let releaseCancel = () => {}
  let cancelError: Error | undefined
  let promptError: Error | undefined
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
  /** The stored body of one Session: seeded on first create or resolve, as persistence would. */
  const seedSession = (sessionId: string): void => {
    if (sessions.has(sessionId)) return
    sessions.set(sessionId, {
      events: sessionId === 'session-keep' ? replay : [],
      header: { cwd: orb, agentPreset: 'computer-use' },
    })
  }
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
        // dsh 0.2.1 `create`: a named Session is reused only while it is still blank. One that has
        // stored history "stays unchanged, and a new Session is created instead" — the exact
        // behaviour that used to land the ball in an empty untitled chat.
        const named = request.sessionId
        if (named !== undefined && (sessions.get(named)?.events.length ?? 0) === 0) {
          seedSession(named)
          return { sessionId: named }
        }
        const sessionId = `session-new-${calls.create.length}`
        seedSession(sessionId)
        return { sessionId }
      },
      // Resolve or resume one existing Session: the live Agent, or the resumed one.
      async resolveAgent(sessionId: string) {
        calls.resolve.push(sessionId)
        const stored = sessions.has(sessionId) || listItems.some((item) => item.sessionId === sessionId)
        if (!stored) return { error: { code: 'session/not-found', sessionId } }
        seedSession(sessionId)
        return { agent: { session: { id: sessionId } } }
      },
      async prompt(request: { sessionId?: string; mode?: string; content?: { text?: string }[] }) {
        calls.prompt.push(request)
        await promptGate
        if (promptError !== undefined) throw promptError
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
        if (cancelGate !== undefined) await cancelGate
        if (cancelError !== undefined) throw cancelError
      },
      modelCatalog: () => ({ groups: catalogGroups }),
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
      if (name === 'llm') return extra.llm
      if (name === 'codeAgentRegistry') return extra.agentRegistry
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
    startMonitor: extra.monitorHandlers === undefined ? () => undefined : (handlers) => {
      extra.monitorHandlers?.(handlers as { onEvent(event: unknown): void })
      return {
        stop() {},
        setExcludePids() {},
        activatePid() {},
        lastFrontPid: () => undefined,
      }
    },
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
    setHostDefault(selection) { previousDefault = selection },
    setCatalog(groups) { catalogGroups = groups },
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
    holdCancel() {
      cancelGate = new Promise((resolve) => { releaseCancel = resolve })
    },
    releaseCancel() { releaseCancel() },
    failCancel(error: Error) { cancelError = error },
    failPrompt(error: Error) { promptError = error },
    provided,
  }
}

async function connect(runtime: OrbRuntime, options: { ack?: boolean } = {}) {
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
      if (options.ack !== false && typeof message.type === 'string' && message.type.startsWith('overlay-') && typeof message.id === 'string') {
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

/** `writeFile` makes the path exist before the JSON lands, so wait for the content itself. */
function markerHas(file: string, swept: number): boolean {
  try {
    return readFileSync(file, 'utf8').includes(`"swept":${swept}`)
  } catch {
    return false
  }
}

function keyOf(message: Record<string, unknown>): string {
  return typeof message.key === 'string' ? message.key : ''
}

function textOf(message: Record<string, unknown>): string {
  return typeof message.text === 'string' ? message.text : ''
}

/**
 * Request a stop with `cancel` held open, run `insert` while stopTurn awaits it, then
 * release. Returns the messages that arrived after the stop request.
 */
async function stopWithPendingCancel(
  harness: Harness,
  client: Awaited<ReturnType<typeof connect>>,
  insert: () => void,
  newTurnBroadcast: () => boolean,
): Promise<Record<string, unknown>[]> {
  harness.holdCancel()
  const mark = client.messages.length
  client.send({ type: 'stop' })
  await waitFor(() => harness.calls.cancel.length === 1)
  insert()
  await waitFor(newTurnBroadcast)
  harness.releaseCancel()
  // Let the resumed stopTurn settle before the caller inspects the stream.
  await new Promise((resolve) => setTimeout(resolve, 80))
  return client.messages.slice(mark)
}

/** The running flags of every turn broadcast, in arrival order. */
function turnFlags(messages: Record<string, unknown>[]): boolean[] {
  return messages.filter((message) => message.type === 'turn').map((message) => message.running === true)
}

/** How many turn broadcasts said "running" — new turns added on top of the first one. */
function liveTurnCount(messages: Record<string, unknown>[]): number {
  return messages.filter((message) => message.type === 'turn' && message.running === true).length
}

describe('ball control socket', { concurrency: 1 }, () => {
  it('keeps the waiting phase up while a runtime download is still pending', async () => {
    // A runtime path that cannot resolve stands in for a download that keeps failing: the attempt
    // fails at once, the budget schedules a retry, and the settings page is told to keep waiting.
    const harness = boot()
    const previous = process.env.DSH_ORB_ELECTRON_PATH
    process.env.DSH_ORB_ELECTRON_PATH = join(harness.profile, 'no-such-electron')
    try {
      await harness.runtime.start()
      assert.equal(harness.runtime.helperPhase(), 'downloading', 'a scheduled retry keeps the waiting line up')
      assert.equal(harness.runtime.helperStatus(), '', 'the retry budget is not spent yet')

      // The retry timer starts the attempt again, and a manual redownload can land here too. This
      // call used to blank the phase on its way in — long enough for the settings page, which polls
      // only while the phase is up, to stop polling and never learn how the download ended.
      const replacing = harness.runtime.start()
      assert.equal(harness.runtime.helperPhase(), 'downloading', 'the replacing start must not blank the phase')
      await replacing
      assert.equal(harness.runtime.helperPhase(), 'downloading', 'and the attempt that follows keeps it up')
    } finally {
      harness.runtime.halt()
      if (previous === undefined) delete process.env.DSH_ORB_ELECTRON_PATH
      else process.env.DSH_ORB_ELECTRON_PATH = previous
    }
  })

  it('keeps New Chat on the current conversation while it is still blank', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'prompt', text: '你好' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const current = harness.calls.prompt[0]?.sessionId
      assert.ok(current)
      assert.equal(harness.calls.create.length, 1)
      const chromeCount = (): number => client.messages.filter((message) => message.type === 'chrome').length

      // The official list marks a never-prompted conversation blank. The main window reuses that
      // draft instead of minting another, which is why its list never fills with 未命名对话; the
      // ball used to mint one per press, and this is the alignment.
      harness.listItems.push({ sessionId: current, cwd: orb, origin: 'user', blank: true, projections: { values: { agentPreset: 'computer-use' } } })
      let seen = chromeCount()
      client.send({ type: 'new' })
      await waitFor(() => chromeCount() > seen)
      assert.equal(harness.calls.create.length, 1, 'a blank press must not mint another conversation')

      // The selected blank stays in the list (the main window shows exactly that one), while the
      // other empties are hidden — that is what keeps the panel from filling with 未命名对话.
      harness.listItems.push({ sessionId: 'session-empty-other', cwd: orb, origin: 'user', blank: true, projections: { values: { agentPreset: 'computer-use' } } })
      client.send({ type: 'history' })
      await waitFor(() => client.messages.some((message) => message.type === 'history'))
      const history = client.messages.filter((message) => message.type === 'history').at(-1) as { items: { sessionId: string }[] }
      assert.equal(history.items.some((item) => item.sessionId === current), true, 'the current blank stays visible')
      assert.equal(history.items.some((item) => item.sessionId === 'session-empty-other'), false, 'every other blank is hidden')

      // Once the conversation holds a turn it is no longer blank, and New Chat does start one.
      const row = harness.listItems[0]
      assert.ok(row)
      harness.listItems[0] = { ...row, blank: false }
      seen = chromeCount()
      client.send({ type: 'new' })
      await waitFor(() => chromeCount() > seen)
      assert.equal(harness.calls.create.length, 2, 'a conversation with a turn gets a fresh one')
    } finally {
      client.socket.destroy()
    }
  })

  it('hard-stops a running turn and starts the interjection as a new turn', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const interject = (text: string) => (harness.runtime as unknown as { onInterject(text: string): Promise<void> }).onInterject(text)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)
      const before = harness.calls.prompt.length
      const voicePrompts = client.messages.filter((message) => message.type === 'voice-prompt').length

      await interject('大肥鱼，把明天的也查一下')
      await waitFor(() => harness.calls.cancel.length === 1)
      assert.equal(harness.calls.cancel[0]?.sessionId, sessionId)
      assert.equal(harness.calls.prompt.length, before, 'the old turn must end before the new prompt')
      await waitFor(() => client.messages.some((message) => message.type === 'block' && message.kind === 'user' && message.text === '大肥鱼，把明天的也查一下'))

      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => harness.calls.prompt.length === before + 1)
      const next = harness.calls.prompt.at(-1)
      assert.equal(next?.mode, 'queue')
      assert.equal(next?.content?.[0]?.text, '大肥鱼，把明天的也查一下')
      assert.equal(harness.calls.prompt.some((call) => call.mode === 'steer'), false)
      assert.equal(client.messages.filter((message) => message.type === 'voice-prompt').length, voicePrompts)
    } finally {
      client.socket.destroy()
    }
  })

  it('hard-stops a running turn when a typed prompt arrives', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)
      const before = harness.calls.prompt.length
      client.send({ type: 'prompt', text: '改成明天的' })
      await waitFor(() => harness.calls.cancel.length === 1)
      assert.equal(harness.calls.cancel[0]?.sessionId, sessionId)
      assert.equal(harness.calls.prompt.length, before, 'the old turn must end before the new prompt')

      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => harness.calls.prompt.length === before + 1)
      assert.equal(harness.calls.prompt.at(-1)?.content?.[0]?.text, '改成明天的')
    } finally {
      client.socket.destroy()
    }
  })

  it('starts an interjection as a new turn when only the closing speech is left', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const interject = (text: string) => (harness.runtime as unknown as { onInterject(text: string): Promise<void> }).onInterject(text)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)
      const closeMark = client.messages.length
      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => client.messages.slice(closeMark).some((message) => message.type === 'turn' && message.running === false))

      const before = harness.calls.prompt.length
      await interject('大肥鱼，再查一次')
      await waitFor(() => harness.calls.prompt.length === before + 1)
      assert.equal(harness.calls.prompt.at(-1)?.mode, 'queue')
      assert.equal(harness.calls.prompt.at(-1)?.content?.[0]?.text, '大肥鱼，再查一次')
      assert.equal(harness.calls.cancel.length, 0, 'an idle turn needs no cancel')
      assert.equal(client.messages.some((message) => message.type === 'voice-prompt'), false)
    } finally {
      client.socket.destroy()
    }
  })

  it('drops the interjection bubble when the old turn cannot be stopped', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const interject = (text: string) => (harness.runtime as unknown as { onInterject(text: string): Promise<void> }).onInterject(text)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      harness.failCancel(new Error('cancel refused'))
      const before = harness.calls.prompt.length
      const mark = client.messages.length
      await interject('大肥鱼，这次发不出去')
      await waitFor(() => harness.calls.cancel.length === 1)
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'block-drop'))
      await waitFor(() => client.messages.some((message) => message.type === 'status' && message.text === 'cancel refused'))
      assert.equal(harness.calls.prompt.length, before)
    } finally {
      client.socket.destroy()
    }
  })

  it('keeps only the newest interjection while the old turn is stopping', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const interject = (text: string) => (harness.runtime as unknown as { onInterject(text: string): Promise<void> }).onInterject(text)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)
      const before = harness.calls.prompt.length

      await interject('大肥鱼，第一句')
      await interject('大肥鱼，第二句')
      await waitFor(() => harness.calls.cancel.length === 2)
      await waitFor(() => client.messages.some((message) => message.type === 'block-drop'))
      assert.equal(harness.calls.prompt.length, before)

      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => harness.calls.prompt.length === before + 1)
      assert.equal(harness.calls.prompt.at(-1)?.content?.[0]?.text, '大肥鱼，第二句')
    } finally {
      client.socket.destroy()
    }
  })

  it('keeps the interjection bubble when the new prompt fails', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const interject = (text: string) => (harness.runtime as unknown as { onInterject(text: string): Promise<void> }).onInterject(text)
    try {
      client.send({ type: 'prompt', text: '查一下今天的天气' })
      await waitFor(() => harness.calls.prompt.length === 1)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)
      const closeMark = client.messages.length
      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => client.messages.slice(closeMark).some((message) => message.type === 'turn' && message.running === false))

      harness.failPrompt(new Error('session missing'))
      await interject('大肥鱼，这次发不出去')
      await waitFor(() => client.messages.some((message) => message.type === 'status' && message.text === 'session missing'))
      assert.equal(client.messages.some((message) => message.type === 'block' && message.kind === 'user' && message.text === '大肥鱼，这次发不出去'), true)
    } finally {
      client.socket.destroy()
    }
  })

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
      const creates = harness.calls.create.length
      client.send({ type: 'open', sessionId: 'session-keep' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'block' && message.text === 'click'))
      const blocks = client.messages.slice(mark).filter((message) => message.type === 'block')
      assert.deepEqual(blocks.map((message) => message.text), ['你好', '好', 'click', 'click'])
      // The generic plugin notice stays invisible; only code_agent reports get a card.
      assert.equal(blocks.some((message) => message.text === '跳过'), false)
      // Opening resumes the stored conversation by identity; it must not mint a fresh Session.
      assert.equal(harness.calls.resolve.at(-1), 'session-keep')
      assert.equal(harness.calls.create.length, creates)
      const adopted = client.messages.slice(mark).find((message) => message.type === 'session') as { sessionId: string }
      assert.equal(adopted.sessionId, 'session-keep')
      assert.equal(JSON.parse(readFileSync(join(home, 'dsh-orb', 'floating-session.json'), 'utf8')).sessionId, 'session-keep')
      client.send({ type: 'open', sessionId: 'session-missing' })
      client.send({ type: 'open', sessionId: 'not-a-session' })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, creates)
      assert.equal(harness.calls.resolve.at(-1), 'session-keep')
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('restores the saved conversation on startup instead of minting an empty one', async () => {
    const harness = boot()
    mkdirSync(join(home, 'dsh-orb'), { recursive: true })
    writeFileSync(join(home, 'dsh-orb', 'floating-session.json'), `${JSON.stringify({ sessionId: 'session-restored' })}\n`)
    harness.listItems.push({
      sessionId: 'session-restored',
      cwd: orb,
      origin: 'user',
      projections: { values: { agentPreset: 'computer-use', title: '上次那段' } },
    })
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'prompt', text: '继续' })
      await waitFor(() => harness.calls.prompt.length > 0)
      assert.equal(harness.calls.resolve.at(-1), 'session-restored')
      assert.equal(harness.calls.prompt.at(-1)?.sessionId, 'session-restored')
      assert.equal(harness.calls.create.length, 0)
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const session = client.messages.find((message) => message.type === 'session') as { sessionId: string }
      assert.equal(session.sessionId, 'session-restored')
      assert.equal(JSON.parse(readFileSync(join(home, 'dsh-orb', 'floating-session.json'), 'utf8')).sessionId, 'session-restored')
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('starts a fresh conversation when the saved one is gone', async () => {
    const harness = boot()
    mkdirSync(join(home, 'dsh-orb'), { recursive: true })
    writeFileSync(join(home, 'dsh-orb', 'floating-session.json'), `${JSON.stringify({ sessionId: 'session-deleted' })}\n`)
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'prompt', text: '你好' })
      await waitFor(() => harness.calls.prompt.length > 0)
      assert.equal(harness.calls.resolve.at(-1), 'session-deleted')
      assert.equal(harness.calls.create.length, 1)
      assert.equal(harness.calls.prompt.at(-1)?.sessionId, 'session-new-1')
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const session = client.messages.find((message) => message.type === 'session') as { sessionId: string }
      assert.equal(session.sessionId, 'session-new-1')
      assert.equal(JSON.parse(readFileSync(join(home, 'dsh-orb', 'floating-session.json'), 'utf8')).sessionId, 'session-new-1')
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

  it('creates a session, changes both models and access, and starts a new chat for millifraction', async () => {
    // Start from millifraction off so the toggle below changes state on every platform.
    const harness = boot({ millifraction: false })
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
      // No explicit ball choice: the session takes the main window's default, so the
      // runtime has nothing to restore and writes no default of its own.
      assert.equal(harness.calls.selectModel[0]?.sessionId, session.sessionId)
      assert.equal(harness.calls.selectModel[0]?.model, 'deepseek-v4')
      assert.equal(harness.calls.selectModel[0]?.reasoningEffort, 'high')
      assert.deepEqual(harness.savedDefaults, [])
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
      // The toolbar ships on, so `enabled: true` is already the stored state: wait for the
      // write itself rather than for a value that was true before the message arrived.
      client.send({ type: 'set-selection', enabled: true })
      await waitFor(() => existsSync(join(harness.profile, 'selection-toolbar.json')))
      const selection = JSON.parse(readFileSync(join(harness.profile, 'selection-toolbar.json'), 'utf8')) as { enabled: boolean }
      assert.equal(selection.enabled, true)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(harness.calls.create.length, creates)

      client.send({ type: 'set-millifraction', enabled: true })
      await waitFor(() => harness.calls.create.length === creates + 1)
      assert.equal(harness.store.millifractionEnabled(), true)
      assert.equal(harness.store.coordinateMode(), 'millifraction')
      assert.equal(harness.calls.create.at(-1)?.sessionId, undefined)
      assert.equal(harness.calls.create.at(-1)?.agentPreset, 'computer-use')
      const afterFraction = harness.calls.create.length
      client.send({ type: 'set-millifraction', enabled: true })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(harness.calls.create.length, afterFraction)

      const beforeChrome = client.messages.filter((message) => message.type === 'chrome').length
      client.send({ type: 'menu' })
      await waitFor(() => client.messages.filter((message) => message.type === 'chrome').length > beforeChrome)
      const chrome = client.messages.filter((message) => message.type === 'chrome').at(-1) as {
        overlay: { model: string }
        background: { model: string }
        millifractionEnabled: boolean
        update: string | null
        catalog: { groups: { id: string }[] }
      }
      assert.equal(chrome.overlay.model, 'deepseek-pro')
      assert.equal(chrome.background.model, 'background-model')
      assert.equal(chrome.millifractionEnabled, true)
      assert.equal(chrome.update, null, 'no checker took over this runtime')
      assert.equal(chrome.catalog.groups[0]?.id, 'deepseek-official')
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('runs a fresh session on the account route when the main window defaults to it', async () => {
    // Account-only profile: signed in, no API key, so the official sign-in already
    // moved the main-window default to `deepseek-account`.
    const harness = boot()
    harness.setHostDefault({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
    harness.setCatalog([
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
      { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      assert.equal(harness.calls.selectModel[0]?.model, 'deepseek-flash')
      assert.equal(harness.calls.selectModel[0]?.reasoningEffort, 'max')
      // The runtime must not push the API-key route or touch the saved default.
      assert.equal(harness.calls.selectModel[0]?.provider, 'deepseek-account')
      assert.deepEqual(harness.savedDefaults, [])
      assert.equal(existsSync(join(harness.profile, 'orb-agent-models.json')), false)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('keeps a track the ball picked when the main window switches later', async () => {
    const harness = boot()
    harness.store.setOverlay({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    // A later sign-in moves the main-window default; the picked track must not follow.
    harness.setHostDefault({ provider: 'deepseek-account', model: 'deepseek-flash' })
    harness.setCatalog([
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
      { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      assert.equal(harness.calls.selectModel[0]?.provider, 'deepseek-official')
      assert.equal(harness.calls.selectModel[0]?.model, 'deepseek-pro')
      assert.equal(harness.calls.selectModel[0]?.reasoningEffort, 'high')
      // The free background track still follows the main window.
      assert.deepEqual(harness.store.models().background, { provider: 'deepseek-account', model: 'deepseek-flash' })
      assert.deepEqual(JSON.parse(readFileSync(join(harness.profile, 'orb-agent-models.json'), 'utf8')), {
        overlay: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' },
      })
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('offers the new version on the ball and upgrades when the menu asks', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    const installs: unknown[] = []
    const state = {
      currentVersion: '0.1.0',
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      available: true,
      checking: false,
      updating: false,
      canUpdate: true,
      autoCheck: true,
      checkedAt: null,
      restartRequired: false,
      error: null,
      pendingBuilds: [],
    }
    try {
      harness.runtime.useUpdater({
        state: () => ({ ...state }),
        availableVersion: () => state.available ? '0.2.0' : null,
        async check() {},
        async install(approvedBuilds?: string[]) {
          installs.push(approvedBuilds)
          Object.assign(state, { available: false, restartRequired: true, installedVersion: '0.2.0' })
        },
        setAutoCheck() {},
      } as unknown as UpdateChecker)
      await waitFor(() => client.messages.some((message) => message.type === 'update' && message.state === 'available'))
      await waitFor(() => client.messages.some((message) => message.type === 'chrome' && message.update === '0.2.0'))

      // The ball's menu row sends one word; the host runs the rest and narrates it back.
      client.send({ type: 'update' })
      await waitFor(() => client.messages.some((message) => message.type === 'update' && message.state === 'starting'))
      await waitFor(() => client.messages.some((message) => message.type === 'update' && message.state === 'done'))
      assert.deepEqual(installs, [undefined])
      const done = client.messages.findLast((message) => message.type === 'update' && message.state === 'done')
      assert.equal(done?.version, '0.2.0')
      assert.equal(done?.restart, true)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('cancels only the ball session, answers a question, and disables the helper', async () => {    const harness = boot()
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

  it('pushes background agent bookmarks and retires one after a click', async () => {
    const entries = [
      {
        sessionId: 'session-agent-done',
        callerId: 'session-caller-a',
        task: '写周报',
        cwd: '/tmp/week',
        startedAt: Date.now() - 200_000,
        endedAt: Date.now() - 1_000,
        state: 'completed',
        outcome: '已完成',
      },
      {
        sessionId: 'session-agent-run',
        callerId: 'session-caller-b',
        task: '抓天气',
        cwd: '/tmp/weather',
        startedAt: Date.now() - 5_000,
        state: 'running',
      },
    ]
    const harness = boot({ agentRegistry: { list: () => entries } })
    const client = await connect(harness.runtime)
    try {
      await waitFor(() => client.messages.some((message) => message.type === 'agents'))
      const first = client.messages.find((message) => message.type === 'agents') as {
        items: { sessionId: string; state: string; unread: boolean; colorIndex: number }[]
      }
      assert.equal(first.items.length, 2)
      assert.equal(first.items[0]?.sessionId, 'session-agent-run')
      assert.equal(first.items[0]?.unread, false)
      assert.equal(first.items[1]?.sessionId, 'session-agent-done')
      assert.equal(first.items[1]?.unread, true)
      assert.notEqual(first.items[0]?.colorIndex, first.items[1]?.colorIndex)

      client.send({ type: 'agent-open', sessionId: 'session-agent-done' })
      await waitFor(() => client.messages.filter((message) => message.type === 'agents').length >= 2)
      const second = client.messages.filter((message) => message.type === 'agents').at(-1) as {
        items: { sessionId: string }[]
      }
      assert.deepEqual(second.items.map((item) => item.sessionId), ['session-agent-run'])

      assert.equal(harness.runtime.takeJump()?.sessionId, 'session-agent-done')
      harness.runtime.confirmJump('session-agent-done')
      assert.equal(harness.runtime.takeJump(), null)
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('consumes a bookmark only once its task has finished', async () => {
    const entry: Record<string, unknown> = {
      sessionId: 'session-agent-run',
      callerId: 'session-caller-b',
      task: '抓天气',
      cwd: '/tmp/weather',
      startedAt: Date.now() - 5_000,
      state: 'running',
    }
    const harness = boot({ agentRegistry: { list: () => [entry] } })
    const client = await connect(harness.runtime)
    const payloads = (): { items: { sessionId: string; unread: boolean }[] }[] => (
      client.messages
        .filter((message) => message.type === 'agents')
        .map((message) => message as unknown as { items: { sessionId: string; unread: boolean }[] })
    )
    const shownUnread = (): boolean => (
      payloads().at(-1)?.items.some((item) => item.sessionId === 'session-agent-run' && item.unread) === true
    )
    /**
     * One bookmark click, settled: the jump target is armed before the click handler returns, so
     * consuming it proves the click was handled — including its read decision.
     */
    const clickBookmark = async (): Promise<void> => {
      client.send({ type: 'agent-open', sessionId: 'session-agent-run' })
      await waitFor(() => harness.runtime.takeJump()?.sessionId === 'session-agent-run')
      harness.runtime.confirmJump('session-agent-run')
    }
    try {
      await waitFor(() => shownUnread() === false && payloads().length >= 1)
      assert.deepEqual(payloads().at(-1)?.items.map((item) => item.sessionId), ['session-agent-run'])

      // Clicking a running bookmark jumps to the session and must not consume the bookmark: the
      // completion still owes the user an unread entry.
      await clickBookmark()
      entry.state = 'completed'
      entry.endedAt = Date.now()
      entry.outcome = '晴'
      await waitFor(shownUnread)

      // Now, and only now, a click retires it.
      await clickBookmark()
      await waitFor(() => payloads().at(-1)?.items.length === 0)

      // A continued stretch reuses the session id: its completion is unread again even though the
      // previous stretch was clicked away.
      entry.state = 'running'
      entry.startedAt = Date.now()
      delete entry.endedAt
      delete entry.outcome
      await waitFor(() => payloads().at(-1)?.items.some((item) => item.sessionId === 'session-agent-run') === true)
      await clickBookmark()
      entry.state = 'completed'
      entry.endedAt = Date.now()
      entry.outcome = '晴'
      await waitFor(shownUnread)
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('dismisses a finished bookmark without opening the main window', async () => {
    const entry: Record<string, unknown> = {
      sessionId: 'session-agent-done',
      callerId: 'session-caller-a',
      task: '写周报',
      cwd: '/tmp/week',
      startedAt: Date.now() - 200_000,
      endedAt: Date.now() - 1_000,
      state: 'completed',
      outcome: '已完成',
    }
    const harness = boot({ agentRegistry: { list: () => [entry] } })
    const client = await connect(harness.runtime)
    const pushes = (): { type?: unknown }[] => client.messages.filter((message) => message.type === 'agents')
    const items = (): { sessionId: string; unread: boolean }[] | undefined => (
      pushes().map((message) => message as unknown as { items: { sessionId: string; unread: boolean }[] })
        .at(-1)?.items
    )
    try {
      await waitFor(() => items()?.length === 1)

      // The dismiss control retires the chip on the spot and arms no jump: the user asked for
      // exactly that — no trip to the main window.
      client.send({ type: 'agent-dismiss', sessionId: 'session-agent-done' })
      await waitFor(() => items()?.length === 0)
      assert.equal(harness.runtime.takeJump(), null)

      // A running stretch has no dismiss control, and the host refuses the message too: while it
      // runs, the chip is the only trace of the task. A refusal must not even re-push the strip.
      entry.state = 'running'
      delete entry.endedAt
      delete entry.outcome
      await waitFor(() => items()?.length === 1)
      const before = pushes().length
      client.send({ type: 'agent-dismiss', sessionId: 'session-agent-done' })
      // Fence: the open below arms its jump only after the dismiss above was handled.
      client.send({ type: 'agent-open', sessionId: 'session-agent-done' })
      await waitFor(() => harness.runtime.takeJump()?.sessionId === 'session-agent-done')
      harness.runtime.confirmJump('session-agent-done')
      assert.equal(pushes().length, before)

      // Finishing the stretch afterwards still owes an unread chip: nothing was consumed meanwhile.
      entry.state = 'completed'
      entry.endedAt = Date.now()
      entry.outcome = '已完成'
      await waitFor(() => items()?.some((item) => item.sessionId === 'session-agent-done' && item.unread) === true)
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('arms the main window settings bridge when the ball menu asks for it', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      // Nothing armed until the row is clicked.
      assert.equal(harness.runtime.takeSettingsOpen(), null)

      client.send({ type: 'open-settings' })
      let target: { at: number } | null = null
      await waitFor(() => (target = harness.runtime.takeSettingsOpen()) !== null)
      assert.ok(target !== null && Number.isFinite(target.at))
      // Reading it twice keeps the click alive: the main window may still be launching.
      assert.deepEqual(harness.runtime.takeSettingsOpen(), target)

      harness.runtime.confirmSettingsOpen(target.at)
      assert.equal(harness.runtime.takeSettingsOpen(), null)

      // A confirm for a target the ball never armed cannot clear a fresh one.
      client.send({ type: 'open-settings' })
      let second: { at: number } | null = null
      await waitFor(() => (second = harness.runtime.takeSettingsOpen()) !== null)
      harness.runtime.confirmSettingsOpen(second.at - 1)
      assert.deepEqual(harness.runtime.takeSettingsOpen(), second)
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })

  it('renders a plugin notice live and marks the wake turn running without a ball prompt', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      const guard = 'Do not restart this task and do not call code_agent for it again unless the user asks.'
      harness.inject(sessionId, {
        type: 'user/message',
        seq: 1,
        data: {
          source: { kind: 'computer-use', form: 'notice' },
          content: [{ type: 'text', text: `Background Code agent session session-bg finished this task:\n写周报\n\n已完成。\n\n${guard}` }],
        },
      })
      await waitFor(() => client.messages.some((message) => message.type === 'block' && message.kind === 'notice'))
      const notice = client.messages.find((message) => message.type === 'block' && message.kind === 'notice') as { text: string }
      assert.equal(notice.text.includes('已完成。'), true)
      assert.equal(notice.text.includes('Do not restart this task'), false)

      harness.inject(sessionId, {
        type: 'user/message',
        seq: 2,
        data: {
          source: { kind: 'computer-use', form: 'notice' },
          content: [{ type: 'text', text: 'Current runtime context: macOS\n当前 frontmost window: Finder' }],
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(client.messages.some((message) => message.type === 'block' && message.text.includes('Current runtime context')), false)

      harness.inject(sessionId, { type: 'turn/start', seq: 3, data: { turn: 1 } })
      await waitFor(() => client.messages.some((message) => message.type === 'turn' && message.running === true))
      harness.inject(sessionId, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })
      await waitFor(() => client.messages.some((message) => message.type === 'turn' && message.running === false))
    } finally {
      client.socket.destroy()
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

  it('keeps the interruption flag off the previous settled answer', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '两段' })
      await waitFor(() => harness.calls.prompt.length > 0)
      // The usage rides the closing reply, which is also what arms its response flag.
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 1,
        data: {
          turn: 1, step: 0,
          message: { content: [{ type: 'text', text: '完整回答' }] },
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      })
      harness.inject(sessionId, {
        type: 'assistant/message', seq: 2,
        data: { turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'text', text: '半截' }] } },
      })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:1:0' && textOf(message) === '半截'
      )))
      const lastOf = (key: string) => client.messages.filter((message) => (
        message.type === 'block' && keyOf(message) === key
      )).at(-1) as Record<string, unknown>
      // Demoting the earlier answer must not republish it as interrupted.
      assert.equal(lastOf('b:1:0:0').interrupted, undefined)
      assert.equal(lastOf('b:1:0:0').response, undefined)
      assert.equal(lastOf('b:1:1:0').interrupted, true)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('keeps the turn running when cancel fails, and lets the turn end close it', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '别停坏' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.failCancel(new Error('cancel refused'))
      const mark = client.messages.length
      client.send({ type: 'stop' })
      await waitFor(() => client.messages.slice(mark).some((message) => message.type === 'status'))
      const after = client.messages.slice(mark)
      // A failed cancel must not paint the ball as stopped.
      assert.equal(after.some((message) => message.type === 'turn' && message.running === false), false)
      const status = after.find((message) => message.type === 'status') as { text?: string }
      assert.match(status.text ?? '', /cancel refused/)
      // The turn's own end stays the authoritative close.
      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: {} })
      await waitFor(() => client.messages.some((message) => message.type === 'turn' && message.running === false))
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('starts a prompt submitted while cancel was pending after the old turn ends', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '第一' })
      await waitFor(() => harness.calls.prompt.length > 0)
      const sessionId = harness.calls.prompt[0]?.sessionId
      assert.ok(sessionId)

      harness.holdCancel()
      const mark = client.messages.length
      client.send({ type: 'stop' })
      await waitFor(() => harness.calls.cancel.length === 1)
      client.send({ type: 'prompt', text: '第二' })
      await waitFor(() => harness.calls.cancel.length === 2)
      assert.equal(harness.calls.prompt.length, 1, 'the new prompt waits for the old turn to end')

      harness.releaseCancel()
      harness.inject(sessionId, { type: 'turn/end', seq: 1, data: { turn: 1 } })
      await waitFor(() => harness.calls.prompt.length >= 2)
      const flags = turnFlags(client.messages.slice(mark))
      assert.equal(flags.at(-1), true, 'the new prompt opens its own turn after the old one closes')
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('does not close a wake-up turn that started while cancel was pending', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '第一' })
      await waitFor(() => harness.calls.prompt.length > 0)
      const after = await stopWithPendingCancel(
        harness,
        client,
        () => {
          // The cancelled turn ends for real, and a completion notice wakes a new one.
          harness.inject(sessionId, { type: 'turn/end', seq: 1, data: {} })
          harness.inject(sessionId, { type: 'turn/start', seq: 2, data: { turn: 2 } })
        },
        () => liveTurnCount(client.messages) >= 2,
      )
      const flags = turnFlags(after)
      // Only the turn/end may close; the wake-up turn stays live.
      assert.equal(flags.filter((running) => !running).length, 1)
      assert.equal(flags.at(-1), true)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('does not close a running session opened while cancel was pending', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '第一' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.listItems.push({
        sessionId: 'session-orb-run',
        cwd: orb,
        origin: 'user',
        running: true,
        projections: { values: { agentPreset: 'computer-use', title: '在跑' } },
      })
      const after = await stopWithPendingCancel(
        harness,
        client,
        () => { client.send({ type: 'open', sessionId: 'session-orb-run' }) },
        () => liveTurnCount(client.messages) >= 2,
      )
      const flags = turnFlags(after)
      // The only close is the session switch's reset; the running row stays live.
      assert.equal(flags.filter((running) => !running).length, 1)
      assert.equal(flags.at(-1), true)
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('ignores a chunk from the attempt a retry replaced', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      harness.holdPrompt()
      client.send({ type: 'prompt', text: '重试串' })
      await waitFor(() => harness.calls.prompt.length > 0)
      harness.stream(sessionId, { type: 'start', attemptId: 'old', revision: 0, turn: 1, step: 0 })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'old', revision: 1, index: 0, chunk: { index: 0, type: 'text-delta', text: '旧答' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message) === '旧答'
      )))
      harness.stream(sessionId, { type: 'start', attemptId: 'new', revision: 2, turn: 1, step: 0 })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block-drop' && keyOf(message) === 'b:1:0:0'
      )))
      // A late chunk from the replaced attempt must not resurface in the rewound step.
      harness.stream(sessionId, { type: 'chunk', attemptId: 'old', revision: 3, index: 0, chunk: { index: 0, type: 'text-delta', text: '迟到' } })
      harness.stream(sessionId, { type: 'chunk', attemptId: 'new', revision: 4, index: 0, chunk: { index: 0, type: 'text-delta', text: '新答' } })
      await waitFor(() => client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'b:1:0:0' && textOf(message).includes('新答')
      )))
      await new Promise((resolve) => setTimeout(resolve, 120))
      const texts = client.messages
        .filter((message) => message.type === 'block' && keyOf(message) === 'b:1:0:0')
        .map((message) => textOf(message))
      assert.equal(texts.some((text) => text.includes('迟到')), false)
      assert.equal(texts.at(-1), '新答')
    } finally {
      harness.releasePrompt()
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('tells the ball when the cap drops the oldest block', async () => {
    const harness = boot()
    const client = await connect(harness.runtime)
    try {
      client.send({ type: 'new' })
      await waitFor(() => client.messages.some((message) => message.type === 'session'))
      const sessionId = (client.messages.find((message) => message.type === 'session') as { sessionId: string }).sessionId
      for (let index = 0; index < 201; index += 1) {
        harness.inject(sessionId, {
          type: 'tool/call',
          seq: index + 1,
          data: { turn: 1, step: 0, callId: `bulk-${index}`, name: 'bash', arguments: '{"command":"ls","description":"x"}' },
        })
      }
      await waitFor(() => client.messages.some((message) => message.type === 'block-drop'))
      const drops = client.messages.filter((message) => message.type === 'block-drop')
      // Exactly the oldest block, and the newcomer survived.
      assert.deepEqual(drops.map(keyOf), ['tool:bulk-0'])
      assert.equal(client.messages.some((message) => (
        message.type === 'block' && keyOf(message) === 'tool:bulk-200'
      )), true)
    } finally {
      client.socket.end()
      harness.runtime.halt()
    }
  })

  it('fails a capture when the overlay ack never arrives', async () => {
    const harness = boot()
    const client = await connect(harness.runtime, { ack: false })
    try {
      const guard = harness.provided.get('computerUseOverlayGuard') as {
        withCapture(run: (session: { excludeWindowIds: readonly number[] }) => Promise<void>): Promise<void>
      }
      const events: string[] = []
      await assert.rejects(guard.withCapture(async () => { events.push('run') }), /ack timed out/)
      // The capture never ran, and the interval still closed on the wire.
      assert.deepEqual(events, [])
      assert.deepEqual(
        client.messages.filter((message) => message.type === 'overlay-capture').map((message) => message.active),
        [true, false],
      )
    } finally {
      client.socket.destroy()
      harness.runtime.halt()
    }
  })
})

describe('blank conversation sweep', () => {
  it('runs once per profile, and records only a pass that actually ran', async () => {
    const dir = mkdtempSync(join(home, 'sweep-'))
    const marker = join(dir, 'blank-sweep.json')
    let calls = 0
    const sweep = async (): Promise<number> => {
      calls += 1
      return 3
    }
    scheduleBlankSweep({ marker, delayMs: 0, sweep, log: () => {} })
    await waitFor(() => calls === 1 && markerHas(marker, 3))
    assert.match(readFileSync(marker, 'utf8'), /"swept":3/, 'the pass records what it moved')

    scheduleBlankSweep({ marker, delayMs: 0, sweep, log: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 1, 'a swept profile is not swept again')

    // A pass whose services are missing cannot run: no marker, so the next launch retries.
    const retry = join(dir, 'retry.json')
    let attempts = 0
    scheduleBlankSweep({
      marker: retry,
      delayMs: 0,
      sweep: async () => { attempts += 1; throw new Error('history-unavailable') },
      log: () => {},
    })
    await waitFor(() => attempts === 1)
    assert.equal(existsSync(retry), false, 'a pass that could not run is not recorded')
    scheduleBlankSweep({ marker: retry, delayMs: 0, sweep: async () => { attempts += 1; return 0 }, log: () => {} })
    await waitFor(() => attempts === 2 && markerHas(retry, 0))
    assert.match(readFileSync(retry, 'utf8'), /"swept":0/, 'a real "nothing to sweep" pass is recorded')
  })
})

describe('selection translation', () => {
  /**
   * A model that answers with the given deltas and records every request it was given.
   * `gate` holds the first delta back so a test can act while the answer is still streaming.
   */
  function model(deltas: readonly string[], gate?: Promise<void>) {
    const requests: Record<string, unknown>[] = []
    return {
      requests,
      service: {
        stream(options: unknown) {
          requests.push(options as Record<string, unknown>)
          return (async function* emit() {
            if (gate !== undefined) await gate
            for (const text of deltas) yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: 'stop' }
          })()
        },
      },
    }
  }

  /** Boot, connect, and hand the test the monitor feed the selection monitor would use. */
  async function bootWithMonitor(llm: { stream(options: unknown): AsyncIterable<unknown> }) {
    let feed: ((event: unknown) => void) | undefined
    const harness = boot({ llm, monitorHandlers: (handlers) => { feed = handlers.onEvent } })
    const client = await connect(harness.runtime)
    await waitFor(() => feed !== undefined)
    return { harness, client, feed: (event: unknown) => feed?.(event) }
  }

  function blocksOf(client: { messages: Record<string, unknown>[] }) {
    return client.messages.filter((message) => message.type === 'block') as {
      key: string
      kind: string
      text: string
      running: boolean
      local?: true
      response?: true
    }[]
  }

  it('renders a translation in the ball without touching the session', async () => {
    const fake = model(['你好', '，世界'])
    const { harness, client, feed } = await bootWithMonitor(fake.service)

    feed({ type: 'selection', text: 'hello, world', pid: 9, x: 10, y: 20 })
    client.send({ type: 'selection-action', action: 'translate' })

    await waitFor(() => blocksOf(client).some((block) => block.kind === 'assistant' && block.text.includes('世界')))
    const answered = blocksOf(client).filter((block) => block.kind === 'assistant')
    assert.equal(answered.at(-1)?.text, '你好，世界')

    // The question and the answer need separate keys: the panel keys its DOM nodes by `key`
    // alone, so one key for both would render the answer into the question's node and fail.
    const keys = blocksOf(client).map((block) => block.key)
    assert.equal(new Set(keys).size, keys.length, 'every block has its own key')
    // The answer is the turn's final answer, so the fold keeps it on screen.
    assert.equal(answered.every((block) => block.response === true), true)
    // Everything produced here is display-only.
    assert.equal(blocksOf(client).every((block) => block.local === true), true)

    assert.equal(harness.calls.prompt.length, 0, 'the session never saw this exchange')
    assert.equal(fake.requests.length, 1)
    assert.equal('tools' in (fake.requests[0] ?? {}), false)

    const lastTurn = () => (client.messages.filter((message) => message.type === 'turn') as { running: boolean }[]).at(-1)
    assert.equal(client.messages.some((message) => message.type === 'turn' && message.running === true), true)
    await waitFor(() => lastTurn()?.running === false)
  })

  it('stops a translation on the stop button and keeps what arrived', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = model(['一半', '的译文'], gate)
    const { harness, client, feed } = await bootWithMonitor(fake.service)

    feed({ type: 'selection', text: 'source', pid: 9, x: 1, y: 2 })
    client.send({ type: 'selection-action', action: 'translate' })
    await waitFor(() => fake.requests.length === 1)

    // Let the first delta through, then stop while the rest is still held.
    client.send({ type: 'stop' })
    release()

    const lastTurn = () => (client.messages.filter((message) => message.type === 'turn') as { running: boolean }[]).at(-1)
    await waitFor(() => lastTurn()?.running === false)
    assert.equal(harness.calls.cancel.length, 0, 'stopping a translation cancels no session')
    // A stopped answer settles what already reached the panel; it must not be blanked out.
    const settled = blocksOf(client).filter((block) => block.kind === 'assistant').at(-1)
    assert.equal(settled?.running, false)
    assert.equal(settled?.text !== '', true, 'the partial translation survives the stop')
  })

  it('keeps the streamed text when the transport rejects on abort', async () => {
    // The real adapter rejects rather than ending cleanly, which leaves `answer` empty; the
    // panel must still be settled with what it was already shown.
    const requests: Record<string, unknown>[] = []
    let emitFirst = () => {}
    const firstDelta = new Promise<void>((resolve) => { emitFirst = resolve })
    const service = {
      stream(options: unknown) {
        requests.push(options as Record<string, unknown>)
        const signal = (options as { signal: AbortSignal }).signal
        return (async function* emit() {
          await firstDelta
          yield { type: 'text-delta', index: 0, text: '半句' }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
          })
        })()
      },
    }
    let feed: ((event: unknown) => void) | undefined
    const harness = boot({ llm: service, monitorHandlers: (handlers) => { feed = handlers.onEvent } })
    const client = await connect(harness.runtime)
    await waitFor(() => feed !== undefined)

    feed({ type: 'selection', text: 'source', pid: 9, x: 1, y: 2 })
    client.send({ type: 'selection-action', action: 'translate' })
    await waitFor(() => requests.length === 1)
    emitFirst()
    await waitFor(() => blocksOf(client).some((block) => block.text === '半句'))
    client.send({ type: 'stop' })

    const lastTurn = () => (client.messages.filter((message) => message.type === 'turn') as { running: boolean }[]).at(-1)
    await waitFor(() => lastTurn()?.running === false)
    const settled = blocksOf(client).filter((block) => block.kind === 'assistant').at(-1)
    assert.equal(settled?.text, '半句', 'the text on screen survives a rejecting transport')
    assert.equal(settled?.running, false)
  })

  it('keeps a superseded translation from unlocking the panel of the one replacing it', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    // The first answer is held mid-stream; the second finishes immediately.
    const slow = model(['慢'], gate)
    const fast = model(['快'])
    let first = true
    const service = {
      stream(options: unknown) {
        const picked = first ? slow.service : fast.service
        first = false
        return picked.stream(options)
      },
    }
    const { client, feed } = await bootWithMonitor(service)

    feed({ type: 'selection', text: 'one', pid: 9, x: 1, y: 2 })
    client.send({ type: 'selection-action', action: 'translate' })
    await waitFor(() => slow.requests.length === 1)

    feed({ type: 'selection', text: 'two', pid: 9, x: 1, y: 2 })
    client.send({ type: 'selection-action', action: 'translate' })
    await waitFor(() => fast.requests.length === 1)
    release()

    const turns = () => client.messages.filter((message) => message.type === 'turn') as { running: boolean }[]
    await waitFor(() => turns().at(-1)?.running === false)
    // Skip the state the panel is handed on connect: two opens and exactly one close. The
    // superseded answer must not send a second `false` that would unlock the composer while
    // the replacement was still streaming.
    assert.deepEqual(turns().slice(1).map((turn) => turn.running), [true, true, false])
    await waitFor(() => blocksOf(client).some((block) => block.text.includes('快')))
  })

  it('drops a translation in flight when the conversation is replaced', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = model(['旧译文'], gate)
    const { client, feed } = await bootWithMonitor(fake.service)

    feed({ type: 'selection', text: 'one', pid: 9, x: 1, y: 2 })
    client.send({ type: 'selection-action', action: 'translate' })
    await waitFor(() => fake.requests.length === 1)

    // New chat clears the transcript; a translation belongs to the one it was rendered into.
    client.send({ type: 'new' })
    await waitFor(() => client.messages.some((message) => message.type === 'reset'))
    release()

    const lastTurn = () => (client.messages.filter((message) => message.type === 'turn') as { running: boolean }[]).at(-1)
    await waitFor(() => lastTurn()?.running === false)
    // Nothing may arrive after the reset that belongs to the old transcript.
    const resetAt = client.messages.findIndex((message) => message.type === 'reset')
    const after = client.messages.slice(resetAt + 1).filter((message) => message.type === 'block')
    assert.equal(after.some((block) => String(block.text).includes('旧译文')), false)
  })
})
