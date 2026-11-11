import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MockMeshService } from '../src/mesh.ts'
import { ProfileStore } from '../src/preferences.ts'
import { registerOrbRoutes, tokensMatch, type OrbControl } from '../src/routes.ts'
import { TccMonitor } from '../src/tcc.ts'
import { EMPTY_UPDATE_STATE } from '../src/update.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-mesh-routes-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function request(
  method: string,
  url: string,
  body?: Buffer | string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)
  const stream = Readable.from(payload.length === 0 ? [] : [payload])
  return Object.assign(stream, { method, url, headers }) as IncomingMessage
}

function response(): ServerResponse & { status: number; body: Buffer } {
  const res = {
    status: 0,
    body: Buffer.alloc(0),
    writableEnded: false,
    writeHead(status: number) { this.status = status },
    end(chunk?: Buffer | string) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.writableEnded = true
    },
    on() { return this },
    off() { return this },
  }
  return res as ServerResponse & { status: number; body: Buffer }
}

const VALID_FP = `Qm9n${'A'.repeat(39)}`

function pairing(code: string, host = 'YOUR_SERVER_IP:443', fp = VALID_FP): string {
  return `dshmesh://${host}/pair?v=1&code=${code}&fp=${fp}`
}

describe('mesh bridge routes', () => {
  it('serves the frozen Mesh shapes to the helper without widening other routes', async () => {
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const mesh = new MockMeshService(() => 1_700_000_000_000)
    let settingsTarget: { at: number; section: string } | null = null
    let confirmedAt = 0
    const control = {
      helperAuthorized: (token: string) => tokensMatch(token, 'helper-secret'),
      takeJump: () => null,
      confirmJump() {},
      takeSettingsOpen: () => settingsTarget,
      confirmSettingsOpen(at: number) { confirmedAt = at; settingsTarget = null },
      async publishChrome() {},
      async setOverlayModel() {},
      async setBackgroundModel() {},
      async setSelectionEnabled() {},
      async setMillifractionEnabled() {},
      async setObservationFrameEnabled() {},
      async setBallEnabled() {},
      updateState: () => EMPTY_UPDATE_STATE,
      async checkUpdate() {},
      installUpdate() {},
      setAutoCheck() {},
    } as unknown as OrbControl

    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handler = route.handler
            return () => { handler = undefined }
          },
        },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
        get: () => undefined,
      },
      store,
      tcc: new TccMonitor(),
      control,
      mesh,
    })
    assert.ok(handler)
    const helper = { 'x-dsh-orb-helper': 'helper-secret' }
    const call = async (method: string, url: string, body?: string, headers: Record<string, string> = helper) => {
      const res = response()
      await handler!(request(method, url, body, headers), res)
      return { status: res.status, body: res.body.length === 0 ? null : JSON.parse(res.body.toString('utf8')) }
    }

    // The helper token is an explicit allowlist: Mesh reads work, everything else does not.
    assert.equal((await call('GET', '/.dsh-orb/mesh/status', undefined, {})).status, 401)
    assert.equal((await call('GET', '/.dsh-orb/mesh/status', undefined, { 'x-dsh-orb-helper': 'nope' })).status, 401)
    assert.equal((await call('GET', '/.dsh-orb/settings')).status, 401)
    assert.equal((await call('GET', '/.dsh-orb/models')).status, 401)
    // The settings page keeps its cookie path.
    assert.equal((await call('GET', '/.dsh-orb/mesh/status', undefined, { 'x-dsh-user': 'ok' })).status, 200)

    const status = await call('GET', '/.dsh-orb/mesh/status')
    assert.equal(status.status, 200)
    assert.equal(status.body.paired, true)
    assert.equal(status.body.connection, 'connected')
    assert.equal(status.body.node.name, '书房 Mac')
    assert.equal(status.body.peersOnline, 1)
    assert.equal(status.body.peersTotal, 2)

    const tree = await call('GET', '/.dsh-orb/mesh/tree')
    assert.equal(tree.status, 200)
    assert.equal(tree.body.nodes.length, 3)
    assert.equal(tree.body.nodes.filter((node: { online: boolean }) => !node.online).length, 1)
    assert.equal(tree.body.workspaces.length, 6)
    assert.equal(tree.body.sessions.length, 12)
    assert.equal(tree.body.sessions.filter((session: { controllable: boolean }) => session.controllable).length, 1)
    for (const node of tree.body.nodes) {
      assert.equal(tree.body.workspaces.filter((workspace: { nodeId: string }) => workspace.nodeId === node.nodeId).length, 2)
    }

    const nodes = await call('GET', '/.dsh-orb/mesh/nodes')
    assert.equal(nodes.body.length, 3)
    assert.equal(nodes.body.find((node: { nodeId: string }) => node.nodeId === 'node-test').online, false)
    assert.equal(typeof nodes.body.find((node: { nodeId: string }) => node.nodeId === 'node-test').lastSeenAt, 'number')

    const page = await call('GET', '/.dsh-orb/mesh/sessions/node-company/session-quote-edit/page')
    assert.equal(page.status, 200)
    assert.equal(page.body.items.length > 0, true)
    for (const frame of page.body.items) {
      assert.equal(frame.nodeId, 'node-company')
      assert.equal(frame.sessionId, 'session-quote-edit')
      assert.equal(typeof frame.seq, 'number')
      assert.equal(typeof frame.event.type, 'string')
    }
    assert.equal(page.body.cursor, page.body.items.at(-1).seq)
    assert.equal(page.body.items.some((frame: { event: { type: string } }) => frame.event.type === 'tool/call'), true)

    const stream = await call('GET', `/.dsh-orb/mesh/sessions/node-company/session-quote-edit/stream?since=${page.body.cursor - 1}`)
    assert.equal(stream.status, 200)
    assert.equal(stream.body.items.length, 1)
    assert.equal(stream.body.cursor, page.body.cursor)

    const interactions = await call('GET', '/.dsh-orb/mesh/interactions')
    assert.equal(interactions.body.length, 2)
    const approval = interactions.body.find((item: { kind: string }) => item.kind === 'approval')
    assert.equal(approval.eventId, 'evt-approval-quote-1')
    assert.equal(approval.toolName, 'edit')
    assert.equal(approval.originNodeId, 'node-local')

    const tasks = await call('GET', '/.dsh-orb/mesh/tasks')
    assert.equal(tasks.body.length, 1)
    assert.equal(tasks.body[0].files[0].name, '报价单.md')
    assert.equal(tasks.body[0].files[0].direction, 'in')
    assert.match(tasks.body[0].files[0].localPath, /^\/Users\/you\/Downloads\/dsh-mesh\//)

    // Only the task session accepts prompt/cancel.
    const refused = await call('POST', '/.dsh-orb/mesh/sessions/node-local/session-design-v3/prompt', JSON.stringify({ text: 'hello' }))
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error, 'session_not_remote_controllable')
    assert.equal(typeof refused.body.message, 'string')
    assert.equal((await call('POST', '/.dsh-orb/mesh/sessions/node-local/session-design-v3/cancel')).status, 403)

    const prompted = await call('POST', '/.dsh-orb/mesh/sessions/node-company/session-quote-edit/prompt', JSON.stringify({ text: '继续修改' }))
    assert.equal(prompted.status, 200)
    const afterPrompt = await call('GET', '/.dsh-orb/mesh/sessions/node-company/session-quote-edit/page')
    assert.equal(afterPrompt.body.items.some((frame: { event: { type: string, data?: { content?: { text?: string }[] } } }) => (
      frame.event.type === 'user/message' && frame.event.data?.content?.[0]?.text === '继续修改'
    )), true)
    assert.equal((await call('POST', '/.dsh-orb/mesh/sessions/node-company/session-quote-edit/cancel')).status, 200)

    // Answering the approval removes the card and settles the tool call.
    const answered = await call('POST', '/.dsh-orb/mesh/interactions/evt-approval-quote-1/answer', JSON.stringify({ outcome: 'allowed-once' }))
    assert.equal(answered.status, 200)
    assert.equal(answered.body.answeredBy, 'node-local')
    const remaining = await call('GET', '/.dsh-orb/mesh/interactions')
    assert.equal(remaining.body.some((item: { eventId: string }) => item.eventId === 'evt-approval-quote-1'), false)
    const settled = await call('GET', '/.dsh-orb/mesh/sessions/node-company/session-quote-edit/page')
    assert.equal(settled.body.items.some((frame: { event: { type: string, data?: { message?: { content?: { text?: string }[] } } } }) => (
      frame.event.type === 'tool/result' && frame.event.data?.message?.content?.[0]?.text === '已允许本次修改'
    )), true)

    // Pairing follows docs/18 §5: TESTPAIR succeeds, every documented failure has its code.
    assert.equal((await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('TESTPAIR') }))).status, 409)
    assert.equal((await call('POST', '/.dsh-orb/mesh/unpair')).status, 200)
    assert.equal((await call('GET', '/.dsh-orb/mesh/status')).body.paired, false)
    assert.equal((await call('GET', '/.dsh-orb/mesh/tree')).body.nodes.length, 1)

    const cases: Array<[string, number, string, number]> = [
      ['BADCODE1', 400, 'code_invalid', 4],
      ['USEDCODE', 409, 'code_used', 4],
      ['OLDCODE1', 410, 'code_expired', 4],
      ['SLOWDOWN', 429, 'rate_limited', 4],
      ['REGFAIL1', 502, 'register_failed', 4],
    ]
    for (const [code, expectedStatus, expectedError, step] of cases) {
      const answer = await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing(code) }))
      assert.equal(answer.status, expectedStatus, code)
      assert.equal(answer.body.error, expectedError, code)
      assert.equal(answer.body.step, step, code)
      assert.equal(typeof answer.body.message, 'string')
    }
    const unreachable = await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('TESTPAIR', 'unreachable.test:443') }))
    assert.equal(unreachable.status, 502)
    assert.equal(unreachable.body.error, 'unreachable')
    assert.match(unreachable.body.message, /unreachable\.test/)
    const mismatch = await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('TESTPAIR', 'YOUR_SERVER_IP:443', 'A'.repeat(43)) }))
    assert.equal(mismatch.status, 502)
    assert.equal(mismatch.body.error, 'fingerprint_mismatch')
    const incompatible = await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('VERSION1') }))
    assert.equal(incompatible.status, 409)
    assert.equal(incompatible.body.error, 'server_incompatible')
    assert.equal(incompatible.body.serverApi, 2)
    assert.equal(incompatible.body.pluginApi, 1)
    assert.equal((await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: 'dshmesh://x/pair?v=1&code=SHORT&fp=x' }))).body.error, 'bad_pairing')

    const paired = await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('NAMETAKE'), name: '新名字' }))
    assert.equal(paired.status, 200)
    assert.equal(paired.body.ok, true)
    assert.equal(paired.body.warning, 'name_taken')
    assert.equal(paired.body.name, 'Mac1')
    const pairedStatus = await call('GET', '/.dsh-orb/mesh/status')
    assert.equal(pairedStatus.body.paired, true)
    assert.equal(pairedStatus.body.node.name, 'Mac1')
    assert.equal((await call('POST', '/.dsh-orb/mesh/pair', JSON.stringify({ pairing: pairing('TESTPAIR') }))).body.error, 'already_paired')

    const renamed = await call('POST', '/.dsh-orb/mesh/name', JSON.stringify({ name: '书房 Mac' }))
    assert.equal(renamed.status, 200)
    assert.equal((await call('GET', '/.dsh-orb/mesh/status')).body.node.name, '书房 Mac')
    const nameTaken = await call('POST', '/.dsh-orb/mesh/name', JSON.stringify({ name: '公司 Windows' }))
    assert.equal(nameTaken.status, 409)
    assert.equal(nameTaken.body.error, 'name_taken')

    const prefs = await call('GET', '/.dsh-orb/mesh/prefs')
    assert.equal(prefs.body.allowIncoming, true)
    const savedPrefs = await call('PUT', '/.dsh-orb/mesh/prefs', JSON.stringify({ allowIncoming: false, receiveDir: '/tmp/mesh' }))
    assert.equal(savedPrefs.body.allowIncoming, false)
    assert.equal(savedPrefs.body.receiveDir, '/tmp/mesh')

    // Unknown paths and malformed bodies stay JSON.
    assert.equal((await call('GET', '/.dsh-orb/mesh/nope')).status, 404)
    assert.equal((await call('POST', '/.dsh-orb/mesh/pair', '{')).status, 400)

    // Backward-compatible deep link: `at` plus an optional section.
    settingsTarget = { at: 123, section: 'orb-mesh' }
    const target = await call('GET', '/.dsh-orb/settings-open', undefined, { 'x-dsh-user': 'ok' })
    assert.deepEqual(target.body, { at: 123, section: 'orb-mesh' })
    const confirmed = await call('POST', '/.dsh-orb/settings-open', JSON.stringify({ at: 123 }), { 'x-dsh-user': 'ok' })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmedAt, 123)
    assert.equal((await call('GET', '/.dsh-orb/settings-open', undefined, { 'x-dsh-user': 'ok' })).body.at, null)

    dispose()
  })
})