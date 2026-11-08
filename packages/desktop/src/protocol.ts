/**
 * Wire types shared by the plugin, the child-process host, and their tests.
 *
 * The host speaks one JSON object per line on stdin/stdout. Nothing in here
 * touches the native library: the platform boundary lives in `ffi.ts`.
 * @module @dsh-orb/desktop/src/protocol
 */

/** One element the model may address. Mirrors the library's snapshot node. */
export interface DesktopNode {
  readonly role: string
  readonly name?: string
  readonly value?: string
  /** Qualified ref (`@<snapshot>:eN`), present only for actionable elements. */
  readonly ref?: string
  readonly actions?: readonly string[]
  readonly states?: readonly string[]
  readonly children?: readonly DesktopNode[]
  /** Number of children the snapshot cut off at the depth limit. */
  readonly childrenCount?: number
  readonly subtreeTruncated?: boolean
}

/** One `snapshot` observation, normalized for the renderer. */
export interface SnapshotData {
  readonly app: string
  readonly windowId?: string
  readonly windowTitle?: string
  readonly snapshotId: string
  readonly refCount: number
  readonly complete: boolean
  readonly nodesObserved?: number
  readonly tree: DesktopNode
}

/** Action verbs the background agent may use. Physical input kinds are absent by design. */
export type ActionKind =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'set_value'
  | 'set_focus'
  | 'toggle'
  | 'check'
  | 'uncheck'
  | 'expand'
  | 'collapse'
  | 'select'
  | 'scroll'
  | 'scroll_to'
  | 'press_key'
  | 'type_text'
  | 'clear'

/** Pointer direction for `scroll`. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/** Modifier names accepted by `press_key` and `click`. */
export type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

/** One action request. */
export interface ActionRequest {
  readonly kind: ActionKind
  /** Text for `type_text` and `set_value`. */
  readonly text?: string
  /** Named key for `press_key`, for example `s`. */
  readonly key?: string
  readonly modifiers?: readonly Modifier[]
  readonly direction?: ScrollDirection
  readonly amount?: number
}

/** Wait modes the host exposes. Event waits are not part of the ABI. */
export type WaitRequest =
  | { readonly kind: 'pause'; readonly ms: number }
  | {
    readonly kind: 'window'
    readonly title: string
    readonly app?: string
    readonly timeoutMs?: number
  }
  | {
    readonly kind: 'text'
    readonly text: string
    readonly app?: string
    readonly timeoutMs?: number
  }
  | {
    readonly kind: 'element'
    readonly ref: string
    readonly predicate?: 'exists' | 'enabled' | 'visible' | 'actionable' | 'value'
    readonly value?: string
    readonly action?: ActionKind
    readonly timeoutMs?: number
  }

/** One running application, as the library reports it. */
export interface AppInfo {
  readonly name: string
  readonly pid: number
  readonly bundleId?: string
}

/** One on-screen window of an application, with its rectangle when the OS reports one. */
export interface WindowInfo {
  readonly id: string
  readonly title: string
  readonly appName: string
  readonly pid: number
  readonly focused: boolean
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

/** Everything the host can be asked to do. */
export type HostRequest =
  | { readonly op: 'ping' }
  | { readonly op: 'status' }
  | { readonly op: 'apps' }
  | { readonly op: 'windows'; readonly app: string }
  | { readonly op: 'frontmost' }
  | { readonly op: 'presence' }
  | { readonly op: 'state' }
  | {
    readonly op: 'snapshot'
    readonly app?: string
    readonly depth?: number
    readonly interactive?: boolean
    readonly compact?: boolean
  }
  | {
    readonly op: 'act'
    readonly ref: string
    readonly action: ActionRequest
    /** Delivery policy: 0 semantic, 1 focus fallback, 2 physical. Default: 0. */
    readonly policy?: number
    /** Override the library's 5 s pre-action wait. */
    readonly timeout_ms?: number
  }
  | { readonly op: 'wait'; readonly wait: WaitRequest }
  | { readonly op: 'shutdown' }

/** Stable shape for every failure the model may see. */
export interface HostError {
  /** Library error code (`STALE_REF`, `WINDOW_NOT_FOUND`, …) or a host code. */
  readonly code: string
  readonly message: string
  readonly suggestion?: string
  readonly resultCode: number
  readonly delivery?: string
  readonly retry?: string
}

/** One response line. */
export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly data: unknown }
  | { readonly id: number; readonly ok: false; readonly error: HostError }