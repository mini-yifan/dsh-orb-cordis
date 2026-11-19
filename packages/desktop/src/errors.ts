/**
 * Failure text the model can act on.
 *
 * A background agent reads errors as instructions, not apologies: every message
 * names the one next step that is consistent with the product rules.
 * @module @dsh-orb/desktop/src/errors
 */

import type { Denial } from './guard.ts'
import type { HostError } from './protocol.ts'

interface Guidance {
  readonly next: string
}

const GUIDANCE: Record<string, Guidance> = {
  STALE_REF: {
    next: 'The interface changed and that ref is dead. Take a new desktop_inspect of the window and use a new ref.',
  },
  SNAPSHOT_NOT_FOUND: {
    // Not always age: a ref read through one storage namespace cannot be used by
    // another, and calling that "expired" sends the model into a retry loop that
    // looks like a race. Name both causes so the model stops guessing.
    next: 'That snapshot cannot be found from this session. Either it is old, or it was taken through a '
      + 'different snapshot namespace than the one acting on it. Take a fresh desktop_inspect of the window you '
      + 'are acting on and use a ref from that result.',
  },
  AMBIGUOUS_TARGET: {
    // On Windows every repeated control in a window has no ref path at all: a ref
    // only resolves when it was the only element with that role and name, so the
    // point-based tools are the only way to pick one of several identical rows.
    next: 'More than one element matches and the library will not guess. Address a control that is unique,'
      + ' work on a different part of the window, or — when the control repeats (identical rows or buttons, '
      + 'common on Windows) — use desktop_see and click the point instead.',
  },
  WINDOW_NOT_FOUND: {
    next: 'The app is running but shows no window you can read. Use desktop_open_app to bring it up,'
      + ' or report back.',
  },
  APP_NOT_FOUND: {
    next: 'No such app. Use desktop_open_app with the name the user gave you.',
  },
  APP_UNRESPONSIVE: {
    next: 'The app is not answering. Wait briefly once, then stop and report that it is unresponsive.',
  },
  ACTION_NOT_SUPPORTED: {
    next: 'This control exposes no semantic action, so the accessibility route cannot reach it.'
      + ' Do not keep trying it: take desktop_see and use desktop_click on the point instead.',
  },
  ACTION_FAILED: {
    next: 'The action may have been delivered but could not be confirmed. Read the state again'
      + ' (a fresh desktop_inspect, or desktop_see) before deciding anything — never repeat it blindly.',
  },
  POLICY_DENIED: {
    next: 'This control exposes no semantic action and refusing to force it is deliberate.'
      + ' Use desktop_see and desktop_click on the point instead of repeating this call.',
  },
  PERM_DENIED: {
    next: 'The system denies desktop access. Stop and tell the foreground agent the user must enable'
      + ' Accessibility for this app in system settings.',
  },
  ELEMENT_NOT_FOUND: {
    next: 'That element is gone. Take a new snapshot.',
  },
  INVALID_ARGS: {
    next: 'The call was malformed. Fix the arguments; repeating it unchanged will fail the same way.',
  },
  PLATFORM_NOT_SUPPORTED: {
    next: 'This platform does not support that command.',
  },
  TIMEOUT: {
    next: 'The app did not answer in time. Retry once; if it times out again, report that it is stuck.',
  },
  INTERNAL: {
    next: 'Internal failure. Do not loop on it; report back what you were doing.',
  },
}

/**
 * Extract actionable diagnostic clues from `agent-desktop`'s `error.details`.
 *
 * Actionability timeouts and verification failures carry structured `kind`,
 * `checks[]` (e.g. `enabled`, `visible`, `occluded`), and `occluder` info;
 * surfacing them stops the model from guessing blindly on `TIMEOUT`.
 */
export function formatErrorDetails(details: unknown): string | undefined {
  if (details === null || typeof details !== 'object') return undefined
  const record = details as {
    kind?: unknown
    retryable?: unknown
    checks?: unknown
    last_report?: { checks?: unknown }
    occluder?: { role?: unknown; name?: unknown }
  }
  const parts: string[] = []
  if (typeof record.kind === 'string' && record.kind !== '') {
    parts.push(`kind=${record.kind}`)
  }
  const rawChecks = Array.isArray(record.checks)
    ? record.checks
    : Array.isArray(record.last_report?.checks)
      ? record.last_report.checks
      : []
  const failed: string[] = []
  for (const item of rawChecks) {
    if (item === null || typeof item !== 'object') continue
    const check = item as { check?: unknown; status?: unknown; reason?: unknown }
    if (check.status !== 'fail') continue
    const name = typeof check.check === 'string' ? check.check : 'check'
    const reason = typeof check.reason === 'string' && check.reason !== '' ? ` (${check.reason})` : ''
    failed.push(`${name}${reason}`)
  }
  if (failed.length > 0) parts.push(`failed checks: ${failed.join(', ')}`)
  if (record.occluder !== undefined && record.occluder !== null && typeof record.occluder === 'object') {
    const role = typeof record.occluder.role === 'string' ? record.occluder.role : 'element'
    const name = typeof record.occluder.name === 'string' && record.occluder.name !== ''
      ? ` "${record.occluder.name}"`
      : ''
    parts.push(`occluder=${role}${name}`)
  }
  if (record.retryable === false) parts.push('retryable=false')
  return parts.length > 0 ? parts.join('; ') : undefined
}

/**
 * Render one failure.
 * @param error - coded failure.
 * @returns two or three lines: what happened, diagnostic details if any, and what to do next.
 */
export function failureText(error: HostError): string {
  const guidance = GUIDANCE[error.code]
  const next = guidance?.next ?? error.suggestion ?? 'Report this to the foreground agent and stop.'
  const detailLine = formatErrorDetails(error.details)
  const retrySafe = error.delivery === 'not_delivered' || error.retry === 'safe'
  const retryNote = retrySafe ? '' : '\nnote: this action may already have landed; never repeat it blindly.'
  return `${error.code}: ${error.message}`
    + `${detailLine === undefined ? '' : `\ndetails: ${detailLine}`}`
    + `\nnext: ${next}${retryNote}`
}

/**
 * Render a refusal produced by the ownership guard.
 * @param denial - the guard's decision.
 * @returns the model-facing text.
 */
export function denialText(denial: Denial): string {
  const suggestion = denial.suggestion === undefined ? '' : `\nnext: ${denial.suggestion}`
  return `${denial.code}: ${denial.message}${suggestion}`
}

/**
 * Render the library's action result.
 * @param data - the action envelope payload.
 * @returns one short status line.
 */
export function actionText(data: unknown): string {
  const payload = (data ?? {}) as {
    action?: string
    ref_id?: string
    disposition?: { delivery?: string; retry?: string }
    steps?: readonly { label?: string; outcome?: string }[]
  }
  const parts = [`ok`]
  if (payload.action !== undefined) parts.push(payload.action)
  if (payload.ref_id !== undefined) parts.push(payload.ref_id)
  const delivery = payload.disposition?.delivery
  if (delivery !== undefined) parts.push(`delivery=${delivery}`)
  const retry = payload.disposition?.retry
  if (retry !== undefined && retry !== 'unknown') parts.push(`retry=${retry}`)
  const lines = [parts.join(' · ')]
  const steps = payload.steps ?? []
  if (steps.length > 0) {
    lines.push(steps.map(step => `  ${step.label ?? 'step'}: ${step.outcome ?? ''}`).join('\n'))
  }
  if (delivery === 'not_delivered') {
    lines.push('note: nothing was sent; retrying once is safe.')
  } else if (delivery !== undefined && delivery !== 'delivered_verified') {
    lines.push('note: delivery is unverified. Read the state again before repeating this action.')
  }
  return lines.join('\n')
}