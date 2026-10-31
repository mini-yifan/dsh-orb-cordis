/**
 * Lasso selections waiting for an instruction, and the capture each confirm-frame
 * button asks for. The helper owns the overlay; this module owns the durable image,
 * the clipboard copy, and the seed the next Computer Use turn consumes.
 */

import { randomUUID } from 'node:crypto'

export interface LassoRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LassoDisplay extends LassoRect {
  readonly scale: number
}

export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

export interface LassoCaptureScreen {
  readonly bounds: LassoRect
  readonly scale: number
  readonly windowId?: number
  readonly transientWindowIds?: readonly number[]
  readonly appName?: string
}

export interface LassoCaptureForeground {
  readonly appName: string
  readonly windowTitle?: string
  readonly finderFolder?: string
  readonly focusNote?: string
}

export interface LassoCaptureResult {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly screen: LassoCaptureScreen
  readonly foreground: LassoCaptureForeground
  readonly bounds: LassoRect
}

export interface LassoCaptureServiceLike {
  capture(input: {
    readonly mode: 'highlight' | 'crop'
    readonly rect: LassoRect
    readonly physicalRect?: LassoRect
    readonly display: LassoDisplay
    readonly physicalDisplay?: LassoDisplay
    readonly copyToClipboard?: boolean
    readonly signal?: AbortSignal
  }): Promise<LassoCaptureResult>
}

export interface AttachmentStoreLike {
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<ImageRef>
}

export interface LassoSeedStoreLike {
  set(sessionId: string, seed: {
    readonly screen: LassoCaptureScreen
    readonly foreground: LassoCaptureForeground
    readonly image: ImageRef
  }): void
  clear(sessionId?: string): void
}

export interface PendingLasso {
  readonly id: string
  readonly sessionId: string | undefined
  readonly image: ImageRef
  readonly screen: LassoCaptureScreen
  readonly foreground: LassoCaptureForeground
  readonly size: { readonly width: number; readonly height: number }
  readonly at: number
}

export interface LassoAction {
  readonly action: 'send' | 'translate' | 'copy'
  readonly rect: LassoRect
  readonly physicalRect?: LassoRect
  readonly display: LassoDisplay
  readonly physicalDisplay?: LassoDisplay
}

export interface LassoDeps {
  readonly capture: () => LassoCaptureServiceLike | undefined
  readonly attachments: () => AttachmentStoreLike | undefined
  readonly seed: () => LassoSeedStoreLike | undefined
  readonly broadcast: (message: unknown) => void
  readonly status: (text: string) => void
  readonly currentSessionId: () => string | undefined
  readonly translate: (image: ImageRef) => void
  readonly now?: () => number
}

const PENDING_TTL_MS = 10 * 60_000
const MAX_PENDING = 8

export class LassoController {
  private readonly pending = new Map<string, PendingLasso>()
  private readonly now: () => number

  constructor(private readonly deps: LassoDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Handle one button press from the confirm frame. */
  async action(input: LassoAction): Promise<void> {
    const capture = this.deps.capture()
    const attachments = this.deps.attachments()
    if (capture === undefined || attachments === undefined) {
      console.error(`dsh-orb: lasso ${input.action} unavailable: ${capture === undefined ? 'capture' : 'attachments'} service is missing`)
      this.result(input.action, false, '截图服务不可用')
      return
    }
    try {
      if (input.action === 'copy') {
        await capture.capture({
          mode: 'crop',
          rect: input.rect,
          physicalRect: input.physicalRect,
          display: input.display,
          physicalDisplay: input.physicalDisplay,
          copyToClipboard: true,
        })
        this.result('copy', true)
        return
      }
      if (input.action === 'translate') {
        const crop = await capture.capture({
          mode: 'crop',
          rect: input.rect,
          physicalRect: input.physicalRect,
          display: input.display,
          physicalDisplay: input.physicalDisplay,
        })
        const image = await attachments.saveImage({
          data: crop.data,
          mediaType: crop.mediaType,
          name: 'lasso-crop',
        })
        this.result('translate', true)
        this.deps.translate(image)
        return
      }
      const shot = await capture.capture({
        mode: 'highlight',
        rect: input.rect,
        physicalRect: input.physicalRect,
        display: input.display,
        physicalDisplay: input.physicalDisplay,
      })
      const image = await attachments.saveImage({
        data: shot.data,
        mediaType: shot.mediaType,
        name: 'lasso-screen',
      })
      const id = randomUUID()
      this.prune()
      this.pending.set(id, {
        id,
        sessionId: this.deps.currentSessionId(),
        image,
        screen: shot.screen,
        foreground: shot.foreground,
        size: { width: Math.round(input.rect.width), height: Math.round(input.rect.height) },
        at: this.now(),
      })
      while (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next().value
        if (typeof oldest !== 'string') break
        this.pending.delete(oldest)
      }
      this.deps.broadcast({
        type: 'lasso-attach',
        selectionId: id,
        image,
        size: { width: Math.round(input.rect.width), height: Math.round(input.rect.height) },
      })
      this.result('send', true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-orb: lasso ${input.action} failed: ${message}`)
      this.result(input.action, false, lassoErrorMessage(error))
    }
  }

  /** The chip was removed before sending: drop the image and any queued seed. */
  dismiss(id: string): void {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    if (pending?.sessionId !== undefined) {
      this.deps.seed()?.clear(pending.sessionId)
    }
  }

  /**
   * Arm the first-frame seed for the prompt carrying this selection.
   * @returns true when the prompt should use the lasso screenshot instead of a live capture.
   */
  takeForPrompt(id: string, sessionId: string): boolean {
    const pending = this.pending.get(id)
    if (pending === undefined) return false
    this.pending.delete(id)
    if (this.now() - pending.at > PENDING_TTL_MS) return false
    if (pending.sessionId !== undefined && pending.sessionId !== sessionId) return false
    const seed = this.deps.seed()
    if (seed === undefined) return false
    seed.set(sessionId, {
      screen: pending.screen,
      foreground: pending.foreground,
      image: pending.image,
    })
    return true
  }

  /** A transcript reset, a new session, or a switch drops a chip that no longer belongs. */
  clearSession(sessionId?: string): void {
    if (sessionId === undefined) {
      this.pending.clear()
      this.deps.seed()?.clear()
      return
    }
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === undefined || pending.sessionId === sessionId) this.pending.delete(id)
    }
    this.deps.seed()?.clear(sessionId)
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  private result(action: LassoAction['action'], ok: boolean, message?: string): void {
    this.deps.broadcast({
      type: 'lasso-result',
      action,
      ok,
      ...message === undefined ? {} : { message },
    })
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [id, pending] of this.pending) {
      if (pending.at < cutoff) this.pending.delete(id)
    }
  }
}

function lassoErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/screen recording|Screen Recording|permission/i.test(message)) {
    return '需要「屏幕录制」权限，请在系统设置中授权后重试'
  }
  return message === '' ? '截图失败，请重试' : message
}

/** Validate one helper action without trusting its shape. */
export function readLassoAction(value: unknown): LassoAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.action !== 'send' && record.action !== 'translate' && record.action !== 'copy') return undefined
  const rect = readRect(record.rect)
  const display = readDisplay(record.display)
  if (rect === undefined || display === undefined) return undefined
  const physicalRect = readRect(record.physicalRect)
  const physicalDisplay = readDisplay(record.physicalDisplay)
  return {
    action: record.action,
    rect,
    display,
    ...physicalRect === undefined ? {} : { physicalRect },
    ...physicalDisplay === undefined ? {} : { physicalDisplay },
  }
}

function readRect(value: unknown): LassoRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const numbers = [record.x, record.y, record.width, record.height]
  if (!numbers.every((field) => typeof field === 'number' && Number.isFinite(field))) return undefined
  if ((record.width as number) < 1 || (record.height as number) < 1) return undefined
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  }
}

function readDisplay(value: unknown): LassoDisplay | undefined {
  const rect = readRect(value)
  if (rect === undefined) return undefined
  const scale = (value as Record<string, unknown>).scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return undefined
  return { ...rect, scale }
}
