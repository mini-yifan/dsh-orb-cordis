/**
 * Selection monitor lifecycle, three-second dedupe, and the search / translate / send actions.
 * The helper draws the toolbar. This module never opens a window.
 */

import { spawn } from 'node:child_process'
import {
  accessibilityTrusted,
  promptAccessibility,
  startSelectionMonitor,
  type SelectionHelperEvent,
} from '@dsh-orb/native-selection'

export const SELECTION_DEDUPE_MS = 3_000
export const SELECTION_RESTORE_FRONT_MS = 80
export const SELECTION_ACCESSIBILITY_POLL_MS = 1_000

/** The selection rectangle in screen coordinates, as the toolbar positions itself against. */
export interface SelectionRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A rectangle is usable only when every field is a finite number and it has an area. */
export function readRect(value: unknown): SelectionRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof record.x !== 'number' || typeof record.y !== 'number'
    || typeof record.width !== 'number' || typeof record.height !== 'number') {
    return undefined
  }
  if (![record.x, record.y, record.width, record.height].every(Number.isFinite)) return undefined
  if (record.width < 1 || record.height < 1) return undefined
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}

export interface SelectionMonitorHandle {
  stop(): void
  setExcludePids(pids: readonly number[]): void
  activatePid(pid: number): void
  /** Told when the toolbar appears and disappears, so a hidden bar costs no event traffic. */
  setToolbarVisible?(visible: boolean): void
  lastFrontPid(): number | undefined
}

export interface SelectionMonitorHandlers {
  onEvent(event: SelectionHelperEvent): void
}

export type SelectionStarter = (handlers: SelectionMonitorHandlers) => SelectionMonitorHandle | undefined

export interface SelectionHost {
  enabled(): boolean
  language(): 'zh' | 'en'
  setLanguage(language: 'zh' | 'en'): void
  helperConnected(): boolean
  helperPid(): number | undefined
  show(payload: {
    text: string
    x: number
    y: number
    bounds?: SelectionRect
    language: 'zh' | 'en'
  }): void
  hide(): void
  pointer(x: number, y: number): void
  attach(text: string): void
  /**
   * Show a translation of `text` in the ball.
   *
   * Deliberately not a prompt: a translation is displayed without entering the
   * conversation, so the host renders it itself instead of starting an agent turn.
   */
  translate(text: string, language: 'zh' | 'en'): void
  openExternal(url: string): void
  requestAccessibility(): boolean
  accessibilityTrusted(): boolean
  now(): number
}

export function selectionSearchUrl(text: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

/** Open a URL with the system handler. Search uses this and does not expand the ball. */
export function openSystemUrl(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : 'open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
  child.once('error', (error) => {
    console.error(`dsh-orb: open failed: ${error.message}`)
  })
  child.unref()
}

export class SelectionController {
  private monitor: SelectionMonitorHandle | undefined
  private lastText = ''
  private lastAnchor = { x: 0, y: 0 }
  private lastRect: SelectionRect | undefined
  private lastDedupe: { key: string; at: number } | undefined
  private lastPid: number | undefined
  private restoreTimer: ReturnType<typeof setTimeout> | undefined
  private sessionRunning = false
  private hidInput = false
  private promptedAccessibility = false
  private accessibilityPoll: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly host: SelectionHost,
    private readonly startMonitor: SelectionStarter = startSelectionMonitor,
  ) {}

  /** Start while the helper is connected and the switch is on. */
  sync(): void {
    if (process.platform === 'linux') return
    if (this.host.helperConnected() && this.host.enabled()) this.start()
    else this.stop()
  }

  stop(): void {
    this.clearAccessibilityPoll()
    this.monitor?.stop()
    this.monitor = undefined
    if (this.restoreTimer !== undefined) {
      clearTimeout(this.restoreTimer)
      this.restoreTimer = undefined
    }
    this.host.hide()
  }

  setLanguage(language: 'zh' | 'en'): void {
    this.host.setLanguage(language)
  }

  /**
   * Hide the toolbar and tell the monitor, so it stops reporting the events that would only
   * dismiss a bar that is no longer there. Every dismissal path goes through here.
   */
  private hideToolbar(): void {
    this.host.hide()
    this.monitor?.setToolbarVisible?.(false)
  }

  setSessionRunning(running: boolean): void {
    this.sessionRunning = running
    if (running) this.hideToolbar()
  }

  setHidInput(active: boolean): void {
    this.hidInput = active
    if (active) this.hideToolbar()
  }

  search(): void {
    if (this.lastText === '') return
    this.hideToolbar()
    this.host.openExternal(selectionSearchUrl(this.lastText))
  }

  translate(): void {
    if (this.lastText === '') return
    this.hideToolbar()
    this.host.translate(this.lastText, this.host.language())
    this.scheduleRestoreFrontApp()
  }

  sendToAgent(): void {
    if (this.lastText === '') return
    this.hideToolbar()
    this.host.attach(this.lastText)
  }

  onHelperEvent(event: SelectionHelperEvent): void {
    switch (event.type) {
      case 'ready':
        this.exclude()
        return
      case 'untrusted':
        if (!this.promptedAccessibility) {
          this.promptedAccessibility = true
          this.host.requestAccessibility()
        }
        this.watchAccessibility()
        return
      case 'mouse-down':
        this.host.pointer(event.x, event.y)
        return
      case 'key':
      case 'dismiss':
        this.hideToolbar()
        return
      case 'mouse-up':
        this.lastAnchor = { x: event.x, y: event.y }
        return
      case 'selection':
        this.onSelection(event)
        return
    }
  }

  private start(): void {
    if (this.monitor !== undefined) return
    const started = this.startMonitor({ onEvent: (event) => { this.onHelperEvent(event) } })
    if (started === undefined) return
    this.monitor = started
    this.exclude()
  }

  private exclude(): void {
    const pids = [process.pid]
    const helper = this.host.helperPid()
    if (helper !== undefined) pids.push(helper)
    this.monitor?.setExcludePids(pids)
  }

  private pausedReads(): boolean {
    return this.sessionRunning || this.hidInput || !this.host.enabled()
  }

  private onSelection(event: Extract<SelectionHelperEvent, { type: 'selection' }>): void {
    if (this.pausedReads()) return
    const key = `${String(event.pid ?? 0)}\0${event.bundle ?? ''}\0${event.text}`
    const now = this.host.now()
    if (this.lastDedupe !== undefined && this.lastDedupe.key === key && now - this.lastDedupe.at < SELECTION_DEDUPE_MS) {
      return
    }
    this.lastDedupe = { key, at: now }
    this.lastText = event.text
    this.lastPid = event.pid
    // A selection without usable coordinates keeps the mouse-up anchor: a missing field
    // must not read as the screen origin.
    if (typeof event.x === 'number' && typeof event.y === 'number'
      && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      this.lastAnchor = { x: event.x, y: event.y }
    }
    // The rectangle is what the toolbar hangs off; a platform that reports one gets the
    // bar clear of the text, and one that does not falls back to the pointer.
    this.lastRect = readRect(event.bounds)
    this.host.show({
      text: event.text,
      x: this.lastAnchor.x,
      y: this.lastAnchor.y,
      ...this.lastRect === undefined ? {} : { bounds: this.lastRect },
      language: this.host.language(),
    })
    // From here on the monitor must report keys and scrolls again: each one dismisses the bar.
    this.monitor?.setToolbarVisible?.(true)
  }

  private scheduleRestoreFrontApp(): void {
    this.restoreFrontApp()
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer)
    const timer = setTimeout(() => {
      this.restoreTimer = undefined
      this.restoreFrontApp()
    }, SELECTION_RESTORE_FRONT_MS)
    timer.unref()
    this.restoreTimer = timer
  }

  private restoreFrontApp(): void {
    const pid = this.lastPid
    if (pid === undefined || pid === process.pid) return
    this.monitor?.activatePid(pid)
  }

  private watchAccessibility(): void {
    if (this.accessibilityPoll !== undefined) return
    const timer = setInterval(() => {
      if (!this.host.enabled() || this.monitor === undefined) {
        this.clearAccessibilityPoll()
        return
      }
      if (!this.host.accessibilityTrusted()) return
      this.rearm()
    }, SELECTION_ACCESSIBILITY_POLL_MS)
    timer.unref()
    this.accessibilityPoll = timer
  }

  private rearm(): void {
    this.clearAccessibilityPoll()
    this.monitor?.stop()
    this.monitor = undefined
    this.start()
  }

  private clearAccessibilityPoll(): void {
    if (this.accessibilityPoll === undefined) return
    clearInterval(this.accessibilityPoll)
    this.accessibilityPoll = undefined
  }
}

export function productionAccessibility(): Pick<SelectionHost, 'requestAccessibility' | 'accessibilityTrusted'> {
  return {
    requestAccessibility: () => promptAccessibility(),
    accessibilityTrusted: () => accessibilityTrusted(),
  }
}
