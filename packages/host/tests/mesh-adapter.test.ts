import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveMeshService } from '../src/mesh.ts'

describe('real mesh service adapter', () => {
  it('flattens the plugin tree and its nested workspaces and sessions', async () => {
    const plugin = {
      status: () => ({
        paired: true,
        server: { url: 'https://mesh.example', fingerprint: 'fp' },
        node: { nodeId: 'node-a', name: 'Mac', platform: 'darwin', hostDeviceId: 'host-a', online: true },
        connection: 'connected',
        peersOnline: 1,
        peersTotal: 1,
      }),
      nodes: () => [],
      tree: async () => ({
        nodes: [{
          nodeId: 'node-b',
          name: 'Windows',
          platform: 'win32',
          hostDeviceId: 'host-b',
          online: true,
          workspaces: [{
            workspaceId: 'ws-1',
            title: 'dsh_orb',
            path: 'C:\\Users\\me\\.dsh\\dsh_orb',
            sessions: [{
              sessionId: 'session-1',
              title: '整理文件',
              status: 'running',
              controllable: true,
              updatedAt: 42,
            }],
          }],
        }],
        cursor: 3,
      }),
      page: async () => ({
        records: [{ type: 'event', event: { type: 'user/message', seq: 1, data: { text: 'hi' } } }],
        cursor: 1,
      }),
      stream: async () => ({}),
      prompt: async () => undefined,
      cancel: async () => undefined,
      interactions: () => [],
      tasks: () => [],
      prefs: () => ({}),
      updatePrefs: () => ({}),
      pair: async () => undefined,
      unpair: async () => undefined,
      rename: async () => ({ name: 'Mac' }),
      createTaskSession: async () => ({}),
      waitTask: async () => ({}),
    }
    const mesh = resolveMeshService({ get: () => plugin })
    assert.equal((await mesh.status()).server.fp, 'fp')
    const tree = await mesh.tree()
    assert.deepEqual(tree.nodes.map(node => node.nodeId), ['node-b'])
    assert.deepEqual(tree.workspaces.map(workspace => ({
      nodeId: workspace.nodeId,
      workspaceId: workspace.workspaceId,
      name: workspace.name,
    })), [{ nodeId: 'node-b', workspaceId: 'ws-1', name: 'dsh_orb' }])
    assert.deepEqual(tree.sessions.map(session => ({
      nodeId: session.nodeId,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      controllable: session.controllable,
    })), [{ nodeId: 'node-b', workspaceId: 'ws-1', sessionId: 'session-1', controllable: true }])
    const page = await mesh.page('node-b', 'session-1')
    assert.deepEqual(page.items.map(item => [item.seq, item.event.type]), [[1, 'user/message']])
  })
})