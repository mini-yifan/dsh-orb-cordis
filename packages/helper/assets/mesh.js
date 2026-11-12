// Interconnect window. The page only draws: every read and write goes through the
// preload bridge, which forwards to orb-host's `/.dsh-orb/mesh/*` adapter.

import {
  attachmentsForSession,
  buildTranscript,
  findSession,
  formatBytes,
  formatLastSeen,
  groupTree,
  interactionCanBeAnswered,
  sessionHint,
  sessionStatusLabel,
  toolCard,
} from './mesh-model.js'

const api = window.dshMesh

const state = {
  status: null,
  tree: { nodes: [], workspaces: [], sessions: [] },
  interactions: [],
  tasks: [],
  selected: null,
  page: null,
  locale: (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en',
  busy: false,
  error: '',
  collapsed: new Set(),
  /** Bookmark click target waiting until the tree contains that Session. */
  pendingOpen: null,
}

const els = {
  title: document.getElementById('mesh-title'),
  summary: document.getElementById('mesh-summary'),
  dot: document.getElementById('mesh-dot'),
  refresh: document.getElementById('mesh-refresh'),
  settings: document.getElementById('mesh-settings'),
  stopAll: document.getElementById('mesh-stop-all'),
  tree: document.getElementById('mesh-tree'),
  detail: document.getElementById('mesh-detail'),
  sessionHead: document.getElementById('mesh-session-head'),
  sessionTitle: document.getElementById('mesh-session-title'),
  sessionMeta: document.getElementById('mesh-session-meta'),
  sessionStatus: document.getElementById('mesh-session-status'),
  transcript: document.getElementById('mesh-transcript'),
  attachments: document.getElementById('mesh-attachments'),
  hint: document.getElementById('mesh-hint'),
  error: document.getElementById('mesh-error'),
  composer: document.getElementById('mesh-composer'),
  inputLabel: document.getElementById('mesh-input-label'),
  input: document.getElementById('mesh-input'),
  stop: document.getElementById('mesh-stop'),
  send: document.getElementById('mesh-send'),
  empty: document.getElementById('mesh-empty'),
  toast: document.getElementById('mesh-toast'),
}

let toastTimer
/** A generation token retires the previous session's long poll on every switch. */
let liveToken = 0
let liveKey = ''

function zh() {
  return state.locale === 'zh'
}

function t(zhText, enText) {
  return zh() ? zhText : enText
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function svgDot(online) {
  const dot = element('span', `mesh-dot ${online ? 'is-online' : 'is-offline'}`)
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

function errorText(error) {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

async function request(method, path, body) {
  if (api === undefined || typeof api.request !== 'function') {
    throw new Error(t('互联桥不可用', 'The interconnect bridge is unavailable'))
  }
  const response = await api.request(method, path, body)
  const payload = response && typeof response === 'object' ? response : { ok: false, status: 0, body: null }
  if (payload.ok !== true) {
    const detail = payload.body && typeof payload.body === 'object' ? payload.body : {}
    const error = new Error(typeof detail.message === 'string' && detail.message !== ''
      ? detail.message
      : typeof detail.error === 'string' ? detail.error : t('请求失败', 'Request failed'))
    error.code = typeof detail.error === 'string' ? detail.error : undefined
    error.status = payload.status
    throw error
  }
  return payload.body
}

function sessionPath(session, action) {
  return `/sessions/${encodeURIComponent(session.nodeId)}/${encodeURIComponent(session.sessionId)}${action === undefined ? '' : `/${action}`}`
}

function selectedSession() {
  return state.selected === null
    ? undefined
    : findSession(state.tree, state.selected.nodeId, state.selected.sessionId)
}

function nodeById(nodeId) {
  return (state.tree.nodes ?? []).find((node) => node.nodeId === nodeId)
}

function toast(message) {
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  els.toast.textContent = message
  els.toast.hidden = false
  toastTimer = setTimeout(() => {
    toastTimer = undefined
    els.toast.hidden = true
  }, 4000)
}

function showError(error) {
  state.error = errorText(error)
}

function applyAppearance(payload) {
  if (typeof payload !== 'object' || payload === null) return
  document.body.toggleAttribute('data-ds-dark-theme', payload.dark === true)
  if (payload.locale === 'zh' || payload.locale === 'en') {
    state.locale = payload.locale
    render()
  }
}

/* ----- Loading ----- */

async function loadPage() {
  const session = selectedSession()
  if (session === undefined) {
    state.page = null
    return
  }
  state.page = await request('GET', `${sessionPath(session, 'page')}`)
}

async function load() {
  stopLive()
  state.busy = true
  render()
  try {
    const [status, tree, interactions, tasks] = await Promise.all([
      request('GET', '/status'),
      request('GET', '/tree'),
      request('GET', '/interactions'),
      request('GET', '/tasks'),
    ])
    state.status = status
    state.tree = tree && typeof tree === 'object' ? tree : { nodes: [], workspaces: [], sessions: [] }
    state.interactions = Array.isArray(interactions) ? interactions : []
    state.tasks = Array.isArray(tasks) ? tasks : []
    const sessions = Array.isArray(state.tree.sessions) ? state.tree.sessions : []
    const pending = state.pendingOpen
    if (pending !== null && findSession(state.tree, pending.nodeId, pending.sessionId) !== undefined) {
      state.selected = { nodeId: pending.nodeId, sessionId: pending.sessionId }
      state.pendingOpen = null
    }
    if (selectedSession() === undefined) {
      const first = sessions.find((session) => session.controllable === true) ?? sessions[0]
      state.selected = first === undefined ? null : { nodeId: first.nodeId, sessionId: first.sessionId }
    }
    if (state.selected !== null) {
      await loadPage()
      startLive()
    } else {
      stopLive()
    }
    state.error = ''
  } catch (error) {
    showError(error)
  } finally {
    state.busy = false
    render()
  }
}

async function selectSession(nodeId, sessionId) {
  stopLive()
  state.selected = { nodeId, sessionId }
  state.error = ''
  render()
  try {
    await loadPage()
    startLive()
  } catch (error) {
    state.page = null
    showError(error)
  }
  render()
}

function stopLive() {
  liveToken += 1
  liveKey = ''
}

function startLive() {
  const session = selectedSession()
  if (session === undefined) {
    stopLive()
    return
  }
  const key = `${session.nodeId}\u0000${session.sessionId}`
  if (key === liveKey) return
  liveKey = key
  const token = ++liveToken
  void liveLoop(token, key, session)
}

function pageCursor() {
  const cursor = state.page?.cursor
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return Math.max(0, cursor)
  const items = Array.isArray(state.page?.items) ? state.page.items : []
  return items.reduce((max, item) => typeof item?.seq === 'number' ? Math.max(max, item.seq) : max, 0)
}

function mergePage(items) {
  const page = state.page ?? { items: [], cursor: 0 }
  const bySeq = new Map()
  for (const item of Array.isArray(page.items) ? page.items : []) {
    if (typeof item?.seq === 'number') bySeq.set(item.seq, item)
  }
  for (const item of items) {
    if (typeof item?.seq === 'number') bySeq.set(item.seq, item)
  }
  const merged = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
  state.page = { ...page, items: merged.slice(-500) }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Long-poll the selected session and append each durable event as it lands. */
async function liveLoop(token, key, session) {
  let cursor = pageCursor()
  while (token === liveToken && liveKey === key) {
    const current = selectedSession()
    if (current === undefined || `${current.nodeId}\u0000${current.sessionId}` !== key) break
    try {
      const result = await request('GET', `${sessionPath(session, 'stream')}?since=${Math.max(0, cursor)}`)
      if (token !== liveToken || liveKey !== key) break
      const incoming = Array.isArray(result?.items) ? result.items : []
      if (incoming.length > 0) {
        mergePage(incoming)
        if (typeof result.cursor === 'number') state.page.cursor = Math.max(cursor, result.cursor)
        cursor = pageCursor()
        renderDetail()
      } else if (typeof result?.cursor === 'number' && result.cursor > cursor) {
        cursor = result.cursor
      }
    } catch {
      if (token !== liveToken || liveKey !== key) break
      await delay(1_000)
    }
  }
}

function readOpenTarget(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const nodeId = payload.nodeId
  const sessionId = payload.sessionId
  if (typeof nodeId !== 'string' || typeof sessionId !== 'string' || nodeId === '' || sessionId === '') return null
  return { nodeId, sessionId }
}

/** A bookmark click landed: select that remote task once the tree can resolve it. */
async function applyOpenTarget(payload) {
  const target = readOpenTarget(payload)
  if (target === null) return
  if (state.busy) {
    state.pendingOpen = target
    return
  }
  if (findSession(state.tree, target.nodeId, target.sessionId) !== undefined) {
    state.pendingOpen = null
    await selectSession(target.nodeId, target.sessionId)
    return
  }
  state.pendingOpen = target
  if (state.status !== null) await load()
}

/* ----- Actions ----- */

async function sendPrompt() {
  const session = selectedSession()
  if (session === undefined || session.controllable !== true || state.busy) return
  const text = els.input.value.trim()
  if (text === '') return
  state.busy = true
  state.error = ''
  render()
  try {
    await request('POST', sessionPath(session, 'prompt'), { text })
    els.input.value = ''
    state.busy = false
    await load()
  } catch (error) {
    state.busy = false
    showError(error)
    render()
  }
}

async function stopCurrent() {
  const session = selectedSession()
  if (session === undefined || session.controllable !== true || state.busy) return
  state.busy = true
  state.error = ''
  render()
  try {
    await request('POST', sessionPath(session, 'cancel'))
    toast(t('已停止这一轮', 'Stopped this turn'))
  } catch (error) {
    showError(error)
  } finally {
    state.busy = false
    render()
  }
}

async function stopAllRemoteTasks() {
  const sessions = (state.tree.sessions ?? []).filter((session) => session.controllable === true)
  if (sessions.length === 0) {
    toast(t('没有正在运行的远程任务', 'No remote task is running'))
    return
  }
  const question = t(
    `确定停止 ${sessions.length} 个远程任务吗？`,
    `Stop ${sessions.length} remote task${sessions.length === 1 ? '' : 's'}?`,
  )
  if (typeof window.confirm === 'function' && !window.confirm(question)) return
  state.busy = true
  state.error = ''
  render()
  let failed = 0
  for (const session of sessions) {
    try {
      await request('POST', sessionPath(session, 'cancel'))
    } catch {
      failed += 1
    }
  }
  state.busy = false
  toast(failed === 0
    ? t('已停止所有远程任务', 'All remote tasks stopped')
    : t(`有 ${failed} 个任务没能停止`, `${failed} task(s) could not be stopped`))
  await load()
}

async function answerInteraction(interaction, outcome, answers) {
  if (state.busy) return
  state.busy = true
  state.error = ''
  render()
  try {
    await request('POST', `/interactions/${encodeURIComponent(interaction.eventId)}/answer`, {
      ...(outcome === undefined ? {} : { outcome }),
      ...(answers === undefined ? {} : { answers }),
    })
    state.busy = false
    await load()
  } catch (error) {
    state.busy = false
    showError(error)
    render()
  }
}

/* ----- Rendering ----- */

function render() {
  renderChrome()
  renderTop()
  renderTree()
  renderDetail()
  renderError()
}

function renderChrome() {
  document.documentElement.lang = zh() ? 'zh' : 'en'
  document.title = t('互联', 'Interconnect')
  els.title.textContent = t('互联', 'Interconnect')
  els.refresh.textContent = t('刷新', 'Refresh')
  els.settings.textContent = t('设置', 'Settings')
  els.stopAll.textContent = t('停止所有远程任务', 'Stop all remote tasks')
  els.inputLabel.textContent = t('输入指令', 'Command')
  els.stop.textContent = t('停止', 'Stop')
  els.send.textContent = t('发送', 'Send')
  els.tree.setAttribute('aria-label', t('设备、工作区与会话', 'Devices, workspaces, and sessions'))
}

function renderTop() {
  const status = state.status
  if (status === null) {
    els.summary.textContent = t('正在连接本机互联服务…', 'Connecting to the local interconnect service…')
    els.dot.className = 'mesh-dot'
  } else if (status.paired !== true) {
    els.summary.textContent = t('未加入互联', 'Not paired')
    els.dot.className = 'mesh-dot is-unpaired'
  } else {
    const node = status.node ?? {}
    const server = status.server ?? {}
    els.summary.textContent = `${t('本机', 'This device')}：${node.name ?? '—'} · ${server.url ?? '—'} · ${t('已连接', 'Connected')} ${status.peersOnline ?? 0}/${status.peersTotal ?? 0}`
    els.dot.className = `mesh-dot ${status.connection === 'connected' ? 'is-online' : 'is-offline'}`
  }
  const sessions = (state.tree.sessions ?? []).filter((session) => session.controllable === true)
  els.stopAll.disabled = state.busy || sessions.length === 0
  els.refresh.disabled = state.busy
}

function renderTree() {
  els.tree.replaceChildren()
  const groups = groupTree(state.tree)
  if (groups.length === 0) {
    els.tree.append(element('p', 'mesh-node-state', t('还没有可查看的设备', 'No device to show yet')))
    return
  }
  for (const group of groups) {
    const node = group.node
    const wrapper = element('div', `mesh-node${node.online === false ? ' is-offline' : ''}`)
    const collapsed = state.collapsed.has(node.nodeId)
    const head = element('button', 'mesh-node-head')
    head.type = 'button'
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    head.append(svgDot(node.online !== false), element('span', 'mesh-node-name', node.name ?? node.nodeId))
    const stateLabel = node.online === false
      ? `${t('离线', 'Offline')}${typeof node.lastSeenAt === 'number' ? ` · ${formatLastSeen(node.lastSeenAt, Date.now(), zh())}` : ''}`
      : t('在线', 'Online')
    head.append(element('span', 'mesh-node-state', stateLabel))
    head.addEventListener('click', () => {
      if (state.collapsed.has(node.nodeId)) state.collapsed.delete(node.nodeId)
      else state.collapsed.add(node.nodeId)
      renderTree()
    })
    wrapper.append(head)
    if (!collapsed) {
      const body = element('div', 'mesh-node-body')
      for (const workspace of group.workspaces) {
        body.append(element('h3', 'mesh-workspace-name', workspace.name ?? workspace.workspaceId))
        for (const session of workspace.sessions) {
          const active = state.selected !== null
            && state.selected.nodeId === session.nodeId
            && state.selected.sessionId === session.sessionId
          const button = element('button', `mesh-session${active ? ' is-active' : ''}`)
          button.type = 'button'
          button.dataset.nodeId = session.nodeId
          button.dataset.sessionId = session.sessionId
          button.title = session.controllable === true ? session.title : sessionHint(zh())
          button.append(element('span', 'mesh-session-title', session.title))
          if (session.controllable !== true) button.append(element('span', 'mesh-lock', t('只读', 'Read-only')))
          if (typeof session.status === 'string' && session.status !== 'idle') {
            button.append(element('span', `mesh-session-badge is-${session.status}`, sessionStatusLabel(session.status, zh())))
          }
          button.addEventListener('click', () => { void selectSession(session.nodeId, session.sessionId) })
          body.append(button)
        }
      }
      wrapper.append(body)
    }
    els.tree.append(wrapper)
  }
}

function renderDetail() {
  const session = selectedSession()
  const loading = state.status === null
  const unpaired = !loading && state.status.paired !== true
  const empty = loading || unpaired || session === undefined
  els.sessionHead.hidden = empty
  els.transcript.hidden = empty
  els.attachments.hidden = empty
  els.hint.hidden = empty || session?.controllable === true
  els.composer.hidden = empty
  els.empty.hidden = !empty
  if (empty) {
    renderEmpty(session)
    return
  }
  els.sessionTitle.textContent = session.title
  const node = nodeById(session.nodeId)
  const workspace = (state.tree.workspaces ?? []).find((row) => (
    row.nodeId === session.nodeId && row.workspaceId === session.workspaceId
  ))
  els.sessionMeta.textContent = `${node?.name ?? session.nodeId} · ${workspace?.name ?? session.workspaceId}`
  els.sessionStatus.textContent = sessionStatusLabel(session.status, zh())
  els.sessionStatus.className = `is-${session.status}`
  renderTranscript(session)
  renderAttachments(session)
  renderComposer(session)
}

function renderEmpty(session) {
  els.empty.replaceChildren()
  const loading = state.status === null
  const unpaired = !loading && state.status.paired !== true
  const title = loading
    ? t('正在连接…', 'Connecting…')
    : unpaired
      ? t('尚未加入互联', 'Not connected yet')
      : session === undefined ? t('选择一个会话', 'Pick a session') : ''
  const detail = loading
    ? t('正在读取本机互联状态。', 'Reading the local interconnect status.')
    : unpaired
      ? t('在 设置 → 互联 里粘贴配对串，连接后这里会出现其他设备与工作区。', 'Paste a pairing string under Settings → Interconnect; devices and workspaces appear here once connected.')
      : t('左侧是设备、工作区和会话；所有会话都能查看，只有任务会话可以输入指令。', 'The left side lists devices, workspaces, and sessions. Every session is viewable; only task sessions accept commands.')
  els.empty.append(element('h2', undefined, title), element('p', undefined, detail))
  if (unpaired) {
    const button = element('button', undefined, t('打开互联设置', 'Open interconnect settings'))
    button.type = 'button'
    button.addEventListener('click', () => { api?.openSettings?.() })
    els.empty.append(button)
  }
}

function renderTranscript(session) {
  const interactions = state.interactions.filter((interaction) => (
    interaction.nodeId === session.nodeId && interaction.sessionId === session.sessionId
  ))
  const previousTop = els.transcript.scrollTop
  const follow = els.transcript.scrollHeight - previousTop - els.transcript.clientHeight < 40
  const { blocks, interactions: shown } = buildTranscript(state.page?.items ?? [], interactions)
  els.transcript.replaceChildren()
  if (blocks.length === 0 && shown.length === 0) {
    els.transcript.append(element('p', 'mesh-node-state', t('这个会话还没有记录。', 'This session has no record yet.')))
    return
  }
  for (const block of blocks) els.transcript.append(renderBlock(block))
  for (const interaction of shown) els.transcript.append(renderInteraction(interaction))
  // A live append follows the tail only while the reader is already there; a
  // reader inspecting earlier output keeps their place.
  els.transcript.scrollTop = follow ? els.transcript.scrollHeight : previousTop
}

function renderBlock(block) {
  if (block.kind === 'user') {
    const row = element('div', 'user-row')
    row.dataset.kind = 'user'
    row.append(element('div', 'user-bubble', block.text))
    return row
  }
  if (block.kind === 'tool') return renderTool(block)
  if (block.kind === 'reasoning') {
    const details = element('details', 'mesh-reasoning')
    details.append(element('summary', undefined, t('思考', 'Reasoning')), element('pre', undefined, block.text))
    return details
  }
  if (block.kind === 'notice') {
    const article = element('article', 'block', block.text)
    article.dataset.kind = 'notice'
    return article
  }
  const article = element('article', 'block')
  article.dataset.kind = 'assistant'
  const root = element('div', 'am')
  root.append(element('div', 'am-body', block.text))
  article.append(root)
  return article
}

function renderTool(block) {
  const card = toolCard(block, zh())
  const article = element('article', 'block mesh-tool')
  article.dataset.kind = 'tool'
  const root = element('div', 'tool')
  const row = element('div', 'tool-row')
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.setAttribute('aria-expanded', 'false')
  row.append(element('span', 'tool-title', card.title))
  if (card.summary !== '') {
    row.append(element('span', 'tool-sep', '·'), element('span', 'tool-summary', card.summary))
  }
  if (card.waitingApproval) row.append(element('span', 'mesh-waiting', t('等待审批', 'Waiting for approval')))
  const body = element('div', 'tool-body mesh-tool-body')
  body.hidden = true
  if (typeof card.body === 'string' && card.body !== '') {
    body.append(element('pre', 'mesh-tool-block', card.body))
  }
  if (card.result !== '') {
    const result = element('pre', 'mesh-tool-block', card.result)
    result.dataset.error = card.isError ? 'true' : 'false'
    body.append(result)
  }
  const toggle = () => {
    if (body.childElementCount === 0) return
    body.hidden = !body.hidden
    row.setAttribute('aria-expanded', String(!body.hidden))
    article.toggleAttribute('data-open', !body.hidden)
  }
  row.addEventListener('click', toggle)
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  })
  root.append(row, body)
  article.append(root)
  return article
}

function renderInteraction(interaction) {
  const localNodeId = state.status?.node?.nodeId ?? ''
  const canAnswer = interactionCanBeAnswered(interaction, localNodeId) && !state.busy
  const card = element('div', 'mesh-card')
  card.dataset.eventId = interaction.eventId
  card.append(element('h3', undefined, interaction.kind === 'approval'
    ? t('等待审批', 'Approval needed')
    : t('等待回答', 'Answer needed')))
  if (typeof interaction.reason === 'string' && interaction.reason !== '') {
    card.append(element('p', undefined, interaction.reason))
  }
  if (interaction.kind === 'approval') {
    if (typeof interaction.toolName === 'string' && interaction.toolName !== '') {
      card.append(element('p', undefined, `${t('工具', 'Tool')}：${interaction.toolName}`))
    }
    const actions = element('div', 'mesh-card-actions')
    const allow = element('button', 'is-primary', t('允许本次', 'Allow once'))
    allow.type = 'button'
    allow.disabled = !canAnswer
    allow.addEventListener('click', () => { void answerInteraction(interaction, 'allowed-once') })
    const reject = element('button', undefined, t('拒绝', 'Reject'))
    reject.type = 'button'
    reject.disabled = !canAnswer
    reject.addEventListener('click', () => { void answerInteraction(interaction, 'rejected') })
    actions.append(allow, reject)
    card.append(actions)
  } else {
    const input = element('input')
    input.type = 'text'
    input.placeholder = t('输入回答…', 'Type an answer…')
    input.disabled = !canAnswer
    const actions = element('div', 'mesh-card-actions')
    const answer = element('button', 'is-primary', t('回答', 'Answer'))
    answer.type = 'button'
    answer.disabled = !canAnswer
    answer.addEventListener('click', () => {
      if (input.value.trim() !== '') void answerInteraction(interaction, undefined, { text: input.value.trim() })
    })
    actions.append(answer)
    card.append(input, actions)
  }
  if (!canAnswer) {
    const origin = nodeById(interaction.originNodeId)?.name ?? interaction.originNodeId ?? t('发起设备', 'the origin device')
    card.append(element('p', undefined, t(`请在 ${origin} 或目标设备上处理。`, `Handle this on ${origin} or the target device.`)))
  }
  return card
}

function renderAttachments(session) {
  const files = attachmentsForSession(state.tasks, session.nodeId, session.sessionId)
  els.attachments.replaceChildren()
  els.attachments.hidden = files.length === 0
  if (files.length === 0) return
  const target = nodeById(session.nodeId)?.name ?? session.nodeId
  const local = state.status?.node?.name ?? t('本机', 'this device')
  for (const file of files) {
    const row = element('div', 'mesh-attachment')
    row.title = file.localPath ?? ''
    row.append(
      element('span', 'mesh-attachment-name', file.name),
      element('span', 'mesh-attachment-source', file.direction === 'in' ? `← ${target}` : `→ ${target}`),
      element('span', 'mesh-attachment-source', formatBytes(file.size)),
    )
    if (typeof file.localPath === 'string' && file.localPath !== '') {
      row.append(element('span', 'mesh-attachment-path', file.localPath))
    } else if (file.direction === 'in') {
      row.append(element('span', 'mesh-attachment-path', t(`${local} 上的任务文件`, `Task file on ${local}`)))
    }
    els.attachments.append(row)
  }
}

function renderComposer(session) {
  const controllable = session.controllable === true
  els.input.disabled = !controllable || state.busy
  els.input.placeholder = controllable
    ? t('输入指令，交给远端任务会话…', 'Send a command to this remote task session…')
    : sessionHint(zh())
  els.send.disabled = !controllable || state.busy
  els.stop.disabled = !controllable || state.busy
  if (!controllable) {
    els.hint.textContent = sessionHint(zh())
    els.hint.hidden = false
  } else {
    els.hint.hidden = true
  }
}

function renderError() {
  els.error.textContent = state.error
  els.error.hidden = state.error === ''
}

/* ----- Wiring ----- */

if (typeof api?.onAppearance === 'function') api.onAppearance(applyAppearance)
if (typeof api?.onOpenSession === 'function') api.onOpenSession((target) => { void applyOpenTarget(target) })
els.refresh.addEventListener('click', () => { void load() })
els.settings.addEventListener('click', () => { api?.openSettings?.() })
els.stopAll.addEventListener('click', () => { void stopAllRemoteTasks() })
els.stop.addEventListener('click', () => { void stopCurrent() })
els.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void sendPrompt()
})
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    els.input.blur()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendPrompt()
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (document.activeElement === els.input) return
  const active = els.tree.querySelector('.mesh-session.is-active')
  if (active instanceof HTMLElement) active.focus()
})

render()
void load()