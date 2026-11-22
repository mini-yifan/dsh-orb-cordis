#!/usr/bin/env node
/**
 * Run one desktop-preset task and report steps, tool calls and wall time.
 *
 * This is the harness used to measure the background desktop worker. It drives a
 * real `desktop` preset session through the same in-process typert gateway mesh
 * uses, then decodes the persisted session log — the same source the baseline QQ
 * session was measured from, so the numbers are comparable.
 *
 * Usage:
 *   node scripts/measure-desktop-task.mjs "打开计算器算 12 乘以 34" [--cwd /tmp]
 *
 * Preconditions:
 *   - A profile with the orb bundle installed and a display that is awake.
 *     Screen capture returns APP_UNRESPONSIVE on a sleeping display.
 *   - The profile must expose `sessionController` and `typertGateway`; the
 *     driver plugin below waits for both.
 *
 * It prints a JSON line starting with `MEASURE` and a human summary.
 * @module dsh-orb/scripts/measure-desktop-task
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const REMOTE = new URL('../../../../dsh-mesh/packages/plugin/dist/index.js', import.meta.url)

/** Cordis plugin that runs the measurement once the runtime is ready. */
export const name = 'measure-desktop-task'
export const inject = []

/** Decode one multi-frame zstd JSONL session log. */
function decodeSessionLog(file) {
  const raw = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i <= raw.length - 4; i += 1) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i)
  }
  offsets.push(raw.length)
  let all = Buffer.alloc(0)
  for (let k = 0; k < offsets.length - 1; k += 1) {
    try {
      all = Buffer.concat([all, zlib.zstdDecompressSync(raw.subarray(offsets[k], offsets[k + 1]))])
    } catch {
      // A partially written tail frame is expected while a turn is running.
    }
  }
  return all.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

/** Summarize one decoded session. */
function summarize(events) {
  const start = events.find(e => e.type === 'turn/start')?.time
  const end = events.find(e => e.type === 'turn/end')?.time
  const steps = events.filter(e => e.type === 'step/start').length
  const toolCalls = events.filter(e => e.type === 'tool/call')
  let modelMs = 0
  for (const message of events.filter(e => e.type === 'assistant/message')) {
    const step = events.find(e => e.type === 'step/start' && e.data?.step === message.data?.step)
    if (step !== undefined) modelMs += message.time - step.time
  }
  const names = {}
  for (const call of toolCalls) names[call.data?.name ?? '?'] = (names[call.data?.name ?? '?'] ?? 0) + 1
  return {
    steps,
    toolCalls: toolCalls.length,
    wallMs: start !== undefined && end !== undefined ? end - start : null,
    modelMs,
    tools: names,
  }
}

/**
 * Start the measurement.
 * @param ctx - cordis context.
 */
export function apply(ctx) {
  const log = (text) => console.error(`[measure] ${text}`)
  ctx.inject(['typertGateway', 'sessionController'], (scoped) => {
    void (async () => {
      const task = process.env.MEASURE_TASK
      const cwd = process.env.MEASURE_CWD ?? process.cwd()
      if (task === undefined || task === '') { log('MEASURE_TASK is empty'); return }
      try {
        const remote = await import(REMOTE.href)
        const native = scoped.get('typertGateway')
        const connection = scoped.get('connection', false)
        const createOwnerPeer = remote.createOwnerPeerFactory(
          scoped,
          remote.ownerPeerConstructor(remote.default ?? remote, connection),
        )
        const peer = createOwnerPeer()
        const gateway = new remote.TypertGatewaySwitch(native, () => peer).local()

        const created = await gateway.dispatch(
          'session/create',
          { args: { request: { cwd } } },
          AbortSignal.timeout(60_000),
        )
        if (created?.ok !== true) { log('create failed: ' + JSON.stringify(created?.error)); return }
        const sessionId = created.value.sessionId
        log(`session ${sessionId}`)

        const selected = await gateway.dispatch(
          'agentPresets/select',
          { args: { agentId: sessionId, agentPreset: 'desktop' } },
          AbortSignal.timeout(30_000),
        )
        log('preset desktop: ' + (selected?.ok === true ? 'ok' : JSON.stringify(selected?.error)))

        // An unattended run cannot answer approval prompts.
        await gateway.dispatch(
          'commands/execute',
          { args: { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] } },
          AbortSignal.timeout(30_000),
        )

        const prompted = Date.now()
        const accepted = await gateway.dispatch(
          'session/prompt',
          {
            args: {
              request: {
                requestId: `measure-${String(prompted)}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: task }],
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
            },
          },
          AbortSignal.timeout(900_000),
        )
        if (accepted?.ok !== true) { log('prompt rejected: ' + JSON.stringify(accepted?.error)); return }

        // The prompt is accepted immediately; the turn runs after it. Watch the
        // session log, which is also where the baseline numbers came from.
        const base = `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/sessions`
        let file
        const deadline = Date.now() + 900_000
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          const dir = fs.readdirSync(base).find(name => fs.existsSync(`${base}/${name}/${sessionId}`))
          if (dir === undefined) continue
          const candidate = `${base}/${dir}/${sessionId}/session.v4.jsonl.zstd`
          if (!fs.existsSync(candidate)) continue
          file = candidate
          const events = decodeSessionLog(candidate)
          if (events.some(e => e.type === 'turn/end')) break
        }
        if (file === undefined) { log('no session log found'); return }
        const summary = summarize(decodeSessionLog(file))
        const wall = summary.wallMs ?? Date.now() - prompted
        console.log('MEASURE ' + JSON.stringify({ sessionId, task, ...summary, wallMs: wall, log: file }))
        console.log(`steps=${String(summary.steps)} calls=${String(summary.toolCalls)} ` +
          `wall=${(wall / 1000).toFixed(1)}s model=${(summary.modelMs / 1000).toFixed(1)}s`)
        console.log('tools: ' + Object.entries(summary.tools).map(([n, c]) => `${n}×${String(c)}`).join(' '))
      } catch (error) {
        log('ERROR ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
  })
}

// Allow running this file directly to print usage; the loader imports it as a plugin.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = process.argv.slice(2).join(' ').trim()
  if (task === '') {
    console.log('usage: instrument this file as a cordis plugin, or call the helper functions.')
    console.log('MEASURE_TASK="<task>" is read by apply().')
  }
}
