/**
 * Lasso capture and first-frame seeding.
 *
 * Capture runs in the Host so the screen-recording permission stays on the process
 * that already owns it. The confirm overlay is deliberately not cloaked: its dim is
 * the highlight, and the page hides its border, handles, and buttons before asking
 * for the pixels.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapturedScreen, DesktopBackend, DesktopForeground, ScreenInfo } from './backend.ts'
import { FOCUS_FALLBACK_FOREGROUND } from './backend.ts'
import { runWithCaptureExcludeWindowIds } from './capture-exclude.ts'
import type { ComputerUseOverlayGuard } from './overlay-guard.ts'
import type { CoordinateMode } from './coordinate-mode.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Lasso capture service; Desktop Host installs it on the orb composition. */
    computerUseLassoCapture?: LassoCaptureService
    /** First-frame slot the orb host fills before submitting a lasso prompt. */
    computerUseLassoSeed?: LassoSeedStore
  }
}

export interface LassoRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LassoDisplay extends LassoRect {
  readonly scale: number
}

export interface LassoCaptureInput {
  /** `highlight` captures the frontmost window with the dim baked in; `crop` captures the rect itself. */
  readonly mode: 'highlight' | 'crop'
  /** Selection in DIP (the helper's screen space). */
  readonly rect: LassoRect
  /** Selection in physical pixels; Windows uses it, macOS ignores it. */
  readonly physicalRect?: LassoRect
  /** Display in DIP. */
  readonly display: LassoDisplay
  /** Display in physical pixels; Windows uses it, macOS ignores it. */
  readonly physicalDisplay?: LassoDisplay
  /** Write the captured image to the system clipboard before returning. */
  readonly copyToClipboard?: boolean
  readonly signal?: AbortSignal
}

export interface LassoCaptureResult {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly screen: ScreenInfo
  readonly foreground: DesktopForeground
  /** Captured bounds in the backend's coordinate space. */
  readonly bounds: LassoRect
}

export interface LassoCaptureService {
  capture(input: LassoCaptureInput): Promise<LassoCaptureResult>
}

/** One image already saved through the attachment service, plus its screen envelope. */
export interface LassoSeed {
  readonly screen: ScreenInfo
  readonly foreground: DesktopForeground
  readonly image: ImageAttachmentRef
}

export interface LassoSeedStore {
  set(sessionId: string, seed: LassoSeed): void
  peek(sessionId: string): LassoSeed | undefined
  take(sessionId: string): LassoSeed | undefined
  clear(sessionId?: string): void
}

const SEED_TTL_MS = 120_000

/**
 * Create the pending first-frame slot. The Host sets one just before submitting the
 * lasso prompt; the next pre-step for that session consumes it exactly once.
 */
export function createLassoSeedStore(now: () => number = Date.now): LassoSeedStore {
  const seeds = new Map<string, { seed: LassoSeed; at: number }>()
  const fresh = (entry: { seed: LassoSeed; at: number } | undefined): entry is { seed: LassoSeed; at: number } => {
    if (entry === undefined) return false
    if (now() - entry.at <= SEED_TTL_MS) return true
    return false
  }
  return {
    set(sessionId, seed) {
      seeds.set(sessionId, { seed, at: now() })
    },
    peek(sessionId) {
      const entry = seeds.get(sessionId)
      if (!fresh(entry)) {
        seeds.delete(sessionId)
        return undefined
      }
      return entry.seed
    },
    take(sessionId) {
      const entry = seeds.get(sessionId)
      seeds.delete(sessionId)
      return fresh(entry) ? entry.seed : undefined
    },
    clear(sessionId) {
      if (sessionId === undefined) seeds.clear()
      else seeds.delete(sessionId)
    },
  }
}

/** First-frame copy for a lasso turn; names the bright region the user selected. */
export function lassoFirstFrameNotice(mode: CoordinateMode): string {
  if (mode === 'pixel') {
    return 'The user circled the bright region in this screenshot. Coordinates are pixel columns and rows of this image ([0, 0] top-left). Use attached_size on the observation envelope.'
  }
  return 'The user circled the bright region in this screenshot. Coordinates are 0–1000 fractions of this image ([0, 0] top-left, [1000, 1000] bottom-right). Center x is 500, not a pixel x.'
}

/**
 * Install the lasso capture service.
 * @param ctx - plugin context; the overlay guard is read at call time.
 * @param backend - the unwrapped platform backend, so listing does not show the observation frame.
 */
export function installLassoCapture(ctx: Context, backend: DesktopBackend): LassoCaptureService {
  const service: LassoCaptureService = {
    capture(input) {
      const guard = ctx.get('computerUseOverlayGuard') as ComputerUseOverlayGuard | undefined
      const run = async (excludeWindowIds: readonly number[]): Promise<LassoCaptureResult> =>
        runWithCaptureExcludeWindowIds(excludeWindowIds, async () => {
          const windows = process.platform === 'win32'
          const rect = windows ? input.physicalRect ?? scaleRect(input.rect, input.display.scale) : input.rect
          const display = windows
            ? input.physicalDisplay ?? { ...scaleRect(input.display, input.display.scale), scale: input.display.scale }
            : input.display
          signalAbort(input.signal)
          if (input.mode === 'crop') {
            const screen: ScreenInfo = { index: 0, bounds: rect, scale: display.scale }
            const captured = await backend.capture(screen, input.signal, { cursor: false })
            if (input.copyToClipboard === true) await copyImage(backend, captured, input.signal)
            return { ...captured, screen, foreground: FOCUS_FALLBACK_FOREGROUND, bounds: rect }
          }
          let listed: readonly ScreenInfo[] = []
          try {
            listed = await backend.listScreens(input.signal)
          } catch (error) {
            if (input.signal?.aborted) throw error
          }
          let foreground = FOCUS_FALLBACK_FOREGROUND
          try {
            foreground = await backend.inspectForeground(input.signal)
          } catch (error) {
            if (input.signal?.aborted) throw error
          }
          const found = listed[0]
          const intersects = found !== undefined && overlaps(found.bounds, display)
          const target = intersects
            ? clampRect(unionRect(found.bounds, rect), display)
            : clampRect(display, display)
          const screen: ScreenInfo = intersects && found !== undefined
            ? {
                index: 0,
                bounds: target,
                scale: found.scale,
                ...found.windowId === undefined ? {} : { windowId: found.windowId },
                ...found.transientWindowIds === undefined ? {} : { transientWindowIds: [...found.transientWindowIds] },
                ...found.appName === undefined ? {} : { appName: found.appName },
              }
            : { index: 0, bounds: target, scale: display.scale }
          const captured = await backend.capture(screen, input.signal, { cursor: false })
          return { ...captured, screen, foreground, bounds: target }
        })
      if (guard === undefined) return run([])
      return guard.withCapture(session => run(session.excludeWindowIds), input.signal)
    },
  }
  return service
}

function signalAbort(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

async function copyImage(
  backend: DesktopBackend,
  captured: CapturedScreen,
  signal: AbortSignal | undefined,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lasso-copy-'))
  const extension = captured.mediaType === 'image/jpeg' ? 'jpg' : captured.mediaType === 'image/png' ? 'png' : 'img'
  const file = join(dir, `lasso.${extension}`)
  try {
    await writeFile(file, captured.data)
    await backend.copyImageToClipboard({ path: file, mediaType: captured.mediaType }, signal)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function scaleRect(rect: LassoRect, scale: number): LassoRect {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  }
}

function overlaps(left: LassoRect, right: LassoRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

function unionRect(left: LassoRect, right: LassoRect): LassoRect {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  const rightEdge = Math.max(left.x + left.width, right.x + right.width)
  const bottom = Math.max(left.y + left.height, right.y + right.height)
  return { x, y, width: Math.max(1, rightEdge - x), height: Math.max(1, bottom - y) }
}

function clampRect(rect: LassoRect, display: LassoRect): LassoRect {
  const width = Math.max(1, Math.min(rect.width, display.width))
  const height = Math.max(1, Math.min(rect.height, display.height))
  return {
    x: Math.min(Math.max(rect.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(rect.y, display.y), display.y + display.height - height),
    width,
    height,
  }
}
