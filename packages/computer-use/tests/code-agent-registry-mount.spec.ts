import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { BALL_PRESET, screenOwnerState, setScreenOwner } from '../src/screen-owner.ts'
import * as Registry from '../src/code-agent-registry.ts'

/**
 * Mounting the registry row the way `cordis.patch.yml` does.
 *
 * The unit test next to the registry calls `apply` on a hand-written fake context, which cannot see
 * cordis's own rule that a service is unreadable from a context that did not inject it. That blind
 * spot shipped a real regression: touching `ctx.tools` here threw, the plugin never provided the
 * registry, and the bookmark strip beside the ball silently emptied. These tests mount the real
 * plugin in a real context so the seam cannot be lost again.
 */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  screenOwnerState().ownerId = ''
  screenOwnerState().ballSessions = undefined
})

function trivial(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    execute: () => Promise.resolve({}),
  })
}

async function appContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function modelText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

describe('registry row mounting', () => {
  it('provides the registry service in a real context', async () => {
    const ctx = await appContext()
    await ctx.plugin(Registry)
    expect(ctx.get(Registry.CODE_AGENT_REGISTRY)).toBe(Registry.sharedCodeAgentRegistry())
  })

  it('mounts before the tools runtime exists instead of throwing', async () => {
    // The patch lists this row above nothing in particular; the inject declaration is what lets the
    // framework hold the row until the service it reads is there.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Registry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(ctx.get(Registry.CODE_AGENT_REGISTRY)).toBe(Registry.sharedCodeAgentRegistry())
  })

  it('leaves the bookmark registry working even when the guard cannot install', async () => {
    // Belt and braces: providing the registry must never depend on the guard.
    const ctx = await appContext()
    const broken = Object.create(ctx) as Context
    Object.defineProperty(broken, 'tools', {
      get() { throw new Error('tools exploded') },
    })
    Registry.apply(broken)
    expect(ctx.get(Registry.CODE_AGENT_REGISTRY)).toBe(Registry.sharedCodeAgentRegistry())
  })

  it('installs the ownership guard the preset tools actually hit', async () => {
    const ctx = await appContext()
    await ctx.plugin(Registry)
    ctx.tools.register(trivial('click'))
    const call = (sessionId: string, agentPreset: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: `mount-${sessionId}-${agentPreset}` as never,
      name: 'click',
      arguments: {},
      agent: { id: sessionId, session: { header: { agentPreset } } } as never,
    })
    // No owner: everything runs.
    expect(modelText(await call('session-b', BALL_PRESET))).not.toContain('Only the conversation')
    setScreenOwner('session-a')
    // A background ball conversation is refused.
    expect(modelText(await call('session-b', BALL_PRESET)))
      .toContain('Only the conversation the floating ball currently shows')
    // The ball conversation on screen is not.
    expect(modelText(await call('session-a', BALL_PRESET))).not.toContain('Only the conversation')
    // And nothing outside the ball is touched — the door this guard once closed by mistake.
    expect(modelText(await call('main-window-chat', 'standard'))).not.toContain('Only the conversation')
    expect(modelText(await call('delegated-code', 'standard'))).not.toContain('Only the conversation')
  })
})
