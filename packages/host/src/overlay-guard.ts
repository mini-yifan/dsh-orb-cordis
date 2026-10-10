/**
 * Computer Use overlay cloak.
 * Every capture runs inside an `overlay-capture` interval: the helper lifts the ball,
 * toolbar, and observation frame out of screen captures for the interval, so the agent
 * never sees its own chrome. HID bursts keep the `overlay-input` interval, which also
 * holds the protection across the post-action screenshot inside the burst.
 */

import { randomUUID } from 'node:crypto'

export const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1_000
export const OVERLAY_GUARD_INPUT_DRAIN_MS = 80
/** Milliseconds to let the helper's protection switch reach WindowServer/WDA before the capture reads the screen. */
export const OVERLAY_GUARD_CAPTURE_SETTLE_MS = 50

export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface OverlayGuardTransport {
  hasHelper(): boolean
  send(message: { id: string; type: string; [key: string]: unknown }, signal?: AbortSignal): Promise<void>
  setHidInput(active: boolean): void
  /**
   * Overlay window ids the capture must skip when it picks an observation window.
   * A Windows helper reports the ball, toolbar, and frame handles, so a click on the ball
   * cannot make it the window the agent believes the user is working in. A macOS helper
   * reports nothing: the ball there is a non-activating panel and never becomes foreground.
   */
  chromeWindowIds?(): readonly number[]
  /** The user's observation-ribbon preference; absent or true draws frames. */
  observationFrameEnabled?(): boolean
  sleep?(ms: number): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

export function createOverlayGuard(transport: OverlayGuardTransport) {
  let inputDepth = 0
  let captureDepth = 0
  /** True between the begin the helper counted and its matching end. */
  let captureOpen = false
  const sleep = transport.sleep ?? delay

  return {
    async withCapture<T>(
      run: (session: { excludeWindowIds: readonly number[] }) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      captureDepth += 1
      // Inside an input cloak the helper already protects every chrome window for the
      // whole burst, so a nested capture interval would only add round-trips and settle.
      const cloaked = captureDepth === 1 && inputDepth === 0 && transport.hasHelper()
      try {
        if (cloaked) {
          const begin = transport.send({ type: 'overlay-capture', id: randomUUID(), active: true }, signal)
          // The helper counts the capture as soon as the begin is written, and an abort or
          // an ack timeout rejects the await. Mark it before that await so the finally
          // still closes the interval; otherwise the ball would stay protected and vanish
          // from every later capture.
          captureOpen = true
          await begin
          await sleep(OVERLAY_GUARD_CAPTURE_SETTLE_MS)
        }
        // Inside an input interval the helper already cloaks every chrome window, so the
        // nested capture sends no IPC. It still needs the ids: the post-action screenshot
        // is taken while the ball may hold the foreground.
        return await run({ excludeWindowIds: transport.chromeWindowIds?.() ?? [] })
      } finally {
        captureDepth -= 1
        // The interval is owned by the depth, not by the call that opened it: overlapping
        // captures close only when the outermost one returns. The end never carries the
        // caller's signal, which may already be aborted, or it would be cancelled itself.
        if (captureDepth === 0 && captureOpen) {
          captureOpen = false
          try {
            await transport.send({ type: 'overlay-capture', id: randomUUID(), active: false })
          } catch {
            // Helper already gone; it quits on disconnect and restarts unprotected.
          }
        }
      }
    },

    async withInput<T>(run: () => Promise<T>): Promise<T> {
      inputDepth += 1
      const outer = inputDepth === 1
      const cloaked = outer && transport.hasHelper()
      try {
        if (outer) {
          transport.setHidInput(true)
          if (cloaked) await transport.send({ type: 'overlay-input', id: randomUUID(), active: true })
        }
        const value = await run()
        if (cloaked) await sleep(OVERLAY_GUARD_INPUT_DRAIN_MS)
        return value
      } finally {
        inputDepth -= 1
        if (inputDepth === 0) {
          try {
            if (cloaked) await transport.send({ type: 'overlay-input', id: randomUUID(), active: false })
          } finally {
            transport.setHidInput(false)
          }
        }
      }
    },

    async setObservationFrame(bounds: OverlayRect | null, signal?: AbortSignal): Promise<void> {
      if (!transport.hasHelper()) return
      // Switched off: a show request collapses to a hide, so a frame that is
      // already on screen goes away and no new one comes back.
      const wanted = bounds === null || transport.observationFrameEnabled?.() === false ? null : bounds
      if (wanted !== null && signal?.aborted) {
        await transport.send({ type: 'observation-frame', id: randomUUID(), bounds: null })
        return
      }
      try {
        await transport.send({ type: 'observation-frame', id: randomUUID(), bounds: wanted }, signal)
      } catch (error) {
        if (wanted !== null && signal?.aborted) {
          await transport.send({ type: 'observation-frame', id: randomUUID(), bounds: null })
          return
        }
        throw error
      }
    },
  }
}
