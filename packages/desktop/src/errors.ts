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
    next: 'The interface changed and that ref is dead. Take a new snapshot of the app and use a new ref.',
  },
  SNAPSHOT_NOT_FOUND: {
    next: 'That snapshot expired. Take a new one.',
  },
  AMBIGUOUS_TARGET: {
    next: 'More than one element matches and the library will not guess. Address a control that is unique,'
      + ' or work on a different part of the window.',
  },
  WINDOW_NOT_FOUND: {
    next: 'The app is running but shows no window you can read. Wait for it to open one'
      + ' (desktop_wait with a window title), or report back.',
  },
  APP_NOT_FOUND: {
    next: 'No such app. Use desktop_apps to read the exact running name.',
  },
  APP_UNRESPONSIVE: {
    next: 'The app is not answering. Wait briefly once, then stop and report that it is unresponsive.',
  },
  ACTION_NOT_SUPPORTED: {
    next: 'This control exposes no semantic action, so headless control cannot reach it.'
      + ' Do not use physical input. Try another route, or stop and report back to the foreground agent.',
  },
  ACTION_FAILED: {
    next: 'The action may have been delivered but could not be confirmed. Read the state again'
      + ' (a fresh snapshot or desktop_wait) before deciding anything — never repeat it blindly.',
  },
  POLICY_DENIED: {
    next: 'This control exposes no semantic action and physical delivery was refused.'
      + ' When the window is in front the tool retries with physical input automatically; if it still fails,'
      + ' the control is disabled or unreachable. Read the state again — do not repeat the same action.',
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
 * Render one failure.
 * @param error - coded failure.
 * @returns two lines: what happened, and what to do next.
 */
export function failureText(error: HostError): string {
  const guidance = GUIDANCE[error.code]
  const next = guidance?.next ?? error.suggestion ?? 'Report this to the foreground agent and stop.'
  const retrySafe = error.delivery === 'not_delivered' || error.retry === 'safe'
  const retryNote = retrySafe ? '' : '\nnote: this action may already have landed; never repeat it blindly.'
  return `${error.code}: ${error.message}\nnext: ${next}${retryNote}`
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