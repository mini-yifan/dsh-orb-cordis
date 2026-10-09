declare module 'electron' {
  interface Rectangle {
    x: number
    y: number
    width: number
    height: number
  }

  interface Display {
    bounds: Rectangle
    workArea: Rectangle
    scaleFactor: number
  }

  interface WebContents {
    send(channel: string, ...args: unknown[]): void
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate' | 'did-finish-load' | 'context-menu', listener: (event: { preventDefault(): void }, params?: { isEditable?: boolean; hasSelection?: boolean }) => void): void
    executeJavaScript(code: string): Promise<unknown>
    session: {
      setPermissionRequestHandler(handler: (contents: WebContents, permission: string, callback: (granted: boolean) => void) => void): void
    }
  }

  interface BrowserWindow {
    loadFile(path: string): Promise<void>
    setContentProtection(enable: boolean): void
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void
    setBounds(bounds: Rectangle): void
    getBounds(): Rectangle
    getNativeWindowHandle(): Buffer
    isVisible(): boolean
    isDestroyed(): boolean
    showInactive(): void
    hide(): void
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
    blur(): void
    once(event: 'ready-to-show', listener: () => void): void
    on(event: 'closed', listener: () => void): void
    webContents: WebContents
  }

  interface BrowserWindowOptions {
    title?: string
    x?: number
    y?: number
    width?: number
    height?: number
    frame?: boolean
    transparent?: boolean
    alwaysOnTop?: boolean
    resizable?: boolean
    movable?: boolean
    minimizable?: boolean
    maximizable?: boolean
    fullscreenable?: boolean
    skipTaskbar?: boolean
    hasShadow?: boolean
    focusable?: boolean
    show?: boolean
    backgroundColor?: string
    roundedCorners?: boolean
    /** Windows only. `false` drops the resize border on a frameless window. */
    thickFrame?: boolean
    type?: string
    webPreferences?: {
      preload?: string
      contextIsolation?: boolean
      nodeIntegration?: boolean
      sandbox?: boolean
    }
  }

  export const BrowserWindow: new (options: BrowserWindowOptions) => BrowserWindow

  export const app: {
    whenReady(): Promise<void>
    quit(): void
    exit(code: number): void
    getLocale?(): string
    setActivationPolicy?(policy: 'accessory'): void
    dock?: { hide(): void }
    on(event: 'before-quit' | 'window-all-closed', listener: () => void): void
  }

  export interface MenuItemOptions {
    label?: string
    type?: 'checkbox' | 'radio' | 'separator' | 'normal'
    checked?: boolean
    enabled?: boolean
    submenu?: MenuItemOptions[]
    click?: (item: { checked: boolean }) => void
  }

  export interface Menu {
    popup(options?: { window?: BrowserWindow }): void
  }

  export const Menu: {
    buildFromTemplate(template: readonly MenuItemOptions[]): Menu
  }

  export interface NativeImage {
    resize(options: { width: number; height: number }): NativeImage
    isEmpty(): boolean
  }

  export const nativeImage: {
    createFromPath(path: string): NativeImage
  }

  export const Tray: new (image: NativeImage) => {
    setToolTip(toolTip: string): void
    setContextMenu(menu: Menu): void
    destroy(): void
  }

  export const dialog: {
    showMessageBox(window: BrowserWindow, options: {
      type?: string
      message: string
      detail?: string
      buttons?: string[]
      defaultId?: number
      cancelId?: number
      noLink?: boolean
    }): Promise<{ response: number }>
  }

  export const screen: {
    getPrimaryDisplay(): Display
    getAllDisplays(): Display[]
    getDisplayNearestPoint(point: { x: number; y: number }): Display
    /** Absolute cursor position in DIPs, the same space `BrowserWindow` bounds use. */
    getCursorScreenPoint(): { x: number; y: number }
    screenToDipRect(window: null, rect: Rectangle): Rectangle
  }

  export const ipcMain: {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  }

  export const shell: {
    openExternal(url: string, options?: { activate?: boolean }): Promise<void>
  }

  export const clipboard: {
    writeText(text: string): void
    readText(): string
  }

  export const nativeTheme: {
    themeSource: 'light' | 'dark' | 'system'
    shouldUseDarkColors: boolean
    on(event: 'updated', listener: () => void): void
  }
}
