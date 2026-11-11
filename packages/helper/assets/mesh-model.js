// Mesh transcript model: DSH session events -> the rows the interconnect window draws.
// Kept free of DOM and Electron so the same reducer can be tested in Node and reused by
// the real `@dsh-mesh/plugin` frames later. Tool titles/summaries reuse transcript-model.

import { classifyTool, deriveSummary, formatToolBody, toolTitle } from './transcript-model.js'

const SESSION_LABELS = {
  zh: {
    idle: '空闲',
    running: '进行中',
    'waiting-approval': '等待确认',
    'waiting-question': '等待回答',
    failed: '失败',
    unknown: '状态未知',
  },
  en: {
    idle: 'Idle',
    running: 'Running',
    'waiting-approval': 'Waiting for approval',
    'waiting-question': 'Waiting for answer',
    failed: 'Failed',
    unknown: 'Unknown',
  },
}

export function sessionStatusLabel(status, zh) {
  return (SESSION_LABELS[zh ? 'zh' : 'en'][status]) ?? (zh ? '状态未知' : 'Unknown')
}

export function sessionHint(zh) {
  return zh
    ? '只能在设备上操作；要让它干活，说一句派任务给它。'
    : 'This session can only be operated on its own device; ask the agent to dispatch a task instead.'
}

export function formatLastSeen(at, now, zh) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return zh ? '刚刚' : 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return zh ? `${days} 天前` : `${days}d ago`
}

export function formatBytes(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Device -> workspaces -> sessions, in the order the host sent them. */
export function groupTree(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : []
  const workspaces = Array.isArray(tree?.workspaces) ? tree.workspaces : []
  const sessions = Array.isArray(tree?.sessions) ? tree.sessions : []
  return nodes.map((node) => ({
    node,
    workspaces: workspaces
      .filter((workspace) => workspace.nodeId === node.nodeId)
      .map((workspace) => ({
        ...workspace,
        sessions: sessions.filter((session) => (
          session.nodeId === node.nodeId && session.workspaceId === workspace.workspaceId
        )),
      })),
  }))
}

export function findSession(tree, nodeId, sessionId) {
  const rows = Array.isArray(tree?.sessions) ? tree.sessions : []
  return rows.find((session) => session.nodeId === nodeId && session.sessionId === sessionId)
}

/**
 * Only the dispatching device and the target device may answer (decision P3). The local
 * node is the dispatching one in the static data, so the card is usable there.
 */
export function interactionCanBeAnswered(interaction, localNodeId) {
  if (typeof localNodeId !== 'string' || localNodeId === '') return false
  return interaction?.originNodeId === localNodeId || interaction?.nodeId === localNodeId
}

/** Result files and uploads for one session, with the task and source node attached. */
export function attachmentsForSession(tasks, nodeId, sessionId) {
  const rows = Array.isArray(tasks) ? tasks : []
  const files = []
  for (const task of rows) {
    if (task?.targetNodeId !== nodeId || task?.sessionId !== sessionId) continue
    for (const file of Array.isArray(task.files) ? task.files : []) {
      files.push({
        ...file,
        taskId: task.taskId,
        targetNodeId: task.targetNodeId,
        status: task.status,
      })
    }
  }
  return files
}

/* ----- Session event reduction ----- */

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : undefined
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function partKind(part) {
  if (part?.type === 'text') return 'assistant'
  if (part?.type === 'reasoning' || part?.type === 'thinking') return 'reasoning'
  if (part?.type === 'tool-call' || part?.type === 'tool_use') return 'tool'
  return undefined
}

function toolOf(part) {
  const name = typeof part?.name === 'string' ? part.name : ''
  const id = typeof part?.id === 'string' ? part.id : typeof part?.callId === 'string' ? part.callId : ''
  return {
    name,
    id,
    args: typeof part?.arguments === 'string' ? part.arguments : '',
  }
}

/**
 * Apply DSH `session/page` or `session/follow` events in order. Unknown event types are
 * ignored so a newer harness can add events without breaking this window.
 * @returns {{ blocks: object[], interactions: object[] }}
 */
export function buildTranscript(frames, interactions = []) {
  const blocks = []
  const byKey = new Map()
  const streamKeys = new Map()
  const waiting = new Map()

  const upsert = (block) => {
    const existing = byKey.get(block.key)
    if (existing === undefined) {
      blocks.push(block)
      byKey.set(block.key, block)
      return block
    }
    Object.assign(existing, block)
    return existing
  }

  for (const frame of Array.isArray(frames) ? frames : []) {
    const event = asRecord(frame?.event)
    if (event === undefined) continue
    const type = event.type
    const data = asRecord(event.data) ?? {}
    if (type === 'user/message') {
      const source = asRecord(data.source)
      if (source?.kind !== undefined && source.kind !== 'user') continue
      const text = textOf(data.content)
      if (text.trim() === '') continue
      upsert({ key: `user:${frame.seq}`, kind: 'user', text, running: false })
      continue
    }
    if (type === 'turn/start') continue
    if (type === 'assistant/chunk') {
      const chunk = asRecord(data.chunk)
      if (chunk === undefined) continue
      const turn = Number(data.turn)
      const step = Number(data.step)
      const index = Number(chunk.index)
      const key = `stream:${turn}:${step}:${index}`
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        const existing = byKey.get(key)
        const block = existing ?? upsert({ key, kind: 'assistant', text: '', running: true, turn, step })
        block.text += chunk.text
        streamKeys.set(`${turn}:${step}`, key)
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        const existing = byKey.get(key)
        const block = existing ?? upsert({ key, kind: 'reasoning', text: '', running: true, turn, step })
        block.text += chunk.text
      } else if (chunk.type === 'tool-call-delta') {
        const id = typeof chunk.id === 'string' ? chunk.id : ''
        const name = typeof chunk.name === 'string' ? chunk.name : ''
        const toolKey = id === '' ? `stream-tool:${turn}:${step}:${index}` : `tool:${id}`
        const existing = byKey.get(toolKey)
        const block = existing ?? upsert({
          key: toolKey,
          kind: 'tool',
          text: name,
          running: true,
          turn,
          step,
          tool: { name, args: '', result: '', isError: false, waitingApproval: false },
        })
        if (block.tool.name === '' && name !== '') {
          block.tool.name = name
          block.text = name
        }
        block.tool.args += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      }
      continue
    }
    if (type === 'assistant/message') {
      const message = asRecord(data.message)
      const parts = Array.isArray(message?.content) ? message.content : []
      const turn = Number(data.turn)
      const step = Number(data.step)
      const streamed = streamKeys.get(`${turn}:${step}`)
      let streamUsed = false
      for (const [index, part] of parts.entries()) {
        const kind = partKind(part)
        if (kind === 'tool') {
          const tool = toolOf(part)
          if (tool.name === '') continue
          const key = tool.id === '' ? `tool:${frame.seq}:${index}` : `tool:${tool.id}`
          upsert({
            key,
            kind: 'tool',
            text: tool.name,
            running: false,
            tool: { name: tool.name, args: tool.args, result: '', isError: false, waitingApproval: false },
          })
          continue
        }
        const text = typeof part?.text === 'string' ? part.text : ''
        if (text.trim() === '') continue
        if (kind === 'assistant' && !streamUsed && streamed !== undefined) {
          upsert({ key: streamed, kind: 'assistant', text, running: false })
          streamUsed = true
          continue
        }
        const key = kind === 'reasoning' ? `reasoning:${frame.seq}:${index}` : `assistant:${frame.seq}:${index}`
        upsert({ key, kind: kind ?? 'assistant', text, running: false })
      }
      for (const block of blocks) {
        if (block.running === true && block.kind !== 'tool' && block.turn === turn) block.running = false
      }
      continue
    }
    if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name === '') continue
      const id = typeof data.callId === 'string' ? data.callId : ''
      const key = id === '' ? `tool:${frame.seq}` : `tool:${id}`
      upsert({
        key,
        kind: 'tool',
        text: name,
        running: true,
        tool: {
          name,
          args: typeof data.arguments === 'string' ? data.arguments : '',
          result: '',
          isError: false,
          waitingApproval: false,
        },
      })
      continue
    }
    if (type === 'tool/result') {
      const message = asRecord(data.message)
      const id = typeof data.callId === 'string'
        ? data.callId
        : typeof message?.toolCallId === 'string' ? message.toolCallId : ''
      if (id === '') continue
      const existing = byKey.get(`tool:${id}`)
      const name = existing?.tool?.name ?? (typeof data.name === 'string' ? data.name : 'tool')
      const block = upsert({
        key: `tool:${id}`,
        kind: 'tool',
        text: name,
        running: false,
        tool: {
          name,
          args: existing?.tool?.args ?? '',
          result: '',
          isError: false,
          waitingApproval: false,
        },
      })
      block.tool.result = textOf(message?.content)
      block.tool.isError = message?.isError === true
      block.running = false
      continue
    }
    if (type === 'turn/end') {
      for (const block of blocks) block.running = false
    }
  }

  for (const interaction of Array.isArray(interactions) ? interactions : []) {
    if (interaction?.kind !== 'approval') continue
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block?.kind !== 'tool') continue
      if (block.tool?.name !== interaction.toolName) continue
      if (block.tool.result !== '') continue
      block.tool.waitingApproval = true
      waiting.set(interaction.eventId, block.key)
      break
    }
  }

  return { blocks, interactions: Array.isArray(interactions) ? interactions : [] }
}

/** Everything the tool card needs, reusing the ball's own tool labels. */
export function toolCard(block, zh) {
  const tool = block?.tool ?? {}
  const name = typeof tool.name === 'string' ? tool.name : ''
  const args = typeof tool.args === 'string' ? tool.args : ''
  const variant = classifyTool(name)
  return {
    title: toolTitle(name, zh),
    summary: deriveSummary(variant, args),
    body: formatToolBody(variant, args),
    result: typeof tool.result === 'string' ? tool.result : '',
    isError: tool.isError === true,
    waitingApproval: tool.waitingApproval === true,
    running: block?.running === true,
  }
}