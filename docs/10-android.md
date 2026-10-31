# dsh-orb 手机版：可行性讨论与 MVP 方案

> 状态：讨论稿，未开始实施。记录 2026-10-31 的讨论结论，供研发对齐。
> 关联：[01-analysis.md](01-analysis.md)（桌面版可行性）、[02-architecture.md](02-architecture.md)（桌面版架构）、[04-addenda.md](04-addenda.md)（修订记录）。

---

## 1. 产品目标

### 1.1 一句话

**一个能看见你此刻屏幕上有什么、并且能动手解决的手机助手。**

### 1.2 和「操作手机的 Agent」的区别

这一点决定了后面全部技术选型，必须先对齐：

| | dsh-go / Mika / 本插件的桌面版 | **本项目手机版** |
|---|---|---|
| 目标 | 完成一个任务 | **解决眼前这一屏** |
| 观察的地位 | 手段，够用就行 | **本体，必须第一手且完整** |
| 观察失败时 | 换手段（a11y 读不出就补截图） | **没有退路，第一手就得对** |

产品初衷是**快**。所以：

> **无障碍树不该拿来当眼睛，只该拿来当手。**

用 a11y 的节点树去描述屏幕给模型看，是错的方向，也是慢的来源。正确的关系是：

```
感知层（看懂屏幕）      →  视觉，第一手，永远先给截图
执行层（精确点到控件）   →  无障碍树/元素，用来把「发送按钮」解析成准确坐标
```

**a11y 失败后再补截图**这条路要明确排除：那等于一次失败探测 + 一次有效探测，两倍延迟；而对「屏幕上是张高数题图片」这类招牌场景，a11y 永远读不出内容（只看到无文本的 `ImageView`），那条「退路」根本不存在。

### 1.3 目标交互（原始设想）

用户当前在微信消息页 → 对悬浮球说「帮我回一条消息」→ Agent 同时收到【用户的话 + 一张当前屏幕截图】→ 开始操作手机。

设想中还有一个「原地变虚拟屏」的形态：用户眼前这块屏本身变成虚拟屏，屏幕边缘出现彩条（有彩条 = 虚拟屏，无彩条 = 真实屏），用户可随时切走虚拟屏去用手机，Agent 在虚拟屏上继续干活，球和对话面板全程可见。

**这个形态已决定暂缓**，原因见 §4。

---

## 2. 现状：本插件在手机上为什么跑不起来

结论：**不是「不能跑」，而是 UI 层和感知执行层同时落地才有意义，而这两层都绑死在桌面运行时上。**

上游版本对齐没问题：dsh-go 本地引擎自带 **DSH 0.2.1-rc.4**，落在本插件声明的兼容区间 `>=0.1.7-rc.2 <0.3.0-0` 内。`ctx.tools.register`、agent preset、system prompt section **都能正常注册**，不受 dsh-go 限制。

### 墙 1：helper 运行时没有 Android 目标

```22:29:packages/host/src/electron-runtime.ts
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  'electron-v44.0.0-darwin-arm64.zip': '...',
  'electron-v44.0.0-darwin-x64.zip': '...',
  'electron-v44.0.0-linux-arm64.zip': '...',
  'electron-v44.0.0-linux-x64.zip': '...',
  'electron-v44.0.0-win32-arm64.zip': '...',
  'electron-v44.0.0-win32-x64.zip': '...',
}
```

**Electron 从来没有 Android 构建。** 这不是漏一个哈希值——整个浮球窗口（`packages/helper`，2559 行：球窗口、观察边框、cloak、Shiki/KaTeX 渲染）在 Android 上无运行时可用。

链式后果：`orb-host` 的 `autoStart: true` → 下载 helper → 失败 → 看门狗重试 3 次 → 球永远不出现。而球是产品入口，没有球等于没装。

### 墙 2：`createPlatformBackend` 只有两个分支

```285:292:packages/computer-use/src/backend.ts
export function createPlatformBackend(
  platform: NodeJS.Platform = process.platform,
  excludedRegionCapture?: OverlayExcludedRegionCapture,
): DesktopBackend {
  if (platform === 'darwin') return createMacosDesktopBackend(undefined, excludedRegionCapture)
  if (platform === 'win32') return createWindowsDesktopBackend()
  return createUnsupportedDesktopBackend()
}
```

Android 落到 `createUnsupportedDesktopBackend()`，**每个 GUI 工具在 execute 时抛错**。插件本身能正常加载（为 Linux CI 留的设计），所以不会崩，但 13 个工具全废。

### 墙 3：感知和执行全绑在桌面 API 上

| 现有依赖 | 位置 | Android |
|---|---|---|
| `/usr/sbin/screencapture -R` | `macos.ts:74` | 不存在 |
| JXA / ObjC `CGWindowListCopyWindowInfo` | `macos.ts:195` | 不存在 |
| `user32` / `gdi32` / `dwmapi` / `shcore` | `windows-native.ts:167-284` | 不存在 |
| koffi 原生 addon | `koffi.ts` | 无 Android 预构建 |
| macOS TCC（屏幕录制 / 辅助功能） | `tcc.ts` | 换 AccessibilityService |

### 墙 4：坐标与前台的「桌面世界观」在手机上不成立

`ScreenInfo.bounds` 定义为「前台 App 的窗口并集在全局逻辑坐标中的矩形」，截图是该矩形的屏幕裁剪。这套模型依赖：

- 多个可重叠窗口（Dock、菜单栏、popover、多显示器）
- 全局桌面坐标系
- 「前台窗口」概念（`FOCUS_NOTE`、`UNFOCUSED_WINDOW_NOTE`）

Android 上：只有一个全屏 Activity、没有全局坐标空间、没有 Dock/菜单栏、没有窗口并集。`list_apps` 的语义（Dock 可见应用）也不存在。

### 墙 5：koffi 静态依赖链（这一条反而是好消息）

`backend.ts` 静态 import 了 `windows.ts`，但真正吃 koffi 的 `windows-native.ts` 是**动态引入**的：

```467:467:packages/computer-use/src/windows.ts
  productionOps ??= (await import('./windows-native.ts')).createProductionWindowsOps()
```

所以 koffi 不会在 Android 上静态炸掉，只在真的走 Windows 路径时才加载。**这一层不用改。**

### 2.1 逐组件失效清单

| 组件 | 状态 | 原因 |
|---|---|---|
| `orb-host` → helper | 完全死 | 无 Electron Android 构建 |
| 浮球窗口 / 观察边框 | 完全死 | 同上 |
| 13 个 GUI 工具 | execute 抛错 | `UNSUPPORTED_DESKTOP_MESSAGE` |
| `code_agent` 后台轨 | **完全可用** | 纯 DSH 会话 API，零平台依赖 |
| `code_agent_status` / `stop` | 可用 | 同上 |
| `bash` | 可跑但语义错位 | PRoot 内的 Ubuntu rootfs，看不见 `/sdcard` 与 Android 文件系统 |
| `screen-owner` / `gui-lock` | 机制可用 | `globalThis` + `Symbol.for` 在 Node 上一样 |
| coordinate-mode 投影 | 可用 | 纯 session 事件 |
| **system prompt 文案** | **严重错位** | 见下 |
| 语音（唤醒/输入/播报） | 死 | `sherpa-onnx-node` + `node-cpal` 无 Android 构建 |
| 划词工具条 | 死 | 已在停用状态 |

### 2.2 最容易被忽略但危害最大：prompt 文案

policy 里大量写死了桌面概念：

```28:28:packages/computer-use/src/policy.ts
If <frontmost_app> or the screenshot is not the application the user asked for, call list_apps or open_app. Do not click the Dock; it is not in the screenshot.
```

还有 `Cmd/Win+Shift+3/4/5`、`open_in_finder with that path`、`<frontmost_folder>`、`Desktop`。

模型拿到这套 prompt 再拿到一张手机截图，会**认真地去点不存在的 Dock**。这比工具报错更糟——它是「看起来在正常工作」的幻觉。

---

## 3. 参考实现调研

### 3.1 dsh-go（`ccch1mneyyy/dsh-go`，AGPL-3.0）

- 本地引擎：PRoot + Ubuntu 24.04 + Node 24 + `@deepseek-ai/dsh@0.2.1-rc.4`
- 手机操控走 **MCP** 暴露：`PhoneGuest.kt` 在每次引擎启动时往 rootfs 写 `relay.cjs` + `phone.patch.yml`，用 `--patch` overlay 把 `@deepseek-ai/dsh-mcp-client` 挂成 server `phone`，模型看到 `mcp__phone__*`
- 桥：abstract unix socket + `SO_PEERCRED` 同 uid 校验 + 每次启动随机 token；proot 会透传 abstract 地址，所以 rootfs 里的 Node 能连出来
- 工具是**元素 ID 优先**：`screen` 给带编号的界面树，`image:true` 时额外附一张画了元素编号的 JPEG（长边 ≤1300px）
- 虚拟屏（不打扰模式）：shell uid 下 `createVirtualDisplay`，输出到 `ImageReader`
- 插件协议 `overlay` 能力**明确不含跨 App 悬浮**：`overlay` = 一行悬浮字幕，**App 画在自己的界面上（不覆盖其他 App）**

### 3.2 Mika（`wangzan101/Mika`，Apache-2.0）

- `AgentDisplay`：虚拟屏 + `ImageReader`，帧处理限速 ≤10 帧/秒，预览缩到宽 ≤360
- `ShellService.moveTask` 调 `moveRootTaskToDisplay`，失败回落 `am display move-stack`——**「把真 App 的 task 从主屏搬到虚拟屏」是真实存在的原子操作**
- 虚拟屏 flags 包含 `PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH|TRUSTED|OWN_FOCUS|STEAL_TOP_FOCUS_DISABLED` 等
- 悬浮胶囊 + 后台屏 + 接管/交还的完整产品形态

### 3.3 关键结论

| | 虚拟屏对用户 | 用户当前屏 |
|---|---|---|
| dsh-go 不打扰模式 | 永远不可见 | 真屏，随便用 |
| Mika 后台屏 | 永远不可见，只有缩略预览 | 真屏，随便用 |
| （原设想） | **就是用户眼前这块** | **就是虚拟屏** |

**「原地变虚拟屏」在现有实现里没有先例。**

---

## 4. 虚拟屏方案：为什么不做了

### 4.1 可行的部分

- 屏能建（`createVirtualDisplay`）
- 真 App 能搬进去（`moveRootTaskToDisplay`），不需要重启 App，**内容连续性成立**
- Agent 能截图、能注入

### 4.2 卡住的部分

两个参考实现都把虚拟屏输出接到 `ImageReader`——一个**离屏缓冲区**，因为它们的虚拟屏对用户永远不可见：

```201:201:app/android/.../phone/background/PrivilegedDisplayCore.kt
val ir = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
```

而「原地变虚拟屏」要求虚拟屏内容**出现在物理屏上**。这触到 Android 显示层的硬规则：

> 一个 display 的内容只会渲染到它自己的输出 Surface 上。`DEFAULT_DISPLAY` 的输出 Surface 由 SurfaceFlinger 独占，第三方（包括 shell uid）无法把另一个 display 的画面「接到」主屏上。

`VIRTUAL_DISPLAY_FLAG_PUBLIC` 能让虚拟屏被系统认可，但不会让物理屏显示它。**物理屏永远显示 `DEFAULT_DISPLAY`。**

### 4.3 唯一可行的实现：镜像法

```
1. 建虚拟屏（离屏 ImageReader）              ~300–800ms
2. 把目标 App 的 task moveRootTaskToDisplay   ~200–500ms
3. 起全屏 SYSTEM_ALERT_WINDOW 覆盖真实屏
4. 每帧从 ImageReader 取出 → 画到悬浮窗      持续
5. 用户触摸 → 转成注入事件送回虚拟屏          持续
```

本质是**云游戏客户端**，不是显示切换。代价：

| 项目 | 现实 |
|---|---|
| 延迟 | ImageReader → Bitmap → Canvas 上屏，至少 2–3 帧，30–60ms 起，滚动有拖影 |
| 交互 | 每次触摸都要转发注入；**输入法无法工作**（IME 不会弹到镜像上） |
| 性能 | 全屏每帧重绘 + 高 DPI 位图拷贝，中端机发热明显 |
| 兼容 | 部分 ROM 拒绝 `PUBLIC` + `TRUSTED` 组合；MIUI/ColorOS 行为各异 |

Mika 的限速注释恰好印证成本：**≤10 帧/秒**——给 Agent 看够了，给用户看是幻灯片。

### 4.4 决策

**镜像法能做出要的效果，但做不出要的体验。** 它引入一次约 1 秒的交接、持续渲染开销、触摸延迟和输入法失效——三者叠加会让「帮我回一条微信」比用户自己打字还慢，与产品初衷相反。

**决定：手机版 MVP 放弃虚拟屏，Agent 直接在当前真实屏上操作。**

### 4.5 由此带来的语义变化（需产品确认）

| | 虚拟屏方案 | 无虚拟屏方案 |
|---|---|---|
| 有彩条 | 你在看虚拟屏 | **Agent 正在操作你眼前这块屏** |
| 无彩条 | 你在真屏 | Agent 空闲 / 只在思考 |

彩条从「屏幕归属指示器」变成「**Agent 是否正在动手机**」的活动指示器。

代价：**Agent 操作时用户不能同时用手机。** MVP 接受，用户可随时通过悬浮条暂停/停止夺回控制权。

> 后续若恢复虚拟屏，建议改成**用户主动触发**：默认后台屏 + 球上缩略预览；用户点「看它操作」才切镜像模式。这样开销只在需要时发生，且彩条语义更准（有彩条 = 你的触摸是给 Agent 的）。

---

## 5. MVP 方案

### 5.1 关键红利：只需无障碍，不需要 ADB

核实 dsh-go 前台实现，两个关键动作都只依赖 `AccessibilityService`：

**截图**——不需要 MediaProjection：
```49:53:.../phone/a11y/ScreenShooter.kt
val raw = if (useWindow) capture(timeoutMs) { cb -> service.takeScreenshotOfWindow(window.id, executor, cb) }
else {
    overlay.hideForCapture(true)
    try { capture(timeoutMs) { cb -> service.takeScreenshot(Display.DEFAULT_DISPLAY, executor, cb) } }
    finally { overlay.hideForCapture(false) }
}
```

**点击**——`dispatchGesture`，标准 a11y API：
```96:96:.../phone/a11y/Actuator.kt
val sent = service.dispatchGesture(description, object : AccessibilityService.GestureResultCallback() {
```

**结论：MVP 权限门槛 = 悬浮窗权限 + 无障碍权限。两步，普通用户自己就能开，不用开发者选项、不用无线调试、不用 Shizuku。**

而且 `hideForCapture` 直接解决了「球不进截图」的需求。

### 5.2 架构：Android 侧只做手脚，大脑留在 Node

```
Android 侧（原生）            PRoot 侧（Node）
┌──────────────┐            ┌──────────────────┐
│ 悬浮球 + 面板 │            │ dsh-orb 插件      │
│ a11y 服务     │◄─ socket ─►│ computer-use     │
│ 截图 / 注入   │            │ policy / tools   │
└──────────────┘            └──────────────────┘
```

- **Android 侧**：悬浮窗、a11y 服务、截图、手势注入
- **Node 侧**：工具定义、policy、坐标校验、`screen-owner`、`gui-lock`、`code_agent`

这样 **90% 现有代码不用动**（`plugin.ts` 1143 行、`policy.ts`、`coordinates.ts`、`screen-owner.ts`、`gui-lock.ts`、`code-agent.ts`），只需要把 `DesktopBackend` 的实现换成「转发给 Android」。

**改的是 15 个方法，不是 8544 行。**

### 5.3 `DesktopBackend` 接口映射

`DesktopBackend` 共 15 个方法，Android 全部可实现：

| 方法 | Android 实现 |
|---|---|
| `listScreens` | 返回单屏 + `DisplayMetrics` |
| `capture` | `takeScreenshot(DEFAULT_DISPLAY)` / `takeScreenshotOfWindow` |
| `inspectForeground` | 当前 foreground package + activity label |
| `listApps` | `PackageManager` 查 launcher 可见应用 |
| `openApp` | `Intent` + 包名 |
| `click` / `longPress` / `drag` | `dispatchGesture` |
| `typeText` | `ACTION_SET_TEXT` on focused node |
| `scroll` | `ACTION_SCROLL_FORWARD` / `BACKWARD` |
| `hotkey` | 保留，但语义改为 `press(back/home/recents)` |
| `openInBrowser` | `ACTION_VIEW` |
| `openInFinder` | **删除**，换 `openPath` |
| `copyImageToClipboard` | `ClipboardManager` |
| `withGuiTurn` | 直接 `run()` |

`unsupported.ts` 就是模板——照着写一个 `android.ts`。

### 5.4 工具集重塑

| 现在 | 手机上 | 说明 |
|---|---|---|
| `click(screen, pos, button, count, modifiers)` | `tap(element_id)` / `tap_xy(x,y)` | 元素优先，坐标兜底 |
| `input_text` | `type(element_id, text, submit)` | `ACTION_SET_TEXT`，不走键盘注入 |
| `scroll` | `scroll(element_id, direction)` | 按可滚动容器，不按坐标 |
| `hotkey(keys)` | **删除** | 拆成 `press(back/home/recents/notifications)` |
| `long_press` | `long_press(element_id)` | |
| `drag` | `drag(from, to)` | `dispatchGesture` |
| `open_in_finder` | **删除** | 改 `pick_file` / `open_path` |
| `open_in_browser` | `ACTION_VIEW` | 保留语义 |
| `list_apps` | `PackageManager` 查询 | launcher 可见应用 |
| `open_app` | `Intent` + 包名 | |
| `wait` / `long_wait` | **保留** | 无改动 |
| `screenshot` | 保留，改 a11y 截图 | 不再写 Desktop + 剪贴板 |
| — | **新增 `intent(kind)`** | alarm/timer/calendar/dial/sms/navigate/share/settings |
| — | **新增 `notify`** | 状态栏通知 |
| — | **新增 `handoff`** | 敏感操作交还用户 |

连带要改：`screen-owner.ts` 的 `DESKTOP_TOOLS` 集合、`coordinates.ts` 的 `CLICK_MODIFIER_KIND`（shift/cmd/option/control 在手机上无意义）、`policy.ts` 全文。

### 5.5 实施步骤

```
Step 0  验证：Android 上能不能跑通 DesktopBackend
        - 写最小 android.ts，只实现 listScreens + capture + click
        - 真机验证：截图 → 模型 → 点击 → 再截图
        - 不碰 UI，纯命令行验证
        ★ 这步通了，后面全是工程量

Step 1  球：原生悬浮窗 + WebView 加载现有 floating.html
        - 先只做：显示 + 输入 + 展示回复
        - 不做：拖拽吸边、语音、桌宠

Step 2  桥：Node ↔ Android socket
        - 参考 dsh-go 的 abstract socket + 同 uid 校验 + 每次启动随机 token
        - 协议用简单 NDJSON

Step 3  工具重塑 + policy 改写
        - 删 hotkey/finder，加 intent/press
        - policy 全文重写（产品差异化的关键）

Step 4  彩条 + 活动指示
```

**Step 0 是唯一的真风险点，建议优先做，一天内可出结果。**

### 5.6 UI 层的复用判断

`packages/helper`（Electron，2559 行）在 Android 零复用，但**渲染层是纯 Web**：

```
packages/helper/assets/floating.html
packages/helper/assets/chat.css
packages/helper/assets/transcript-model.js
packages/helper/assets/vendor/shiki.js
package/helper/assets/vendor/... (KaTeX)
```

可搬进 Android WebView：球的外壳用原生（悬浮窗 + 拖拽 + 贴边），球的**内容**用 WebView 加载现有 HTML/CSS/JS。好处是 Shiki 高亮、KaTeX、流式 transcript 渲染全部保留；坏处是悬浮窗内 WebView 性能一般，与原生输入框配合要调。

备选：纯 Flutter（dsh-go 的选择），体验更原生，但渲染层要重写。

---

## 6. 已知技术约束

### 6.1 截图与悬浮窗的闪烁

`takeScreenshot` 在 API 30–33 是「整屏截图 + 临时隐藏悬浮窗」，API 34+ 才支持 `takeScreenshotOfWindow`。

整屏截图模式下，如果球频繁隐藏/显示，用户会看到球一直在闪。

**设计约束：球的绘制最好和截图区域分离，别让球嵌在截图路径里。** 或截图时用 `setAlpha(0)` 而不是 `View.GONE` 来避免重绘。

### 6.2 截图分辨率 vs token 成本

dsh-go 的策略是长边 ≤1300px、JPEG，为省 token。但本项目的头号场景是**读图片里的题目**——1300px 长边的高数题截图，根号里的上下标、积分上下限、矩阵下标很可能糊到模型读错。

**且模型不会说「我看不清」，它会自信地给出一个错的解。**

建议策略：
- 默认给全屏缩略图（便宜，定位用）
- 模型表示「这块要看清」时，给**局部放大图**（crop 该区域，按原分辨率）
- 或按内容类型：检测到大面积图文区域，直接给高分辨率裁切

### 6.3 许可证边界

| 项目 | 许可证 |
|---|---|
| dsh-go | **AGPL-3.0**（`sdk/`、`examples/` 为 MIT） |
| Mika | Apache-2.0 |
| 本项目 | **MIT** |

**读 dsh-go 的设计思路没问题，直接搬代码会把项目污染成 AGPL。** 若打算复用 `ScreenShooter`、`Actuator`、`UiTree`，需先决定是否接受转 AGPL。Mika 是 Apache-2.0，约束更松但仍有 NOTICE 与专利条款要求。

### 6.4 其他

- `bash` 在 PRoot 内，看不见 `/sdcard` 与 Android 文件系统，语义与桌面版不同
- 语音全套（`sherpa-onnx-node` + `node-cpal`）无 Android 构建，MVP 不做
- 经 DSH Remote 连接时功能裁剪：只能发图片、App 内打不开网页版、插件只能开关

---

## 7. 待决问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | MVP 是否确认放弃虚拟屏、直接在真实屏上操作？ | 决定整个骨架 |
| 2 | 彩条语义改为「Agent 正在动手机」，是否接受？ | 产品表达 |
| 3 | 球的 UI 用 WebView（复用现有渲染）还是 Flutter（重写）？ | 工作量与体验 |
| 4 | 元素 ID 与坐标点击的取舍比例 | 成功率 |
| 5 | 高数题类场景靠局部放大还是整屏高分辨率？ | 招牌场景成败 |
| 6 | 是否接受为复用 dsh-go 代码而转 AGPL？ | 许可证 |
| 7 | 原生能力从哪来：dsh-go 开放 API / 自建轻量原生壳 / 只做「截屏+回答」 | 路线与排期 |

---

## 8. 一句话总结

> 手机版的技术地基是实的（DSH 引擎可用、`DesktopBackend` 接缝干净、无障碍足以支撑截图与点击），真正的阻塞不在算法也不在框架，而在**权限归属**——球、截图、注入都必须由持有 Android 权限的原生层提供，而 DSH 插件跑在 PRoot 里拿不到它们。
>
> 放弃虚拟屏把这个问题的规模从「重写整个 UI 运行时」降到「写一个 15 方法的 backend + 一个悬浮窗」。
