/**
 * Bounded screenshot history for Computer Use sessions: a retained-image
 * window plus last-image-per-step retention, both recorded as durable
 * `image/offload` decisions on the session log.
 *
 * The offload projection — owned by `@deepseek-ai/dsh-compaction-image-offload`
 * and registered by the shipped base — turns each selected occurrence into
 * deterministic placeholder text for every later request, while the session
 * log, the UI, and replay keep the original image blocks. This module only
 * decides *which* occurrences to select; it never replaces the upstream
 * error-driven offload path, which stays as the backstop.
 *
 * Occurrences are enumerated through `surface.nodes` + `eventAt` +
 * `deriveEventMessage`, the same walk the shipped offload plugin uses; there is
 * no non-deprecated per-node read on Session yet, and one policy run per step
 * boundary keeps the walk bounded.
 *
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/image-history
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ImageOffloadTarget } from '@deepseek-ai/dsh-compaction-image-offload/projection'

/** One input-image occurrence in model-request order. */
interface ImageSlot {
  /** Message-producing surface event holding this occurrence. */
  readonly seq: SessionSeq
  /** Zero-based depth-first image index inside that message. */
  readonly imageIndex: number
  /** Whether a durable offload decision already omits this occurrence. */
  readonly offloaded: boolean
}

/** Resolved tunables for {@link applyImageHistoryPolicy}. */
export interface ImageHistoryPolicy {
  /** Retained input-image occurrences; older ones are offloaded oldest-first. */
  readonly window: number
  /** Whether one step keeps only its last image-bearing GUI result. */
  readonly keepLastStepScreenshot: boolean
}

/**
 * GUI call ids recorded since the last policy run, per session. A step's tool
 * results are recognized by call id because the derived tool message carries
 * the provider-issued `toolCallId`. A restored session starts with an empty
 * set and simply resumes recording from its next step.
 */
const stepGuiCalls = new WeakMap<Session, Set<ToolCallId>>()

/**
 * Remember one GUI tool call so its result reads as this session's own
 * screenshot when the policy next runs.
 * @param session - session that ran the call; omitted on stubs without identity.
 * @param callId - provider-issued call id of the GUI call.
 */
export function rememberGuiCall(session: Session | undefined, callId: ToolCallId | undefined): void {
  if (session === undefined || callId === undefined) return
  let calls = stepGuiCalls.get(session)
  if (calls === undefined) {
    calls = new Set()
    stepGuiCalls.set(session, calls)
  }
  calls.add(callId)
}

/**
 * Whether one event is an input-side message node that may carry images.
 * @param event - candidate session event.
 * @returns true for user messages and tool results.
 */
function isInputEvent(event: SessionEvent): event is SessionEvent<'user/message' | 'tool/result'> {
  return event.type === 'user/message' || event.type === 'tool/result'
}

/**
 * Input-image occurrences of one session in model-request order.
 * @param session - session whose current surface is enumerated.
 * @returns occurrences in request order, each flagged when already offloaded.
 */
function inputImageSlots(session: Session): ImageSlot[] {
  const slots: ImageSlot[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || !isInputEvent(event)) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type === 'image') {
        slots.push({ seq, imageIndex, offloaded: block.offloaded === true })
        imageIndex += 1
      }
    }
  }
  return slots
}

/**
 * Record one durable offload decision selecting the given occurrences.
 * @param session - session that receives the decision.
 * @param selected - occurrences in request order; each must still be retained.
 */
function appendOffload(session: Session, selected: readonly ImageSlot[]): void {
  if (selected.length === 0) return
  const targets: ImageOffloadTarget[] = []
  for (const slot of selected) {
    const last = targets[targets.length - 1]
    if (last !== undefined && last.seq === slot.seq) last.imageIndexes.push(slot.imageIndex)
    else targets.push({ seq: slot.seq, imageIndexes: [slot.imageIndex] })
  }
  session.append('image/offload', { targets })
}

/**
 * Offload the oldest retained images beyond the window.
 * @param session - session whose retained occurrences are trimmed.
 * @param window - retained-image ceiling; at or below it nothing changes.
 */
function evictBeyondWindow(session: Session, window: number): void {
  const retained = inputImageSlots(session).filter(slot => !slot.offloaded)
  if (retained.length <= window) return
  appendOffload(session, retained.slice(0, retained.length - window))
}

/**
 * Surface sequences of one session's trailing GUI tool results — the results
 * committed since the last assistant message, in request order. A trailing run
 * always belongs to one assistant step, so sibling results need no other
 * boundary marker.
 * @param session - session whose surface tail is walked.
 * @param calls - recorded GUI call ids of the current step.
 * @returns trailing GUI result sequences, oldest first.
 */
function trailingGuiResultSeqs(session: Session, calls: ReadonlySet<ToolCallId>): SessionSeq[] {
  const nodes = session.surface.nodes
  const seqs: SessionSeq[] = []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'tool/result') break
    if (calls.has(event.data.message.toolCallId)) seqs.unshift(seq)
  }
  return seqs
}

/**
 * Offload one step's earlier GUI screenshots, keeping the last image-bearing
 * result of that step. Idempotent: already-offloaded occurrences are skipped.
 * @param session - session whose current step is trimmed.
 */
function dropIntermediateStepImages(session: Session): void {
  const calls = stepGuiCalls.get(session)
  if (calls === undefined) return
  stepGuiCalls.delete(session)
  if (calls.size === 0) return
  const stepSeqs = trailingGuiResultSeqs(session, calls)
  const stepSeqSet = new Set(stepSeqs)
  const slots = inputImageSlots(session).filter(slot => stepSeqSet.has(slot.seq))
  const seqsWithImages = new Set(slots.map(slot => slot.seq))
  if (seqsWithImages.size === 0) return
  const lastWithImages = stepSeqs.filter(seq => seqsWithImages.has(seq)).pop()
  appendOffload(session, slots.filter(slot => !slot.offloaded && slot.seq !== lastWithImages))
}

/**
 * Apply the bounded-history policy to one session: first drop the step's
 * intermediate screenshots, then trim the retained window from the oldest
 * image. Runs once per step boundary and at turn end; repeated runs select
 * nothing new.
 * @param session - session to bound; omitted sessions are ignored.
 * @param policy - resolved window and per-step retention tunables.
 */
export function applyImageHistoryPolicy(session: Session | undefined, policy: ImageHistoryPolicy): void {
  if (session === undefined) return
  if (policy.keepLastStepScreenshot) dropIntermediateStepImages(session)
  evictBeyondWindow(session, policy.window)
}

/**
 * Whether one plugin context can record offload decisions at all: the
 * projection that interprets `image/offload` must be registered on the session
 * store, because a log carrying the event without its interpreter cannot be
 * derived or restored. Deployments without the offload plugin skip the policy
 * instead of writing unreadable events.
 * @param ctx - plugin context whose session store is inspected.
 * @returns true when the offload projection is registered.
 */
export function imageOffloadReady(ctx: Context): boolean {
  return ctx.sessions?.messageProjections.some(projection => projection.type === 'image/offload') === true
}
