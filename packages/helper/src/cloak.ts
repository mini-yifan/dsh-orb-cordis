/**
 * Refcounted agent-activity cloak over the helper's chrome windows.
 * Mirrors the original floating-window overlay guard: while a Computer Use capture
 * interval is active, every chrome window leaves screen captures; while input is
 * active the ball also turns click-through so posted clicks land underneath.
 * Windows hides via WDA_EXCLUDEFROMCAPTURE for the interval. macOS capture runs
 * through `screencapture`, which cannot omit windows by id, so the same toggle
 * drives NSWindowSharingNone there; the chrome stays captureable between intervals.
 * Linux has no capture-exclusion flag, so the interval takes the chrome fully
 * transparent instead: the window stays mapped and the compositor still has to
 * draw it, so captures miss it while the user only sees it fade.
 */

/** The subset of BrowserWindow the cloak touches; duck-typed so tests need no Electron. */
export interface CloakWindow {
  isDestroyed(): boolean
  setContentProtection(active: boolean): void
  setIgnoreMouseEvents(active: boolean, options?: { forward?: boolean }): void
  blur(): void
  /** Required when the platform conceals by transparency; unused elsewhere. */
  setOpacity?(value: number): void
}

export interface CloakEntry {
  /** Read on every sync so recreated windows re-attach. */
  window(): CloakWindow | undefined
  /** Protection kept while no interval is active (Windows observation frame). */
  resting: boolean
}

export type CloakMode = 'capture' | 'input'

/** How a platform takes a window out of a screen capture. */
export type CloakConceal = 'content-protection' | 'opacity'

/**
 * Linux keeps the window mapped and makes it transparent. Unmapping also leaves
 * a capture, but `hide()`/`showInactive()` are an X11 unmap and remap: the ball
 * vanished and popped back for every capture, openApp and HID interval, which
 * reads as the floating window being covered and uncovered several times a turn.
 * @param platform - Node platform id; tests pass an explicit value.
 * @returns the conceal strategy for that platform.
 */
export function cloakConceal(platform: NodeJS.Platform = process.platform): CloakConceal {
  return platform === 'linux' ? 'opacity' : 'content-protection'
}

/**
 * Milliseconds to wait after applying click-through before acking input begin,
 * so WindowServer hit-testing has committed. Clicks posted earlier still land on
 * the ball instead of the app underneath (the original's OVERLAY_GUARD_INPUT_APPLY_MS).
 */
export const OVERLAY_GUARD_INPUT_APPLY_MS = 80

/**
 * Milliseconds the chrome stays concealed after the last capture ends.
 *
 * A turn captures, acts and captures again within a few hundred milliseconds, so
 * restoring between two intervals blinked the chrome once per tool call. Holding
 * it concealed across the gap collapses that into a single fade.
 */
export const CLOAK_TAIL_MS = 250

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
 * @param entries - chrome windows and their resting conceal state.
 * @param clickThroughWindow - the ball, for click-through on input intervals.
 * @param conceal - how this platform removes a window from a capture.
 */
export function createAgentCloak(
  entries: CloakEntry[],
  clickThroughWindow?: () => CloakWindow | undefined,
  conceal: CloakConceal = cloakConceal(),
): AgentCloak {
  const counts: Record<CloakMode, number> = { capture: 0, input: 0 }
  let clickThrough = false
  /** Last conceal state pushed per window, so the toggle happens on crossings only. */
  const hidden = new WeakMap<CloakWindow, boolean>()
  let tail: ReturnType<typeof setTimeout> | undefined
  /** True between the first capture begin and the end of the tail hold. */
  let captureApplied = false

  function clearTail(): void {
    if (tail === undefined) return
    clearTimeout(tail)
    tail = undefined
  }

  /** Push the current conceal state to every chrome window. */
  function applyConceal(active: boolean): void {
    for (const entry of entries) {
      const window = entry.window()
      if (window === undefined || window.isDestroyed()) continue
      const concealNow = active || entry.resting
      if (hidden.get(window) === concealNow) continue
      hidden.set(window, concealNow)
      if (conceal === 'opacity') {
        // Transparency rather than an unmap: the window never leaves the X11
        // window list, so nothing remaps and the user sees a fade, not a flicker.
        window.setOpacity?.(concealNow ? 0 : 1)
        continue
      }
      window.setContentProtection(concealNow)
    }
  }

  function sync(): void {
    // Only a capture has to take the chrome out of the picture. An input interval
    // needs the ball click-through so posted clicks land underneath, which is a
    // separate toggle — concealing on input too made every click-typed tool call
    // blink the ball away and back.
    const capturing = counts.capture > 0
    if (capturing) {
      clearTail()
      captureApplied = true
      applyConceal(true)
    } else if (captureApplied && tail === undefined) {
      tail = setTimeout(() => {
        tail = undefined
        captureApplied = false
        applyConceal(false)
      }, CLOAK_TAIL_MS)
      tail.unref?.()
    }

    const next = counts.input > 0
    if (next === clickThrough) return
    clickThrough = next
    const ball = clickThroughWindow?.()
    if (ball === undefined || ball.isDestroyed()) return
    if (next) {
      ball.setIgnoreMouseEvents(true, { forward: false })
      ball.blur()
      return
    }
    ball.setIgnoreMouseEvents(false)
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
      clearTail()
      captureApplied = false
      applyConceal(false)
      const ball = clickThroughWindow?.()
      if (ball !== undefined && !ball.isDestroyed() && clickThrough) {
        clickThrough = false
        ball.setIgnoreMouseEvents(false)
      }
    },
  }
}
