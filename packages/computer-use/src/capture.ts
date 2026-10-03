/**
 * Screen capture on KDE Wayland.
 *
 * `spectacle` is KDE's own capture client and the only supported way to read
 * pixels under KWin; it takes a whole-desktop image, which is then cropped to
 * the observed rectangle. The compositor renders that image at a uniform
 * integer-scaled copy of the logical desktop, so the crop is a plain linear
 * mapping from logical coordinates.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/capture
 */

import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { KWinRect } from './kwin.ts'
import { desktopEnv } from './session.ts'

/** Raised when the desktop has no capture client installed. */
export const CAPTURE_UNAVAILABLE_MESSAGE =
  'computer-use: spectacle is not installed; screen capture on KDE Wayland requires it'

/** Raised when the captured image cannot be decoded into something croppable. */
export const CROP_UNAVAILABLE_MESSAGE =
  'computer-use: ImageMagick (magick or convert) is not installed; screen capture on KDE Wayland requires it'

/** Pixel size of an encoded image. */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** One capture request. */
export interface CaptureRequest {
  /** Logical rectangle to keep, in compositor coordinates. */
  readonly bounds: KWinRect
  /** Virtual desktop rectangle the capture covers, in compositor coordinates. */
  readonly desktop: KWinRect
  /** Destination file; the parent directory must exist. */
  readonly output: string
}

/**
 * Capture the whole desktop to a PNG.
 * @param output - destination file path.
 * @param signal - cooperative cancellation.
 */
export async function captureDesktop(output: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(output), { recursive: true })
  await run('spectacle', ['-b', '-n', '-f', '-p', '-o', output], signal)
}

/**
 * Capture the frontmost window to a PNG.
 * @param output - destination file path.
 * @param signal - cooperative cancellation.
 */
export async function captureActiveWindow(output: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(output), { recursive: true })
  await run('spectacle', ['-b', '-n', '-a', '-p', '-o', output], signal)
}

/**
 * Read an image's pixel size.
 * @param file - encoded PNG or JPEG.
 * @param signal - cooperative cancellation.
 * @returns the pixel dimensions.
 */
export async function imageSize(file: string, signal?: AbortSignal): Promise<ImageSize> {
  const { stdout } = await run('identify', ['-format', '%w %h', file], signal)
  const [rawWidth, rawHeight] = stdout.trim().split(/\s+/)
  const width = Number(rawWidth)
  const height = Number(rawHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) {
    throw new Error(`computer-use: could not read the size of ${file}`)
  }
  return { width, height }
}

/**
 * Capture the desktop and crop it to one logical rectangle.
 *
 * The crop is written over `request.output`, so the caller gets exactly the
 * pixels of the observed surface with no further work.
 * @param request - rectangle, desktop, and destination.
 * @param signal - cooperative cancellation.
 */
export async function captureRegion(request: CaptureRequest, signal?: AbortSignal): Promise<void> {
  const scratch = join(tmpdir(), `dsh-orb-capture-${process.pid}`)
  await mkdir(scratch, { recursive: true })
  const full = join(scratch, `${randomBytes(6).toString('hex')}.png`)
  try {
    await captureDesktop(full, signal)
    const size = await imageSize(full, signal)
    const scaleX = size.width / request.desktop.width
    const scaleY = size.height / request.desktop.height
    const geometry = cropGeometry(request.bounds, request.desktop, scaleX, scaleY, size)
    await mkdir(dirname(request.output), { recursive: true })
    await run('magick', [full, '-crop', geometry, '+repage', request.output], signal)
    const written = await stat(request.output).catch(() => undefined)
    if (written === undefined || written.size === 0) {
      throw new Error('computer-use: cropping the capture produced an empty image')
    }
  } finally {
    await rm(full, { force: true }).catch(() => undefined)
  }
}

/**
 * Crop geometry for one logical rectangle inside a captured desktop image.
 * @param bounds - logical rectangle to keep.
 * @param desktop - logical rectangle the image covers.
 * @param scaleX - image pixels per logical x unit.
 * @param scaleY - image pixels per logical y unit.
 * @param size - the captured image size, used to clamp the crop.
 * @returns an ImageMagick `WxH+X+Y` geometry string.
 */
export function cropGeometry(
  bounds: KWinRect,
  desktop: KWinRect,
  scaleX: number,
  scaleY: number,
  size: ImageSize,
): string {
  const x = Math.round((bounds.x - desktop.x) * scaleX)
  const y = Math.round((bounds.y - desktop.y) * scaleY)
  const width = Math.max(1, Math.round(bounds.width * scaleX))
  const height = Math.max(1, Math.round(bounds.height * scaleY))
  const left = Math.min(Math.max(x, 0), Math.max(0, size.width - 1))
  const top = Math.min(Math.max(y, 0), Math.max(0, size.height - 1))
  const right = Math.min(left + width, size.width)
  const bottom = Math.min(top + height, size.height)
  return `${Math.max(1, right - left)}x${Math.max(1, bottom - top)}+${left}+${top}`
}

/**
 * True when both capture and crop tools are on `PATH`.
 * @returns whether region capture can run.
 */
export async function captureAvailable(): Promise<boolean> {
  const [spectacle, magick] = await Promise.all([which('spectacle'), which('magick')])
  return spectacle && magick
}

async function which(command: string): Promise<boolean> {
  try {
    await run('which', [command])
    return true
  } catch {
    return false
  }
}

function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: desktopEnv() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout })
          return
        }
        const detail = stderr.trim() === '' ? error.message : stderr.trim()
        const wrapped = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(command === 'spectacle' ? CAPTURE_UNAVAILABLE_MESSAGE : CROP_UNAVAILABLE_MESSAGE)
          : new Error(`computer-use: ${command} failed: ${detail}`)
        if (signal?.aborted === true) {
          reject(new Error('computer-use: capture aborted'))
          return
        }
        reject(wrapped)
      },
    )
  })
}
