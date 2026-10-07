# dsh-orb 架构

> 实施蓝图。为什么这样做见 [01-analysis.md](01-analysis.md)，分几步做见 [03-plan.md](03-plan.md)。
> 源仓库指 fork `mini-yifan/deepseek-harness-orb`。本仓库是插件 monorepo，不修改源仓库。

## 1. 进程

```
官方 deepseek-harness（不改）
├─ Electron 壳（官方主窗口、dsh://open、单实例）
│    └─ spawn Host（ELECTRON_RUN_AS_NODE=1）
│         ├─ 官方 cordis 树
│         └─ 我们的插件
│              ├─ dsh-orb/host
│              │    会话、权限、坐标、后台模型、web 路由、helper 生命周期、划词监控
│              ├─ computer-use 工具与 code_agent（挂在 computer-use preset 上）
│              └─ 设置页 client 插件
│
helper（我们下载的 Electron，独立 userData）
├─ 球窗口
├─ 划词工具条
├─ 观察边框
└─ preload + 页面
     数据请求转到官方 Host 的鉴权 loopback URL
```

`dsh web` 没有上面那层官方壳。Host 由 CLI 拉起，helper 仍然是我们下载的那份 Electron。

helper 不使用 `/Applications/DeepSeek Harness.app` 里的可执行文件。那份文件会启动官方应用自己的 `app.asar`，并走 `requestSingleInstanceLock`。

## 2. 包

用户只安装一个 bundle：`dsh-orb`。装上它就同时得到 Computer Use preset 和悬浮球。

| 包 | 名称 | 形态 | 职责 |
|---|---|---|---|
| `packages/overlay` | `@dsh-orb/overlay` | 类型 | Host 与 helper 之间的窗口控制类型。无运行时 |
| `packages/computer-use` | `@dsh-orb/computer-use` | cordis 插件 | vendor 自 `tool-computer-use`。13 个 GUI 工具、`code_agent`、macOS `screencapture` / `osascript`、Windows koffi。去掉 `private`，保留 `./code-agent` |
| `packages/host` | `@dsh-orb/host` | cordis 插件 | 见 §3 |
| `packages/helper` | `@dsh-orb/helper` | Electron 入口 | 球、工具条、观察框、preload、页面 |
| `packages/native-selection` | `@dsh-orb/native-selection` | 原生模块 | macOS 划词（napi + Swift）。Windows 划词继续用 koffi，不必单独预编译 |
| `packages/client-settings` | `@dsh-orb/client-ui-settings-orb` | client 插件 | 主窗口「悬浮球」设置。`desktop-api.ts` 改为请求 Host 的 HTTP |
| `packages/bundle` | `dsh-orb` | bundle | 唯一发布给用户安装的包，也是设置页 client 插件本身。`scripts/assemble.mjs` 把其余包的构建产物收进 `dsh-orb/dist`。patch 插入 preset、host、设置页 |

除 `dsh-orb` 以外的 `@dsh-orb/*` 都只是工作区里的源码包，`private`，不发布，也不会出现在用户的 `node_modules`。原因：官方加载器（`readPluginMeta`、`manifestOf`、`dsh-client-modules` 的 `resolveMeta`）总是从 profile 根目录解析 patch 里的包名。嵌在 `dsh-orb/node_modules` 里的子包，或者 `link:` 安装时不会被安装的依赖，都解析不到。所以用户只装一个包，各部分用子路径导出：

| patch 里的名字 | 指向 |
|---|---|
| `dsh-orb` | `lib/index.js`（设置页 Host 半边）。`./client` 是浏览器半边，模块 id 也是 `dsh-orb` |
| `dsh-orb/host` | `dist/host/index.js` |
| `dsh-orb/computer-use` | `dist/computer-use/index.js`，旁边是 ScreenCaptureKit 二进制 |
| `dsh-orb/computer-use/code-agent` | `dist/computer-use/code-agent.js` |

helper 在 `dist/helper`，划词监控在 `dist/native-selection`。Host 用相对路径找它们，工作区里回退到按包名解析。`lib/`、`dist/`、`client.js` 都是 `pnpm build` 生成的，不提交。

阶段 1 可以先发一个只有 preset 的 `dsh-computer-use` bundle，用来在没有球的时候验证工具。阶段 2 把这条 preset 收进 `dsh-orb`，避免两个 bundle 插入同一个 `preset-computer-use`。用户文档只保留 `dsh plugin add dsh-orb`。

`@deepseek-ai/dsh-*` 依赖范围是 `>=0.1.7-rc.2 <0.3.0-0`。代码按 `0.1.7-rc.2` 编译。上限写成 `<0.3.0-0`，这样 `0.3.0-rc.1` 不会被算进兼容范围。发布前确认 npm 上无 scope 的 `dsh-orb` 是否被占用；被占用就换名，文档里的职责不变。因为只发布这一个包，`@dsh-orb` scope 不需要注册。

## 3. 从 fork 搬什么

### 3.1 进 `@dsh-orb/host`

| 源文件 | 处理 |
|---|---|
| `apps/desktop-host/src/computer-use-orb-permission.ts` | 原样搬。Access 预设 |
| `apps/desktop-host/src/computer-use-orb-coordinate-mode.ts` | 原样搬。千分比 / 像素 |
| `apps/desktop-host/src/computer-use-orb-code-agent-model.ts` | 原样搬。后台轨模型 |
| `apps/desktop/src/orb-permission.ts` | 原样搬。`orb-permission.json`，和上面的服务是存储 / 服务分工 |
| `apps/desktop/src/orb-agent-models.ts` | 原样搬。两条轨的模型选择。Host 自己读写，不再由壳推送 |
| `apps/desktop/src/floating-session.ts` | 原样搬。球会话 id 与 `dsh_orb` 目录 |
| `apps/desktop/src/orb-avatar.ts` | 只留存储和 URL 签发。展示在 helper |
| `apps/desktop/src/tcc.ts` | 状态查询留在 Host。采集和点击发生在 Host 进程，权限属于官方应用或终端 |
| `apps/desktop/src/selection-monitor.ts` 与工具条的配置读写 | 监控和配置在 Host。窗口在 helper |
| `apps/desktop-host/src/remote-stream-route.ts` | 作为写法参考。在 `ctx.webServer` 上注册 `/.dsh/remote-stream`，内部调用官方 `typertGateway` |
| `apps/desktop/src/millifraction-coordinates*.ts` | 服务已在坐标插件里。菜单和设置走 helper / 设置页 |

不搬 `apps/desktop-host/src/computer-use-preset-root.ts`。它是旧的目录定位器。preset 的显示名写进声明行的 `config.name`。

`computer-use-overlay-guard.ts` 里 Host 向官方壳要窗口 id 的 IPC 删掉。Host 仍向工具提供 `computerUseOverlayGuard`：`withCapture` 是空操作（窗口采集排除由 helper 自己做），`withInput` 通知 helper 在点击期间让球穿透，`setObservationFrame` 通知 helper 显示或隐藏边框。

### 3.2 进 `@dsh-orb/helper`

| 源文件 | 处理 |
|---|---|
| `apps/desktop/src/floating-window.ts` | 去掉对官方 `main`、`ipc`、`paths` 的依赖。`presentOverlayWindow` 一并搬，工具条和观察框复用它 |
| `apps/desktop/renderer/floating.html`、`floating.css`、`floating.js` | 页面搬进来，改成 helper 自己的 `shell.js`。不嵌官方 SPA，所以不复刻 `window.dshDesktop` |
| `apps/desktop/src/preload.ts` | 不按原 API 整份复刻。球的 preload 暴露 `window.dshOrb`。划词工具条用另一份 preload，只暴露 `selection` |
| `apps/desktop/src/floating-agent-menu.ts` | `quit` 改为停用悬浮球。`focusMain` 在 macOS 上打开 `dsh://open` |
| `selection-toolbar-window.ts`、`observation-frame-window.ts` 及对应 renderer | 原样搬 |
| 头像 GIF 等静态资源 | 原样搬 |

preload 里需要跨进程的成员走控制 socket，问 Host：会话、权限、模型、TCC 状态、划词动作。窗口几何、展开、穿透、编辑态留在 helper 进程内。

球的页面是 helper 自己的，不是官方主窗口那一页，所以 API 叫 `window.dshOrb`，不叫 `dshDesktop`。官方主窗口的 preload 我们改不了。设置页不靠这个对象，走 HTTP。

对话记录做在 helper 页面里。Host 读官方会话存储，经控制 socket 把块推过来。不装 `ui-overlay-chat`，也不请求 `index.html?surface=overlay`。头像由 Host 存文件；helper 带本次 token 去取，再交给页面。页面的 CSP 不允许它自己去打带凭据的地址。

### 3.3 进 `@dsh-orb/computer-use`

整个 `packages/experimental/tool-computer-use`，包含 `presets/`、Swift 源和 `libmacos-sck-capture.dylib`。macOS 常规路径不加载这只 dylib。dylib 留在包里，供阶段 4 若要在 helper 里走 ScreenCaptureKit 时使用。

`presets/computer-use/preset.yml` 的 `name` 和 `description` 写到 bundle 的声明行上。目录本身不再被官方扫描。

### 3.4 不搬

官方壳的启动、更新、账号、单实例、welcome。fork 自己的 `update-*` 更新器也不搬，插件用 npm 版本升级。

fork 对 `packages/client/ui-layout`、`packages/client/ui-chat`、`packages/api/session-controller`、`packages/bundle/web-app/cordis.patch.yml` 的修改不搬。那些是官方包里的 Orb 补丁。

## 4. helper 怎么启动

`@dsh-orb/host` 在 `apply` 时，若 `autoStart` 为真，按这个顺序找 Electron：

1. 环境变量 `DSH_ORB_ELECTRON_PATH` 指向一个未打包的 Electron 可执行文件。开发时用。
2. 已经下载过的副本：`dshHomePath('dsh-orb', 'electron-runtime')`。
3. 否则从 Electron 的官方发布物下载与我们锁定的版本一致的 dist zip。源码里钉死了该版本 darwin、win32、linux 的 arm64 和 x64 共六个包的 SHA256。下载到的 `SHASUMS256.txt` 必须和钉死的值一致，zip 再对这个值校验。桌面版和 `dsh web` 走同一步。语音输入 bundle 的「首次使用再下载运行时」是这个模式的先例。

启动参数：

- 入口是 helper 的主脚本。
- `--user-data-dir` 指向 `dshHome/dsh-orb/helper-data`，避开官方应用的单实例锁和存储。
- 环境里不要带 `ELECTRON_RUN_AS_NODE`。
- `DSH_ORB_SOCKET` 和 `DSH_ORB_TOKEN` 放在环境变量里，不放 argv。

helper 启动后调用 `app.setActivationPolicy('accessory')`（macOS）并隐藏 Dock 图标。窗口使用 `setContentProtection(true)`：macOS 上这是 `NSWindowSharingNone`，Windows 上是 `WDA_EXCLUDEFROMCAPTURE`。这样 Host 的 `screencapture` 看不到球。阶段 4 用一次真实截图确认。

若 content protection 挡不住 `screencapture`，再把 ScreenCaptureKit 挪进 helper。helper 是完整 Electron，有 Cocoa 事件循环。不要在 Host 的 Node 模式里调用这只 dylib，那次调用会卡住。

## 5. 通信

### 5.1 控制面

Host 听 `127.0.0.1:0`，生成本次启动专用的 32 字节 token，经环境变量交给 helper。协议是 NDJSON。内容是建窗、几何、穿透、观察框、菜单动作、TCC 状态、划词事件。token 不落盘、不进 argv。

### 5.2 数据面

Host 在自己的进程里读 `ctx.sessionController` 和会话存储，不把带凭据的 URL 交给 helper。球的发送、历史、模型、权限都是控制 socket 上的一条消息。转录用大约 400ms 的轮询把新事件推到球上，不走官方的 `$events` 流。轮询够用，也避免 helper 持有鉴权 URL。

设置读写和头像下载用 `ctx.webServer.register` 挂在官方端口上。头像请求要带本次启动的 token 头。

权限文件 `orb-permission.json` 不存在时用完全访问，因为球的主要用途是操作界面。文件在但读不出来或取值非法时，降为工作区内修改，并在设置页提示。

球正在显示提问卡时，helper 断开或 Host 停掉球，这道题交回主窗口回答，不直接拒绝。用户点放弃，或提问被 abort，才拒绝。

Windows 划词的低级钩子装在 worker 线程里，由那个线程跑 `GetMessageW`。Host 的主线程没有 Windows 消息循环。

### 5.3 设置页

fork 的设置页通过 `window.dshDesktop.orb` 读写。官方主窗口没有这个对象，设置节会消失。

client 插件改为 `fetch` 上面的路由。类型 `OrbSettingsSnapshot`、`TccStatus` 保持不变。选择头像时，页面用 `<input type="file">` 上传；桌面端也可以让 helper 打开系统文件框，再走同一条上传路由。

设置项：头像、两条轨的模型、划词开关、千分比开关、TCC 状态。

## 6. 看门狗

| 事件 | 行为 |
|---|---|
| 插件卸载或 Host 正常退出 | disposer 结束 helper |
| 控制面 socket 断开 | helper 自行退出。Host 崩溃和卸载都走这里 |
| helper 非预期退出 | Host 记日志，最多重试 3 次。仍失败则球不出现，Computer Use 在主窗口里仍可用，并通过事件提示 |
| 官方应用退出 | Host 退出，socket 断开，helper 退出 |

没有「关掉主窗口但进程继续活着，只能从球里退出」这套语义。那是独立 Orb 应用的行为。

## 7. bundle patch

`dsh-orb` 的 `cordis.patch.yml` 插入下面三行。`plugins` 不在这里展开：从源仓库 `packages/experimental/tool-computer-use/cordis.patch.yml` 整段搬来，把其中的包名改成 `dsh-orb/computer-use` 和 `dsh-orb/computer-use/code-agent`。显示名和说明用这里写的中文，不用再读 `preset.yml`。

```yaml
- insert:
    - id: preset-computer-use
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: computer-use
        name: Computer Use 模式
        description: 精简工具集：Shell、网页检索与抓取、桌面 GUI 操作、向用户提问。
        order: 20
        plugins: []   # 实施时替换为源 patch 里的插件列表
    - id: orb-host
      name: 'dsh-orb/host'
      config:
        autoStart: true
    - id: ui-settings-orb
      name: dsh-orb
```

GUI 工具只出现在 `computer-use` 这个 preset 上，不写进官方默认的 `standard` preset。

不要 patch 官方 webserver 的 `listen`。官方桌面和 `dsh web` 本来就在听 TCP。fork 里曾经计划的 `listen: false` 和 `desktop-fetch.ts` 不是当前官方，也不是当前 fork 主路径的运行方式。

## 8. 窗口控制类型

`@dsh-orb/overlay` 只描述 Host 里的服务。Provider 由 `@dsh-orb/host` 实现，真正的 `BrowserWindow` 在 helper。

```ts
interface OrbOverlay {
  create(spec: OverlaySpec): Promise<OverlayHandle>
  requestPermission(kind: 'screen' | 'accessibility'): Promise<PermissionState>
  queryPermission(kind: 'screen' | 'accessibility'): PermissionState
}

interface OverlaySpec {
  kind: 'ball' | 'selection-toolbar' | 'observation-frame'
  url: string
  bounds: Rect
  alwaysOnTop: boolean
  transparent: boolean
  contentProtection: boolean
  clickThrough?: boolean
  dock?: { edge: 'left' | 'right'; collapsedWidth: number }
}
```

悬浮球吸边:拖动松手时球一接触屏幕左右边缘即停靠,判定带 `DOCK_OVERLAP`(3 DIP)容差。Windows 把窗口 bounds 量化到整数设备像素,`物理宽 / scaleFactor` 不是整数时(1920/1.5、2560/1.25、3840/1.75),贴到屏幕边的球会报告差 1–2 DIP——严格 `>=` 比较于是只在 100%/200% 缩放的机器上成立,这正是「我能吸、别人不能吸」的来源。判定同时采信两路球原点——主进程窗口 bounds 派生的位置与渲染端拖动坐标(`orb:clamp` 的 `origin` 字段),任一触边即吸,以规避 Windows 每显示器 DPI 下窗口 bounds 与输入坐标不一致的问题(electron#10862)。渲染端的拖动坐标由「主进程回报的窗口原点(`orb:origin`) + `clientX/Y`」算出,不用 `event.screenX`——后者按 Chromium 缓存的窗口原点计算,窗口正在被移动时会给出过期值,这是拖动跳跃的根源;`pointermove` 按帧合并成一次 `orb:move`,一次手势期间 enter/leave 不改变面板展开态。设 `DSH_ORB_DOCK_DEBUG=1` 后每次松手向 stderr 输出一行 `[orb-dock]` 诊断日志,记录窗口 bounds、渲染端原点、各显示器 scaleFactor 与停靠结果,供无法复现的 DPI/多屏布局定位。

划词监控不进这个接口。它在 Host 里跑，把「选中的文字 + 屏幕坐标」发给 helper。

## 9. 打开主窗口

macOS：helper 执行 `open dsh://open`。官方打包应用已 `setAsDefaultProtocolClient('dsh')`，`open-url` 里这个地址会聚焦主窗口。

Windows：启动 `dsh://open`。官方单实例的 `second-instance` 会聚焦主窗口。

`dsh web` 没有桌面主窗口时，菜单项不可用。
