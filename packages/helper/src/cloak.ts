/**
 * Refcounted agent-activity cloak over the helper's chrome windows.
 * Mirrors the original floating-window overlay guard: while a Computer Use capture
 * or HID interval is active, every chrome window leaves screen captures; while input
 * is active the ball also turns click-through so posted clicks land underneath.
 * Windows hides via WDA_EXCLUDEFROMCAPTURE for the interval. macOS capture runs
 * through `screencapture`, which cannot omit windows by id, so the same toggle
 * drives NSWindowSharingNone there; the chrome stays captureable between intervals.
 */

/** The subset of BrowserWindow the cloak touches; duck-typed so tests need no Electron. */
export interface CloakWindow {
  isDestroyed(): boolean
  setContentProtection(active: boolean): void
  setIgnoreMouseEvents(active: boolean, options?: { forward?: boolean }): void
  blur(): void
}

export interface CloakEntry {
  /** Read on every sync so recreated windows re-attach. */
  window(): CloakWindow | undefined
  /** Protection kept while no interval is active (Windows observation frame). */
  resting: boolean
}

export type CloakMode = 'capture' | 'input'

/**
 * Milliseconds to wait after applying click-through before acking input begin,
 * so WindowServer hit-testing has committed. Clicks posted earlier still land on
 * the ball instead of the app underneath (the original's OVERLAY_GUARD_INPUT_APPLY_MS).
 */
export const OVERLAY_GUARD_INPUT_APPLY_MS = 80

export interface AgentCloak {
  begin(mode: CloakMode): void
  end(mode: CloakMode): void
  /** Drop every interval and restore resting chrome; covers a lost `end`. */
  reset(): void
}

/**
 * Fire a cloak ack. Input begin waits {@link OVERLAY_GUARD_INPUT_APPLY_MS} after
 * click-through was applied — the ack arriving is the host's signal that posted
 * HID events may start. Every other transition acks immediately.
 */
export function scheduleCloakAck(
  ack: () => void,
  mode: CloakMode,
  action: 'begin' | 'end',
): void {
  if (mode !== 'input' || action !== 'begin') {
    ack()
    return
  }
  const timer = setTimeout(ack, OVERLAY_GUARD_INPUT_APPLY_MS)
  timer.unref()
}

/**
 * Create the cloak. `clickThroughWindow` is the ball: it receives
 * `setIgnoreMouseEvents`/`blur` on input-count crossings, chrome windows do not.
 */
export function createAgentCloak(
  entries: CloakEntry[],
  clickThroughWindow?: () => CloakWindow | undefined,
  onClickThroughChange?: (clickThrough: boolean) => void,
): AgentCloak {
  const counts: Record<CloakMode, number> = { capture: 0, input: 0 }
  let clickThrough = false

  function sync(): void {
    const active = counts.capture > 0 || counts.input > 0
    for (const entry of entries) {
      const window = entry.window()
      if (window === undefined || window.isDestroyed()) continue
      window.setContentProtection(active || entry.resting)
    }
    const next = counts.input > 0
    if (next === clickThrough) return
    clickThrough = next
    const ball = clickThroughWindow?.()
    if (ball === undefined || ball.isDestroyed()) return
    if (next) {
      ball.setIgnoreMouseEvents(true, { forward: false })
      ball.blur()
    } else {
      ball.setIgnoreMouseEvents(false)
    }
    // The transparent-chrome owner caches the OS flag it last wrote, and this write
    // went around it; report the new reality so the two never disagree.
    onClickThroughChange?.(next)
  }

  return {
    begin(mode) {
      counts[mode] += 1
      sync()
    },
    end(mode) {
      counts[mode] = Math.max(0, counts[mode] - 1)
      sync()
    },
    reset() {
      counts.capture = 0
      counts.input = 0
      sync()
    },
  }
}
