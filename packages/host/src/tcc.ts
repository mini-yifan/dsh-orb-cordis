/**
 * Screen Recording and Accessibility status for the process that actually calls screencapture and osascript.
 * The desktop host is the DeepSeek Harness executable. `dsh web` is the terminal's node process.
 */

import { spawn } from 'node:child_process'
import { requireKoffi } from './native-images.ts'

export type TccRight = 'screen' | 'accessibility'
export type TccState = 'missing' | 'granted' | 'needsRelaunch'

export interface TccStatus {
  readonly applicable: boolean
  readonly appName: string
  readonly screen: TccState
  readonly accessibility: TccState
}

const SETTINGS_URL = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const

interface Probe {
  screen(): boolean
  accessibility(): boolean
}

/** Remembers which panes were opened so a grant that needs a relaunch is visible. */
export class TccMonitor {
  private readonly opened = new Set<TccRight>()
  private probe: Probe | undefined
  private probeFailed = false

  status(): TccStatus {
    const appName = tccAppName()
    if (process.platform !== 'darwin') {
      return { applicable: false, appName, screen: 'granted', accessibility: 'granted' }
    }
    const probe = this.loadProbe()
    return {
      applicable: true,
      appName,
      screen: this.right('screen', probe?.screen() ?? false),
      accessibility: this.right('accessibility', probe?.accessibility() ?? false),
    }
  }

  async open(right: TccRight): Promise<void> {
    if (process.platform !== 'darwin') return
    this.opened.add(right)
    await openExternal(SETTINGS_URL[right])
  }

  private right(right: TccRight, granted: boolean): TccState {
    if (granted) return 'granted'
    return this.opened.has(right) ? 'needsRelaunch' : 'missing'
  }

  private loadProbe(): Probe | undefined {
    if (this.probe) return this.probe
    if (this.probeFailed) return undefined
    try {
      this.probe = loadMacProbe()
      return this.probe
    } catch (error) {
      this.probeFailed = true
      console.error(`dsh-orb: TCC probe unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

export function isDesktopHost(): boolean {
  if (typeof process.env.DSH_DESKTOP_NODE_EXECUTABLE === 'string' && process.env.DSH_DESKTOP_NODE_EXECUTABLE !== '') {
    return true
  }
  return process.execPath.includes('DeepSeek Harness')
}

export function tccAppName(): string {
  if (isDesktopHost()) return 'DeepSeek Harness'
  const lang = `${process.env.LANG ?? ''}${process.env.LC_ALL ?? ''}`.toLowerCase()
  return lang.includes('zh') ? '终端' : 'Terminal'
}

export function isTccRight(value: unknown): value is TccRight {
  return value === 'screen' || value === 'accessibility'
}

function loadMacProbe(): Probe {
  const koffi = requireKoffi<{ load(path: string): { func(signature: string): () => boolean } }>(import.meta.url)
  const library = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
  const screen = library.func('bool CGPreflightScreenCaptureAccess()')
  const accessibility = library.func('bool AXIsProcessTrusted()')
  return {
    screen: () => screen() === true,
    accessibility: () => accessibility() === true,
  }
}

function openExternal(url: string): Promise<void> {
  const command = process.platform === 'win32' ? 'cmd' : 'open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`open exited ${code ?? 'unknown'}`))
    })
  })
}
