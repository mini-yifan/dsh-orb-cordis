/**
 * Mesh data seam.
 *
 * `orb-host` owns `/.dsh-orb/mesh/*` for the helper's Mesh window. The shape of every
 * response follows the frozen `/.dsh-mesh/v1/*` contract (docs/18 §4.3). Until
 * `@dsh-mesh/plugin` releases R0 this module serves static mock data through the same
 * interface; replacing it with `ctx.get('mesh')` later does not touch the routes or the UI.
 */

export type MeshPlatform = 'darwin' | 'win32' | 'android' | 'linux'

/** 17 §7.1 */
export interface MeshNode {
  nodeId: string
  name: string
  platform: MeshPlatform
  hostDeviceId: string
  clientDeviceId?: string
  online: boolean
  lastSeenAt?: number
  harnessVersion?: string
  appVersion?: string
}

/** The tree snapshot's workspace row. */
export interface MeshWorkspace {
  nodeId: string
  workspaceId: string
  name: string
  path?: string
}

/** 17 §7.2 */
export type MeshSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'waiting-question'
  | 'failed'
  | 'unknown'

export interface MeshSession {
  nodeId: string
  sessionId: string
  workspaceId: string
  title: string
  status: MeshSessionStatus
  /** Only `device_agent` task sessions accept prompt/cancel; everything else is read-only. */
  controllable: boolean
  updatedAt: number
}

export interface MeshTree {
  nodes: MeshNode[]
  workspaces: MeshWorkspace[]
  sessions: MeshSession[]
  cursor: number
}

/** 17 §7.3 */
export interface MeshInteraction {
  nodeId: string
  sessionId: string
  eventId: string
  clientId: string
  kind: 'approval' | 'question'
  toolName?: string
  reason?: string
  originNodeId?: string
  createdAt: number
}

export interface MeshInteractionAnswer {
  eventId: string
  outcome?: 'allowed-once' | 'rejected'
  answers?: unknown
  answeredBy?: string
}

/** 17 §7.4 */
export interface DeviceTaskFile {
  name: string
  size: number
  direction: 'out' | 'in'
  localPath?: string
  state: 'transferring' | 'done' | 'failed'
  progress?: number
}

export interface DeviceTask {
  taskId: string
  originNodeId: string
  targetNodeId: string
  sessionId: string
  workspaceId?: string
  status: 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled' | 'unknown'
  files: DeviceTaskFile[]
  createdAt: number
  updatedAt: number
}

export interface MeshPrefs {
  allowIncoming: boolean
  allowedCallers: string[]
  allowGuardedTools: boolean
  receiveDir: string
}

export interface MeshStatus {
  paired: boolean
  server: { url: string; fp: string }
  node: MeshNode | null
  connection: 'unpaired' | 'connecting' | 'connected' | 'offline'
  peersOnline: number
  peersTotal: number
}

/** One frame of a session page/stream: the raw DSH event, addressed by node and session. */
export interface MeshFrame {
  nodeId: string
  sessionId: string
  seq: number
  event: { type: string; data?: unknown }
}

export interface MeshPage {
  items: MeshFrame[]
  cursor: number
  reset?: boolean
}

export interface MeshPairSuccess {
  ok: true
  node: MeshNode
  peers: MeshNode[]
  warning?: 'name_taken'
  name?: string
  message?: string
}

export interface MeshOk {
  ok: true
  [key: string]: unknown
}

/**
 * The process-internal surface the plugin provides as `mesh`. Every method mirrors one
 * `/.dsh-mesh/v1/*` route so the HTTP layer is a thin adapter.
 */
export interface MeshService {
  status(): MeshStatus
  nodes(): MeshNode[]
  tree(): MeshTree | Promise<MeshTree>
  page(nodeId: string, sessionId: string, since?: number): MeshPage | Promise<MeshPage>
  stream(nodeId: string, sessionId: string, since: number): MeshPage | Promise<MeshPage>
  prompt(nodeId: string, sessionId: string, text: string): MeshOk | Promise<MeshOk>
  cancel(nodeId: string, sessionId: string): MeshOk | Promise<MeshOk>
  interactions(): MeshInteraction[]
  answer(answer: MeshInteractionAnswer): MeshOk
  tasks(): DeviceTask[]
  prefs(): MeshPrefs
  setPrefs(patch: unknown): MeshPrefs
  pair(pairing: string, name?: string): MeshPairSuccess | Promise<MeshPairSuccess>
  unpair(): MeshOk | Promise<MeshOk>
  rename(name: string): MeshOk | Promise<MeshOk>
}

/** A route-visible failure carrying the contract's `error`, `message`, and optional `step`. */
export class MeshRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly step?: number
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, step?: number, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'MeshRequestError'
    this.status = status
    this.code = code
    this.step = step
    this.details = details
  }
}

const MESH_API = 1
const LOCAL_NODE_ID = 'node-local'
const TASK_SESSION = { nodeId: 'node-company', sessionId: 'session-quote-edit' }
const MOCK_FP = `Qm9n${'A'.repeat(39)}`
const MOCK_SERVER = { url: 'https://YOUR_SERVER_IP:443', fp: MOCK_FP }
const MINUTE = 60_000

function now(): number {
  return Date.now()
}

function localNode(name = '书房 Mac'): MeshNode {
  return {
    nodeId: LOCAL_NODE_ID,
    name,
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    hostDeviceId: 'device-host-local',
    clientDeviceId: 'device-client-local',
    online: true,
    lastSeenAt: now(),
    harnessVersion: '0.2.1',
    appVersion: '0.2.1',
  }
}

function peerNodes(at: number): MeshNode[] {
  return [
    {
      nodeId: 'node-company',
      name: '公司 Windows',
      platform: 'win32',
      hostDeviceId: 'device-host-company',
      clientDeviceId: 'device-client-company',
      online: true,
      lastSeenAt: at,
      harnessVersion: '0.2.1',
      appVersion: '0.2.1',
    },
    {
      nodeId: 'node-test',
      name: '测试机',
      platform: 'linux',
      hostDeviceId: 'device-host-test',
      clientDeviceId: 'device-client-test',
      online: false,
      lastSeenAt: at - 2 * MINUTE,
      harnessVersion: '0.1.9',
      appVersion: '0.1.9',
    },
  ]
}

function workspaces(): MeshWorkspace[] {
  return [
    { nodeId: LOCAL_NODE_ID, workspaceId: 'ws-brand', name: '品牌改版', path: '/Users/you/work/brand' },
    { nodeId: LOCAL_NODE_ID, workspaceId: 'ws-weekly', name: '周报', path: '/Users/you/work/weekly' },
    { nodeId: 'node-company', workspaceId: 'ws-quote', name: 'Q4 报价', path: 'C:\\work\\quote' },
    { nodeId: 'node-company', workspaceId: 'ws-clients', name: '客户资料', path: 'C:\\work\\clients' },
    { nodeId: 'node-test', workspaceId: 'ws-compat', name: '兼容测试', path: '/srv/compat' },
    { nodeId: 'node-test', workspaceId: 'ws-regress', name: '回归', path: '/srv/regress' },
  ]
}

function sessions(at: number): MeshSession[] {
  const row = (
    nodeId: string,
    workspaceId: string,
    sessionId: string,
    title: string,
    status: MeshSessionStatus,
    controllable = false,
  ): MeshSession => ({
    nodeId,
    sessionId,
    workspaceId,
    title,
    status,
    controllable,
    updatedAt: at - 3 * MINUTE,
  })
  return [
    row(LOCAL_NODE_ID, 'ws-brand', 'session-design-v3', '设计说明 v3', 'idle'),
    row(LOCAL_NODE_ID, 'ws-brand', 'session-copy', '文案校对', 'running'),
    row(LOCAL_NODE_ID, 'ws-weekly', 'session-weekly', '第 45 周周报', 'idle'),
    row(LOCAL_NODE_ID, 'ws-weekly', 'session-weekly-review', '周报评审', 'idle'),
    row('node-company', 'ws-quote', TASK_SESSION.sessionId, '改报价单', 'waiting-approval', true),
    row('node-company', 'ws-quote', 'session-quote-history', '报价历史', 'idle'),
    row('node-company', 'ws-clients', 'session-contract', '合同模板', 'waiting-question'),
    row('node-company', 'ws-clients', 'session-list', '客户名单', 'idle'),
    row('node-test', 'ws-compat', 'session-compat-1', '启动检查', 'unknown'),
    row('node-test', 'ws-compat', 'session-compat-2', '截图对比', 'unknown'),
    row('node-test', 'ws-regress', 'session-regress-1', '旧版回归', 'unknown'),
    row('node-test', 'ws-regress', 'session-regress-2', '汇总', 'unknown'),
  ]
}

function userEvent(text: string): { type: string; data: unknown } {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function assistantEvent(text: string, turn = 1, step = 0): { type: string; data: unknown } {
  return {
    type: 'assistant/message',
    data: { turn, step, message: { content: [{ type: 'text', text }] }, stream: [] },
  }
}

function toolCallEvent(callId: string, name: string, args: string): { type: string; data: unknown } {
  return { type: 'tool/call', data: { turn: 1, step: 0, callId, name, arguments: args } }
}

function toolResultEvent(callId: string, text: string, isError = false): { type: string; data: unknown } {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 0,
      message: { toolCallId: callId, isError, content: [{ type: 'text', text }] },
    },
  }
}

function framesFor(nodeId: string, sessionId: string, offline: boolean): MeshFrame[] {
  const events: { type: string; data?: unknown }[] = []
  if (nodeId === TASK_SESSION.nodeId && sessionId === TASK_SESSION.sessionId) {
    events.push(
      userEvent('把标题改成蓝色，再发我一份最终版。'),
      { type: 'turn/start', data: { turn: 1 } },
      toolCallEvent('call-read-quote', 'read', '{"file_path":"报价单.md"}'),
      toolResultEvent('call-read-quote', '1\t# Q4 报价单\n2\t\n3\t## 基础版\n4\t- 部署 2 台\n5\t- 不含培训'),
      toolCallEvent('call-edit-quote', 'edit', '{"file_path":"报价单.md","old_string":"# Q4 报价单","new_string":"# Q4 报价单（蓝色标题）"}'),
    )
  } else if (sessionId === 'session-contract') {
    events.push(
      userEvent('用新的合同模板重新整理这份合同。'),
      { type: 'turn/start', data: { turn: 1 } },
      toolCallEvent('call-search-contract', 'grep', '{"query":"违约责任","path":"contracts"}'),
      toolResultEvent('call-search-contract', 'contracts/2026-框架合同.md:18: 违约责任按合同总额的 10% 计。'),
      assistantEvent('合同已读取。要继续，请先确认使用哪个模板。'),
    )
  } else if (offline) {
    events.push(userEvent('这份会话还开着吗？'), assistantEvent('设备离线，显示的是最后一次快照。'))
  } else {
    events.push(
      userEvent('看一下这个工作区最近的改动。'),
      { type: 'turn/start', data: { turn: 1 } },
      assistantEvent('这里不是任务会话，只能查看记录；要让它干活，说一句派任务给它。'),
      { type: 'turn/end', data: { turn: 1 } },
    )
  }
  return events.map((event, index) => ({ nodeId, sessionId, seq: index + 1, event }))
}

function mockTask(at: number): DeviceTask {
  return {
    taskId: 'task-quote-1',
    originNodeId: LOCAL_NODE_ID,
    targetNodeId: TASK_SESSION.nodeId,
    sessionId: TASK_SESSION.sessionId,
    workspaceId: 'ws-quote',
    status: 'waiting-input',
    files: [{
      name: '报价单.md',
      size: 48_211,
      direction: 'in',
      localPath: '/Users/you/Downloads/dsh-mesh/公司 Windows/task-quote-1/报价单.md',
      state: 'done',
      progress: 1,
    }],
    createdAt: at - 6 * MINUTE,
    updatedAt: at - 1 * MINUTE,
  }
}

/**
 * Static fake data for the first UI skeleton. It starts paired so the Mesh window has a
 * tree to render on first open; "退出互联" in settings returns to the first-run form, and
 * the documented mock pairing codes then drive the whole pair flow.
 */
export class MockMeshService implements MeshService {
  private paired = true
  private server = { ...MOCK_SERVER }
  private name = '书房 Mac'
  private prefsState: MeshPrefs = {
    allowIncoming: true,
    allowedCallers: [],
    allowGuardedTools: false,
    receiveDir: '/Users/you/Downloads/dsh-mesh',
  }
  private answered = new Set<string>()
  private pages = new Map<string, MeshFrame[]>()

  constructor(private readonly clock: () => number = now) {
    this.rebuildPages()
  }

  status(): MeshStatus {
    const node = this.local()
    if (!this.paired) {
      return {
        paired: false,
        server: { url: '', fp: '' },
        node,
        connection: 'unpaired',
        peersOnline: 0,
        peersTotal: 0,
      }
    }
    const peers = this.peerRows()
    return {
      paired: true,
      server: { ...this.server },
      node,
      connection: 'connected',
      peersOnline: peers.filter((peer) => peer.online).length,
      peersTotal: peers.length,
    }
  }

  nodes(): MeshNode[] {
    if (!this.paired) return [this.local()]
    return [this.local(), ...this.peerRows()]
  }

  tree(): MeshTree {
    if (!this.paired) return { nodes: [this.local()], workspaces: [], sessions: [], cursor: 0 }
    return {
      nodes: this.nodes(),
      workspaces: workspaces(),
      sessions: sessions(this.clock()),
      cursor: 1,
    }
  }

  page(nodeId: string, sessionId: string, since = 0): MeshPage {
    const frames = this.frames(nodeId, sessionId)
    const items = frames.filter((frame) => frame.seq > since)
    const cursor = frames.reduce((max, frame) => Math.max(max, frame.seq), 0)
    return { items, cursor }
  }

  stream(nodeId: string, sessionId: string, since: number): MeshPage {
    return this.page(nodeId, sessionId, since)
  }

  prompt(nodeId: string, sessionId: string, text: string): MeshOk {
    this.requireControllable(nodeId, sessionId)
    const trimmed = text.trim()
    if (trimmed === '') throw new MeshRequestError(400, 'invalid-prompt', '指令不能为空')
    const frames = this.frames(nodeId, sessionId)
    const seq = frames.reduce((max, frame) => Math.max(max, frame.seq), 0)
    const appended: MeshFrame[] = [
      { nodeId, sessionId, seq: seq + 1, event: userEvent(trimmed) },
      {
        nodeId,
        sessionId,
        seq: seq + 2,
        event: assistantEvent('已收到。当前是静态假数据，真实任务会在目标设备上执行。'),
      },
    ]
    this.pages.set(this.key(nodeId, sessionId), [...frames, ...appended])
    return { ok: true }
  }

  cancel(nodeId: string, sessionId: string): MeshOk {
    this.requireControllable(nodeId, sessionId)
    return { ok: true }
  }

  interactions(): MeshInteraction[] {
    if (!this.paired) return []
    const at = this.clock()
    const all: MeshInteraction[] = [
      {
        nodeId: TASK_SESSION.nodeId,
        sessionId: TASK_SESSION.sessionId,
        eventId: 'evt-approval-quote-1',
        clientId: 'client-mock-company',
        kind: 'approval',
        toolName: 'edit',
        reason: '允许修改《报价单.md》吗？',
        originNodeId: LOCAL_NODE_ID,
        createdAt: at - 30_000,
      },
      {
        nodeId: 'node-company',
        sessionId: 'session-contract',
        eventId: 'evt-question-contract-1',
        clientId: 'client-mock-company',
        kind: 'question',
        reason: '这份合同用哪个模板？',
        originNodeId: LOCAL_NODE_ID,
        createdAt: at - 2 * MINUTE,
      },
    ]
    return all.filter((interaction) => !this.answered.has(interaction.eventId))
  }

  answer(answer: MeshInteractionAnswer): MeshOk {
    const interaction = this.interactions().find((item) => item.eventId === answer.eventId)
    if (interaction === undefined) {
      throw new MeshRequestError(404, 'interaction_not_found', '这条审批已经处理过了')
    }
    if (interaction.kind === 'approval' && answer.outcome !== 'allowed-once' && answer.outcome !== 'rejected') {
      throw new MeshRequestError(400, 'invalid_answer', '审批结果无效')
    }
    this.answered.add(interaction.eventId)
    const frames = this.frames(interaction.nodeId, interaction.sessionId)
    const seq = frames.reduce((max, frame) => Math.max(max, frame.seq), 0)
    const appended: MeshFrame[] = interaction.kind === 'approval' && interaction.toolName !== undefined
      ? [{
          nodeId: interaction.nodeId,
          sessionId: interaction.sessionId,
          seq: seq + 1,
          event: toolResultEvent(
            'call-edit-quote',
            answer.outcome === 'allowed-once' ? '已允许本次修改' : '用户拒绝了这次修改',
            answer.outcome !== 'allowed-once',
          ) as { type: string; data: unknown },
        }]
      : [{
          nodeId: interaction.nodeId,
          sessionId: interaction.sessionId,
          seq: seq + 1,
          event: assistantEvent(`已收到选择：${String(answer.answers ?? '')}`),
        }]
    this.pages.set(this.key(interaction.nodeId, interaction.sessionId), [...frames, ...appended])
    return { ok: true, answeredBy: LOCAL_NODE_ID }
  }

  tasks(): DeviceTask[] {
    if (!this.paired) return []
    return [mockTask(this.clock())]
  }

  prefs(): MeshPrefs {
    return { ...this.prefsState, allowedCallers: [...this.prefsState.allowedCallers] }
  }

  setPrefs(patch: unknown): MeshPrefs {
    const record = typeof patch === 'object' && patch !== null ? patch as Record<string, unknown> : {}
    if (typeof record.allowIncoming === 'boolean') this.prefsState.allowIncoming = record.allowIncoming
    if (typeof record.allowGuardedTools === 'boolean') this.prefsState.allowGuardedTools = record.allowGuardedTools
    if (typeof record.receiveDir === 'string') this.prefsState.receiveDir = record.receiveDir
    if (Array.isArray(record.allowedCallers)) {
      this.prefsState.allowedCallers = record.allowedCallers.filter((item): item is string => typeof item === 'string')
    }
    return this.prefs()
  }

  pair(pairing: string, name?: string): MeshPairSuccess {
    if (this.paired) {
      throw new MeshRequestError(409, 'already_paired', `本机已加入另一台服务器（${this.server.url}）的互联，请先退出`, 0, {
        address: this.server.url,
      })
    }
    const parsed = parsePairing(pairing)
    if (parsed === undefined) {
      throw new MeshRequestError(400, 'bad_pairing', '配对串格式不对，请从管理页重新复制', 1)
    }
    if (parsed.host === 'unreachable.test') {
      throw new MeshRequestError(502, 'unreachable', `连不上服务器 ${parsed.address}，请检查网络或服务器是否在运行`, 2, {
        address: parsed.address,
      })
    }
    if (parsed.fp === 'A'.repeat(43)) {
      throw new MeshRequestError(502, 'fingerprint_mismatch', '服务器证书和配对串里的指纹不一致，可能连错了服务器，已停止连接', 2)
    }
    if (parsed.code === 'VERSION1') {
      throw new MeshRequestError(409, 'server_incompatible', '服务器版本（meshApi 2）和本机互联插件（meshApi 1）不兼容，请先升级', 3, {
        serverApi: 2,
        pluginApi: MESH_API,
      })
    }
    const failures: Record<string, [number, string, string]> = {
      BADCODE1: [400, 'code_invalid', '配对码无效，请在管理页重新生成'],
      USEDCODE: [409, 'code_used', '配对码已被使用，请在管理页重新生成'],
      OLDCODE1: [410, 'code_expired', '配对码已过期，请在管理页重新生成'],
      SLOWDOWN: [429, 'rate_limited', '尝试次数过多，请 1 分钟后再试'],
      REGFAIL1: [502, 'register_failed', '服务器拒绝了本机的注册（mock），请重新生成配对码再试'],
      CONNFAIL: [502, 'connect_failed', '已配对，但暂时连不上中继，会自动重试'],
    }
    const failure = failures[parsed.code]
    if (failure !== undefined) {
      throw new MeshRequestError(failure[0], failure[1], failure[2], 4)
    }
    let warning: 'name_taken' | undefined
    let appliedName = name?.trim() || 'Mac1'
    if (parsed.code === 'NAMETAKE' || appliedName === '公司 Windows') {
      warning = 'name_taken'
      appliedName = 'Mac1'
    }
    this.paired = true
    this.server = { url: parsed.address, fp: parsed.fp }
    this.name = appliedName
    this.rebuildPages()
    return {
      ok: true,
      node: this.local(),
      peers: this.peerRows(),
      ...(warning === undefined ? {} : { warning, name: appliedName }),
    }
  }

  unpair(): MeshOk {
    this.paired = false
    return { ok: true }
  }

  rename(name: string): MeshOk {
    const trimmed = name.trim()
    if (trimmed === '') throw new MeshRequestError(400, 'invalid-name', '本机名称不能为空')
    if (trimmed.length > 40) throw new MeshRequestError(400, 'invalid-name', '本机名称不能超过 40 个字符')
    if (trimmed === '公司 Windows') {
      throw new MeshRequestError(409, 'name_taken', '名称「公司 Windows」已被占用，暂用 Mac1，可在设置里再改', undefined, {
        name: 'Mac1',
      })
    }
    this.name = trimmed
    return { ok: true, name: trimmed }
  }

  private local(): MeshNode {
    return localNode(this.name)
  }

  private peerRows(): MeshNode[] {
    return peerNodes(this.clock())
  }

  private key(nodeId: string, sessionId: string): string {
    return `${nodeId}\u0000${sessionId}`
  }

  private rebuildPages(): void {
    this.pages.clear()
  }

  private frames(nodeId: string, sessionId: string): MeshFrame[] {
    const key = this.key(nodeId, sessionId)
    const existing = this.pages.get(key)
    if (existing !== undefined) return existing
    const session = sessions(this.clock()).find((row) => row.nodeId === nodeId && row.sessionId === sessionId)
    if (session === undefined) {
      throw new MeshRequestError(404, 'session_not_found', '会话不存在')
    }
    const offline = this.peerRows().some((node) => node.nodeId === nodeId && !node.online)
    const built = framesFor(nodeId, sessionId, offline)
    this.pages.set(key, built)
    return built
  }

  private requireControllable(nodeId: string, sessionId: string): void {
    const session = sessions(this.clock()).find((row) => row.nodeId === nodeId && row.sessionId === sessionId)
    if (session === undefined) {
      throw new MeshRequestError(404, 'session_not_found', '会话不存在')
    }
    if (!session.controllable) {
      throw new MeshRequestError(403, 'session_not_remote_controllable', '只能在设备上操作；要让它干活，说一句派任务给它')
    }
  }
}

/** Parse the frozen `dshmesh://host:port/pair?v=1&code=…&fp=…` pairing string (18 §4.1). */
export function parsePairing(pairing: string): { address: string; host: string; code: string; fp: string } | undefined {
  if (typeof pairing !== 'string' || pairing.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(pairing.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'dshmesh:') return undefined
  if (url.pathname !== '/pair' && url.pathname !== '') return undefined
  if (url.searchParams.get('v') !== '1') return undefined
  const code = url.searchParams.get('code') ?? ''
  const fp = url.searchParams.get('fp') ?? ''
  if (!/^[A-Z0-9]{8}$/.test(code)) return undefined
  if (!/^[A-Za-z0-9_-]{43}$/.test(fp)) return undefined
  const host = url.hostname
  if (host === '') return undefined
  const port = url.port === '' ? '443' : url.port
  return { address: `https://${host}:${port}`, host, code, fp }
}

interface PluginMeshLike {
  status(): unknown
  nodes(): unknown
  tree(): unknown
  page(nodeId: string, sessionId: string, maxMessages?: number): unknown
  stream(nodeId: string, sessionId: string, since: number): unknown
  prompt(nodeId: string, sessionId: string, text: string): unknown
  cancel(nodeId: string, sessionId: string): unknown
  interactions(): unknown
  tasks(): unknown
  prefs(): unknown
  updatePrefs(patch: unknown): unknown
  pair(input: unknown): unknown
  unpair(): unknown
  rename(name: string): unknown
  createTaskSession(...args: unknown[]): unknown
  waitTask(...args: unknown[]): unknown
}

/**
 * Adapt the real `@dsh-mesh/plugin` service (nested device tree, raw Session
 * snapshots) onto the flat shape this window has always consumed. Without this
 * seam the Mesh page receives the plugin object and renders an empty tree.
 */
class PluginMeshService implements MeshService {
  constructor(private readonly plugin: PluginMeshLike) {}

  status(): MeshStatus {
    const value = record(this.plugin.status())
    const node = record(value?.node)
    const server = record(value?.server)
    return {
      paired: value?.paired === true,
      server: {
        url: typeof server?.url === 'string' ? server.url : '',
        fp: typeof server?.fingerprint === 'string' ? server.fingerprint : '',
      },
      node: node === undefined ? null : normalizeNode(node),
      connection: value?.connection === 'connected' || value?.connection === 'connecting' || value?.connection === 'offline'
        ? value.connection : 'unpaired',
      peersOnline: typeof value?.peersOnline === 'number' ? value.peersOnline : 0,
      peersTotal: typeof value?.peersTotal === 'number' ? value.peersTotal : 0,
    }
  }

  nodes(): MeshNode[] {
    const value = this.plugin.nodes()
    return Array.isArray(value) ? value.flatMap(item => {
      const node = record(item)
      return node === undefined ? [] : [normalizeNode(node)]
    }) : []
  }

  async tree(): Promise<MeshTree> {
    const value = record(await this.plugin.tree())
    const nodes: MeshNode[] = []
    const workspaces: MeshWorkspace[] = []
    const sessions: MeshSession[] = []
    for (const item of Array.isArray(value?.nodes) ? value.nodes : []) {
      const row = record(item)
      if (row === undefined) continue
      const node = normalizeNode(row)
      nodes.push(node)
      for (const workspaceItem of Array.isArray(row.workspaces) ? row.workspaces : []) {
        const workspace = record(workspaceItem)
        if (workspace === undefined || typeof workspace.workspaceId !== 'string') continue
        const workspaceId = workspace.workspaceId
        workspaces.push({
          nodeId: node.nodeId,
          workspaceId,
          name: typeof workspace.title === 'string' ? workspace.title
            : typeof workspace.name === 'string' ? workspace.name : workspaceId,
          ...(typeof workspace.path === 'string' ? { path: workspace.path } : {}),
        })
        for (const sessionItem of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
          const session = record(sessionItem)
          if (session === undefined || typeof session.sessionId !== 'string') continue
          sessions.push({
            nodeId: node.nodeId,
            workspaceId,
            sessionId: session.sessionId,
            title: typeof session.title === 'string' ? session.title : session.sessionId,
            status: normalizeSessionStatus(session.status),
            controllable: session.controllable === true,
            updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
          })
        }
      }
    }
    return {
      nodes,
      workspaces,
      sessions,
      cursor: typeof value?.cursor === 'number' ? value.cursor : 0,
    }
  }

  async page(nodeId: string, sessionId: string, since = 0): Promise<MeshPage> {
    return pageFromSnapshot(nodeId, sessionId, await this.plugin.page(nodeId, sessionId, 200), since)
  }

  async stream(nodeId: string, sessionId: string, since: number): Promise<MeshPage> {
    return this.page(nodeId, sessionId, since)
  }

  async prompt(nodeId: string, sessionId: string, text: string): Promise<MeshOk> {
    await this.plugin.prompt(nodeId, sessionId, text)
    return { ok: true }
  }

  async cancel(nodeId: string, sessionId: string): Promise<MeshOk> {
    await this.plugin.cancel(nodeId, sessionId)
    return { ok: true }
  }

  interactions(): MeshInteraction[] {
    const value = this.plugin.interactions()
    return Array.isArray(value) ? value as MeshInteraction[] : []
  }

  answer(_answer: MeshInteractionAnswer): MeshOk {
    throw new MeshRequestError(501, 'not_supported', 'Remote approvals are not exposed in this build.')
  }

  tasks(): DeviceTask[] {
    const value = this.plugin.tasks()
    return Array.isArray(value) ? value as DeviceTask[] : []
  }

  prefs(): MeshPrefs {
    const value = record(this.plugin.prefs())
    return {
      allowIncoming: value?.allowIncoming !== false,
      allowedCallers: Array.isArray(value?.allowedCallers)
        ? value.allowedCallers.filter((item): item is string => typeof item === 'string')
        : [],
      allowGuardedTools: value?.allowGuardedTools === true,
      receiveDir: typeof value?.receiveDir === 'string' ? value.receiveDir : '',
    }
  }

  setPrefs(patch: unknown): MeshPrefs {
    this.plugin.updatePrefs(patch)
    return this.prefs()
  }

  async pair(pairing: string, name?: string): Promise<MeshPairSuccess> {
    const parsed = parsePairing(pairing)
    if (parsed === undefined) {
      throw new MeshRequestError(400, 'bad_pairing', '配对串格式不对，请从管理页重新复制', 1)
    }
    await this.plugin.pair({ serverUrl: parsed.address, code: parsed.code, fingerprint: parsed.fp })
    const status = this.status()
    const node = status.node ?? {
      nodeId: 'local',
      name: name?.trim() || 'local',
      platform: 'linux' as const,
      hostDeviceId: 'local',
      online: true,
    }
    return {
      ok: true,
      node,
      peers: this.nodes().filter(item => item.nodeId !== node.nodeId),
    }
  }

  async unpair(): Promise<MeshOk> {
    await this.plugin.unpair()
    return { ok: true }
  }

  async rename(name: string): Promise<MeshOk> {
    const node = record(await this.plugin.rename(name))
    return { ok: true, ...(typeof node?.name === 'string' ? { name: node.name } : {}) }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function normalizeNode(value: Record<string, unknown>): MeshNode {
  const platform = value.platform === 'win32' || value.platform === 'android' || value.platform === 'linux' || value.platform === 'darwin'
    ? value.platform : 'linux'
  return {
    nodeId: typeof value.nodeId === 'string' ? value.nodeId : 'local',
    name: typeof value.name === 'string' ? value.name : 'local',
    platform,
    hostDeviceId: typeof value.hostDeviceId === 'string' ? value.hostDeviceId : '',
    ...(typeof value.clientDeviceId === 'string' ? { clientDeviceId: value.clientDeviceId } : {}),
    online: value.online !== false,
    ...(typeof value.lastSeenAt === 'number' ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(typeof value.harnessVersion === 'string' ? { harnessVersion: value.harnessVersion } : {}),
    ...(typeof value.appVersion === 'string' ? { appVersion: value.appVersion } : {}),
  }
}

function normalizeSessionStatus(value: unknown): MeshSessionStatus {
  return value === 'running' || value === 'waiting-approval' || value === 'waiting-question'
    || value === 'failed' || value === 'unknown' ? value : 'idle'
}

function pageFromSnapshot(nodeId: string, sessionId: string, value: unknown, since: number): MeshPage {
  const snapshot = record(value)
  const records = Array.isArray(snapshot?.records) ? snapshot.records : []
  const items: MeshFrame[] = []
  for (const entry of records) {
    const row = record(entry)
    const event = record(row?.event)
    if (event === undefined || typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    if (event.seq <= since) continue
    items.push({
      nodeId,
      sessionId,
      seq: event.seq,
      event: {
        type: event.type,
        ...(event.data === undefined ? {} : { data: event.data }),
      },
    })
  }
  return {
    items,
    cursor: typeof snapshot?.cursor === 'number' ? snapshot.cursor : (items.at(-1)?.seq ?? since),
  }
}

/** Prefer the plugin's process service; fall back to the static mock until R0 ships. */
export function resolveMeshService(ctx: { get?(name: string): unknown }): MeshService {
  let candidate: unknown
  try {
    candidate = ctx.get?.('mesh')
  } catch {
    candidate = undefined
  }
  if (isPluginMeshService(candidate)) return new PluginMeshService(candidate)
  if (isMeshService(candidate)) return candidate
  return new MockMeshService()
}

function isPluginMeshService(value: unknown): value is PluginMeshLike {
  const record = value as Record<string, unknown> | undefined
  return record !== undefined
    && typeof record.status === 'function'
    && typeof record.tree === 'function'
    && typeof record.page === 'function'
    && typeof record.createTaskSession === 'function'
    && typeof record.waitTask === 'function'
}

function isMeshService(value: unknown): value is MeshService {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.status === 'function'
    && typeof record.tree === 'function'
    && typeof record.page === 'function'
    && typeof record.pair === 'function'
}

/** The JSON the route layer should send for a thrown error. */
export function meshErrorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof MeshRequestError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.step === undefined ? {} : { step: error.step }),
        ...error.details,
      },
    }
  }
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return {
      status,
      body: {
        error: status === 413 ? 'too-large' : 'invalid-request',
        message: error instanceof Error && error.message !== '' ? error.message : 'request-failed',
      },
    }
  }
  return {
    status: 500,
    body: {
      error: 'internal-error',
      message: error instanceof Error ? error.message : 'request-failed',
    },
  }
}