/**
 * NDJSON control plane for the ball, plus the Computer Use session it talks to.
 * The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Appearance, ThemePreference } from './appearance.ts'
import { avatarPresetSrc } from './avatar-presets.ts'
import { normalizeCatalog } from './catalog.ts'
import { resolveElectronBinary } from './electron-runtime.ts'
import { helperMain } from './helper-path.ts'
import { openMainWindow } from './open-main.ts'
import { isDesktopHost, isTccRight, TccMonitor, type TccRight, type TccStatus } from './tcc.ts'
import {
  isAgentModelSelection,
  isHotkeyAccelerator,
  isPermissionPreset,
  type AgentModelSelection,
  type HotkeyAccelerator,
  type PermissionPreset,
  type ProfileStore,
} from './preferences.ts'
import { tokensMatch } from './routes.ts'
import { createOverlayGuard } from './overlay-guard.ts'
import {
  openSystemUrl,
  productionAccessibility,
  SelectionController,
  type SelectionStarter,
} from './selection.ts'
import { pinSessionId } from './services.ts'
import { selectModelKeepDefault } from './select-model.ts'
import { createForegroundMemory } from './windows-foreground.ts'

/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
export interface OrbContext {
  readonly webServer: {
    readonly port: number
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    authenticatedUrl(baseUrl: string): string
    admit?(request: import('node:http').IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: import('node:http').IncomingMessage): boolean
  }
  readonly workspaceController: {
    create(request: { readonly path: string }): Promise<{
      readonly workspace: { readonly workspaceId: string }
    }>
  }
  readonly sessionController: {
    create(request: {
      readonly workspaceId?: string
      readonly sessionId?: string
      readonly agentPreset?: string
    }): Promise<{ readonly sessionId: string }>
    prompt(request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
      readonly clientTimeZone?: string
    }, signal: AbortSignal): Promise<{ readonly accepted: true }>
    list(request: object, signal: AbortSignal): Promise<{ readonly items?: readonly unknown[] } | readonly unknown[]>
    selectModel(request: {
      readonly sessionId: string
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }): Promise<unknown>
    cancel(request: { readonly sessionId: string }): Promise<unknown>
    modelCatalog(): unknown
  }
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
      readonly header?: { readonly cwd?: string; readonly agentPreset?: string }
    } | undefined
  }
  readonly agentDefaultModel?: {
    currentSelection(): {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }
    saveSelection(selection: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }): Promise<void>
  }
  effect(execute: () => void | (() => void)): void
  get(name: string): unknown
  provide(name: string, value: unknown): void
  on(
    name: 'user-questions/request',
    listener: (
      request: QuestionRequest,
      next: () => Promise<QuestionAnswer>,
    ) => Promise<QuestionAnswer>,
    options?: { readonly prepend?: boolean },
  ): (() => void) | void
  on(
    name: 'session/created',
    listener: (session: { readonly header?: { readonly cwd?: string; readonly agentPreset?: string } }) => void,
  ): (() => void) | void
  on(
    name: 'agent/assistant-stream',
    listener: (payload: {
      readonly agent?: { readonly session?: { readonly id?: unknown } }
      readonly frame?: unknown
    }) => void,
    options?: { readonly global?: boolean },
  ): (() => void) | void
  on(
    name: 'settings/document-updated',
    listener: (ns: unknown, revision: unknown) => void,
  ): (() => void) | void
  on(name: string, listener: (...args: unknown[]) => void): (() => void) | void
}

interface QuestionRequest {
  readonly questions?: unknown
  readonly agent?: { readonly id?: unknown }
  readonly signal?: AbortSignal
}

interface QuestionAnswer {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

interface ToolDetail {
  /** Raw argument JSON exactly as the model produced it. */
  readonly args: string
  /** Flattened result text, present once the call settled. */
  readonly result: string
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
  /** Result-time tool-private presentation payload (diffs, read windows), JSON text. */
  readonly meta: string
  /** Session workspace root, for path display. */
  readonly cwd: string
}

/** Provider-reported token counts of one settled assistant message. */
interface BlockUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

interface BlockMessage {
  readonly type: 'block'
  readonly key: string
  readonly kind: 'user' | 'reasoning' | 'assistant' | 'tool'
  readonly text: string
  readonly running: boolean
  readonly interrupted?: true
  /** Part of the turn's final answer: the only text a folded turn keeps visible. */
  readonly response?: true
  readonly detail?: ToolDetail
  readonly usage?: BlockUsage
}

interface PendingQuestion {
  readonly id: string
  readonly resolve: (answer: QuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly next: () => Promise<QuestionAnswer>
}

interface ShownQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: true
}

/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
export class OrbRuntime {
  private readonly token = randomBytes(32).toString('hex')
  private readonly sessionFile = dshHomePath('dsh-orb', 'floating-session.json')
  private server: Server | undefined
  private port = 0
  private readonly sockets = new Set<Socket>()
  private readonly buffers = new Map<Socket, string>()
  private readonly blocks = new Map<string, BlockMessage>()
  private readonly blockOrder: string[] = []
  private pending: PendingQuestion | undefined
  private questionBody: readonly ShownQuestion[] | undefined
  private turnRunning = false
  private turnInterrupted = false
  private child: ChildProcess | undefined
  private binary = ''
  private failures = 0
  private halted = false
  private generation = 0
  private replaying = false
  private workspaceTask: Promise<string> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private opening = false
  private pendingStart = false
  private helperError: string | undefined
  private userData = ''
  private idleWarned = false
  private sessionId: string | undefined
  private sessionError: string | undefined
  private creating: Promise<string> | undefined
  private watermark = 0
  private missingLogged = false
  private timer: ReturnType<typeof setInterval> | undefined
  private giveUp: ReturnType<typeof setTimeout> | undefined
  private readonly dirty = new Set<string>()
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined
  /** Chunk frames carry no turn/step; only the attempt's start frame does. */
  private readonly attemptPositions = new Map<string, { turn: number; step: number }>()
  private readonly lastAttemptByStep = new Map<string, string>()
  /** Transient block keys one streaming step created, in creation order. */
  private readonly stepBlocks = new Map<string, string[]>()
  private liveStep: string | undefined
  private orphanFrameLogged = false
  /** Keys of the newest settled assistant message: the turn's final answer so far. */
  private responseKeys: string[] = []
  private helperPid: number | undefined
  private appearance: Appearance = {}
  private readonly overlayWaiters = new Map<string, () => void>()
  /** Chrome window ids each helper reported, keyed by its socket. */
  private readonly chromeWindows = new Map<Socket, readonly number[]>()
  private readonly tcc: { status(): TccStatus; open(right: TccRight): Promise<void> }
  private readonly selection: SelectionController
  private readonly overlay = createOverlayGuard({
    hasHelper: () => this.sockets.size > 0,
    send: (message, signal) => this.waitAck(message, signal),
    setHidInput: (active) => { this.selection.setHidInput(active) },
    chromeWindowIds: () => this.chromeWindowIds(),
  })
  /**
   * Windows only. Clicking the ball makes it the system foreground window, so the window
   * the user was actually working in is remembered and handed back on submit.
   */
  private readonly foreground = createForegroundMemory({
    chromeWindowIds: () => this.chromeWindowIds(),
  })

  constructor(
    private readonly ctx: OrbContext,
    private readonly store: ProfileStore,
    options: { startMonitor?: SelectionStarter; tcc?: { status(): TccStatus; open(right: TccRight): Promise<void> } } = {},
  ) {
    this.tcc = options.tcc ?? new TccMonitor()
    const access = productionAccessibility()
    this.selection = new SelectionController({
      enabled: () => this.store.selectionEnabled(),
      language: () => this.store.translateLanguage(),
      setLanguage: (language) => {
        this.store.setTranslateLanguage(language)
        this.broadcast({ type: 'selection-language', language })
      },
      helperConnected: () => this.sockets.size > 0,
      helperPid: () => this.helperPid,
      show: (payload) => { this.broadcast({ type: 'selection', ...payload }) },
      hide: () => { this.broadcast({ type: 'selection-hide' }) },
      pointer: (x, y) => { this.broadcast({ type: 'selection-pointer', x, y }) },
      attach: (text) => { this.broadcast({ type: 'selection-attach', text }) },
      prompt: (text) => { void this.onPrompt(text) },
      openExternal: (url) => { openSystemUrl(url) },
      requestAccessibility: () => access.requestAccessibility(),
      accessibilityTrusted: () => access.accessibilityTrusted(),
      now: () => Date.now(),
    }, options.startMonitor)
    ctx.provide('computerUseOverlayGuard', this.overlay)
    this.listenAssistantStream()
  }

  /**
   * Follow the loop's process-local assistant stream so text, thinking, and tool
   * calls reach the ball while the model is still producing them. The durable
   * log only records the settled message, which is what the 400 ms poll sees.
   */
  private listenAssistantStream(): void {
    try {
      this.ctx.on('agent/assistant-stream', (payload) => this.onAssistantStream(payload), { global: true })
    } catch (error) {
      console.error(`dsh-orb: assistant stream unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private onAssistantStream(payload: unknown): void {
    if (this.sessionId === undefined) return
    const record = asRecord(payload)
    const agent = asRecord(record?.agent)
    const session = asRecord(agent?.session)
    if (session?.id !== this.sessionId) return
    const frame = asRecord(record?.frame)
    if (!frame) return
    const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
    if (frame.type === 'start') {
      if (attemptId === '') return
      const turn = numberOf(frame.turn)
      const step = numberOf(frame.step)
      this.attemptPositions.set(attemptId, { turn, step })
      const stepKey = `${turn}:${step}`
      const previous = this.lastAttemptByStep.get(stepKey)
      this.lastAttemptByStep.set(stepKey, attemptId)
      if (previous !== undefined && previous !== attemptId) this.rewindLiveStep(turn, step)
      return
    }
    if (frame.type === 'end') {
      this.attemptPositions.delete(attemptId)
      return
    }
    if (frame.type !== 'chunk') return
    const position = this.attemptPositions.get(attemptId)
    if (position === undefined) {
      if (!this.orphanFrameLogged) {
        this.orphanFrameLogged = true
        console.error('dsh-orb: assistant stream chunk arrived without its start frame')
      }
      return
    }
    if (!asRecord(frame.chunk)) return
    this.onChunk({ turn: position.turn, step: position.step, chunk: frame.chunk })
  }

  /** A new attempt supersedes the dead one: drop its transient blocks so the retry streams into a clean slate. */
  private rewindLiveStep(turn: number, step: number): void {
    const tracked = this.stepBlocks.get(`${turn}:${step}`)
    if (!tracked) return
    this.stepBlocks.delete(`${turn}:${step}`)
    for (const key of tracked) this.dropBlock(key)
  }

  /** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
  async start(): Promise<void> {
    if (process.platform === 'linux') return
    this.halted = false
    this.failures = 0
    this.helperError = undefined
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && this.server) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    if (this.opening) {
      this.generation += 1
      this.pendingStart = true
      return
    }
    this.opening = true
    this.generation += 1
    const generation = this.generation
    try {
      await this.begin(generation)
    } finally {
      this.opening = false
      if (this.pendingStart) {
        this.pendingStart = false
        if (!this.halted) await this.start()
      }
    }
  }

  /** Short code the settings page can show after the helper gives up. */
  helperStatus(): string {
    return this.helperError ?? ''
  }

  private async begin(generation: number): Promise<void> {
    if (!this.server) await this.listen()
    if (this.halted || generation !== this.generation) {
      this.server?.close()
      this.server = undefined
      return
    }
    console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`)
    const sessionTask = this.ensureSession().catch((error: unknown) => {
      this.sessionError = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: session setup failed: ${this.sessionError}`)
    })
    try {
      this.binary = await resolveElectronBinary()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: ${message}`)
      this.helperError = 'runtime-download'
      this.server?.close()
      this.server = undefined
      return
    }
    await sessionTask
    if (this.halted || generation !== this.generation) return
    this.userData = helperDataDirectory(this.store.dir)
    await mkdir(this.userData, { recursive: true })
    this.launch()
  }

  /**
   * Open the control socket without spawning the helper.
   * {@link start} listens and then launches the helper process.
   */
  async bind(): Promise<{ port: number; token: string }> {
    if (!this.server) await this.listen()
    return { port: this.port, token: this.token }
  }

  /** Stop the helper and the socket. Settings can call {@link start} again. */
  halt(): void {
    this.generation += 1
    this.halted = true
    this.pendingStart = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.stopWatch()
    this.clearDirty()
    this.handQuestionBack()
    this.server?.close()
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.buffers.clear()
    this.chromeWindows.clear()
    this.helperPid = undefined
    this.overlayWaiters.clear()
    this.selection.stop()
    this.foreground.stop()
    this.killChild()
  }

  /** Claim questions for this orb session. Register this while the plugin fiber is active. */
  attachQuestions(): () => void {
    try {
      const dispose = this.ctx.on(
        'user-questions/request',
        (request, next) => this.onQuestion(request, next),
        { prepend: true },
      )
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      console.error(`dsh-orb: question listener failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((socket) => {
      this.handle(socket)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('dsh-orb: helper socket has no port')
    this.port = address.port
  }

  private handle(socket: Socket): void {
    socket.setEncoding('utf8')
    let authed = false
    const timer = setTimeout(() => {
      if (!authed) socket.destroy()
    }, 3000)
    timer.unref()
    socket.on('data', (chunk: string) => {
      const next = `${this.buffers.get(socket) ?? ''}${chunk}`
      if (next.length > 1_000_000) {
        socket.destroy()
        return
      }
      const parts = next.split('\n')
      this.buffers.set(socket, parts.pop() ?? '')
      for (const part of parts) {
        if (!part.trim()) continue
        let message: unknown
        try {
          message = JSON.parse(part)
        } catch {
          socket.destroy()
          return
        }
        if (!authed) {
          if (!this.helloOk(message)) {
            socket.destroy()
            return
          }
          authed = true
          clearTimeout(timer)
          this.accept(socket, message)
          continue
        }
        if (isPrompt(message)) void this.onPrompt(message.text)
        else if (isQuestionAnswer(message)) this.onQuestionAnswer(message.id, message.answers)
        else if (isQuestionCancel(message)) this.onQuestionCancel(message.id)
        else this.onControl(message, socket)
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.buffers.delete(socket)
      this.chromeWindows.delete(socket)
      if (this.sockets.size === 0) {
        this.handQuestionBack()
        this.helperPid = undefined
        this.selection.stop()
        this.foreground.stop()
      }
    })
    socket.on('error', () => {
      socket.destroy()
    })
  }

  private helloOk(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const record = message as { type?: unknown; token?: unknown }
    if (record.type !== 'hello' || typeof record.token !== 'string') return false
    const given = Buffer.from(record.token)
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private accept(socket: Socket, hello: unknown): void {
    const pid = asRecord(hello)?.pid
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) this.helperPid = pid
    this.sockets.add(socket)
    if (this.sessionId) this.send(socket, { type: 'session', sessionId: this.sessionId })
    if (this.blockOrder.length === 0 && this.sessionId) {
      this.replaying = true
      this.drain()
      this.replaying = false
    } else {
      for (const key of this.blockOrder) {
        const block = this.blocks.get(key)
        if (block) this.send(socket, block)
      }
    }
    this.send(socket, { type: 'turn', running: this.turnRunning })
    if (Object.keys(this.appearance).length > 0) this.send(socket, { type: 'appearance', ...this.appearance })
    this.send(socket, { type: 'hotkey', ...this.store.hotkey() })
    if (this.pending) this.send(socket, this.questionPayload(this.pending.id))
    void this.publishChrome()
    this.selection.sync()
    this.foreground.start()
  }

  private async onPrompt(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    this.turnInterrupted = false
    this.block(`user:${randomUUID()}`, 'user', trimmed, false, 'set')
    this.turnRunning = true
    this.selection.setSessionRunning(true)
    this.broadcast({ type: 'turn', running: true })
    if (this.sessionError && !this.sessionId) {
      this.turnRunning = false
      this.selection.setSessionRunning(false)
      this.broadcast({ type: 'turn', running: false })
      this.status(this.sessionError)
      return
    }
    try {
      // Hand the foreground back before the agent's first capture. The user submitted from
      // the ball, so the ball is the system foreground window right now and the observation
      // walk would otherwise read it as the app the user is working in.
      this.foreground.restore()
      const sessionId = await this.ensureSession()
      if (!this.timer) this.syncWatermark()
      this.watch()
      await this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: trimmed }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, new AbortController().signal)
      this.drain()
    } catch (error) {
      this.finishTurn()
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: prompt failed: ${message}`)
      this.status(message)
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId
    this.creating ??= this.createSession().finally(() => {
      this.creating = undefined
    })
    return this.creating
  }

  private async createSession(): Promise<string> {
    const workspaceId = await this.workspaceId()
    const saved = await readSavedSession(this.sessionFile)
    try {
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
        ...saved ? { sessionId: saved } : {},
      })
      return this.adopt(session.sessionId)
    } catch (error) {
      if (!saved) throw error
      console.error('dsh-orb: saved session cannot be opened; creating a new one')
      await rm(this.sessionFile, { force: true })
      const session = await this.ctx.sessionController.create({
        workspaceId,
        agentPreset: 'computer-use',
      })
      return this.adopt(session.sessionId)
    }
  }

  private workspaceId(): Promise<string> {
    this.workspaceTask ??= this.createWorkspace().catch((error: unknown) => {
      this.workspaceTask = undefined
      throw error
    })
    return this.workspaceTask
  }

  private async createWorkspace(): Promise<string> {
    const workspace = dshHomePath('dsh_orb')
    await mkdir(workspace, { recursive: true })
    const created = await this.ctx.workspaceController.create({ path: workspace })
    return created.workspace.workspaceId
  }

  private async adopt(sessionId: string): Promise<string> {
    const id = await this.remember(sessionId)
    await this.applyOverlayQuiet(id)
    pinSessionId(this.ctx, id, this.store.permission())
    return id
  }

  private async remember(sessionId: string): Promise<string> {
    this.sessionId = sessionId
    this.sessionError = undefined
    try {
      await mkdir(dirname(this.sessionFile), { recursive: true })
      await writeFile(this.sessionFile, `${JSON.stringify({ sessionId })}\n`)
    } catch (error) {
      console.error(`dsh-orb: could not save session id: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.broadcast({ type: 'session', sessionId })
    console.error(`dsh-orb: session ${sessionId}`)
    return sessionId
  }

  private syncWatermark(): void {
    if (!this.sessionId) return
    const session = this.ctx.sessions.get(this.sessionId)
    if (!session) return
    for (const event of session.snapshotEvents()) {
      const seq = Number(event.seq)
      if (seq > this.watermark) this.watermark = seq
    }
  }

  private watch(): void {
    if (!this.timer) this.timer = setInterval(() => this.drain(), 400)
    this.armIdle()
  }

  /** Warn after 3 quiet minutes, but keep polling until the session goes idle. */
  private armIdle(): void {
    if (this.giveUp) clearTimeout(this.giveUp)
    this.giveUp = setTimeout(() => {
      if (!this.turnRunning) return
      if (this.pending) {
        this.armIdle()
        return
      }
      if (!this.idleWarned) {
        this.idleWarned = true
        this.status('等待超时')
      }
    }, 180_000)
  }

  private stopWatch(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.giveUp) clearTimeout(this.giveUp)
    this.giveUp = undefined
  }

  private drain(): void {
    if (!this.sessionId) return
    const session = this.ctx.sessions.get(this.sessionId)
    if (!session) {
      if (!this.missingLogged) {
        this.missingLogged = true
        console.error('dsh-orb: session is not in the store yet')
      }
      return
    }
    this.missingLogged = false
    let fresh = false
    try {
      for (const event of session.snapshotEvents()) {
        const seq = Number(event.seq)
        if (seq <= this.watermark) continue
        this.watermark = seq
        fresh = true
        this.consume(event.type, event.data, seq)
      }
    } catch (error) {
      console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (fresh && this.turnRunning) {
      this.idleWarned = false
      this.armIdle()
    }
  }

  private consume(type: string, data: unknown, seq: number): void {
    if (type === 'user/message') {
      if (!this.replaying) return
      const text = userText(data)
      if (!text.trim()) return
      this.block(`user:${seq}`, 'user', text, false, 'set')
      return
    }
    if (type === 'assistant/chunk') {
      this.onChunk(data)
      return
    }
    if (type === 'assistant/message') {
      this.onAssistant(data)
      return
    }
    if (type === 'tool/call') {
      const name = toolName(data)
      if (!name) return
      const id = callId(data)
      const existing = id ? undefined : this.runningTool(name)
      const key = id ? `tool:${id}` : existing ?? `tool:${seq}`
      this.block(key, 'tool', name, false, 'set', {
        args: clip(toolArguments(data), 4000),
      })
      return
    }
    if (type === 'tool/result') {
      this.onToolResult(data)
      return
    }
    if (type === 'turn/end') this.finishTurn()
  }

  /** Join a settled result to its call by id, carrying error state and meta. */
  private onToolResult(data: unknown): void {
    const record = asRecord(data)
    if (!record) return
    const id = callId(record)
    const message = asRecord(record.message)
    const callIdValue = id || (message ? callIdValueOf(message) : '')
    if (!callIdValue) return
    const key = `tool:${callIdValue}`
    const existing = this.blocks.get(key)
    const name = existing?.kind === 'tool' ? existing.text : toolName(record) || ''
    const content = Array.isArray(message?.content) ? message?.content : []
    const error = asRecord(record.error)
    const detail: ToolDetail = {
      args: existing?.detail?.args ?? '',
      result: clip(resultText(content, error ?? undefined), 8000),
      isError: message?.isError === true,
      ...(error === undefined ? {} : {
        error: {
          name: typeof error.name === 'string' ? error.name : 'Error',
          code: typeof error.code === 'string' ? error.code : 'unknown',
          ...(typeof error.reason === 'string' ? { reason: clip(error.reason, 2000) } : {}),
        },
      }),
      meta: clip(jsonText(record.meta), 12000),
      cwd: this.sessionCwd(),
    }
    this.block(key, 'tool', name, false, 'set', detail)
  }

  private sessionCwd(): string {
    if (!this.sessionId) return ''
    return this.ctx.sessions.get(this.sessionId)?.header?.cwd ?? ''
  }

  private onChunk(data: unknown): void {
    const record = asRecord(data)
    const chunk = asRecord(record?.chunk)
    if (!record || !chunk) return
    const turn = numberOf(record.turn)
    const step = numberOf(record.step)
    const index = numberOf(chunk.index)
    const key = `b:${turn}:${step}:${index}`
    this.liveStep = `${turn}:${step}`
    try {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        this.block(key, 'assistant', chunk.text, true, 'append')
        return
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        this.block(key, 'reasoning', chunk.text, true, 'append')
        return
      }
      if (chunk.type === 'tool-call-delta') {
        const name = typeof chunk.name === 'string' ? chunk.name : ''
        if (!name) return
        const id = typeof chunk.id === 'string' ? chunk.id : ''
        const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        const toolKey = id ? `tool:${id}` : `b:${turn}:${step}:${index}`
        const previous = this.blocks.get(toolKey)
        this.block(toolKey, 'tool', name, true, 'set', {
          args: clip(`${previous?.detail?.args ?? ''}${delta}`, 4000),
        })
        return
      }
      if (chunk.type === 'block-end') this.applyContent(key, chunk.block, false)
    } finally {
      this.liveStep = undefined
    }
  }

  /**
   * Settle one assistant message like Harness settleAssistant: the transient
   * streamed blocks are consumed in place (kind + order) and whatever the
   * message did not claim is dropped, so no stale copy can survive the fold.
   */
  private onAssistant(data: unknown): void {
    const record = asRecord(data)
    if (!record) return
    const turn = numberOf(record.turn)
    const step = numberOf(record.step)
    const usage = readUsage(record.usage)
    if (record.interrupted === true) this.turnInterrupted = true
    // Only the newest settled message is the final answer; demote the previous one.
    const previous = this.responseKeys
    this.responseKeys = []
    for (const key of previous) {
      const item = this.blocks.get(key)
      if (item?.response === true) this.block(key, item.kind, item.text, false, 'set')
    }
    const message = asRecord(record.message)
    const content = message?.content
    const parts: unknown[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content) ? content : []
    const transient = this.stepBlocks.get(`${turn}:${step}`) ?? []
    this.stepBlocks.delete(`${turn}:${step}`)
    const writtenKeys: string[] = []
    let cursor = 0
    for (const [index, part] of parts.entries()) {
      const wanted = partKind(asRecord(part))
      let key: string | undefined
      if (wanted !== undefined) {
        while (cursor < transient.length) {
          const candidate = transient[cursor]
          cursor += 1
          if (this.blocks.get(candidate)?.kind === wanted) {
            key = candidate
            break
          }
          this.dropBlock(candidate)
        }
      }
      key ??= `b:${turn}:${step}:${index}`
      const written = this.applyContent(key, part, false)
      if (written === undefined || written !== key) this.dropBlock(key)
      if (written !== undefined) writtenKeys.push(written)
    }
    while (cursor < transient.length) {
      this.dropBlock(transient[cursor])
      cursor += 1
    }
    this.responseKeys = writtenKeys
    // The usage meter rides on the message's closing reply block, as in Harness.
    if (usage !== undefined) {
      const last = [...writtenKeys].reverse().find((key) => this.blocks.get(key)?.kind === 'assistant')
      const settled = last === undefined ? undefined : this.blocks.get(last)
      if (last !== undefined && settled) this.block(last, settled.kind, settled.text, false, 'set', undefined, usage)
    }
  }

  /** Remove one block everywhere: map, order, and the ball's DOM. */
  private dropBlock(key: string): void {
    if (!this.blocks.delete(key)) return
    const at = this.blockOrder.indexOf(key)
    if (at >= 0) this.blockOrder.splice(at, 1)
    this.dirty.delete(key)
    this.publish({ type: 'block-drop', key })
  }

  /** Write one content part. Returns the key it landed on, or `undefined` when the part is skipped. */
  private applyContent(key: string, part: unknown, running: boolean): string | undefined {
    const block = asRecord(part)
    if (!block) return undefined
    if ((block.type === 'text' || block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string') {
      if (!block.text.trim()) return undefined
      const kind = block.type === 'text' ? 'assistant' : 'reasoning'
      this.block(key, kind, block.text, running, 'set')
      return key
    }
    if (block.type !== 'tool-call' && block.type !== 'tool_use') return undefined
    const name = typeof block.name === 'string' ? block.name : ''
    if (!name) return undefined
    const id = typeof block.id === 'string' ? block.id : typeof block.callId === 'string' ? block.callId : ''
    const toolKey = id ? `tool:${id}` : key
    this.block(toolKey, 'tool', name, running, 'set', {
      args: clip(typeof block.arguments === 'string' ? block.arguments : '', 4000),
    })
    return toolKey
  }

  private runningTool(name: string): string | undefined {
    for (const key of this.blockOrder) {
      const block = this.blocks.get(key)
      if (block?.kind === 'tool' && block.text === name && block.running) return key
    }
    return undefined
  }

  private finishTurn(): void {
    this.turnRunning = false
    this.idleWarned = false
    this.selection.setSessionRunning(false)
    for (const key of [...this.blockOrder]) {
      const item = this.blocks.get(key)
      if (item?.running) this.settleBlock(key)
    }
    this.stepBlocks.clear()
    this.lastAttemptByStep.clear()
    // Mark the final answer so a folded turn keeps only it visible.
    for (const key of [...this.responseKeys]) {
      const item = this.blocks.get(key)
      if (item) this.block(key, item.kind, item.text, false, 'set')
    }
    this.responseKeys = []
    this.broadcast({ type: 'turn', running: false, ...(this.turnInterrupted ? { interrupted: true } : {}) })
    this.turnInterrupted = false
    this.stopWatch()
    const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === 'assistant')
    console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`)
  }

  /** Flip one leftover running block to settled, bypassing the empty-text guard in {@link block}. */
  private settleBlock(key: string): void {
    const previous = this.blocks.get(key)
    if (!previous) return
    const message: BlockMessage = {
      ...previous,
      running: false,
      ...(this.turnInterrupted && previous.kind === 'assistant' ? { interrupted: true as const } : {}),
    }
    this.blocks.set(key, message)
    this.dirty.delete(key)
    this.publish(message)
  }

  private block(
    key: string,
    kind: BlockMessage['kind'],
    text: string,
    running: boolean,
    mode: 'set' | 'append',
    detail?: Partial<ToolDetail>,
    usage?: BlockUsage,
  ): void {
    const previous = this.blocks.get(key)
    const previousText = previous?.text ?? ''
    const next = clip(mode === 'append' ? `${previousText}${text}` : text, 20_000)
    if (!next.trim() && kind !== 'tool') return
    const mergedDetail = detail === undefined ? previous?.detail : {
      args: detail.args ?? previous?.detail?.args ?? '',
      result: detail.result ?? previous?.detail?.result ?? '',
      isError: detail.isError ?? previous?.detail?.isError ?? false,
      error: detail.error ?? previous?.detail?.error,
      meta: detail.meta ?? previous?.detail?.meta ?? '',
      cwd: detail.cwd ?? previous?.detail?.cwd ?? '',
    }
    const merged: ToolDetail | undefined = mergedDetail === undefined ? undefined : {
      ...mergedDetail,
      ...(mergedDetail.error === undefined ? {} : { error: mergedDetail.error }),
    }
    const mergedUsage = usage === undefined ? previous?.usage : usage
    const message: BlockMessage = {
      type: 'block', key, kind, text: next, running,
      ...(this.turnInterrupted && kind === 'assistant' && !running ? { interrupted: true } : {}),
      ...(this.responseKeys.includes(key) ? { response: true as const } : {}),
      ...(merged === undefined ? {} : { detail: merged }),
      ...(mergedUsage === undefined ? {} : { usage: mergedUsage }),
    }
    if (!this.blocks.has(key)) {
      this.blockOrder.push(key)
      if (this.liveStep !== undefined) {
        const tracked = this.stepBlocks.get(this.liveStep)
        if (tracked) tracked.push(key)
        else this.stepBlocks.set(this.liveStep, [key])
      }
      while (this.blockOrder.length > 200) {
        const dropped = this.blockOrder.shift()
        if (dropped) {
          this.blocks.delete(dropped)
          this.dirty.delete(dropped)
        }
      }
    }
    this.blocks.set(key, message)
    if (running) {
      this.dirty.add(key)
      this.dirtyTimer ??= setTimeout(() => this.flushDirty(), 60)
      return
    }
    this.dirty.delete(key)
    this.publish(message)
  }

  /** Broadcast with global FIFO: pending coalesced updates go out before anything newer. */
  private publish(message: unknown): void {
    this.flushDirty()
    this.broadcast(message)
  }

  /** Coalesce per-token running-block updates; settled blocks always go out immediately. */
  private flushDirty(): void {
    this.dirtyTimer = undefined
    const keys = [...this.dirty]
    this.dirty.clear()
    for (const key of keys) {
      const message = this.blocks.get(key)
      if (message) this.broadcast(message)
    }
  }

  private clearDirty(): void {
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer)
    this.dirtyTimer = undefined
    this.dirty.clear()
  }

  private status(text: string): void {
    this.broadcast({ type: 'status', text: clip(text, 500) })
  }

  private onQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const agentId = typeof request.agent?.id === 'string' ? request.agent.id : ''
    const questions = sanitizeQuestions(request.questions)
    if (this.sockets.size === 0 || !this.sessionId || agentId !== this.sessionId || this.pending || questions.length === 0) {
      if (this.sessionId && agentId === this.sessionId) {
        console.error(`dsh-orb: question deferred sockets=${this.sockets.size} pending=${this.pending !== undefined} count=${questions.length}`)
      }
      return next()
    }
    console.error(`dsh-orb: question card ${questions.length}`)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, next }
      this.questionBody = questions
      this.broadcast(this.questionPayload(id))
      const signal = request.signal
      const onAbort = () => {
        this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED', id)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private onQuestionAnswer(id: string, answers: unknown): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    const parsed = parseAnswers(answers)
    if (!parsed) {
      this.broadcast({ type: 'question-error', id, text: '答案无效' })
      return
    }
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id })
    console.error('dsh-orb: question answered')
    pending.resolve(parsed)
  }

  private onQuestionCancel(id: string): void {
    this.failQuestion('the user cancelled ask_user_question', 'ASK_CANCELLED', id)
  }

  /** The ball is gone, so the main window can answer. Abort and cancel still reject. */
  private handQuestionBack(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id: pending.id })
    console.error('dsh-orb: question returned to the main window')
    void pending.next().then(pending.resolve, pending.reject)
  }

  private failQuestion(message: string, code: string, id = this.pending?.id): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id })
    console.error(`dsh-orb: question ${code}`)
    pending.reject(questionError(message, code))
  }

  private questionPayload(id: string): { type: 'question'; id: string; questions: readonly ShownQuestion[] } {
    return { type: 'question', id, questions: this.questionBody ?? [] }
  }

  private broadcast(message: unknown): void {
    for (const socket of this.sockets) this.send(socket, message)
  }

  /**
   * Every chrome handle the connected helpers reported.
   * The Windows observation walk skips these, so the ball never becomes the window the
   * agent believes the user is working in. Empty on macOS, where the ball is a
   * non-activating panel and the helper reports nothing.
   */
  private chromeWindowIds(): readonly number[] {
    const ids: number[] = []
    for (const reported of this.chromeWindows.values()) {
      for (const id of reported) {
        if (!ids.includes(id)) ids.push(id)
      }
    }
    return ids
  }

  private send(socket: Socket, message: unknown): void {
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch {
      socket.destroy()
    }
  }

  private launch(): void {
    if (this.halted || !this.binary) return
    const generation = this.generation
    const userData = this.userData || helperDataDirectory(this.store.dir)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_ORB_TOKEN: this.token,
      DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
      DSH_ORB_WEB_PORT: String(this.ctx.webServer.port),
      ...(Object.keys(this.appearance).length > 0
        ? { DSH_ORB_APPEARANCE: JSON.stringify(this.appearance) }
        : {}),
    }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(this.binary, [`--user-data-dir=${userData}`, helperMain()], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    console.error(`dsh-orb: helper started pid ${child.pid ?? 'unknown'}`)
    const stable = setTimeout(() => {
      if (this.child === child) this.failures = 0
    }, 60_000)
    stable.unref()
    const token = this.token
    const log = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue
        console.error(`dsh-orb helper: ${line}`)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    let settled = false
    const fail = (reason: string) => {
      if (settled || this.halted || generation !== this.generation) return
      settled = true
      if (this.child === child) this.child = undefined
      this.failures += 1
      if (this.failures > 3) {
        this.helperError = 'helper-exited'
        console.error('dsh-orb: helper exited too many times; ball stays hidden')
        return
      }
      console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`)
      this.retry = setTimeout(() => this.launch(), 500)
      this.retry.unref()
    }
    child.once('error', (error) => fail(error.message))
    child.once('exit', (code, signal) => fail(String(code ?? signal)))
  }

  private killChild(): void {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const pid = child.pid
    if (pid === undefined) return
    const timer = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The helper already exited.
      }
    }, 1000)
    timer.unref()
  }

  /** True when the helper presented this socket token. */
  helperAuthorized(token: string): boolean {
    return tokensMatch(token, this.token)
  }

  /** Push permission, both models, the catalog, and the avatar version to the ball. */
  async publishChrome(): Promise<void> {
    const models = this.store.models()
    let catalog = { groups: [] as readonly { id: string; name: string; models: readonly unknown[] }[] }
    try {
      catalog = normalizeCatalog(await this.ctx.sessionController.modelCatalog())
    } catch (error) {
      console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.broadcast({ type: 'permission', preset: this.store.permission() })
    this.broadcast({
      type: 'chrome',
      overlay: models.overlay,
      background: models.background,
      millifractionEnabled: this.store.millifractionEnabled(),
      openMain: isDesktopHost(),
      catalog,
    })
    this.broadcast(avatarMessage(this.store))
  }

  /**
   * Store the theme/locale preferences the ball mirrors and push them to a
   * connected helper. The raw preference travels; the helper resolves
   * `system` and an absent locale against its own environment.
   */
  setAppearance(appearance: Appearance): void {
    const next: Appearance = {
      ...(appearance.theme === undefined ? {} : { theme: appearance.theme }),
      ...(appearance.locale === undefined ? {} : { locale: appearance.locale }),
    }
    this.appearance = next
    if (Object.keys(next).length > 0) this.broadcast({ type: 'appearance', ...next })
  }

  async setOverlayModel(selection: AgentModelSelection): Promise<void> {
    this.store.setOverlay(selection)
    if (this.sessionId) await this.applyOverlayQuiet(this.sessionId)
    await this.publishChrome()
  }

  async setBackgroundModel(selection: AgentModelSelection): Promise<void> {
    this.store.setBackground(selection)
    await this.publishChrome()
  }

  async setSelectionEnabled(enabled: boolean): Promise<void> {
    this.store.setSelectionEnabled(enabled)
    this.selection.sync()
    await this.publishChrome()
  }

  async setMillifractionEnabled(enabled: boolean): Promise<void> {
    if (this.store.millifractionEnabled() === enabled) return
    this.store.setMillifractionEnabled(enabled)
    if (this.sessionId) await this.newSession()
    else await this.publishChrome()
  }

  async setBallEnabled(enabled: boolean): Promise<void> {
    this.store.setBallEnabled(enabled)
    if (process.platform === 'linux') return
    if (enabled) {
      void this.start().catch((error: unknown) => {
        console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.halt()
  }

  async setHotkey(enabled: boolean, accelerator: HotkeyAccelerator): Promise<void> {
    const previous = this.store.hotkey()
    if (previous.enabled === enabled && previous.accelerator === accelerator) return
    this.store.setHotkey(enabled, accelerator)
    this.broadcast({ type: 'hotkey', enabled, accelerator })
  }

  private onControl(message: unknown, socket: Socket): void {
    const record = asRecord(message)
    if (!record || typeof record.type !== 'string') return
    if (record.type === 'chrome-windows') {
      this.chromeWindows.set(socket, readWindowIds(record.ids))
      return
    }
    if (record.type === 'overlay-ack' && typeof record.id === 'string') {
      this.overlayWaiters.get(record.id)?.()
      this.overlayWaiters.delete(record.id)
      return
    }
    if (record.type === 'selection-action' && typeof record.action === 'string') {
      this.onSelectionAction(record)
      return
    }
    if (record.type === 'history') {
      this.run('history', () => this.sendHistory())
      return
    }
    if (record.type === 'open' && typeof record.sessionId === 'string') {
      this.run('open', () => this.openSession(record.sessionId as string))
      return
    }
    if (record.type === 'new') {
      this.run('new', () => this.newSession())
      return
    }
    const preset = record.preset
    if (record.type === 'permission' && isPermissionPreset(preset)) {
      this.run('permission', () => this.setPermission(preset))
      return
    }
    if (record.type === 'stop') {
      this.run('stop', () => this.stopTurn())
      return
    }
    if (record.type === 'menu') {
      this.run('menu', () => this.publishChrome())
      return
    }
    const selection = record.selection
    if (record.type === 'set-overlay' && isAgentModelSelection(selection)) {
      this.run('overlay-model', () => this.setOverlayModel(selection))
      return
    }
    if (record.type === 'set-background' && isAgentModelSelection(selection)) {
      this.run('background-model', () => this.setBackgroundModel(selection))
      return
    }
    if (record.type === 'set-selection' && typeof record.enabled === 'boolean') {
      this.run('selection', () => this.setSelectionEnabled(record.enabled === true))
      return
    }
    if (record.type === 'set-millifraction' && typeof record.enabled === 'boolean') {
      this.run('millifraction', () => this.setMillifractionEnabled(record.enabled === true))
      return
    }
    if (record.type === 'disable') {
      this.run('disable', () => this.setBallEnabled(false))
      return
    }
    if (record.type === 'open-main') {
      this.run('open-main', () => this.openMain())
      return
    }
    if (record.type === 'tcc') {
      this.broadcast({ type: 'tcc', status: this.tcc.status() })
      return
    }
    if (record.type === 'tcc-open' && isTccRight(record.right)) {
      const right = record.right
      this.run('tcc', async () => {
        await this.tcc.open(right)
        this.broadcast({ type: 'tcc', status: this.tcc.status() })
      })
    }
  }

  /** Keep a failed ball action inside this plugin. An unhandled rejection exits the official host. */
  private run(label: string, task: () => Promise<void>): void {
    void task().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: ${label} failed: ${message}`)
      this.status(message)
    })
  }

  private async setPermission(preset: PermissionPreset): Promise<void> {
    this.store.setPermission(preset)
    if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset)
    await this.publishChrome()
  }

  private async stopTurn(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId || !this.turnRunning) return
    try {
      await this.ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      console.error(`dsh-orb: cancel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.drain()
    this.finishTurn()
  }

  private async newSession(): Promise<void> {
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    const session = await this.ctx.sessionController.create({
      workspaceId: await this.workspaceId(),
      agentPreset: 'computer-use',
    })
    await this.adopt(session.sessionId)
    this.resetTranscript()
    await this.publishChrome()
  }

  private async openSession(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('session-') || sessionId.length > 80) return
    const rows = await this.historyRecords()
    const row = rows.find((item) => item.sessionId === sessionId)
    if (!row) return
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    const session = await this.ctx.sessionController.create({
      workspaceId: await this.workspaceId(),
      agentPreset: 'computer-use',
      sessionId,
    })
    await this.adopt(session.sessionId)
    this.resetTranscript()
    this.replaying = true
    this.drain()
    this.replaying = false
    if (row.running) {
      this.turnRunning = true
      this.selection.setSessionRunning(true)
      this.broadcast({ type: 'turn', running: true })
      this.watch()
    }
  }

  private async sendHistory(): Promise<void> {
    const current = this.sessionId
    const items = (await this.historyRecords()).slice(0, 40).map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      current: row.sessionId === current,
    }))
    this.broadcast({ type: 'history', items })
  }

  private async historyRecords(): Promise<{ sessionId: string; title: string; running: boolean }[]> {
    try {
      const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15_000))
      const rows = Array.isArray(listed) ? listed : (listed as { items?: readonly unknown[] }).items ?? []
      const orb = resolve(dshHomePath('dsh_orb'))
      const items: { sessionId: string; title: string; running: boolean }[] = []
      for (const row of rows) {
        const record = asRecord(row)
        if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== 'string') continue
        const title = projection(record, 'title')
        items.push({
          sessionId: record.sessionId,
          title: typeof title === 'string' ? title.slice(0, 200) : '',
          running: record.running === true,
        })
      }
      return items
    } catch (error) {
      console.error(`dsh-orb: history failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private resetTranscript(): void {
    this.blocks.clear()
    this.blockOrder.length = 0
    this.watermark = 0
    this.turnRunning = false
    this.attemptPositions.clear()
    this.lastAttemptByStep.clear()
    this.stepBlocks.clear()
    this.liveStep = undefined
    this.responseKeys = []
    this.clearDirty()
    this.selection.setSessionRunning(false)
    this.stopWatch()
    this.broadcast({ type: 'reset' })
    this.broadcast({ type: 'turn', running: false })
  }

  private onSelectionAction(record: Record<string, unknown>): void {
    if (record.action === 'search') this.selection.search()
    else if (record.action === 'translate') this.selection.translate()
    else if (record.action === 'send') this.selection.sendToAgent()
    else if (record.action === 'language' && (record.language === 'zh' || record.language === 'en')) {
      this.selection.setLanguage(record.language)
    }
  }

  private waitAck(message: { id: string; type: string; [key: string]: unknown }, signal?: AbortSignal): Promise<void> {
    if (this.sockets.size === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (abort: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.overlayWaiters.delete(message.id)
        if (abort) reject(signal?.reason instanceof Error ? signal.reason : new Error('dsh-orb: overlay ack aborted'))
        else resolve()
      }
      const timer = setTimeout(() => { finish(false) }, 1_000)
      timer.unref()
      const onAbort = () => { finish(true) }
      if (signal?.aborted) {
        finish(true)
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.overlayWaiters.set(message.id, () => { finish(false) })
      this.broadcast(message)
    })
  }

  private async applyOverlayQuiet(sessionId: string): Promise<void> {
    const selection = this.store.models().overlay
    try {
      await selectModelKeepDefault(this.ctx, {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })
    } catch (error) {
      console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async openMain(): Promise<void> {
    if (!isDesktopHost()) return
    await openMainWindow(this.ctx)
  }
}

/** Per-profile Chromium data so desktop and `dsh web` do not share one lock. */
function helperDataDirectory(profileDir: string): string {
  const id = createHash('sha256').update(profileDir).digest('hex').slice(0, 16)
  return dshHomePath('dsh-orb', 'helper-data', id)
}

function isPrompt(message: unknown): message is { type: 'prompt'; text: string } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; text?: unknown }
  return record.type === 'prompt' && typeof record.text === 'string' && record.text.length <= 8000
}

/**
 * Chrome window ids from one helper's `chrome-windows` report.
 * A malformed payload yields no ids, which is the pre-report behaviour: the observation
 * walk simply excludes nothing.
 */
function readWindowIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 16) return []
  const ids: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) return []
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

async function readSavedSession(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { sessionId?: unknown }
    if (typeof parsed.sessionId === 'string' && parsed.sessionId.startsWith('session-')) return parsed.sessionId
  } catch {
    // No saved session yet, or the file is unreadable. A new session is created.
  }
  return undefined
}

function toolName(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const name = (data as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

/**
 * Avatar descriptor for the ball. A preset travels as the relative asset path, so the
 * ball reads it off disk: pushing megabytes of GIF through the socket as a data URL
 * would stall every chrome publish.
 */
function avatarMessage(store: ProfileStore): Record<string, unknown> {
  const version = Math.trunc(store.avatarVersion())
  const selection = store.avatarSelection()
  if (selection.kind === 'preset') {
    const src = avatarPresetSrc(selection.id)
    if (src !== undefined) return { type: 'avatar', kind: 'preset', src, version }
  }
  return { type: 'avatar', kind: selection.kind === 'custom' ? 'custom' : 'default', version }
}

function toolArguments(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const args = (data as { arguments?: unknown }).arguments
  return typeof args === 'string' ? args : ''
}

function callIdValueOf(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ''
  const id = record.toolCallId ?? record.callId ?? record.id
  return typeof id === 'string' ? id : ''
}

/** Flatten result content blocks to display text (tool-call-model resultText). */
function resultText(content: unknown, error?: { name?: unknown; code?: unknown }): string {
  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = asRecord(block)
      if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
      else parts.push(JSON.stringify(block, null, 2))
    }
  }
  if (parts.length === 0 && error !== undefined) {
    parts.push(`${typeof error.name === 'string' ? error.name : 'Error'}: ${typeof error.code === 'string' ? error.code : 'unknown'}`)
  }
  return parts.join('\n')
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function isQuestionAnswer(message: unknown): message is { type: 'question-answer'; id: string; answers: unknown } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; id?: unknown }
  return record.type === 'question-answer' && typeof record.id === 'string'
}

function isQuestionCancel(message: unknown): message is { type: 'question-cancel'; id: string } {
  if (typeof message !== 'object' || message === null) return false
  const record = message as { type?: unknown; id?: unknown }
  return record.type === 'question-cancel' && typeof record.id === 'string'
}

function isHistoryRow(record: Record<string, unknown>, orb: string): boolean {
  if (record.origin === 'subagent') return false
  if (typeof record.cwd !== 'string' || resolve(record.cwd) !== orb) return false
  const preset = projection(record, 'agentPreset')
  return preset === undefined || preset === 'computer-use'
}

function projection(record: Record<string, unknown>, key: string): unknown {
  const values = asRecord(asRecord(record.projections)?.values)
  return values?.[key]
}

function userText(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ''
  const source = asRecord(record.source)
  if (source && source.kind !== undefined && source.kind !== 'user') return ''
  return textOf(record.content)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Validate the provider token-usage payload of an `assistant/message` event. */
function readUsage(value: unknown): BlockUsage | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const count = (raw: unknown): number | undefined => {
    const number = typeof raw === 'number' ? raw : NaN
    return Number.isFinite(number) && number >= 0 ? number : undefined
  }
  const inputTokens = count(record.inputTokens)
  const outputTokens = count(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    ...(count(record.totalTokens) === undefined ? {} : { totalTokens: count(record.totalTokens) }),
    ...(count(record.cacheReadTokens) === undefined ? {} : { cacheReadTokens: count(record.cacheReadTokens) }),
    ...(count(record.cacheWriteTokens) === undefined ? {} : { cacheWriteTokens: count(record.cacheWriteTokens) }),
    ...(count(record.reasoningTokens) === undefined ? {} : { reasoningTokens: count(record.reasoningTokens) }),
  }
}

function partKind(part: Record<string, unknown> | undefined): BlockMessage['kind'] | undefined {
  if (!part) return undefined
  if (part.type === 'text') return 'assistant'
  if (part.type === 'reasoning' || part.type === 'thinking') return 'reasoning'
  if (part.type === 'tool-call' || part.type === 'tool_use') return 'tool'
  return undefined
}

function callId(data: unknown): string {
  const record = asRecord(data)
  if (!record) return ''
  if (typeof record.id === 'string') return record.id
  if (typeof record.callId === 'string') return record.callId
  if (typeof record.toolCallId === 'string') return record.toolCallId
  const call = asRecord(record.call)
  return typeof call?.id === 'string' ? call.id : ''
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : ''
}

function sanitizeQuestions(value: unknown): ShownQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: ShownQuestion[] = []
  for (const item of value.slice(0, 20)) {
    const record = asRecord(item)
    if (!record) continue
    const id = bounded(record.id, 200)
    const question = bounded(record.question, 4000)
    if (!id || !question) continue
    const options: { label: string; description?: string }[] = []
    if (Array.isArray(record.options)) {
      for (const option of record.options.slice(0, 20)) {
        const entry = asRecord(option)
        const label = entry ? bounded(entry.label, 500) : ''
        if (!label) continue
        const description = entry ? bounded(entry.description, 2000) : ''
        options.push(description ? { label, description } : { label })
      }
    }
    const detail = bounded(record.detail, 8000)
    const header = bounded(record.header, 200)
    questions.push({
      id,
      question,
      ...detail ? { detail } : {},
      ...header ? { header } : {},
      ...options.length > 0 ? { options } : {},
      ...record.multiSelect === true ? { multiSelect: true as const } : {},
    })
  }
  return questions
}

function parseAnswers(value: unknown): QuestionAnswer | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record || typeof record.id !== 'string' || record.id.length > 200) return undefined
    if (!Array.isArray(record.selected) || record.selected.length > 20) return undefined
    const selected: string[] = []
    for (const label of record.selected) {
      if (typeof label !== 'string' || label.length > 4000) return undefined
      selected.push(label)
    }
    if (record.custom !== undefined && (typeof record.custom !== 'string' || record.custom.length > 4000)) return undefined
    const custom = typeof record.custom === 'string' ? record.custom : ''
    answers.push({ id: record.id, selected, ...custom ? { custom } : {} })
  }
  return { answers }
}

function questionError(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  return Object.assign(error, { code })
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
