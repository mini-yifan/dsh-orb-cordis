export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export type SelectionHelperEvent =
  | { type: 'ready' }
  | { type: 'untrusted' }
  | { type: 'key' }
  | { type: 'dismiss' }
  | { type: 'mouse-down'; x: number; y: number }
  | { type: 'mouse-up'; x: number; y: number }
  | {
    type: 'selection'
    text: string
    bounds?: SelectionRect
    x?: number
    y?: number
    pid?: number
    bundle?: string
  }

export interface SelectionMonitor {
  stop(): void
  setExcludePids(pids: readonly number[]): void
  activatePid(pid: number): void
  /**
   * Whether the toolbar is on screen.
   *
   * While it is hidden the monitor only reports clicks that could raise one; every other
   * key and pointer event would only dismiss a bar that is not there.
   */
  setToolbarVisible(visible: boolean): void
  lastFrontPid(): number | undefined
}

export interface SelectionMonitorHandlers {
  onEvent(event: SelectionHelperEvent): void
}

export function parseSelectionHelperLine(line: string): SelectionHelperEvent | undefined
export function draggedFarEnough(dx: number, dy: number): boolean
export const MIN_DRAG_PX: number
export function startSelectionMonitor(handlers: SelectionMonitorHandlers): SelectionMonitor | undefined
export function selectionRuntimeAvailable(): boolean
export function promptAccessibility(): boolean
export function accessibilityTrusted(): boolean

export interface WindowsSelectionMessage {
  type: 'key' | 'wheel' | 'mouse-down' | 'mouse-up'
  x?: number
  y?: number
  button?: 'left' | 'right' | 'middle'
}

export interface WindowsSelectionProbe {
  readSelection(): Promise<{
    text: string
    pid?: number
    x?: number
    y?: number
    width?: number
    height?: number
  } | undefined>
  activatePid(pid: number): void
}

export function dispatchWindowsSelectionMessage(
  message: WindowsSelectionMessage,
  handlers: SelectionMonitorHandlers,
  probe: WindowsSelectionProbe,
  excluded: ReadonlySet<number>,
  /**
   * Shared staleness counter. `startWindowsSelectionMonitor` passes the one object its hook
   * closes over, so a slow read is dropped when a newer press or release lands. Callers that
   * omit it share the module's own counter.
   */
  reads?: { generation: number },
): void
