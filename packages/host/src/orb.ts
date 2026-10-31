/**
 * NDJSON control plane for the ball, plus the Computer Use session it talks to.
 * The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Appearance, ThemePreference } from './appearance.ts'
import { avatarPresetSrc } from './avatar-presets.ts'
import type { ModelCatalog } from './catalog.ts'
import { cancelRuntimeDownload, isRuntimeDownloadCancelled, purgeRuntimeArtifacts, resolveElectronBinary } from './electron-runtime.ts'
import { helperMain } from './helper-path.ts'
import {
  HistoryCleaner,
  type HistoryPersistence,
  type HistoryPreview,
  type HistorySessionRow,
  type HistoryState,
  type WorkspaceSafety,
} from './history.ts'
import { moveToOsTrash, osTrashAvailable } from './os-trash.ts'
import { refreshModelFallback } from './model-defaults.ts'
import { openMainWindow } from './open-main.ts'
import { isDesktopHost, isTccRight, TccMonitor, type TccRight, type TccStatus } from './tcc.ts'
import { openVoiceChild, VoiceController } from './voice.ts'
import { officialAsrFrom, VoiceDownloads } from './voice-download.ts'
import { voicePresence } from './voice-models.ts'
import {
  defaultWorkspaceDirectory,
  isAgentModelSelection,
  isPermissionPreset,
  type AgentModelSelection,
  type PermissionPreset,
  type ProfileStore,
  type WorkspaceState,
} from './preferences.ts'
import { tokensMatch } from './routes.ts'
import { OVERLAY_GUARD_ACK_TIMEOUT_MS, createOverlayGuard } from './overlay-guard.ts'
import {
  openSystemUrl,
  productionAccessibility,
  SelectionController,
  type SelectionStarter,
} from './selection.ts'
import { pinSessionId } from './services.ts'
import {
  clipTranslationText,
  runTranslation,
  translationUserText,
  type TranslationLlm,
  type TranslationRoute,
  type TranslationTarget,
} from './translate.ts'
import { validateWorkspaceSelection } from './workspace.ts'
import { publishScreenOwner } from './screen-owner.ts'
import { selectModelKeepDefault } from './select-model.ts'
import { createForegroundMemory } from './windows-foreground.ts'
import { EMPTY_UPDATE_STATE, type UpdateChecker, type UpdateState } from './update.ts'

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
    /** Complete archive/pin projection; absent on a Host that predates it. */
    baseline?(): {
      readonly archivedSessionIds?: readonly string[]
      readonly pinnedSessionIds?: readonly string[]
    }
    /** First frame carries a baseline on a controller that exposes only the stream. */
    follow?(signal: AbortSignal): AsyncIterable<{
      readonly type?: string
      readonly value?: {
        readonly archivedSessionIds?: readonly string[]
        readonly pinnedSessionIds?: readonly string[]
      }
    }>
    archiveSession?(request: { readonly sessionId: string }): Promise<unknown>
    unarchiveSession?(request: { readonly sessionId: string }): Promise<unknown>
  }
  readonly sessionController: {
    create(request: {
      readonly workspaceId?: string
      readonly sessionId?: string
      readonly agentPreset?: string
    }): Promise<{ readonly sessionId: string }>
    /**
     * Resolve or resume one existing Session: the live Agent when it is already attached, otherwise
     * the resumed one. This — not `create` — is how a stored conversation is opened. Since dsh
     * 0.2.1 `create` reuses a named Session only while it is still blank and otherwise mints a
     * different one, the same contract both versions already carry for `resolveAgent`.
     */
    resolveAgent(sessionId: string): Promise<{ readonly agent: unknown } | { readonly error: unknown }>
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

/** One background Code session as the code-agent plugin's registry reports it. */
interface AgentBookmark {
  readonly sessionId: string
  readonly callerId: string
  readonly task: string
  readonly cwd: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly state: 'running' | 'completed' | 'stopped'
  readonly outcome?: string
}

/**
 * The code-agent plugin's `codeAgentRegistry` service, declared structurally:
 * the two packages are separate cordis plugins and share no import.
 */
interface AgentBookmarkRegistry {
  list(): readonly AgentBookmark[]
}

/** Cordis service name of {@link AgentBookmarkRegistry}. */
const CODE_AGENT_REGISTRY = 'codeAgentRegistry'
/**
 * Backoff before the first-run runtime download is retried; the last entry is
 * the self-heal attempt. One dropped connection must not cost the user the ball
 * until they find the toggle.
 */
const RUNTIME_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000]
/** Same shape for a helper that exits right after launch; the last entry self-heals. */
const HELPER_RETRY_DELAYS_MS = [500, 2_000, 10_000, 5 * 60_000]
/** Strip poll cadence; the helper ticks elapsed clocks itself. */
const AGENT_POLL_MS = 1_000
/** How long a ball-initiated main-window target (session jump, settings) stays valid: long enough for a cold app launch. */
const MAIN_WINDOW_TARGET_TTL_MS = 30_000
/** Caller conversations cycle through this many attribution colors. */
const AGENT_COLOR_COUNT = 4
/**
 * Where the profile records that the empty conversations the old New Chat button left behind
 * have been swept. One pass per profile, written only once the pass actually ran.
 */
const BLANK_SWEEP_FILE = 'blank-sweep.json'
/** Let the first start settle before sweeping, so the conversation on screen is already known. */
const BLANK_SWEEP_DELAY_MS = 15_000

/** One strip entry pushed to the helper. */
interface AgentBookmarkItem {
  readonly sessionId: string
  readonly callerId: string
  readonly task: string
  readonly cwd: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly state: 'running' | 'completed' | 'stopped'
  readonly outcome?: string
  readonly colorIndex: number
  readonly callerTitle: string
  readonly unread: boolean
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
  readonly kind: 'user' | 'reasoning' | 'assistant' | 'tool' | 'notice'
  readonly text: string
  readonly running: boolean
  readonly interrupted?: true
  /**
   * Shown in the transcript but never part of the conversation.
   *
   * A selection-toolbar translation sets this: the ball renders it like any other exchange,
   * the panel marks it as outside the conversation, and no request ever carries it.
   */
  readonly local?: true
  /** Part of the turn's final answer: the only text a folded turn keeps visible. */
  readonly response?: true
  readonly detail?: ToolDetail
  readonly usage?: BlockUsage
}

/** Per-block flags the turn machinery does not derive on its own. */
interface BlockFlags {
  /** The answer was cut short by the user rather than finished by the model. */
  readonly interrupted?: boolean
  /** Display-only content: never sent to the model, never in the session log. */
  readonly local?: boolean
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
  /** Bumped every time a turn starts; stopTurn uses it to spot a turn that replaced its own. */
  private turnEpoch = 0
  /** The old turn is being stopped; send this text as a new task after its turn/end. */
  private pendingPrompt: { text: string; key: string; sessionId?: string } | undefined
  /** Steps whose first tool-call delta already told voice that the preceding text was mid-turn. */
  private readonly toolVoiceSteps = new Set<string>()
  /**
   * The translation currently streaming into the ball, if any.
   *
   * A translation is shown exactly like an agent turn but is not one: it never touches the
   * session, so `turnRunning` must stay false while it runs. The ball still gets a
   * `turn: true` broadcast, and the completion wait that guards real turns does not apply —
   * nothing is queued behind a translation, so there is nothing to serialise.
   */
  private translation: { readonly abort: AbortController; readonly key: string } | undefined
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
  /** 'downloading'/'extracting' while the helper runtime is prepared; '' otherwise. */
  private runtimePhase = ''
  /**
   * True from the moment a runtime download is asked for until it lands or its budget is spent.
   * The waiting phase is only ever a promise this flag backs: while it is set, a `start()` that
   * merely relaunches must not blank the phase the settings page is polling on.
   */
  private runtimePending = false
  private runtimeRetries = 0
  private userData = ''
  /** Newer version waiting to be installed, or null once none is known. */
  private updateAvailable: string | null = null
  private idleWarned = false
  private sessionId: string | undefined
  private sessionError: string | undefined
  private creating: Promise<string> | undefined
  private watermark = 0
  private missingLogged = false
  private timer: ReturnType<typeof setInterval> | undefined
  private giveUp: ReturnType<typeof setTimeout> | undefined
  private agentTimer: ReturnType<typeof setInterval> | undefined
  private lastAgentsPayload = ''
  /**
   * Sessions whose *finished* bookmark the user clicked away. A running stretch is never in here:
   * a click during the run only jumps to the session, so the completion still raises an unread
   * bookmark. {@link agentItems} drops the id the moment that session runs again, which is what
   * gives a continued session a fresh unread bookmark for its next stretch.
   */
  private readonly readAgentIds = new Set<string>()
  private jumpTarget: { readonly sessionId: string; readonly at: number } | undefined
  /** One-shot "open the ball's own settings page" request for the main window's client plugin. */
  private settingsTarget: { readonly at: number } | undefined
  private readonly callerColors = new Map<string, number>()
  private callerTitles: { readonly at: number; readonly byId: Map<string, string> } | undefined
  private callerTitlesTask: Promise<void> | undefined
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
  /** Set by the plugin entry; the settings routes and the ball menu both drive it. */
  private updater: UpdateChecker | undefined
  /** Retention for the floating-ball workspace history; routes and scheduling delegate here. */
  private readonly history: HistoryCleaner
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
    observationFrameEnabled: () => this.store.observationFrameEnabled(),
  })
  /** Wake, command, and speech. The child stays down until this install has one. */
  private readonly voice: VoiceController
  private readonly voiceDownloads: VoiceDownloads
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
      // Translate renders in the ball without reaching the session, so it does not go through
      // onPrompt: that path writes a user message and starts a real agent turn.
      translate: (text, language) => { this.run('translate', () => this.startTranslation(text, language)) },
      openExternal: (url) => { openSystemUrl(url) },
      requestAccessibility: () => access.requestAccessibility(),
      accessibilityTrusted: () => access.accessibilityTrusted(),
      now: () => Date.now(),
    }, options.startMonitor)
    this.history = new HistoryCleaner({
      store: this.store,
      workspacePath: () => this.store.workspaceDirectory(),
      currentSession: () => this.sessionId,
      listSessions: () => this.listHistoryRows(),
      isAttached: (id) => this.ctx.sessions.get(id) !== undefined,
      workspaceSafety: () => readWorkspaceSafety(this.ctx),
      archive: (id) => archiveHistorySession(this.ctx, id),
      unarchive: (id) => unarchiveHistorySession(this.ctx, id),
      persistence: () => historyPersistence(this.ctx),
      available: () => historyAvailable(this.ctx),
      sessionsRoot: dshHomePath('sessions'),
      objectsRoot: dshHomePath('attachments', 'v1', 'objects'),
      trash: (path) => moveToOsTrash(path),
      log: (message) => console.error(`dsh-orb: ${message}`),
    })
    ctx.provide('computerUseOverlayGuard', this.overlay)
    this.voice = new VoiceController({
      settings: () => this.store.voice(),
      presence: () => voicePresence({
        kws: dshHomePath('dsh-orb', 'voice', 'kws'),
        asr: dshHomePath('speech-to-text', 'sensevoice'),
        tts: dshHomePath('dsh-orb', 'voice', 'tts'),
      }),
      now: () => Date.now(),
      paths: () => ({
        kws: dshHomePath('dsh-orb', 'voice', 'kws'),
        asrModel: dshHomePath('speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx', 'model.int8.onnx'),
        asrTokens: dshHomePath('speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx', 'tokens.txt'),
        asrVad: dshHomePath('speech-to-text', 'sensevoice', 'models', 'silero', 'silero_vad.onnx'),
        tts: dshHomePath('dsh-orb', 'voice', 'tts'),
      }),
      send: (message) => this.broadcast(message),
      open: () => openVoiceChild(),
      interject: (text) => { void this.onInterject(text) },
      stopTurn: () => {
        if (!this.turnRunning) return
        const epoch = this.turnEpoch
        this.run('stop', () => this.stopTurn(epoch))
      },
    })
    this.voiceDownloads = new VoiceDownloads(() => ({
      kws: dshHomePath('dsh-orb', 'voice', 'kws'),
      asr: dshHomePath('speech-to-text', 'sensevoice'),
      tts: dshHomePath('dsh-orb', 'voice', 'tts'),
    }), undefined, () => { this.voice.applySettings() }, () => officialAsrFrom(this.ctx.get('speechToText')))
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
      if (previous !== undefined && previous !== attemptId) {
        // The replaced attempt's id must stop resolving: a late chunk carrying it would
        // otherwise write into the step this start just rewound.
        this.attemptPositions.delete(previous)
        this.rewindLiveStep(turn, step)
      }
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
    // Only a start with nothing left to download may take the waiting line down. Every retry
    // runs through here, and clearing the phase on the way in used to blank it for the length of
    // an attempt — long enough for the settings page, which polls only while the phase is up, to
    // stop polling and never see the download finish or fail.
    if (!this.runtimePending) this.runtimePhase = ''
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

  /** The voice settings file changed. */
  applyVoiceSettings(): void {
    this.voice.applySettings()
  }

  /** What the settings page shows under each download button. */
  voiceModels() {
    return this.voiceDownloads.view()
  }

  /** Start a model download, or say the files are already current. */
  downloadVoiceModel(kind: 'wake' | 'tts' | 'asr') {
    return this.voiceDownloads.begin(kind)
  }

  /** Null until the voice child has reported whether the microphone opened. */
  voiceMic(): boolean | null {
    return this.voice.microphone()
  }

  /** Short code the settings page can show after the helper gives up. */
  helperStatus(): string {
    return this.helperError ?? ''
  }

  /** What the runtime preparation is busy with, for the settings page's waiting line. */
  helperPhase(): string {
    return this.runtimePhase
  }

  /**
   * The first-run runtime download retried with backoff. While attempts remain
   * the phase stays on screen; only a spent budget surfaces the failure.
   */
  private async beginRuntime(generation: number): Promise<boolean> {
    this.runtimePending = true
    try {
      this.binary = await resolveElectronBinary((phase) => { this.runtimePhase = phase })
      this.runtimePhase = ''
      this.runtimePending = false
      this.runtimeRetries = 0
      return true
    } catch (error) {
      // A manual redownload aborted this attempt: it is not a failure, and the start that
      // replaced it owns the next download. Counting it would burn a retry the user never used.
      // The phase and the pending flag stay as they are: the replacement attempt is already on
      // its way, and taking the waiting line down here would be the same lie as above.
      if (isRuntimeDownloadCancelled(error)) {
        this.runtimeRetries = 0
        return false
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: ${message}`)
      this.runtimeRetries += 1
      const delay = RUNTIME_RETRY_DELAYS_MS[this.runtimeRetries - 1]
      if (delay !== undefined && !this.halted && generation === this.generation) {
        this.runtimePhase = 'downloading'
        console.error(`dsh-orb: retrying the runtime download in ${Math.round(delay / 1000)}s`)
        this.retry = setTimeout(() => {
          this.retry = undefined
          void this.start().catch((error: unknown) => {
            console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
          })
        }, delay)
        this.retry.unref()
        return false
      }
      this.runtimePhase = ''
      this.runtimePending = false
      this.helperError = 'runtime-download'
      this.server?.close()
      this.server = undefined
      return false
    }
  }

  private async begin(generation: number): Promise<void> {
    if (!this.server) await this.listen()
    if (this.halted || generation !== this.generation) {
      this.server?.close()
      this.server = undefined
      return
    }
    console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`)
    this.startPolls()
    const sessionTask = this.ensureSession().catch((error: unknown) => {
      this.sessionError = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: session setup failed: ${this.sessionError}`)
    })
    if (!await this.beginRuntime(generation)) return
    await sessionTask
    if (this.halted || generation !== this.generation) return
    this.userData = helperDataDirectory(this.store.dir)
    await mkdir(this.userData, { recursive: true })
    this.launch()
    // The fresh helper page starts unpinned. A turn or a waiting question can already exist
    // when the ball was switched back on, so hand those to the new voice lifecycle.
    this.voice.start({
      agentBusy: this.turnRunning,
      questionOpen: this.pending !== undefined,
    })
  }

  /**
   * Open the control socket without spawning the helper.
   * {@link start} listens and then launches the helper process.
   */
  async bind(): Promise<{ port: number; token: string }> {
    if (!this.server) await this.listen()
    this.startPolls()
    return { port: this.port, token: this.token }
  }

  /** Stop the helper and the socket. Settings can call {@link start} again. */
  halt(): void {
    this.generation += 1
    this.halted = true
    this.pendingStart = false
    this.runtimePhase = ''
    this.runtimePending = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.stopWatch()
    this.stopAgentPoll()
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
    this.jumpTarget = undefined
    this.settingsTarget = undefined
    this.selection.stop()
    this.voice.close()
    this.foreground.stop()
    this.killChild()
    // No ball means no displayed conversation: leaving the owner behind would keep the GUI tools
    // denied to every session, which is a restriction nobody asked for once the ball is off.
    publishScreenOwner(undefined)
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
        // The ball is gone with the page, so its pin is gone too. Otherwise the fresh
        // page would start unpinned while voice kept listening for commands.
        this.voice.setPinned(false)
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
    // A closing line or a queued question prompt may still be playing from before a page
    // reload. The page starts with no hold, so say what the current speaker wants.
    this.send(socket, { type: 'voice-hold', hold: this.voice.holdState() })
    // A reloaded page starts with the meter hidden. Tell it what the microphone is doing.
    this.send(socket, { type: 'voice-mode', mode: this.voice.listenMode() })
    this.send(socket, { type: 'voice-level', value: 0 })
    this.send(socket, { type: 'voice-speech', open: this.voice.speaking() })
    if (Object.keys(this.appearance).length > 0) this.send(socket, { type: 'appearance', ...this.appearance })
    if (this.pending) this.send(socket, this.questionPayload(this.pending.id))
    void this.publishChrome()
    this.selection.sync()
    this.foreground.start()
    this.pollAgents(true)
  }

  private async onPrompt(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    // A typed send (or the page's command-mode voice prompt) is the newest intent. It
    // preempts a running turn, or a previous voice command still waiting for its turn/end.
    const key = `user:${randomUUID()}`
    this.block(key, 'user', trimmed, false, 'set')
    await this.preempt(trimmed, key)
  }

  /** Start one new turn on the current session. The caller owns the user bubble. */
  private async submitPrompt(trimmed: string): Promise<void> {
    this.voice.activity()
    this.turnInterrupted = false
    this.beginTurn()
    if (this.sessionError && !this.sessionId) {
      // beginTurn already told voice the agent is busy. Ending the turn here
      // is what opens the microphone again; clearing the flag alone leaves it shut.
      this.finishTurn()
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

  /**
   * 一句最新的用户命令：停掉旧轮和旧语音，等旧轮真正结束后，把这句话当成新消息另起一轮。
   * 打字、语音命令和插话都走这里；旧轮还在跑时不能立刻开始下一轮（官方要求同一会话只有一轮）。
   */
  private async preempt(trimmed: string, key: string): Promise<void> {
    // The latest command wins while the old turn is being stopped.
    this.settlePendingPrompt()
    this.voice.activity()

    if (!this.turnRunning || this.sessionId === undefined) {
      await this.submitPrompt(trimmed)
      return
    }

    const pending = { text: trimmed, key, sessionId: this.sessionId }
    this.pendingPrompt = pending
    // Stop the old speaker immediately, before cancel() and the eventual turn/end. The
    // remaining old-turn text stays muted until beginTurn rebuilds the queue.
    this.voice.prepareNewTurn()
    try {
      await this.ctx.sessionController.cancel({ sessionId: pending.sessionId })
      // The official cancel aborts the current step; turn/end lands after in-flight tools
      // settle. Drain once now so the normal 400 ms transcript poll is not the floor.
      this.drain()
    } catch (error) {
      // A newer command, a stop, or a turn/end may have replaced this one already.
      if (this.pendingPrompt !== pending) return
      this.pendingPrompt = undefined
      this.dropBlock(key)
      this.voice.resumeAfterInterjectFailure()
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: prompt cancel failed: ${message}`)
      this.status(message)
    }
  }

  private async onInterject(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const key = `user:${randomUUID()}`
    this.block(key, 'user', trimmed, false, 'set')
    await this.preempt(trimmed, key)
  }

  /** Start the command waiting for the old turn's turn/end. */
  private startPendingPrompt(): void {
    const pending = this.pendingPrompt
    if (!pending) return
    this.pendingPrompt = undefined
    if (pending.sessionId !== this.sessionId) {
      this.dropBlock(pending.key)
      return
    }
    void this.submitPrompt(pending.text)
  }

  /** Drop a waiting command because a newer input or a stop replaced it. */
  private settlePendingPrompt(): void {
    const pending = this.pendingPrompt
    if (!pending) return
    this.pendingPrompt = undefined
    this.dropBlock(pending.key)
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
    if (saved !== undefined) {
      if (await this.openConversation(saved)) return this.adopt(saved)
      console.error('dsh-orb: saved session cannot be opened; creating a new one')
      await rm(this.sessionFile, { force: true })
    }
    const session = await this.ctx.sessionController.create({
      workspaceId,
      agentPreset: 'computer-use',
    })
    return this.adopt(session.sessionId)
  }

  /**
   * Make one stored or already-live conversation current, keeping its identity.
   *
   * `sessionController.create` cannot open a conversation that has any history. Since dsh 0.2.1 a
   * named Session is reused only while it is still blank; one that has started a turn "stays
   * unchanged, and a new Session is created instead" — which is how clicking a history row used to
   * land the ball in an empty untitled chat. `resolveAgent` is the documented resolve-or-resume
   * entry: it keeps a live Agent, resumes a cold one, and re-mounts the preset the Session recorded.
   */
  private async openConversation(sessionId: string): Promise<boolean> {
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) {
        const reason = resolved.error instanceof Error ? resolved.error.message : JSON.stringify(resolved.error)
        console.error(`dsh-orb: session ${sessionId} cannot be opened: ${reason}`)
        return false
      }
      return true
    } catch (error) {
      console.error(`dsh-orb: session ${sessionId} cannot be opened: ${error instanceof Error ? error.message : String(error)}`)
      return false
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
    const workspace = this.store.workspaceDirectory()
    await mkdir(workspace, { recursive: true })
    const created = await this.ctx.workspaceController.create({ path: workspace })
    return created.workspace.workspaceId
  }

  private async adopt(sessionId: string): Promise<string> {
    const id = await this.remember(sessionId)
    // Refresh before the model is applied: a sign-in that happened since the last
    // chrome publish must reach this session, not the one after it.
    await this.refreshModelDefaults()
    await this.applyOverlayQuiet(id)
    pinSessionId(this.ctx, id, this.store.permission(), this.store.workspaceDirectory())
    return id
  }

  /**
   * Refresh the unpicked-track fallback from the live catalog and the main-window
   * default, keeping the previous one when that read fails. The settings page calls this
   * through the plugin entry, so the value it shows is the one a session would use even
   * when the ball never starts.
   */
  async refreshModelDefaults(): Promise<void> {
    try {
      await refreshModelFallback(this.ctx, this.store)
    } catch (error) {
      console.error(`dsh-orb: model fallback failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async remember(sessionId: string): Promise<string> {
    this.sessionId = sessionId
    this.sessionError = undefined
    // The panel shows this conversation from here on. Publishing it is what keeps every other ball
    // conversation — each still a live agent a completion notice can wake — off the screen and the
    // shell: they keep their text, search, question, and background tools, and lose the rest.
    publishScreenOwner(sessionId)
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
    // A translation owns the transcript while it streams. Session events are left for later
    // rather than consumed, so a notice that landed mid-translation cannot interleave with
    // the answer; the watermark does not move, which means nothing is skipped either.
    if (this.translation !== undefined) return
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
      const record = asRecord(data)
      const sourceKind = asRecord(record?.source)?.kind
      if (sourceKind === 'user' || sourceKind === undefined) {
        if (!this.replaying) return
        const text = userText(data)
        if (!text.trim()) return
        this.block(`user:${seq}`, 'user', text, false, 'set')
        return
      }
      // The code_agent completion report is the only notice the ball shows as
      // a card: pre-step context injections (frontmost window, etc.) share the
      // source shape and stay invisible.
      const text = stripNoticeGuards(textOf(record?.content))
      if (!isCompletionNotice(text)) return
      this.block(`notice:${seq}`, 'notice', text, false, 'set')
      return
    }
    if (type === 'turn/start') {
      // A wake turn (e.g. the code_agent completion followup) starts without a
      // ball prompt; the ball still shows it as running, stop button included.
      if (this.turnRunning) return
      this.turnInterrupted = false
      this.beginTurn()
      this.armIdle()
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
    if (type === 'turn/end') {
      this.finishTurn()
      // The old turn is really gone; now the pending command can become the next turn.
      this.startPendingPrompt()
    }
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
        // The model has started a tool call. Anything it said before this belongs to a
        // mid-turn step; tell voice now, not when the tool block gets its name or result.
        const stepKey = `${turn}:${step}`
        if (!this.replaying && !this.toolVoiceSteps.has(stepKey)) {
          this.toolVoiceSteps.add(stepKey)
          this.voice.tool()
        }
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
    // Only the newest settled message is the final answer; demote the previous one first.
    // The interrupted flag is raised after the demote: a demoted block belongs to an
    // earlier, completed answer and must not be republished as interrupted.
    const previous = this.responseKeys
    this.responseKeys = []
    for (const key of previous) {
      const item = this.blocks.get(key)
      if (item?.response === true) this.block(key, item.kind, item.text, false, 'set')
    }
    if (record.interrupted === true) this.turnInterrupted = true
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

  /**
   * Start (or adopt) a turn. The epoch is what lets stopTurn tell whether its await
   * still owns the turn it was asked to cancel.
   */
  private beginTurn(): void {
    this.turnEpoch += 1
    this.turnRunning = true
    this.selection.setSessionRunning(true)
    this.broadcast({ type: 'turn', running: true })
    this.voice.beginTurn()
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
    this.toolVoiceSteps.clear()
    // Mark the final answer so a folded turn keeps only it visible.
    for (const key of [...this.responseKeys]) {
      const item = this.blocks.get(key)
      if (item) this.block(key, item.kind, item.text, false, 'set')
    }
    this.responseKeys = []
    this.broadcast({ type: 'turn', running: false, ...(this.turnInterrupted ? { interrupted: true } : {}) })
    this.turnInterrupted = false
    // The transcript poll keeps running: a completion notice can wake this
    // session into a new turn at any time, without a ball prompt.
    if (this.giveUp !== undefined) {
      clearTimeout(this.giveUp)
      this.giveUp = undefined
    }
    const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === 'assistant')
    console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`)
    this.voice.endTurn()
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
    flags?: BlockFlags,
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
      ...flags?.interrupted === true ? { interrupted: true as const } : {},
      ...flags?.local === true ? { local: true as const } : {},
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
      // The cap drops through dropBlock so the ball hears about it; that path also
      // removes the key from blockOrder. Keys are pushed before their map write, so a
      // key without a block is a transient state: shift it out or dropBlock spins.
      while (this.blockOrder.length > 200) {
        const oldest = this.blockOrder[0]
        if (oldest === undefined) break
        if (!this.blocks.has(oldest)) {
          this.blockOrder.shift()
          continue
        }
        this.dropBlock(oldest)
      }
    }
    this.blocks.set(key, message)
    // A local block is display-only, and that includes the speaker: a translation is read,
    // not listened to, and reading it aloud would also fight the microphone the user just
    // had shut for it.
    const spoken = flags?.local !== true && message.local !== true
    if (!this.replaying && spoken && kind === 'assistant') this.voice.noteAssistant(key, next)
    if (!this.replaying && spoken && kind === 'tool' && previous?.kind !== 'tool') this.voice.tool()
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
      this.voice.questionOpened()
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
    this.voice.questionClosed()
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
    this.voice.questionClosed()
    console.error('dsh-orb: question returned to the main window')
    void pending.next().then(pending.resolve, pending.reject)
  }

  private failQuestion(message: string, code: string, id = this.pending?.id): void {
    const pending = this.pending
    if (!pending || pending.id !== id) return
    this.pending = undefined
    this.questionBody = undefined
    this.broadcast({ type: 'question-clear', id })
    this.voice.questionClosed()
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
      const delay = HELPER_RETRY_DELAYS_MS[this.failures - 1]
      if (delay === undefined) {
        this.helperError = 'helper-exited'
        console.error('dsh-orb: helper exited too many times; ball stays hidden')
        return
      }
      console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`)
      this.retry = setTimeout(() => this.launch(), delay)
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

  /**
   * Push permission, both models, the catalog, and the avatar version to the ball.
   * Refreshing the model fallback here is also what keeps an unpicked track in step with
   * the main window: a sign-in moves the product default, and the ball follows.
   */
  async publishChrome(): Promise<void> {
    let catalog: ModelCatalog = { groups: [] }
    let moved = false
    try {
      const refreshed = await refreshModelFallback(this.ctx, this.store)
      catalog = refreshed.catalog
      moved = refreshed.changed
    } catch (error) {
      console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const models = this.store.models()
    this.broadcast({ type: 'permission', preset: this.store.permission() })
    this.broadcast({
      type: 'chrome',
      overlay: models.overlay,
      background: models.background,
      selectionEnabled: this.store.selectionEnabled(),
      millifractionEnabled: this.store.millifractionEnabled(),
      openMain: isDesktopHost(),
      update: this.updateAvailable,
      catalog,
    })
    this.broadcast(avatarMessage(this.store))
    // A live session still runs the previous fallback: hand it the new one. Only the
    // fallback moves this way — an explicit pick is never reported as changed.
    if (moved && this.sessionId !== undefined) await this.applyOverlayQuiet(this.sessionId)
  }

  /**
   * Remember the version the check found and tell the ball.
   * The menu row and the status line both come from this; the settings page reads the checker.
   */
  setUpdateAvailable(version: string | null): void {
    if (this.updateAvailable === version) return
    this.updateAvailable = version
    if (version !== null) this.broadcast({ type: 'update', state: 'available', version })
    void this.publishChrome()
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

  /** The observation ribbon. Turning it off takes any live frame down at once. */
  async setObservationFrameEnabled(enabled: boolean): Promise<void> {
    if (this.store.observationFrameEnabled() === enabled) return
    this.store.setObservationFrameEnabled(enabled)
    if (!enabled) await this.overlay.setObservationFrame(null)
  }

  async setBallEnabled(enabled: boolean): Promise<void> {
    this.store.setBallEnabled(enabled)
    if (process.platform === 'linux') return
    if (enabled) {
      // A manual retry grants a fresh download budget.
      this.runtimeRetries = 0
      void this.start().catch((error: unknown) => {
        console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.halt()
  }

  /**
   * Start the runtime download over from zero, on the user's explicit request. A download that
   * died with the previous process, stalled on a bad connection, or already spent its retry
   * budget is dropped — bytes, staging folder, and budget — and fetched again right away.
   *
   * Returns as soon as the new attempt is armed: the download itself runs for minutes and the
   * settings page follows it through `helperPhase`, exactly as it does a first launch.
   */
  async redownloadRuntime(): Promise<void> {
    if (process.platform === 'linux') return
    // A live helper means the runtime is already resolved: nothing to fetch, and arming a phase
    // would leave the waiting line up over a ball that is running fine.
    const live = this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && this.server !== undefined
    cancelRuntimeDownload()
    await purgeRuntimeArtifacts().catch((error: unknown) => {
      console.error(`dsh-orb: could not clear the leftover runtime files: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (live) return
    this.runtimeRetries = 0
    this.helperError = undefined
    // Armed before `start()`: that call clears the phase unless a download is already pending,
    // and this one is.
    this.runtimePending = true
    // Deliberately not awaited: one attempt runs for minutes, and the page follows it through
    // `helperPhase` the same way it follows a first launch.
    void this.start().catch((error: unknown) => {
      console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`)
    })
    // `start()` clears the phase on its way in. The user just asked for a download, so the
    // waiting line stays up until the attempt reports its own phase or fails for real.
    this.runtimePhase = 'downloading'
  }

  /** Take the checker the plugin entry owns. Without one the settings page hides its update card. */
  useUpdater(updater: UpdateChecker): void {
    this.updater = updater
    this.setUpdateAvailable(updater.availableVersion())
  }

  updateState(): UpdateState {
    return this.updater?.state() ?? EMPTY_UPDATE_STATE
  }

  async checkUpdate(): Promise<void> {
    await this.updater?.check(true)
    this.setUpdateAvailable(this.updater?.availableVersion() ?? null)
  }

  /**
   * Start the upgrade and return at once; the settings page polls {@link updateState}.
   * The ball hears the outcome through the same status line every other action uses.
   */
  installUpdate(approvedBuilds?: string[]): void {
    const updater = this.updater
    if (updater === undefined) return
    const version = updater.availableVersion()
    if (version === null) return
    this.run('update', async () => {
      this.broadcast({ type: 'update', state: 'starting', version })
      await updater.install(approvedBuilds)
      const state = updater.state()
      this.setUpdateAvailable(updater.availableVersion())
      if (state.error !== null) {
        this.broadcast({
          type: 'update',
          state: 'failed',
          version,
          reason: state.pendingBuilds.length > 0 ? 'build-blocked' : state.error,
        })
        return
      }
      this.broadcast({ type: 'update', state: state.deferred ? 'deferred' : 'done', version, restart: state.restartRequired })
    })
  }

  setAutoCheck(enabled: boolean): void {
    this.updater?.setAutoCheck(enabled)
  }

  /** Current Agent workspace and whether it is the shipped default. */
  workspaceState(): WorkspaceState {
    const path = this.store.workspaceDirectory()
    const defaultPath = defaultWorkspaceDirectory()
    return { path, defaultPath, custom: resolve(path) !== resolve(defaultPath) }
  }

  /**
   * Ask the Host's directory-picker seam for one absolute directory. Native OS
   * panels are the desktop composition's capability; a remote browse-only Host
   * rejects this and the page keeps the manual input path.
   */
  async pickWorkspaceDirectory(signal?: AbortSignal): Promise<string | null> {
    const service = this.ctx.get('directoryPicker') as {
      capability?: () => { readonly kind?: string; pick?: (signal: AbortSignal) => Promise<string | null> }
    } | undefined
    if (service === undefined || typeof service.capability !== 'function') throw new Error('workspace-picker-unavailable')
    const capability = service.capability()
    if (capability === null || typeof capability !== 'object' || capability.kind !== 'native' || typeof capability.pick !== 'function') {
      throw new Error('workspace-picker-unavailable')
    }
    const picked = await capability.pick(signal ?? new AbortController().signal)
    return typeof picked === 'string' && picked !== '' ? picked : null
  }

  /**
   * Move the floating-ball Agent to a custom directory (or back to the default).
   * The old directory is never touched. A running turn is refused; an idle current
   * session is replaced by a fresh one in the new workspace.
   */
  async setWorkspaceDirectory(value: string): Promise<void> {
    if (this.turnRunning) throw new Error('workspace-running')
    const previous = this.store.workspaceDirectory()
    const previousPath = resolve(previous)
    const defaultPath = resolve(defaultWorkspaceDirectory())
    const selection = await validateWorkspaceSelection(value, defaultPath, previousPath)
    if (selection.unchanged) return
    const next = selection.path
    const previousIsDefault = previousPath === defaultPath
    this.store.setWorkspaceDirectory(selection.custom ? next : null)
    this.workspaceTask = undefined
    try {
      if (this.sessionId !== undefined) {
        await this.newSession()
      } else {
        // The saved pointer would otherwise resume the old session on the next launch.
        await rm(this.sessionFile, { force: true })
      }
    } catch {
      this.store.setWorkspaceDirectory(previousIsDefault ? null : previous)
      this.workspaceTask = undefined
      throw new Error('workspace-create-failed')
    }
    void this.sendHistory()
  }

  /** Start the daily retention check; the plugin effect owns the disposer. */
  startHistory(): () => void {
    this.sweepBlankSessionsOnce()
    return this.history.start()
  }

  /**
   * Take the empty conversations the pre-0.1.9 New Chat button left behind out of the store.
   * One pass per profile; see {@link scheduleBlankSweep} for the marker contract.
   */
  private sweepBlankSessionsOnce(): void {
    scheduleBlankSweep({
      marker: join(this.store.dir, BLANK_SWEEP_FILE),
      delayMs: BLANK_SWEEP_DELAY_MS,
      sweep: () => this.history.sweepBlanks(),
    })
  }

  historyState(): HistoryState {
    return this.history.state()
  }

  setHistoryRetention(days: number): void {
    this.history.setRetention(days)
  }

  previewHistory(days: number): Promise<HistoryPreview> {
    return this.history.preview(days)
  }

  cleanHistory(): void {
    this.history.startClean()
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
    if (record.type === 'agent-open' && typeof record.sessionId === 'string') {
      this.run('agent-open', () => this.openAgent(record.sessionId as string))
      return
    }
    if (record.type === 'agent-dismiss' && typeof record.sessionId === 'string') {
      this.run('agent-dismiss', () => this.dismissAgent(record.sessionId as string))
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
      this.voice.haltSpeech()
      // A translation looks like a turn on screen, so the stop button reaches it here. It
      // has no session to cancel: abort the stream and keep what already arrived.
      if (this.translation !== undefined) {
        this.stopTranslation()
        return
      }
      if (this.turnRunning) {
        const epoch = this.turnEpoch
        this.run('stop', () => this.stopTurn(epoch))
      }
      return
    }
    if (record.type === 'pinned' && typeof record.pinned === 'boolean') {
      this.voice.setPinned(record.pinned)
      return
    }
    if (record.type === 'activity') {
      this.voice.activity()
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
    if (record.type === 'update') {
      this.installUpdate()
      return
    }
    if (record.type === 'open-main') {
      this.run('open-main', () => this.openMain())
      return
    }
    if (record.type === 'open-settings') {
      this.run('open-settings', () => this.openSettings())
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
    if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset, this.store.workspaceDirectory())
    await this.publishChrome()
  }

  /**
   * Translate a selection into the ball's transcript without touching the conversation.
   *
   * The ball shows a user bubble and a streaming answer exactly as it would for a real turn,
   * but `turnRunning` stays false and nothing reaches `sessionController`: the pair is display
   * only, so no later request ever carries it and the user pays for the words once. Every
   * block carries `local: true`, which is how the panel marks it as outside the conversation.
   * @param source - the selected text, already trimmed by the monitor.
   * @param target - the language the toolbar's dropdown selects.
   */
  private async startTranslation(source: string, target: TranslationTarget): Promise<void> {
    const text = source.trim()
    if (!text) return
    const llm = this.ctx.get('llm') as TranslationLlm | undefined
    if (llm === undefined || typeof llm.stream !== 'function') {
      this.status('翻译不可用：当前宿主没有模型服务。')
      return
    }
    // A second selection replaces the first: one answer streaming at a time keeps the stop
    // button unambiguous.
    this.stopTranslation()
    const key = `translate:${randomUUID()}`
    const abort = new AbortController()
    this.translation = { abort, key }

    const clipped = clipTranslationText(text)
    const userText = translationUserText(clipped.text, target, clipped.truncated, LOCAL_TRUNCATED_MARK)
    this.block(key, 'user', userText, false, 'set', undefined, undefined, { local: true })
    // The answer block exists before the first token so the panel can lay out the turn and
    // show its busy state; `append` grows it in place as deltas arrive.
    this.block(key, 'assistant', '', true, 'set', undefined, undefined, { local: true })

    // The ball reads exactly like an agent turn from here: expanded, pinned, stop button up,
    // composer locked. `turn: true` is the same broadcast a real turn sends.
    this.broadcast({ type: 'turn', running: true })
    this.voice.setTranslationBusy(true)

    const route = this.store.models().overlay
    let answer = ''
    try {
      answer = await runTranslation({
        source: clipped.text,
        target,
        route: toTranslationRoute(route),
        truncatedMark: LOCAL_TRUNCATED_MARK,
        llm,
        signal: abort.signal,
        onText: (soFar) => {
          // The panel ignores a frame for a transcript it has already replaced.
          if (this.translation?.key !== key) return
          this.block(key, 'assistant', soFar, true, 'set', undefined, undefined, { local: true })
        },
      })
    } catch (error) {
      // An abort is the user's own stop, not a failure: keep whatever was on screen.
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`dsh-orb: translate failed: ${message}`)
        this.status(message)
      }
    } finally {
      if (this.translation?.key === key) this.translation = undefined
      // Settle whether the answer finished, failed, or was stopped: the panel drops its
      // busy look either way, and the idle clock starts counting down to the unpin.
      this.block(
        key,
        'assistant',
        answer,
        false,
        'set',
        undefined,
        undefined,
        { local: true, ...abort.signal.aborted ? { interrupted: true as const } : {} },
      )
      this.broadcast({ type: 'turn', running: false })
      this.voice.setTranslationBusy(false)
      // The transcript poll stood aside while the translation held the view. Catch up now
      // instead of waiting out the next tick.
      this.drain()
    }
  }

  /** Halt the translation in flight, keeping the text already on screen. */
  private stopTranslation(): void {
    this.translation?.abort.abort()
  }

  private async stopTurn(epoch: number): Promise<void> {
    // Stop and dismiss own the turn now; a command waiting for its turn/end must not
    // start a new task after this.
    this.settlePendingPrompt()
    const sessionId = this.sessionId
    if (!sessionId || !this.turnRunning) return
    try {
      await this.ctx.sessionController.cancel({ sessionId })
    } catch (error) {
      // A failing cancel must not paint the ball as stopped: the turn keeps running and
      // its own turn/end stays the authoritative close.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: cancel failed: ${message}`)
      this.status(message)
      return
    }
    // A new turn (ball prompt, wake-up, session switch) may have started while the cancel
    // was in flight; only the turn this call was about may be closed here.
    if (this.turnEpoch !== epoch || this.sessionId !== sessionId) return
    this.drain()
    // drain() can synchronously process the old turn/end, which starts a pending new
    // prompt. Re-check before closing: that new turn is not ours to finish.
    if (this.turnEpoch !== epoch || this.sessionId !== sessionId) return
    this.finishTurn()
  }

  private async newSession(): Promise<void> {
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    // Aligned with the main window's reuseOrCreateBlank(): pressing New Chat inside a
    // conversation that has not started a turn keeps the user on it. Minting one on every press
    // is what filled profiles with empty "untitled" conversations nothing could open or delete.
    if (await this.currentIsBlank()) {
      this.resetTranscript()
      await this.publishChrome()
      return
    }
    const session = await this.ctx.sessionController.create({
      workspaceId: await this.workspaceId(),
      agentPreset: 'computer-use',
    })
    await this.adopt(session.sessionId)
    this.resetTranscript()
    await this.publishChrome()
  }

  /**
   * True while the conversation on screen holds no turn. The official list marks it
   * (`blank`), and that mark is the same one the main window reads before it reuses a draft.
   * An unreadable list answers false: New Chat must still work when the list cannot be read.
   */
  private async currentIsBlank(): Promise<boolean> {
    const current = this.sessionId
    if (current === undefined) return false
    try {
      const rows = await this.listHistoryRows()
      return rows.find((row) => row.sessionId === current)?.blank === true
    } catch (error) {
      console.error(`dsh-orb: could not tell whether the conversation is blank: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private async openSession(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('session-') || sessionId.length > 80) return
    const rows = await this.historyRecords()
    const row = rows.find((item) => item.sessionId === sessionId)
    if (!row) return
    this.failQuestion('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    if (!(await this.openConversation(sessionId))) return
    await this.adopt(sessionId)
    this.resetTranscript()
    this.replaying = true
    this.drain()
    this.replaying = false
    if (row.running) {
      this.beginTurn()
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
      const rows = await this.listHistoryRows()
      const orb = this.store.workspaceDirectory()
      const items: { sessionId: string; title: string; running: boolean }[] = []
      for (const row of rows) {
        const record = asRecord(row)
        if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== 'string') continue
        // The main window shows only the selected blank conversation, never the others: the ball
        // follows it, so the empty rows an older New Chat button minted stop cluttering the list.
        if (record.blank === true && record.sessionId !== this.sessionId) continue
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

  /** One official list read, unfiltered, for both the ball history and retention. */
  private async listHistoryRows(): Promise<HistorySessionRow[]> {
    const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15_000))
    const rows = Array.isArray(listed) ? listed : (listed as { items?: readonly unknown[] }).items ?? []
    return rows as HistorySessionRow[]
  }

  private resetTranscript(): void {
    this.pendingPrompt = undefined
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
    // The transcript poll outlives a session switch: keep it running.
    this.broadcast({ type: 'reset' })
    this.broadcast({ type: 'turn', running: false })
    this.voice.clearSession()
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
      const finish = (error: Error | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.overlayWaiters.delete(message.id)
        if (error === undefined) resolve()
        else reject(error)
      }
      // No ack means the helper never confirmed the cloak; the capture must fail rather
      // than proceed against an unprotected screen.
      const timer = setTimeout(() => { finish(new Error('dsh-orb: overlay ack timed out')) }, OVERLAY_GUARD_ACK_TIMEOUT_MS)
      timer.unref()
      const onAbort = () => { finish(signal?.reason instanceof Error ? signal.reason : new Error('dsh-orb: overlay ack aborted')) }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.overlayWaiters.set(message.id, () => { finish(undefined) })
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

  /**
   * The ball's "open floating-ball settings" click: arm the request the main window's
   * client plugin polls for, then bring that window forward. The window may be closed —
   * the target outlives the launch (`MAIN_WINDOW_TARGET_TTL_MS`) so a cold start still
   * lands on the settings page.
   */
  private async openSettings(): Promise<void> {
    this.settingsTarget = { at: Date.now() }
    await this.openMain()
  }

  private startAgentPoll(): void {
    if (this.agentTimer) return
    this.agentTimer = setInterval(() => this.pollAgents(), AGENT_POLL_MS)
  }

  /**
   * The always-on polls: the bookmark registry, and the transcript drain. The
   * latter runs for the whole helper lifetime, not just during ball-initiated
   * turns — completion notices can wake the session into a new turn at any time.
   */
  private startPolls(): void {
    this.startAgentPoll()
    this.watch()
  }

  private stopAgentPoll(): void {
    if (this.agentTimer) clearInterval(this.agentTimer)
    this.agentTimer = undefined
    this.lastAgentsPayload = ''
  }

  /**
   * Poll the code-agent bookmark registry and push the strip on change.
   * The registry is provided by the preset's code-agent plugin; without it
   * (preset not mounted) the strip simply stays empty.
   */
  private pollAgents(force = false): void {
    if (this.sockets.size === 0) return
    const registry = this.agentRegistry()
    if (registry === undefined) return
    let items: AgentBookmarkItem[]
    try {
      items = this.agentItems(registry)
    } catch (error) {
      console.error(`dsh-orb: agent bookmarks failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.refreshCallerTitles()
    const payload = JSON.stringify(items)
    if (!force && payload === this.lastAgentsPayload) return
    this.lastAgentsPayload = payload
    this.broadcast({ type: 'agents', items })
  }

  private agentRegistry(): AgentBookmarkRegistry | undefined {
    try {
      const registry = this.ctx.get(CODE_AGENT_REGISTRY) as AgentBookmarkRegistry | undefined
      return registry !== undefined && typeof registry.list === 'function' ? registry : undefined
    } catch {
      return undefined
    }
  }

  /** Running first (oldest start at the top), finished after (newest first); read ones dropped. */
  private agentItems(registry: AgentBookmarkRegistry): AgentBookmarkItem[] {
    const bookmarks = registry.list()
    // A running stretch is never read. Clearing here — not only at click time — is what re-arms a
    // continued session: the previous stretch was clicked away, this one starts running, and its
    // completion must raise an unread bookmark again.
    for (const bookmark of bookmarks) {
      if (bookmark.state === 'running') this.readAgentIds.delete(bookmark.sessionId)
    }
    const visible = bookmarks.filter((bookmark) => (
      bookmark.state === 'running' || !this.readAgentIds.has(bookmark.sessionId)
    ))
    visible.sort((left, right) => {
      const leftRunning = left.state === 'running'
      const rightRunning = right.state === 'running'
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
      if (leftRunning) return left.startedAt - right.startedAt
      return (right.endedAt ?? 0) - (left.endedAt ?? 0)
    })
    const titles = this.callerTitles?.byId
    return visible.map((bookmark) => ({
      sessionId: bookmark.sessionId,
      callerId: bookmark.callerId,
      task: bookmark.task,
      cwd: bookmark.cwd,
      startedAt: bookmark.startedAt,
      state: bookmark.state,
      colorIndex: this.callerColor(bookmark.callerId),
      callerTitle: titles?.get(bookmark.callerId) ?? '',
      unread: bookmark.state !== 'running' && !this.readAgentIds.has(bookmark.sessionId),
      ...(bookmark.endedAt === undefined ? {} : { endedAt: bookmark.endedAt }),
      ...(bookmark.outcome === undefined ? {} : { outcome: bookmark.outcome }),
    }))
  }

  private callerColor(callerId: string): number {
    let index = this.callerColors.get(callerId)
    if (index === undefined) {
      index = this.callerColors.size % AGENT_COLOR_COUNT
      this.callerColors.set(callerId, index)
    }
    return index
  }

  /** Caller conversation titles for the tooltips, refreshed at most every 10 seconds. */
  private refreshCallerTitles(): void {
    if (this.callerTitles !== undefined && Date.now() - this.callerTitles.at < 10_000) return
    this.callerTitlesTask ??= this.historyRecords().then((rows) => {
      const byId = new Map<string, string>()
      for (const row of rows) if (row.title !== '') byId.set(row.sessionId, row.title)
      this.callerTitles = { at: Date.now(), byId }
    }).catch(() => {}).finally(() => {
      this.callerTitlesTask = undefined
    })
  }

  /** One-shot jump target for the main window's client plugin. `null` once consumed or expired. */
  takeJump(): { sessionId: string; at: number } | null {
    const target = this.jumpTarget
    if (target === undefined) return null
    if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
      this.jumpTarget = undefined
      return null
    }
    return { sessionId: target.sessionId, at: target.at }
  }

  confirmJump(sessionId: string): void {
    if (this.jumpTarget?.sessionId === sessionId) this.jumpTarget = undefined
  }

  /**
   * The armed floating-ball-settings request, for the main window's client plugin.
   * `null` once confirmed or expired; reading it does not consume it, so a window that
   * cannot open the section yet retries instead of losing the click.
   */
  takeSettingsOpen(): { at: number } | null {
    const target = this.settingsTarget
    if (target === undefined) return null
    if (Date.now() - target.at > MAIN_WINDOW_TARGET_TTL_MS) {
      this.settingsTarget = undefined
      return null
    }
    return { at: target.at }
  }

  confirmSettingsOpen(at: number): void {
    if (this.settingsTarget?.at === at) this.settingsTarget = undefined
  }

  /**
   * A bookmark click: arm the main window's jump and focus the main window.
   *
   * Only a finished bookmark is consumed. Clicking one that is still running is a plain jump —
   * no matter how often it happens — so the completion that follows still raises an unread
   * bookmark with its outcome.
   */
  private async openAgent(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('session-') || sessionId.length > 80) return
    const state = this.bookmarkState(sessionId)
    if (state !== undefined && state !== 'running') {
      this.readAgentIds.add(sessionId)
      this.pollAgents(true)
    }
    this.jumpTarget = { sessionId, at: Date.now() }
    await this.openMain()
  }

  /**
   * Live state of one bookmark, or undefined when no record answers for it (already dropped, or the
   * registry is unavailable). A click falls back to a plain jump in that case.
   */
  private bookmarkState(sessionId: string): AgentBookmarkItem['state'] | undefined {
    try {
      return this.agentRegistry()?.list().find((bookmark) => bookmark.sessionId === sessionId)?.state
    } catch {
      return undefined
    }
  }

  /**
   * The chip's dismiss control: retire a finished bookmark on the spot, without the main-window
   * jump {@link openAgent} performs — the whole point is not having to look at that session.
   *
   * A running stretch has no dismiss control and is refused here too: while it runs the chip is the
   * only trace of the task, and stopping it stays `code_agent_stop`'s job.
   */
  private async dismissAgent(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('session-') || sessionId.length > 80) return
    const state = this.bookmarkState(sessionId)
    if (state === undefined || state === 'running') return
    if (this.readAgentIds.has(sessionId)) return
    this.readAgentIds.add(sessionId)
    this.pollAgents(true)
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
  if (typeof record.cwd !== 'string' || resolve(record.cwd) !== resolve(orb)) return false
  const preset = projection(record, 'agentPreset')
  return preset === undefined || preset === 'computer-use'
}

/**
 * Run the empty-conversation sweep once per profile, a moment after startup.
 *
 * The marker file is the whole state: once it exists this profile has been swept, and it is
 * written only after a pass actually ran — {@link HistoryCleaner.sweepBlanks} throws when its
 * services are missing, the marker stays unwritten, and the next launch tries again instead of
 * leaving the pile behind forever.
 *
 * @param options.marker - profile file that records the pass.
 * @param options.delayMs - time to let the first start settle, so the adopted conversation is known.
 * @param options.sweep - the pass; resolves with the number of conversations it moved.
 * @param options.log - diagnostics sink, defaulting to the host's stderr.
 */
export function scheduleBlankSweep(options: {
  readonly marker: string
  readonly delayMs: number
  readonly sweep: () => Promise<number>
  readonly log?: (message: string) => void
}): void {
  if (existsSync(options.marker)) return
  const log = options.log ?? ((message: string) => { console.error(message) })
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const swept = await options.sweep()
        await writeFile(options.marker, `${JSON.stringify({ swept, at: Date.now() })}\n`)
        if (swept > 0) log(`dsh-orb: moved ${swept} empty conversation(s) to the system trash`)
      } catch (error) {
        log(`dsh-orb: blank conversation sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, options.delayMs)
  timer.unref()
}

/** The persistence service, when this Host exposes its read surface. */
function historyPersistence(ctx: OrbContext): HistoryPersistence | undefined {
  const value = ctx.get('sessionPersistence')
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<HistoryPersistence>
  if (typeof candidate.list !== 'function' || typeof candidate.stat !== 'function' || typeof candidate.open !== 'function') return undefined
  return value as HistoryPersistence
}

/** All services retention needs, checked before the card offers the action. */
function historyAvailable(ctx: OrbContext): boolean {
  if (!osTrashAvailable()) return false
  if (historyPersistence(ctx) === undefined) return false
  const controller = ctx.workspaceController
  if (typeof controller.archiveSession !== 'function' || typeof controller.unarchiveSession !== 'function') return false
  return typeof controller.baseline === 'function' || typeof controller.follow === 'function'
}

/** Pinned and archived Session ids, read from the Workspace projection. */
async function readWorkspaceSafety(ctx: OrbContext): Promise<WorkspaceSafety> {
  const controller = ctx.workspaceController
  if (typeof controller.baseline === 'function') {
    const baseline = controller.baseline()
    return {
      pinned: [...baseline.pinnedSessionIds ?? []],
      archived: [...baseline.archivedSessionIds ?? []],
    }
  }
  if (typeof controller.follow === 'function') {
    const abort = new AbortController()
    try {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame.type !== 'baseline' || frame.value === undefined) continue
        return {
          pinned: [...frame.value.pinnedSessionIds ?? []],
          archived: [...frame.value.archivedSessionIds ?? []],
        }
      }
    } finally {
      abort.abort()
    }
  }
  throw new Error('workspace-safety-unavailable')
}

async function archiveHistorySession(ctx: OrbContext, sessionId: string): Promise<void> {
  const archive = ctx.workspaceController.archiveSession
  if (typeof archive !== 'function') throw new Error('workspace-archive-unavailable')
  await archive.call(ctx.workspaceController, { sessionId })
}

async function unarchiveHistorySession(ctx: OrbContext, sessionId: string): Promise<void> {
  const unarchive = ctx.workspaceController.unarchiveSession
  if (typeof unarchive !== 'function') throw new Error('workspace-unarchive-unavailable')
  await unarchive.call(ctx.workspaceController, { sessionId })
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

/**
 * Model-facing tails the code_agent completion notices append; the ball shows
 * notices to the user, so the instructions come off. Unknown tails stay.
 */
const NOTICE_GUARDS = [
  'Another Computer Use chat is operating the screen right now. Report this result as text only; do not perform any GUI actions unless the user asks again in this chat.',
  'Do not restart this task and do not call code_agent for it again unless the user asks.',
]

/** Only the code_agent completion report becomes a card; the prefix is ours to define. */
function isCompletionNotice(text: string): boolean {
  return text.startsWith('Background Code agent session ')
    || text.startsWith('The user stopped background Code agent session ')
}

function stripNoticeGuards(text: string): string {
  let shown = text
  for (const guard of NOTICE_GUARDS) {
    while (shown.endsWith(guard)) {
      shown = shown.slice(0, shown.length - guard.length).replace(/\n+$/, '')
    }
  }
  return shown
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

/**
 * Appended to a translation's source when the selection was longer than the toolbar's budget.
 * The panel already has a translated "truncated" string for the composer; this is the host's
 * own copy so the marker travels with the stored bubble rather than being re-derived.
 */
const LOCAL_TRUNCATED_MARK = '\n\n…[已截断]'

/** The ball's model route, narrowed to what one throwaway call needs. */
function toTranslationRoute(route: { provider: string; model: string }): TranslationRoute {
  return { provider: route.provider, model: route.model }
}
