/** Right-click menu for the ball. Model rows come from the host catalog. */

import { modelMenuItems, type MenuCatalog, type MenuItem, type MenuSelection } from './model-menu.ts'

export interface ContextMenuState {
  readonly catalog: MenuCatalog
  readonly overlay: MenuSelection
  readonly background: MenuSelection
  readonly millifractionEnabled: boolean
  readonly openMain: boolean
  /** Newer published version, or null when the ball has nothing to offer. */
  readonly update: string | null
}

export interface ContextMenuActions {
  openMain(): void
  setOverlay(selection: MenuSelection): void
  setBackground(selection: MenuSelection): void
  setMillifraction(enabled: boolean): void
  update(): void
  disable(): void
}

/** Labels and actions for the ball menu. The selection toolbar is disabled (buggy) and has no entry here. */
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
      label: zh ? '悬浮球 Agent 设置' : 'Floating-ball Agent settings',
      submenu: modelMenuItems(state.catalog, state.overlay, actions.setOverlay, labels),
    },
    {
      label: zh ? '后台 Agent 设置' : 'Background Agent settings',
      submenu: modelMenuItems(state.catalog, state.background, actions.setBackground, labels),
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
      label: zh ? '关闭悬浮球' : 'Close floating ball',
      click: () => { actions.disable() },
    },
  ]
}

export interface TrayMenuState {
  readonly openMain: boolean
}

export interface TrayMenuActions {
  toggleVisible(): void
  openMain(): void
  disable(): void
}

/**
 * System-tray menu: the one handle that survives a hidden ball or a closed
 * main window — summon, reopen, and stop without the settings page.
 */
export function trayMenuTemplate(state: TrayMenuState, zh: boolean, actions: TrayMenuActions): MenuItem[] {
  return [
    {
      label: zh ? '显示/隐藏悬浮球' : 'Show / Hide Floating Ball',
      click: () => { actions.toggleVisible() },
    },
    {
      label: zh ? '打开主窗口' : 'Open Main Window',
      enabled: state.openMain,
      click: () => { actions.openMain() },
    },
    { type: 'separator' },
    {
      label: zh ? '关闭悬浮球' : 'Close floating ball',
      click: () => { actions.disable() },
    },
  ]
}
