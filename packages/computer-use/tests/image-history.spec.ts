import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import { resolveComputerUseConfig } from '../src/config.ts'
import { FAKE_WINDOW_PNG, createFakeDesktopBackend } from '../src/fake.ts'
import { SCREEN_IMAGE_TOOLS } from '../src/image-history.ts'
import { inject as COMPUTER_USE_INJECT } from '../src/index.ts'
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
  /**
   * Mount the plugin the way the Loader does — as a child fiber carrying the module's own `inject`
   * list — instead of applying it straight to the root context.
   */
  readonly loaderMounted?: boolean
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
  const resolved = resolveComputerUseConfig({
    postActionWaitMs: 0,
    imageWindow: config.imageWindow,
    keepLastStepScreenshot: config.keepLastStepScreenshot,
  })
  if (config.loaderMounted === true) {
    // A child fiber with the declared inject list: an undeclared `ctx.<service>` read throws here,
    // which is the shape the ball actually runs in.
    await ctx.plugin({
      inject: [...COMPUTER_USE_INJECT],
      apply: (scope: Context) => {
        applyComputerUse(scope, backend, resolved)
      },
    })
  } else {
    applyComputerUse(ctx, backend, resolved)
  }
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

/** Offloaded flags of every block referencing one attachment, in request order. */
function attachmentFlags(
  messages: readonly {
    readonly content: readonly {
      readonly type: string
      readonly offloaded?: true
      readonly attachment?: { readonly attachmentId: string }
    }[]
  }[],
  attachmentId: string,
): boolean[] {
  const flags: boolean[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.attachment?.attachmentId === attachmentId) {
        flags.push(block.offloaded === true)
      }
    }
  }
  return flags
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

  it('runs from a Loader-mounted fiber that does not inject the session store', async () => {
    const adapter = new VisionAdapter(stepsWithClose([click('m1'), click('m2'), click('m3')]))
    const { ctx, agent } = await harness(adapter, { imageWindow: 2, loaderMounted: true })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'three clicks')
    await idle

    // Reading the store as `ctx.sessions` here throws `cannot get property "sessions" without
    // inject`, which fails the step instead of recording anything.
    expect(imageTally(agent.session.deriveMessages())).toEqual({ retained: 2, offloaded: 2 })
  }, 30_000)

  it('never spends the window on an image the user supplied', async () => {
    const adapter = new VisionAdapter(stepsWithClose([click('u1'), click('u2')]))
    const { ctx, agent } = await harness(adapter, { imageWindow: 1 })
    const reference = await ctx.attachments.saveImage({
      data: FAKE_WINDOW_PNG,
      mediaType: 'image/png',
      name: 'user-reference',
    })
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [
        { type: 'text', text: 'match this reference' },
        { type: 'image', attachment: reference },
      ],
      source: { kind: 'user' },
    }))
    await idle

    // The user's picture survives while the notice and the older screenshot are evicted.
    const last = adapter.requests[adapter.requests.length - 1]
    expect(attachmentFlags(last?.messages ?? [], reference.attachmentId)).toEqual([false])
    expect(imageTally(last?.messages ?? [])).toEqual({ retained: 2, offloaded: 2 })
  }, 30_000)

  it('records its decisions when a turn is aborted before the next request', async () => {
    const adapter = new VisionAdapter(stepsWithClose([
      click('c1'),
      multiCall([
        { id: 'click-a', name: 'click', args: { screen_index: 0, position: [100, 100] } },
        { id: 'click-b', name: 'click', args: { screen_index: 0, position: [200, 200] } },
      ]),
    ]))
    const { ctx, agent } = await harness(adapter, { imageWindow: 2 })
    let cancelled = false
    // The human stops the run right after the step's second screenshot commits. No later pre-step
    // arrives, so only the settle-time pass can close the step and trim the window.
    ctx.on('session/event', (session, event) => {
      if (cancelled || session !== agent.session) return
      if (event.type !== 'tool/result') return
      if (event.data.message.toolCallId !== ToolCallId('click-b')) return
      cancelled = true
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'click twice then stop')
    await idle

    const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason.kind)).toEqual(['aborted'])
    expect(offloadSelections(agent.session)).toHaveLength(2)
    expect(imageTally(agent.session.deriveMessages())).toEqual({ retained: 2, offloaded: 2 })
  }, 30_000)

  it('restores the same request projection from the log', async () => {
    const adapter = new VisionAdapter(stepsWithClose([click('r1'), click('r2'), click('r3')]))
    const { ctx, agent } = await harness(adapter, { imageWindow: 2 })
    const idle = waitForIdle(ctx, agent)
    send(agent, 'three clicks')
    await idle

    const live = imageTally(agent.session.deriveMessages())
    expect(live).toEqual({ retained: 2, offloaded: 2 })
    const seed = agent.session.snapshotEvents()
    const restored = Session.fromRestore(
      SessionId(String(agent.session.id)),
      seed,
      agent.session.header,
      SessionLogOffset(0),
      'shared-frozen',
      [imageOffloadProjection],
    )
    expect(imageTally(restored.deriveMessages())).toEqual(live)

    // Without its interpreter the log cannot be derived at all — the reason the policy refuses to
    // record a decision when the projection is not registered.
    expect(() => Session.fromRestore(
      SessionId(String(agent.session.id)),
      seed,
      agent.session.header,
      SessionLogOffset(0),
      'shared-frozen',
    )).toThrow(/requires a message projection/u)
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

describe('computer-use screen ownership', () => {
  it('claims exactly the GUI tools the plugin registers', async () => {
    const { ctx } = await harness(new VisionAdapter([]))
    const registered = ctx.tools.schemas().map(schema => schema.name).sort()
    expect(registered).toEqual([...SCREEN_IMAGE_TOOLS].sort())
  }, 30_000)
})
