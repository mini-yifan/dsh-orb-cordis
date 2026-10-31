/** Right-click menu for the ball. Model rows come from the host catalog. */

import { modelMenuItems, type MenuCatalog, type MenuItem, type MenuSelection } from './model-menu.ts'

export interface ContextMenuState {
  readonly catalog: MenuCatalog
  readonly overlay: MenuSelection
  readonly background: MenuSelection
  readonly selectionEnabled: boolean
  readonly lassoEnabled: boolean
  readonly millifractionEnabled: boolean
  readonly openMain: boolean
  /** Newer published version, or null when the ball has nothing to offer. */
  readonly update: string | null
}

export interface ContextMenuActions {
  openMain(): void
  openSettings(): void
  setOverlay(selection: MenuSelection): void
  setBackground(selection: MenuSelection): void
  setSelection(enabled: boolean): void
  setLasso(enabled: boolean): void
  setMillifraction(enabled: boolean): void
  update(): void
  disable(): void
}

/** Labels and actions for the ball menu. The selection checkbox writes the preference; the host starts and stops the monitor. */
export function contextMenuTemplate(state: ContextMenuState, zh: boolean, actions: ContextMenuActions): MenuItem[] {
  const labels = {
    empty: zh ? '没有可用的模型。' : 'No models available.',
    defaultEffort: zh ? '默认' : 'Default',
  }
  return [
    {
      label: zh ? '打开主窗口' : 'Open Main Window',
      enabled: state.openMain,
      click: () => { actions.openMain() },
    },
    {
      // The settings panel only exists inside the main window, so this row lives
      // and dies with the same availability flag as the row above.
      label: zh ? '打开悬浮球设置' : 'Open floating-ball settings',
      enabled: state.openMain,
      click: () => { actions.openSettings() },
    },
    {
      label: zh ? '悬浮球 Agent 模型' : 'Floating-ball Agent model',
      submenu: modelMenuItems(state.catalog, state.overlay, actions.setOverlay, labels),
    },
    {
      label: zh ? '后台 Agent 模型' : 'Background Agent model',
      submenu: modelMenuItems(state.catalog, state.background, actions.setBackground, labels),
    },
    {
      label: zh ? '划词工具栏' : 'Selection toolbar',
      type: 'checkbox',
      checked: state.selectionEnabled,
      click: (item) => { actions.setSelection(item.checked) },
    },
    {
      label: zh ? '圈选截图' : 'Lasso screenshot',
      type: 'checkbox',
      checked: state.lassoEnabled,
      click: (item) => { actions.setLasso(item.checked) },
    },
    {
      label: zh ? '千分比坐标' : 'Millifraction coordinates',
      type: 'checkbox',
      checked: state.millifractionEnabled,
      click: (item) => { actions.setMillifraction(item.checked) },
    },
    ...typeof state.update === 'string' && state.update !== '' ? [{
      label: zh ? `更新到 ${state.update}` : `Update to ${state.update}`,
      click: () => { actions.update() },
    }] : [],
    { type: 'separator' },
    {
      label: zh ? '停用悬浮球' : 'Disable floating ball',
      click: () => { actions.disable() },
    },
  ]
}
