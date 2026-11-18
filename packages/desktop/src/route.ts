/**
 * Image-modality check for the desktop preset's visual fallback.
 *
 * Mirrors the Computer Use rule: a tool that hands the model a picture must
 * refuse to run on a model that does not declare image input, because the
 * fallback would otherwise return an attachment the route cannot read. The
 * service is read lazily so the preset still loads when `llm` is absent.
 * @module @dsh-orb/desktop/src/route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import type {} from '@deepseek-ai/dsh-llm'

interface ResolvedRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the calling agent's provider and model.
 * @param agent - calling agent, when any.
 * @returns the route, or undefined when it cannot be resolved.
 */
function resolveRoute(agent: Agent | undefined): ResolvedRoute | undefined {
  const routed = agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? agent?.options.provider
  const model = routed?.model ?? agent?.options.model
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}

/**
 * Refuse a picture-returning tool when the route does not accept images.
 *
 * Messages name the fix instead of the internal cause, because this text is all
 * the model sees: switching model is the only way forward.
 * @param ctx - plugin context used to resolve the optional `llm` service.
 * @param exec - tool execution supplying the calling agent.
 * @throws when the route is unknown or lacks image input.
 */
export async function requireImageRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const route = resolveRoute(exec.agent)
  const llm = ctx.get('llm')
  if (route === undefined || llm === undefined) {
    throw new Error(
      'desktop_see needs a model route that can read images, and the current route could not be resolved',
    )
  }
  const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `desktop_see needs a model that declares image input; "${route.model}" does not. `
      + 'Use desktop_snapshot instead, or switch to an image-capable model.',
    )
  }
}
