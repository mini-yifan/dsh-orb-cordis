import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import { resolveComputerUseConfig } from '../src/config.ts'
import { FAKE_WINDOW_PNG, createFakeDesktopBackend } from '../src/fake.ts'
import { applyComputerUse } from '../src/plugin.ts'

class VisionAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
    })
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** One assistant response carrying several sibling tool calls. */
function multiCall(calls: { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id),
          name: call.name,
          arguments: JSON.stringify(call.args),
        },
      },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function click(id: string): StreamChunk[] {
  return toolCallResponse(id, 'click', { screen_index: 0, position: [100, 100] })
}

const homes: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** Harness options forwarded to the plugin config. */
interface HarnessConfig {
  readonly postActionWaitMs?: number
  readonly imageWindow?: number
  readonly keepLastStepScreenshot?: boolean
  /** Capture bytes for the fake desktop; the default 1×1 PNG is not persistable by `screenshot`. */
  readonly png?: Uint8Array
}

async function harness(adapter: LlmAdapter, config: HarnessConfig = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cu-image-history-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  const backend = createFakeDesktopBackend(config.png === undefined ? {} : { png: config.png })
  applyComputerUse(ctx, backend, resolveComputerUseConfig({
    postActionWaitMs: 0,
    imageWindow: config.imageWindow,
    keepLastStepScreenshot: config.keepLastStepScreenshot,
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('computer-use-image-history'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, backend, adapter }
}

/** One assistant tool-call step followed by a closing text step, per response. */
function stepsWithClose(calls: readonly (readonly StreamChunk[])[]): (readonly StreamChunk[])[] {
  return [...calls, textResponse('DONE')]
}

/** Image blocks in one request, split by whether a durable offload omits them. */
function imageTally(messages: readonly { readonly content: readonly { readonly type: string; readonly offloaded?: true }[] }[]): { retained: number; offloaded: number } {
  let retained = 0
  let offloaded = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (block.offloaded === true) offloaded += 1
      else retained += 1
    }
  }
  return { retained, offloaded }
}

/** Offloaded flags of every image block of one tool result, by call id. */
function toolImageFlags(
  messages: readonly { readonly role: string; readonly content: readonly { readonly type: string; readonly offloaded?: true }[]; readonly toolCallId?: string }[],
): Map<string, boolean[]> {
  const flags = new Map<string, boolean[]>()
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolCallId === undefined) continue
    const list = flags.get(message.toolCallId) ?? []
    for (const block of message.content) {
      if (block.type === 'image') list.push(block.offloaded === true)
    }
    flags.set(message.toolCallId, list)
  }
  return flags
}

/** Every recorded offload decision, flattened to `seq:index` keys in event order. */
function offloadSelections(session: { snapshotEvents(): readonly SessionEvent[] }): string[] {
  const keys: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'image/offload') continue
    for (const target of event.data.targets) {
      for (const imageIndex of target.imageIndexes) keys.push(`${target.seq}:${imageIndex}`)
    }
  }
  return keys
}

describe('computer-use image history policy', () => {
  it('retains only the newest screenshots within the configured window', async () => {
    const adapter = new VisionAdapter(stepsWithClose([click('c1'), click('c2'), click('c3'), click('c4'), click('c5')]))
    const { ctx, agent } = await harness(adapter, { imageWindow: 3 })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'click through five steps')
    await idle

    // One first-frame notice plus five click results carry images; the window keeps three.
    const last = adapter.requests[adapter.requests.length - 1]
    expect(last).toBeDefined()
    const tally = imageTally(last?.messages ?? [])
    expect(tally.retained).toBe(3)
    expect(tally.offloaded).toBe(3)

    const selections = offloadSelections(agent.session)
    expect(selections).toHaveLength(3)
    expect(new Set(selections).size).toBe(3)
    expect(selections.every(key => /^\d+:\d+$/.test(key))).toBe(true)
  }, 30_000)

  it('keeps only the last image of one step when sibling GUI calls run together', async () => {
    const adapter = new VisionAdapter(stepsWithClose([
      multiCall([
        { id: 'click-a', name: 'click', args: { screen_index: 0, position: [100, 100] } },
        { id: 'click-b', name: 'click', args: { screen_index: 0, position: [200, 200] } },
        { id: 'shot-c', name: 'screenshot', args: {} },
      ]),
    ]))
    const { ctx, agent } = await harness(adapter, { png: FAKE_WINDOW_PNG })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'click twice then screenshot')
    await idle

    const followUp = adapter.requests[1]
    expect(followUp).toBeDefined()
    const flags = toolImageFlags(followUp?.messages ?? [])
    expect(flags.get('click-a')).toEqual([true])
    expect(flags.get('click-b')).toEqual([true])
    expect(flags.get('shot-c')).toEqual([false])

    // The first-frame notice plus the step's final screenshot stay retained.
    const tally = imageTally(followUp?.messages ?? [])
    expect(tally.retained).toBe(2)
    expect(tally.offloaded).toBe(2)
  }, 30_000)

  it('leaves a single-call step untouched', async () => {
    const adapter = new VisionAdapter(stepsWithClose([click('only')]))
    const { ctx, agent } = await harness(adapter)
    const idle = waitForIdle(ctx, agent)
    send(agent, 'one click')
    await idle

    expect(offloadSelections(agent.session)).toHaveLength(0)
    const last = adapter.requests[adapter.requests.length - 1]
    const tally = imageTally(last?.messages ?? [])
    expect(tally.retained).toBe(2)
    expect(tally.offloaded).toBe(0)
  }, 30_000)

  it('does not drop step intermediates when keepLastStepScreenshot is off', async () => {
    const adapter = new VisionAdapter(stepsWithClose([
      multiCall([
        { id: 'drag-a', name: 'drag', args: { start_screen_index: 0, start_position: [10, 10], end_screen_index: 0, end_position: [20, 20] } },
        { id: 'drag-b', name: 'drag', args: { start_screen_index: 0, start_position: [30, 30], end_screen_index: 0, end_position: [40, 40] } },
      ]),
    ]))
    const { ctx, agent } = await harness(adapter, { keepLastStepScreenshot: false })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'drag twice')
    await idle

    const followUp = adapter.requests[1]
    const flags = toolImageFlags(followUp?.messages ?? [])
    expect(flags.get('drag-a')).toEqual([false])
    expect(flags.get('drag-b')).toEqual([false])
    expect(offloadSelections(agent.session)).toHaveLength(0)
  }, 30_000)

  it('stays idempotent across a second turn and never re-selects an image', async () => {
    const adapter = new VisionAdapter([
      ...stepsWithClose([click('t1a'), click('t1b'), click('t1c'), click('t1d')]),
      ...stepsWithClose([click('t2a'), click('t2b')]),
    ])
    const { ctx, agent } = await harness(adapter, { imageWindow: 2 })
    const first = waitForIdle(ctx, agent)
    send(agent, 'first turn')
    await first
    const second = waitForIdle(ctx, agent)
    send(agent, 'second turn')
    await second

    const selections = offloadSelections(agent.session)
    expect(new Set(selections).size).toBe(selections.length)
    const last = adapter.requests[adapter.requests.length - 1]
    const tally = imageTally(last?.messages ?? [])
    expect(tally.retained).toBe(2)
  }, 30_000)
})

describe('computer-use config', () => {
  it('defaults the window to 25 images and keeps per-step retention on', () => {
    expect(resolveComputerUseConfig()).toEqual({
      postActionWaitMs: 600,
      imageWindow: 25,
      keepLastStepScreenshot: true,
    })
  })

  it('rejects an unusable image window at load', () => {
    expect(() => resolveComputerUseConfig({ imageWindow: 0 })).toThrow(/imageWindow/)
    expect(() => resolveComputerUseConfig({ imageWindow: -3 })).toThrow(/imageWindow/)
    expect(() => resolveComputerUseConfig({ imageWindow: 1.5 })).toThrow(/imageWindow/)
  })
})
