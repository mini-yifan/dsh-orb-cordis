/** Right-click menu for the ball. Model rows come from the host catalog. */

import { modelMenuItems, type MenuCatalog, type MenuItem, type MenuSelection } from './model-menu.ts'

type LassoBallSkin = 'classic' | 'glass' | 'theme' | 'avatar'
type LassoBallPosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

export interface LassoBallMenuState {
  readonly skin: LassoBallSkin
  readonly position: LassoBallPosition
  readonly length: number
  readonly balance: boolean
}

export interface ContextMenuState {
  readonly catalog: MenuCatalog
  readonly overlay: MenuSelection
  readonly background: MenuSelection
  readonly selectionEnabled: boolean
  readonly lassoEnabled: boolean
  readonly lassoBall: LassoBallMenuState
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
  setLassoBall(patch: Partial<LassoBallMenuState>): void
  setMillifraction(enabled: boolean): void
  update(): void
  disable(): void
}

/** The satellite's quick choices; the settings page owns the slider and the preview. */
function lassoBallMenuItems(
  state: ContextMenuState,
  zh: boolean,
  actions: ContextMenuActions,
): MenuItem[] {
  const positions: readonly [LassoBallPosition, string, string][] = [
    ['top-left', '左上', 'Top left'],
    ['top', '正上', 'Top'],
    ['top-right', '右上', 'Top right'],
    ['left', '正左', 'Left'],
    ['right', '正右', 'Right'],
    ['bottom-left', '左下', 'Bottom left'],
    ['bottom', '正下', 'Bottom'],
    ['bottom-right', '右下', 'Bottom right'],
  ]
  const skins: readonly [LassoBallSkin, string, string][] = [
    ['classic', '经典灰', 'Classic gray'],
    ['glass', '磨砂玻璃', 'Frosted glass'],
    ['theme', '主题蓝', 'Theme blue'],
    ['avatar', '跟随头像', 'Follow avatar'],
  ]
  const lengths: readonly [number, string, string][] = [
    [26, '圆形', 'Circle'],
    [36, '稍长', 'Short oval'],
    [46, '长', 'Long oval'],
    [56, '最长', 'Longest'],
  ]
  return [
    {
      label: zh ? '位置' : 'Position',
      submenu: positions.map(([position, labelZh, labelEn]) => ({
        label: zh ? labelZh : labelEn,
        type: 'radio' as const,
        checked: state.lassoBall.position === position,
        click: () => { actions.setLassoBall({ position }) },
      })),
    },
    {
      label: zh ? '皮肤' : 'Skin',
      submenu: skins.map(([skin, labelZh, labelEn]) => ({
        label: zh ? labelZh : labelEn,
        type: 'radio' as const,
        checked: state.lassoBall.skin === skin,
        click: () => { actions.setLassoBall({ skin }) },
      })),
    },
    {
      label: zh ? '长度' : 'Length',
      submenu: lengths.map(([length, labelZh, labelEn]) => ({
        label: `${zh ? labelZh : labelEn} · ${length}px`,
        type: 'radio' as const,
        checked: state.lassoBall.length === length,
        click: () => { actions.setLassoBall({ length }) },
      })),
    },
    {
      label: zh ? '显示余额' : 'Show balance',
      type: 'checkbox',
      checked: state.lassoBall.balance,
      click: (item) => { actions.setLassoBall({ balance: item.checked }) },
    },
    { type: 'separator' },
    {
      label: zh ? '小卫星球设置…' : 'Lasso ball settings…',
      enabled: state.openMain,
      click: () => { actions.openSettings() },
    },
  ]
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
      label: zh ? '小卫星球' : 'Lasso ball',
      submenu: lassoBallMenuItems(state, zh, actions),
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
