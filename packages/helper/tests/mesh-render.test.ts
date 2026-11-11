import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
} from '../assets/mesh-model.js'

const here = dirname(fileURLToPath(import.meta.url))

/** A source asset with CRLF folded: the pins anchor on `\n`. */
function source(relative: string): string {
  return readFileSync(join(here, relative), 'utf8').replaceAll('\r\n', '\n')
}

function liveCode(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
}

const html = source('../assets/mesh.html')
const css = source('../assets/mesh.css')
const mesh = liveCode(source('../assets/mesh.js'))
const main = liveCode(source('../src/main.ts'))
const routes = liveCode(source('../../host/src/routes.ts'))

function frame(nodeId: string, sessionId: string, seq: number, type: string, data?: unknown) {
  return { nodeId, sessionId, seq, event: { type, data } }
}

describe('mesh window markup and wiring', () => {
  it('ships the tree, transcript, cards, composer, and stop-all control', () => {
    assert.match(html, /id="mesh-tree" role="tree"/)
    assert.match(html, /id="mesh-transcript" role="log"/)
    assert.match(html, /id="mesh-attachments"/)
    assert.match(html, /id="mesh-hint" role="status" hidden/)
    assert.match(html, /id="mesh-composer"/)
    assert.match(html, /id="mesh-stop-all"/)
    assert.match(html, /id="mesh-empty"/)
    assert.match(html, /<script type="module" src="mesh\.js"><\/script>/)
    // The window reuses the ball's transcript styles beside the Mesh-only layout.
    assert.match(html, /href="chat\.css"/)
    assert.match(html, /href="theme\.css"/)
    assert.match(css, /#mesh-transcript \{[^}]*flex: 1;/)
    assert.match(css, /\.mesh-card \{/)
    assert.match(css, /\.mesh-attachment \{/)
  })

  it('disables the composer for every non-task session and explains why', () => {
    assert.match(mesh, /const controllable = session\.controllable === true/)
    assert.match(mesh, /els\.input\.disabled = !controllable \|\| state\.busy/)
    assert.match(mesh, /els\.send\.disabled = !controllable \|\| state\.busy/)
    assert.match(mesh, /els\.stop\.disabled = !controllable \|\| state\.busy/)
    assert.match(mesh, /els\.hint\.textContent = sessionHint\(zh\(\)\)/)
    assert.match(mesh, /els\.input\.placeholder = controllable/)
    assert.match(mesh, /session\.controllable !== true/)
    assert.equal(mesh.includes('innerHTML'), false)
  })

  it('stops all remote tasks only after an explicit confirmation', () => {
    assert.match(mesh, /async function stopAllRemoteTasks\(\)/)
    assert.match(mesh, /filter\(\(session\) => session\.controllable === true\)/)
    assert.match(mesh, /window\.confirm\(question\)/)
    assert.match(mesh, /request\('POST', sessionPath\(session, 'cancel'\)\)/)
    assert.match(mesh, /没有正在运行的远程任务/)
  })

  it('renders approval and question cards with the answer boundary', () => {
    assert.match(mesh, /interaction\.kind === 'approval'/)
    assert.match(mesh, /allowed-once/)
    assert.match(mesh, /interactionCanBeAnswered\(interaction, localNodeId\)/)
    assert.match(mesh, /\/interactions\/\$\{encodeURIComponent\(interaction\.eventId\)\}\/answer/)
    assert.match(mesh, /请在 \$\{origin\} 或目标设备上处理/)
    assert.match(mesh, /attachmentsForSession\(state\.tasks/)
  })

  it('opens settings on the interconnect section from the window', () => {
    assert.match(mesh, /api\?\.openSettings\?\.\(\)/)
    assert.match(main, /ipcMain\.on\('orb:mesh-open-settings'/)
    assert.match(main, /write\(\{ type: 'open-settings', section: 'orb-mesh' \}\)/)
  })

  it('creates an ordinary framed, resizable taskbar window and loads mesh.html', () => {
    const start = main.indexOf('function openMeshWindow()')
    assert.notEqual(start, -1)
    const block = main.slice(start, start + 2600)
    assert.match(block, /width: 960/)
    assert.match(block, /height: 640/)
    assert.match(block, /minWidth: 760/)
    assert.match(block, /frame: true/)
    assert.match(block, /resizable: true/)
    assert.match(block, /skipTaskbar: false/)
    assert.match(block, /mesh-preload\.cjs/)
    assert.match(block, /assets\/mesh\.html/)
    assert.match(block, /created\.on\('closed'/)
  })

  it('reaches the host only through an allowlisted Mesh bridge with the helper token', () => {
    assert.match(main, /orb:mesh-request/)
    assert.match(main, /const MESH_PATH = \/\^\\\/\(\?:status\|nodes\|tree/)
    assert.match(main, /'x-dsh-orb-helper': token/)
    assert.match(main, /path: `\/\.dsh-orb\/mesh\$\{request\.path\}`/)
    // The host widens its helper exemption only for the Mesh prefix.
    assert.match(routes, /const helperMesh = path\.startsWith\(`\$\{MESH_PREFIX\}\/`\) && helperTokenOk/)
    assert.match(routes, /if \(!helperAsset && !helperMesh\)/)
  })

  it('routes the menu row to the host and opens the window from its broadcast', () => {
    assert.match(main, /openMesh: \(\) => \{ write\(\{ type: 'mesh-open' \}\) \}/)
    assert.match(main, /record\.type === 'open-mesh'\) \{\n\s+openMeshWindow\(\)/)
    assert.match(source('../../host/src/orb.ts'), /record\.type === 'mesh-open'\) \{[\s\S]{0,220}this\.broadcast\(\{ type: 'open-mesh' \}\)/)
  })
})

describe('mesh transcript model', () => {
  it('groups devices into workspaces and sessions without losing offline rows', () => {
    const tree = {
      nodes: [
        { nodeId: 'a', name: 'A', online: true },
        { nodeId: 'b', name: 'B', online: false },
      ],
      workspaces: [
        { nodeId: 'a', workspaceId: 'wa', name: 'WA' },
        { nodeId: 'b', workspaceId: 'wb', name: 'WB' },
      ],
      sessions: [
        { nodeId: 'a', workspaceId: 'wa', sessionId: 's1', title: 'S1', status: 'idle', controllable: true },
        { nodeId: 'b', workspaceId: 'wb', sessionId: 's2', title: 'S2', status: 'unknown', controllable: false },
      ],
    }
    const groups = groupTree(tree)
    assert.equal(groups.length, 2)
    assert.equal(groups[0].workspaces[0].sessions.length, 1)
    assert.equal(groups[1].node.online, false)
    assert.equal(findSession(tree, 'b', 's2').title, 'S2')
    assert.equal(findSession(tree, 'b', 'missing'), undefined)
    assert.equal(groupTree(undefined).length, 0)
  })

  it('reduces user, tool, approval, and result events into transcript rows', () => {
    const frames = [
      frame('n', 's', 1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '把标题改成蓝色' }] }),
      frame('n', 's', 2, 'turn/start', { turn: 1 }),
      frame('n', 's', 3, 'tool/call', { turn: 1, step: 0, callId: 'edit-1', name: 'edit', arguments: '{"file_path":"报价单.md"}' }),
    ]
    const interaction = {
      nodeId: 'n',
      sessionId: 's',
      eventId: 'e1',
      clientId: 'c',
      kind: 'approval',
      toolName: 'edit',
      reason: '允许修改《报价单.md》吗？',
      originNodeId: 'local',
      createdAt: 1,
    }
    const before = buildTranscript(frames, [interaction])
    assert.equal(before.blocks.length, 2)
    assert.equal(before.blocks[0].kind, 'user')
    assert.equal(before.blocks[1].kind, 'tool')
    assert.equal(before.blocks[1].tool.waitingApproval, true)
    assert.equal(before.blocks[1].tool.result, '')
    const card = toolCard(before.blocks[1], true)
    assert.equal(card.title, '编辑')
    assert.equal(card.summary, '报价单.md')
    assert.equal(card.waitingApproval, true)

    const settled = buildTranscript([
      ...frames,
      frame('n', 's', 4, 'tool/result', {
        turn: 1,
        step: 0,
        message: { toolCallId: 'edit-1', isError: false, content: [{ type: 'text', text: '已允许本次修改' }] },
      }),
      frame('n', 's', 5, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: '改好了。' }] } }),
      frame('n', 's', 6, 'turn/end', { turn: 1 }),
    ], [])
    assert.equal(settled.blocks.find((block) => block.kind === 'tool').tool.result, '已允许本次修改')
    assert.equal(settled.blocks.find((block) => block.kind === 'assistant').text, '改好了。')
    assert.equal(settled.blocks.every((block) => block.running === false), true)
  })

  it('appends streamed text into one assistant row and drops unknown events', () => {
    const { blocks } = buildTranscript([
      frame('n', 's', 1, 'assistant/chunk', { turn: 1, step: 0, chunk: { index: 0, type: 'text-delta', text: '你' } }),
      frame('n', 's', 2, 'assistant/chunk', { turn: 1, step: 0, chunk: { index: 0, type: 'text-delta', text: '好' } }),
      frame('n', 's', 3, 'projection/change', { anything: true }),
      frame('n', 's', 4, 'turn/end', { turn: 1 }),
    ], [])
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text, '你好')
    assert.equal(blocks[0].running, false)
  })

  it('keeps task attachments with their source and local path', () => {
    const tasks = [{
      taskId: 'task-1',
      targetNodeId: 'node-company',
      sessionId: 'session-quote-edit',
      status: 'waiting-input',
      files: [{ name: '报价单.md', size: 48_211, direction: 'in', localPath: '/Users/you/Downloads/dsh-mesh/报价单.md', state: 'done' }],
    }, {
      taskId: 'task-2',
      targetNodeId: 'node-company',
      sessionId: 'other',
      files: [{ name: 'ignore.md', size: 1, direction: 'in', state: 'done' }],
    }]
    const files = attachmentsForSession(tasks, 'node-company', 'session-quote-edit')
    assert.equal(files.length, 1)
    assert.equal(files[0].taskId, 'task-1')
    assert.equal(files[0].localPath, '/Users/you/Downloads/dsh-mesh/报价单.md')
    assert.equal(formatBytes(48_211), '47.1 KB')
  })

  it('labels status, presence, and who may answer', () => {
    assert.equal(sessionStatusLabel('waiting-approval', true), '等待确认')
    assert.equal(sessionStatusLabel('waiting-question', false), 'Waiting for answer')
    assert.match(sessionHint(true), /只能在设备上操作/)
    assert.match(sessionHint(false), /dispatch a task/)
    assert.equal(formatLastSeen(1_000_000, 1_030_000, true), '刚刚')
    assert.equal(formatLastSeen(1_000_000, 1_120_000, true), '2 分钟前')
    assert.equal(formatLastSeen(1_000_000, 1_000_000 + 2 * 3_600_000, false), '2h ago')
    assert.equal(interactionCanBeAnswered({ originNodeId: 'local', nodeId: 'remote' }, 'local'), true)
    assert.equal(interactionCanBeAnswered({ originNodeId: 'other', nodeId: 'remote' }, 'local'), false)
    assert.equal(interactionCanBeAnswered({ originNodeId: 'other', nodeId: 'remote' }, ''), false)
  })
})

interface MeshPreloadApi {
  request?: (method: string, path: string, body?: unknown) => Promise<unknown>
  openSettings?: () => void
  onAppearance?: (callback: (value: unknown) => void) => void
}

function loadMeshPreload(): {
  api: MeshPreloadApi
  sent: [string, unknown][]
  invoked: [string, unknown][]
  listeners: [string, unknown][]
} {
  const sent: [string, unknown][] = []
  const invoked: [string, unknown][] = []
  const listeners: [string, unknown][] = []
  const exposed: Record<string, MeshPreloadApi> = {}
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: MeshPreloadApi) { exposed[name] = value },
    },
    ipcRenderer: {
      send(channel: string, payload?: unknown) { sent.push([channel, payload]) },
      invoke(channel: string, payload?: unknown) {
        invoked.push([channel, payload])
        return Promise.resolve({ ok: true, status: 200, body: { ok: true } })
      },
      on(channel: string, listener: unknown) { listeners.push([channel, listener]) },
    },
  }
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string
    _cache: Record<string, { id: string; filename: string; loaded: boolean; exports: unknown }>
  }
  const original = loader._resolveFilename
  loader._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return 'electron-mock-dsh-mesh'
    return original.call(this, request, parent, isMain, options)
  }
  loader._cache['electron-mock-dsh-mesh'] = {
    id: 'electron-mock-dsh-mesh',
    filename: 'electron-mock-dsh-mesh',
    loaded: true,
    exports: electron,
  }
  const filename = join(here, '../mesh-preload.cjs')
  delete loader._cache[filename]
  try {
    createRequire(import.meta.url)(filename)
  } finally {
    loader._resolveFilename = original
    delete loader._cache['electron-mock-dsh-mesh']
    delete loader._cache[filename]
  }
  return { api: exposed.dshMesh ?? {}, sent, invoked, listeners }
}

describe('mesh preload', () => {
  it('forwards allowlisted requests and the settings/section request only', async () => {
    const bridge = loadMeshPreload()
    assert.ok(bridge.api.request)
    const answer = await bridge.api.request('GET', '/status')
    assert.deepEqual(answer, { ok: true, status: 200, body: { ok: true } })
    bridge.api.openSettings?.()
    bridge.api.onAppearance?.(() => {})
    assert.deepEqual(bridge.invoked, [
      ['orb:mesh-request', { method: 'GET', path: '/status', body: undefined }],
    ])
    assert.deepEqual(bridge.sent, [['orb:mesh-open-settings', undefined]])
    assert.deepEqual(bridge.listeners.map(([channel]) => channel), ['mesh:appearance'])
  })
})