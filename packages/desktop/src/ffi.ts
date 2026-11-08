/**
 * koffi bindings for `libagent_desktop_ffi`.
 *
 * Only the symbols this package uses are bound. Every `char **` output is taken
 * as a raw pointer and decoded by hand: koffi would otherwise turn the pointer
 * into a JS string and lose the address, leaking one allocation per call.
 * @module @dsh-orb/desktop/src/ffi
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ActionKind, ActionRequest, Modifier, ScrollDirection } from './protocol.ts'

type Koffi = typeof import('koffi')

/** Same copy rule the orb host uses: a loaded addon inside the package blocks updates on Windows. */
function loadKoffi(): Koffi {
  const dir = process.env.DSH_ORB_KOFFI_DIR
  if (dir !== undefined && dir !== '') {
    try {
      return createRequire(join(dir, 'index.js'))('koffi') as Koffi
    } catch {
      // A broken copy: the packaged one still works, it only delays the next update.
    }
  }
  return createRequire(import.meta.url)('koffi') as Koffi
}

/** ABI major this package was written against. */
const ABI_MAJOR = 7

const ACTION_KIND: Record<ActionKind, number> = {
  click: 0,
  double_click: 1,
  right_click: 2,
  set_value: 4,
  set_focus: 5,
  expand: 6,
  collapse: 7,
  select: 8,
  toggle: 9,
  check: 10,
  uncheck: 11,
  scroll: 12,
  scroll_to: 13,
  press_key: 14,
  type_text: 17,
  clear: 18,
}

const DIRECTION: Record<ScrollDirection, number> = { up: 0, down: 1, left: 2, right: 3 }

const MODIFIER: Record<Modifier, number> = { cmd: 0, ctrl: 1, alt: 2, shift: 3 }

/** Delivery policies the library accepts. */
export const POLICY = {
  /** Semantic actions only; no focus change and no synthetic input. */
  headless: 0,
  /** May focus an element without moving the cursor. */
  focusFallback: 1,
  /** May move the cursor and post synthetic keyboard events. */
  headed: 2,
} as const

/** Result codes that carry a model-facing meaning. */
export const RESULT = {
  OK: 0,
  PERM_DENIED: -1,
  ELEMENT_NOT_FOUND: -2,
  APP_NOT_FOUND: -3,
  ACTION_FAILED: -4,
  ACTION_NOT_SUPPORTED: -5,
  STALE_REF: -6,
  WINDOW_NOT_FOUND: -7,
  PLATFORM_NOT_SUPPORTED: -8,
  TIMEOUT: -9,
  INVALID_ARGS: -10,
  NOTIFICATION_NOT_FOUND: -11,
  INTERNAL: -12,
  SNAPSHOT_NOT_FOUND: -13,
  POLICY_DENIED: -14,
  AMBIGUOUS_TARGET: -15,
  APP_UNRESPONSIVE: -16,
} as const

/** Last-error slot read after a failing call. */
export interface NativeError {
  readonly resultCode: number
  readonly code: string
  readonly message: string
  readonly suggestion?: string
  readonly delivery?: string
  readonly retry?: string
}

/** The loaded library, bound once per child process. */
export interface NativeLibrary {
  readonly abiVersion: number
  readonly libraryVersion: string
  createAdapter(session: string): unknown
  createProbeAdapter(): unknown
  destroyAdapter(adapter: unknown): void
  snapshot(adapter: unknown, app: string | null, depth: number, interactive: boolean, compact: boolean): { ok: boolean; json?: string; error?: NativeError }
  act(
    adapter: unknown,
    ref: string,
    action: ActionRequest,
    policy?: number,
    timeoutMs?: number,
  ): { ok: boolean; json?: string; error?: NativeError }
  wait(adapter: unknown, wait: import('./protocol.ts').WaitRequest): { ok: boolean; json?: string; error?: NativeError }
  status(adapter: unknown): { ok: boolean; json?: string; error?: NativeError }
  apps(adapter: unknown): { ok: true; apps: readonly { name: string; pid: number; bundleId?: string }[] } | { ok: false; error: NativeError }
  windows(adapter: unknown, app: string): { ok: true; windows: readonly import('./protocol.ts').WindowInfo[] } | { ok: false; error: NativeError }
  idleMs(): number | undefined
}

const RESULT_CODES: Record<number, string> = {
  [-1]: 'PERM_DENIED',
  [-2]: 'ELEMENT_NOT_FOUND',
  [-3]: 'APP_NOT_FOUND',
  [-4]: 'ACTION_FAILED',
  [-5]: 'ACTION_NOT_SUPPORTED',
  [-6]: 'STALE_REF',
  [-7]: 'WINDOW_NOT_FOUND',
  [-8]: 'PLATFORM_NOT_SUPPORTED',
  [-9]: 'TIMEOUT',
  [-10]: 'INVALID_ARGS',
  [-11]: 'NOTIFICATION_NOT_FOUND',
  [-12]: 'INTERNAL',
  [-13]: 'SNAPSHOT_NOT_FOUND',
  [-14]: 'POLICY_DENIED',
  [-15]: 'AMBIGUOUS_TARGET',
  [-16]: 'APP_UNRESPONSIVE',
}

/**
 * Load the library and bind every symbol used by the host.
 * @param dir - folder holding the library (and the macOS helper).
 * @returns the bound library.
 * @throws when the ABI, struct layouts, or the pinned version disagree.
 */
export function loadNative(dir: string): NativeLibrary {
  const koffi = loadKoffi()
  const platform = process.platform
  const libraryFile = platform === 'darwin'
    ? 'libagent_desktop_ffi.dylib'
    : platform === 'win32' ? 'agent_desktop_ffi.dll' : 'libagent_desktop_ffi.so'
  const lib = koffi.load(join(dir, libraryFile))

  const ScrollParams = koffi.struct('AdScrollParams', { direction: 'int32', amount: 'uint32' })
  const KeyCombo = koffi.struct('AdKeyCombo', {
    key: 'const char *',
    modifiers: 'const int32 *',
    modifier_count: 'uint32',
  })
  const Point = koffi.struct('AdPoint', { x: 'double', y: 'double' })
  const DragParams = koffi.struct('AdDragParams', {
    from: Point,
    to: Point,
    duration_ms: 'uint64',
    drop_delay_ms: 'uint64',
  })
  const Action = koffi.struct('AdAction', {
    kind: 'int32',
    text: 'const char *',
    scroll: ScrollParams,
    key: KeyCombo,
    drag: DragParams,
  })

  const OptionalU64 = koffi.struct('AdOptionalU64', { value: 'uint64', present: 'bool' })
  const OptionalUsize = koffi.struct('AdOptionalUsize', { value: 'size_t', present: 'bool' })
  const SurfaceModes = koffi.struct('AdWaitSurfaceModes', {
    menu: 'bool',
    menu_closed: 'bool',
    notification: 'bool',
  })
  const WaitMode = koffi.struct('AdWaitMode', {
    pause: OptionalU64,
    element: 'const char *',
    window: 'const char *',
    text: 'const char *',
    surfaces: SurfaceModes,
  })
  const WaitPredicate = koffi.struct('AdWaitPredicate', {
    predicate: 'const char *',
    value: 'const char *',
    action: 'const char *',
    count: OptionalUsize,
  })
  const WaitScope = koffi.struct('AdWaitScope', { timeout_ms: 'uint64', app: 'const char *' })
  const WaitArgs = koffi.struct('AdWaitArgs', {
    mode: WaitMode,
    predicate: WaitPredicate,
    scope: WaitScope,
  })

  const Rect = koffi.struct('AdRect', {
    x: 'double',
    y: 'double',
    width: 'double',
    height: 'double',
  })
  const WindowInfo = koffi.struct('AdWindowInfo', {
    id: 'const char *',
    title: 'const char *',
    app_name: 'const char *',
    pid: 'uint32',
    bounds: Rect,
    has_bounds: 'bool',
    is_focused: 'bool',
  })
  const ExactWindowInfo = koffi.struct('AdExactWindowInfo', {
    version: 'uint32',
    size: 'uint32',
    window: WindowInfo,
    process_instance: 'const char *',
    accessible: 'bool',
  })

  const AppInfo = koffi.struct('AdAppInfo', {
    name: 'const char *',
    pid: 'uint32',
    bundle_id: 'const char *',
  })

  const DeliverySemantics = koffi.struct('AdDeliverySemantics', {
    delivery: 'int32',
    retry: 'int32',
  })

  const ad_init = lib.func('int ad_init(uint32_t expected_major)')
  const ad_abi_version = lib.func('uint32_t ad_abi_version(void)')
  const ad_version = lib.func('int ad_version(_Out_ void **out)')
  const ad_create = lib.func('void *ad_adapter_create_with_session(const char *session)')
  const ad_destroy = lib.func('void ad_adapter_destroy(void *adapter)')
  const ad_snapshot = lib.func(
    'int ad_snapshot(void *adapter, const char *app, int32_t surface, uint8_t max_depth,'
    + ' bool interactive_only, bool compact, _Out_ void **out)',
  )
  const ad_execute = lib.func(
    'int ad_execute_by_ref(void *adapter, const char *ref_id, const AdAction *action,'
    + ' int32_t policy, _Out_ void **out)',
  )
  const ad_execute_timeout = lib.func(
    'int ad_execute_by_ref_timeout(void *adapter, const char *ref_id, const AdAction *action,'
    + ' int32_t policy, int64_t timeout_ms, _Out_ void **out)',
  )
  const ad_wait = lib.func('int ad_wait(void *adapter, const AdWaitArgs *args, _Out_ void **out)')
  const ad_status = lib.func('int ad_status(void *adapter, _Out_ void **out)')
  const ad_list_apps = lib.func('int ad_list_apps(void *adapter, _Out_ void **out)')
  const ad_app_count = lib.func('uint32_t ad_app_list_count(void *list)')
  const ad_app_get = lib.func('void *ad_app_list_get(void *list, uint32_t index)')
  const ad_app_free = lib.func('void ad_app_list_free(void *list)')
  const ad_list_windows = lib.func(
    'int ad_list_windows_exact(void *adapter, const char *app_filter, bool focused_only, _Out_ void **out)',
  )
  const ad_window_count = lib.func('uint32_t ad_exact_window_list_count(void *list)')
  const ad_window_get = lib.func('void *ad_exact_window_list_get(void *list, uint32_t index)')
  const ad_window_free = lib.func('void ad_exact_window_list_free(void *list)')
  const ad_free_string = lib.func('void ad_free_string(void *s)')
  const ad_action_size = lib.func('size_t ad_action_size(void)')
  const ad_wait_size = lib.func('size_t ad_wait_args_size(void)')
  const ad_last_code = lib.func('int32_t ad_last_error_code(void)')
  const ad_last_message = lib.func('const char *ad_last_error_message(void)')
  const ad_last_suggestion = lib.func('const char *ad_last_error_suggestion(void)')
  const ad_last_delivery = lib.func(
    'int32_t ad_last_error_delivery_semantics(_Out_ AdDeliverySemantics *out)',
  )

  const rc = ad_init(ABI_MAJOR)
  if (rc !== 0) throw new Error(`agent-desktop ABI mismatch (ad_init=${rc}, header=${ABI_MAJOR})`)
  if (koffi.sizeof(Action) !== ad_action_size()) {
    throw new Error(`AdAction layout mismatch: ${koffi.sizeof(Action)} != ${ad_action_size()}`)
  }
  if (koffi.sizeof(WaitArgs) !== ad_wait_size()) {
    throw new Error(`AdWaitArgs layout mismatch: ${koffi.sizeof(WaitArgs)} != ${ad_wait_size()}`)
  }

  const versionOut: unknown[] = [null]
  let libraryVersion = 'unknown'
  if (ad_version(versionOut) === 0 && typeof versionOut[0] === 'bigint') {
    const raw = decodeString(versionOut[0])
    ad_free_string(versionOut[0])
    try {
      libraryVersion = String((JSON.parse(raw).data as { version?: string }).version ?? 'unknown')
    } catch {
      libraryVersion = 'unknown'
    }
  }

  function decodeString(pointer: unknown): string {
    try {
      return String(koffi.decode(pointer, 'char', -1))
    } catch {
      return ''
    }
  }

  function takeString(pointer: unknown): string {
    const text = decodeString(pointer)
    if (typeof pointer === 'bigint' && pointer !== 0n) ad_free_string(pointer)
    return text
  }

  function lastError(resultCode: number): NativeError {
    const semantics = readSemantics()
    const message = String(ad_last_message() ?? '')
    const suggestion = String(ad_last_suggestion() ?? '')
    return {
      resultCode,
      code: RESULT_CODES[resultCode] ?? `UNKNOWN_${resultCode}`,
      message: message !== '' ? message : `agent-desktop call failed (${resultCode})`,
      ...suggestion !== '' ? { suggestion } : {},
      ...semantics,
    }
  }

  function fromEnvelope(resultCode: number, pointer: unknown): { ok: boolean; json?: string; error?: NativeError } {
    const json = takeString(pointer)
    if (json === '') return { ok: false, error: lastError(resultCode) }
    try {
      const parsed = JSON.parse(json) as { ok?: boolean; error?: { code?: string; message?: string; suggestion?: string } }
      if (parsed.ok === true) return { ok: true, json }
      return {
        ok: false,
        error: {
          resultCode,
          code: parsed.error?.code ?? (RESULT_CODES[resultCode] ?? 'UNKNOWN'),
          message: parsed.error?.message ?? 'agent-desktop call failed',
          ...parsed.error?.suggestion !== undefined ? { suggestion: parsed.error.suggestion } : {},
          ...readSemantics(),
        },
      }
    } catch {
      return { ok: false, error: lastError(resultCode) }
    }
  }

  function readSemantics(): { delivery?: string; retry?: string } {
    try {
      const semantics = { delivery: 0, retry: 0 }
      if (ad_last_delivery(semantics) !== 0) return {}
      return {
        delivery: deliveryName(semantics.delivery),
        retry: retryName(semantics.retry),
      }
    } catch {
      return {}
    }
  }

  function buildAction(action: ActionRequest): unknown {
    const kind = ACTION_KIND[action.kind]
    if (kind === undefined) throw new Error(`unsupported action kind: ${(action as { kind?: string }).kind}`)
    const modifiers = (action.modifiers ?? []).map(modifier => MODIFIER[modifier])
    return {
      kind,
      text: action.text ?? null,
      scroll: {
        direction: action.direction === undefined ? 1 : DIRECTION[action.direction],
        amount: action.amount ?? 0,
      },
      key: {
        key: action.key ?? null,
        modifiers,
        modifier_count: modifiers.length,
      },
      drag: { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, duration_ms: 0, drop_delay_ms: 0 },
    }
  }

  function buildWait(wait: import('./protocol.ts').WaitRequest): unknown {
    const args = {
      mode: {
        pause: { value: 0n, present: false },
        element: null as string | null,
        window: null as string | null,
        text: null as string | null,
        surfaces: { menu: false, menu_closed: false, notification: false },
      },
      predicate: {
        predicate: null as string | null,
        value: null as string | null,
        action: null as string | null,
        count: { value: 0, present: false },
      },
      scope: { timeout_ms: 0n, app: null as string | null },
    }
    if (wait.kind === 'pause') {
      args.mode.pause = { value: BigInt(Math.max(0, Math.round(wait.ms))), present: true }
      return args
    }
    if (wait.kind === 'window') args.mode.window = wait.title
    if (wait.kind === 'text') args.mode.text = wait.text
    if (wait.kind === 'element') {
      args.mode.element = wait.ref
      if (wait.predicate !== undefined) args.predicate.predicate = wait.predicate
      if (wait.value !== undefined) args.predicate.value = wait.value
      if (wait.action !== undefined) args.predicate.action = String(ACTION_KIND[wait.action])
    }
    if ('timeoutMs' in wait && wait.timeoutMs !== undefined) {
      args.scope.timeout_ms = BigInt(Math.max(0, Math.round(wait.timeoutMs)))
    }
    const app = 'app' in wait ? wait.app : undefined
    if (app !== undefined) args.scope.app = app
    return args
  }

  let idleReader: (() => number | undefined) | undefined
  function idleMs(): number | undefined {
    idleReader ??= createIdleReader(koffi)
    return idleReader?.()
  }

  return {
    abiVersion: ad_abi_version(),
    libraryVersion,
    createAdapter: (session: string) => ad_create(session),
    createProbeAdapter: () => ad_create(null),
    destroyAdapter: (adapter: unknown) => ad_destroy(adapter),
    snapshot: (adapter, app, depth, interactive, compact) => {
      const out: unknown[] = [null]
      const code = ad_snapshot(adapter, app, 0, Math.min(255, Math.max(1, depth)), interactive, compact, out)
      return fromEnvelope(code, out[0])
    },
    act: (adapter, ref, action, policy = POLICY.headless, timeoutMs) => {
      const out: unknown[] = [null]
      const code = timeoutMs === undefined
        ? ad_execute(adapter, ref, buildAction(action), policy, out)
        : ad_execute_timeout(adapter, ref, buildAction(action), policy, timeoutMs, out)
      return fromEnvelope(code, out[0])
    },
    wait: (adapter, wait) => {
      const out: unknown[] = [null]
      const code = ad_wait(adapter, buildWait(wait), out)
      return fromEnvelope(code, out[0])
    },
    status: (adapter) => {
      const out: unknown[] = [null]
      const code = ad_status(adapter, out)
      return fromEnvelope(code, out[0])
    },
    apps: (adapter) => {
      const out: unknown[] = [null]
      const code = ad_list_apps(adapter, out)
      if (code !== 0) return { ok: false, error: lastError(code) }
      const list = out[0]
      const count = ad_app_count(list)
      const apps: { name: string; pid: number; bundleId?: string }[] = []
      try {
        for (let index = 0; index < count; index += 1) {
          const info = koffi.decode(ad_app_get(list, index), AppInfo) as
            { name?: string; pid?: number; bundle_id?: string | null }
          const name = info.name ?? ''
          if (name === '') continue
          apps.push({
            name,
            pid: info.pid ?? 0,
            ...typeof info.bundle_id === 'string' && info.bundle_id !== '' ? { bundleId: info.bundle_id } : {},
          })
        }
      } finally {
        ad_app_free(list)
      }
      return { ok: true, apps }
    },
    windows: (adapter, app) => {
      const out: unknown[] = [null]
      // The ABI's app filter matches no running app on macOS (checked against display
      // names and bundle ids), so ask for every window and filter the decoded rows here.
      const code = ad_list_windows(adapter, null, false, out)
      if (code !== 0) return { ok: false, error: lastError(code) }
      const list = out[0]
      const windows: import('./protocol.ts').WindowInfo[] = []
      try {
        const count = ad_window_count(list)
        const expected = koffi.sizeof(ExactWindowInfo)
        for (let index = 0; index < count; index += 1) {
          const raw = koffi.decode(ad_window_get(list, index), ExactWindowInfo) as {
            size?: number
            window?: {
              id?: string
              title?: string
              app_name?: string
              pid?: number
              bounds?: { x?: number; y?: number; width?: number; height?: number }
              has_bounds?: boolean
              is_focused?: boolean
            }
          }
          // A different struct size means the library grew the record: skip rather than
          // read fields at the wrong offset.
          if (raw.size !== expected || raw.window === undefined) continue
          const info = raw.window
          const box = info.bounds
          const hasBounds = info.has_bounds === true && box !== undefined
            && Number.isFinite(box.x) && Number.isFinite(box.y)
            && Number.isFinite(box.width) && Number.isFinite(box.height)
            && (box.width ?? 0) > 0 && (box.height ?? 0) > 0
          if (app !== '' && (info.app_name ?? '') !== app) continue
          windows.push({
            id: info.id ?? '',
            title: info.title ?? '',
            appName: info.app_name ?? '',
            pid: info.pid ?? 0,
            focused: info.is_focused === true,
            ...hasBounds
              ? { bounds: { x: box.x ?? 0, y: box.y ?? 0, width: box.width ?? 0, height: box.height ?? 0 } }
              : {},
          })
        }
      } finally {
        ad_window_free(list)
      }
      return { ok: true, windows }
    },
    idleMs,
  }
}

const DELIVERY_NAMES = ['unknown', 'not_delivered', 'delivery_uncertain', 'delivered_unverified', 'delivered_verified']
const RETRY_NAMES = ['unknown', 'safe', 'unsafe']

function deliveryName(value: number): string {
  return DELIVERY_NAMES[value] ?? 'unknown'
}

function retryName(value: number): string {
  return RETRY_NAMES[value] ?? 'unknown'
}

/**
 * Build a reader for milliseconds since the last user input, binding the platform
 * symbol once. Returns undefined when the platform cannot answer.
 * This reads only a system-wide counter; it sees no keystrokes or content.
 */
function createIdleReader(koffi: Koffi): (() => number | undefined) | undefined {
  try {
    if (process.platform === 'darwin') {
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
      const seconds = cg.func('double CGEventSourceSecondsSinceLastEventType(int32_t state, uint32_t eventType)')
      return () => {
        try {
          const value = Number(seconds(0, 0xffffffff))
          return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : undefined
        } catch {
          return undefined
        }
      }
    }
    if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll')
      const kernel32 = koffi.load('kernel32.dll')
      const LastInputInfo = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' })
      const getLastInputInfo = user32.func('bool GetLastInputInfo(_Inout_ LASTINPUTINFO *info)')
      const getTickCount64 = kernel32.func('uint64_t GetTickCount64(void)')
      const size = koffi.sizeof(LastInputInfo)
      return () => {
        try {
          const info = { cbSize: size, dwTime: 0 }
          if (!getLastInputInfo(info)) return undefined
          const now = Number(getTickCount64()) & 0xffffffff
          return ((now - (info.dwTime >>> 0)) >>> 0)
        } catch {
          return undefined
        }
      }
    }
  } catch {
    // No counter on this platform: the caller treats presence as unknown.
  }
  return undefined
}