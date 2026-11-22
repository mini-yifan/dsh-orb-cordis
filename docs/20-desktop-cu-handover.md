# `dsh-orb-cordis` 近期改动与交接文档

> 日期：2026-11-20  
> 仓库：`dsh-orb-cordis`（本仓库根目录）  
> 分支：`feat/background-desktop`（已同步至 `origin/feat/background-desktop`）  
> 覆盖提交：`6635cfb`、`b32cb47`、`4c30c27`、`3a89f1f`  
> 适用对象：接手后续开发、Windows 同步部署与真机回归的 Agent / 开发者

---

## 1. 当前状态速览（接手必读）

### 1.1 代码与 Git 状态

`feat/background-desktop` 已包含 4 个核心提交并已全部推送至 GitHub（[mini-yifan/dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis/tree/feat/background-desktop)）：

| Commit | 主题 | 主要范围 |
|---|---|---|
| `6635cfb` | 后台桌面模式（macOS）升级为增强型 AX-First Computer Use | `packages/desktop`、`packages/bundle/cordis.patch.yml` |
| `b32cb47` | Windows 后台桌面模式对齐 macOS 基础能力（冷启动、还原、粘贴输入、锁屏检测） | `packages/desktop`、`packages/bundle/cordis.patch.yml` |
| `4c30c27` | Windows 后台桌面模式进程内加速（`win-native.ts`）与微信输入/匹配修复 | `packages/desktop` |
| `3a89f1f` | 前台 Computer Use 点击精度修复（1280px 限幅、`pixel` 默认、视口守卫）与 DSH 0.2.x 兼容修复 | `packages/computer-use`、`packages/host` |

### 1.2 双端环境部署现状（关键差异）

- **本机 macOS（`~/.dsh/profiles/desktop`）**：
  - **已部署至最新 `3a89f1f`**（`node_modules/dsh-orb` 为最新构建产物，`packages/computer-use/native/` 通用二进制和 dylib 已重编）。
  - `~/.dsh/profiles/desktop/millifraction-coordinates.json` 已显式设置为 `{"enabled": false}`。
- **远端 Windows（`<windows-host>`，此前通过子 Agent `@windows-harness-remote` 部署）**：
  - **仅同步到了 `4c30c27`（后台桌面模式 P0+P1 优化）**。
  - **尚未部署 `3a89f1f`**（上一轮用户明确指示“只部署到本机 Mac，暂不同步 Windows”）。这是接手后的首要同步事项之一。

---

## 2. 改动详情与根因说明

### 模块 A：后台桌面模式（`@dsh-orb/desktop`）macOS AX-First 增强（`6635cfb`）

#### 为什么改（诊断根因）
1. **视觉点击平均向上偏移 ~18pt**：`agent-desktop` 默认窗口截图携带 macOS 非对称阴影（顶部边距 76px，底部边距 148px），按对称边距推算逻辑坐标导致点击偏高。
2. **AX 树过浅且缺乏检索与局部下钻能力**：复杂界面截断后难以定位深层节点，模型频繁退回靠猜坐标点击。
3. **失败原因不透明、动作链轮次过多**：无障碍预检等待长，出错缺少结构化字段；`desktop_open_app` 倾向直接截屏而非先给 AX 树；已知多步确定操作必须一轮一次工具调用，`tool-result-pruner` 阈值偏低也容易过早裁掉刚读到的树。

#### 改了什么
- **无阴影窗口截图（`packages/desktop/src/vision.ts`）**：macOS 首选 `screencapture -x -o -l <windowId>`（失败再回退），消除非对称阴影引起的 ~18pt 坐标偏移，保持像素与窗口 `bounds` 1:1 对齐。
- **结构化错误透传（`errors.ts` / `ffi.ts` / `host.ts` / `protocol.ts`）**：保留并格式化 `error.details`（`kind`、`checks[]`、`occluder`），让模型明确知道超时卡在哪个检查项或被谁遮挡。
- **Tree-first 与更丰富的 AX 工具集（`packages/desktop/src/tools.ts`、`gui.ts`、`render.ts`）**：
  - `desktop_open_app`：窗口支持完整树（`tree=yes`）时直接返回 AX 树；仅在 `tree=no`、`tree_thin` 或显式 `visual=true` 时回退无阴影截图。
  - `desktop_inspect`：`depth` 放开到最高 `32`；支持 `root` 局部下钻并将节点合并回 `RefBook`；支持 `skeleton` 骨架模式、基于 `include_text` 的空容器剪枝，以及操作后 `readTreeFor` 保留原有 `depth` 与文本模式。
  - 新增 `desktop_find`：按条件检索 AX 节点，并将结果直接注册到 `RefBook`，减少全树往返。
  - `desktop_act` 升级：支持 `select` 文本结果校验、`scroll_to`、更短的 headless preflight、`expand` 逐级升级、基于精确 AX `bounds` 的兜底点击/`click_bounds`、`submit` 与 `wait_ms` 复合参数，以及选择性 `list-surfaces` 检查。
  - 新增 `desktop_batch`：声明式执行 1–8 个确定性 AX 步骤，只做一次最终树回读，并内置防重复提交保护。
- **Preset 与上下文保持（`packages/bundle/cordis.patch.yml`、`sessions.ts`）**：更新 `preset-desktop` 的 AX-first 操作指引，并提高 `tool-result-pruner` 阈值。

---

### 模块 B：后台桌面模式 Windows 对齐与进程内加速（`b32cb47` & `4c30c27`）

#### 为什么改（诊断根因）
1. **跨端功能缺失（`b32cb47` 前）**：Windows 端无法冷启动应用、无法还原最小化窗口、无 AX 树时无法点位输入、也无法感知系统锁屏状态。
2. **实测耗时过长与微信输入错位（`4c30c27` 前，`session-bb8ca99d` 复盘）**：
   - **子进程冷启动开销大**：每次截图和鼠键操作都要拉起一次 `agent-desktop.exe`，单次数百毫秒，整段任务大量时间耗在进程启动上。
   - **UIA 身份超时级联**：微信（`Weixin.exe`）等应用在 UIA 读取时容易触发 `identity` 超时并反复重试。
   - **应用/窗口别名匹配失败**：进程名 `Weixin.exe` 与中文窗口标题 `微信` 不一致，导致匹配漏掉后重走慢路径。
   - **无树点位输入错位**：点击输入框后未在点击焦点处可靠输入/粘贴，导致文本跑偏。
   - **DWM 隐形边框**：Windows 标准窗口约有 ~11px 不可见缩放边框，直接按窗口矩形截图/换算会带偏坐标。

#### 改了什么
- **`b32cb47` 基础能力补齐**：
  - `activate.ts`：补齐 Windows 应用冷启动与最小化窗口还原。
  - `win-clipboard.ts`（新增）：基于 Win32 剪贴板实现可靠的文本粘贴输入。
  - `hid.ts` / `tools.ts`：补齐无 AX 树场景的输入通路；点击后直接粘贴到目标焦点。
  - `session-state.ts`：补齐 Windows 锁屏状态检测。
- **`4c30c27` 进程内加速与精准修复**：
  - **`packages/desktop/src/win-native.ts`（新增，653 行）**：通过 `koffi` 直接在 Node 进程内调用 Win32 原生 API：
    - DPI 感知的 `DwmGetWindowAttribute`（`DWMWA_EXTENDED_FRAME_BOUNDS`）获取真实可见矩形，扣除 ~11px 隐形缩放边框。
    - GDI `BitBlt` 进程内窗口/区域截图，绕开 `agent-desktop.exe` 冷启动。
    - `SetForegroundWindow` + `SendInput` 进程内完成点击、拖拽、键盘输入与组合键。
  - **`gui.ts` / `activate.ts` / `vision.ts` / `tools.ts`**：
    - 支持 `Weixin.exe` / `微信` 等进程名与本地化标题别名匹配。
    - 身份类 UIA 超时采用快速失败（fail-fast），避免级联等待。
    - 点选后输入改为在 clicked field 处就地粘贴，防止误输入到错误控件。

---

### 模块 C：前台 Computer Use 点击精度修复与 DSH 0.2.x 兼容（`3a89f1f`）

#### 为什么改（诊断根因）
1. **~36% 严重点击偏移（`session-c2a44942`）**：
   - 在 `millifraction`（`0–1000` 千分比）模式下，高分屏窗口截图（~2700px）进入 VLM 前被视觉编码器静默缩放到 ~1666px。
   - 模型（如 DeepSeek-Flash）直接读取其所见预览图上的像素坐标（例如 `(906, 571)`）并填入 `0–1000` 字段，插件再把 `906` 当作 90.6% 宽度放大回逻辑屏幕，导致落点严重偏右。
2. **截图后视口变化缺乏防线**：模型发出点击时若目标窗口已经移动或缩放，仍按上一帧坐标点击会误点别处。
3. **DSH 0.2.x 运行时崩溃（`session-759a3fa3`）**：
   - 升级到 DeepSeek Harness 0.2.2 后，`system-prompt/assemble` 瀑布流不再传递 `assembly.tools`（该字段变为 `undefined`）。
   - 插件在 `turn/start` 直接对 `tools` 调用 `.map(...)`，抛出 `TypeError: Cannot read properties of undefined (reading 'map')`，导致整个 Computer Use 会话无法运行。

#### 改了什么
- **全局默认切换为 `pixel` 像素坐标模式（`packages/host/src/preferences.ts`）**：
  - `defaultMillifraction()` 在所有平台默认返回 `false`（不再默认开启千分比）。
  - 本机 `~/.dsh/profiles/desktop/millifraction-coordinates.json` 同步写入 `{"enabled": false}`。
- **观察图长边限幅至 `1280px`（`observe.ts` / `raster.ts` / `backend.ts` / `lasso.ts`）**：
  - 定义 `OBSERVATION_MAX_LONG_EDGE = 1280` 与 `clampedLongEdgeSize(width, height, maxLongEdge)`。
  - 所有传给 VLM 的观察截图（含套索 `lasso.ts` 首帧）按比例钳制到长边 `<= 1280px`，保证 VLM 看到 **1:1 像素**而不再触发隐式二次缩放；导出给用户的全尺寸截图仍保留原始分辨率（`maxLongEdge: null`）。
- **macOS ScreenCaptureKit 统一通路与缩放（`macos-sck-capture.swift` / `macos.ts` / `native/*`）**：
  - `--exclude=` 改为可选参数，新增 `--max-long-edge=N` 与 `--no-cursor`。
  - 默认 macOS 截屏即使没有需要排除的悬浮球窗口也走 ScreenCaptureKit，以保留高对比度红白光标环及硬件缩放；回退分支使用 `screencapture -x -C -R` + `/usr/bin/sips -Z`。
  - 已重新编译 `packages/computer-use/native/macos-sck-capture` 与 `libmacos-sck-capture.dylib`。
- **Windows 原生缩放（`windows.ts` / `windows-native.ts`）**：
  - `capturePng` 支持 `maxLongEdge`，编码 PNG 前使用 `HALFTONE` `StretchBlt` 下采样。
- **动作前 `VIEWPORT_CHANGED` 视口守卫（`coordinate-mode.ts` / `plugin.ts`）**：
  - `ObservationRaster` 与 `rememberObservation` 记录观察时的逻辑 `bounds`。
  - 在 `click`、`input_text`、`scroll`、`long_press`、`drag` 执行前调用 `boundsStillMatch(lastObservedBounds(session), screen.bounds, 4)`；若窗口位置/尺寸漂移超过 `4pt`，返回 `VIEWPORT_CHANGED` 并拒绝派发过期坐标。
- **DSH 0.2.x 兼容修复（`coordinate-mode.ts` / `plugin.ts`）**：
  - `toolsForCoordinateMode(tools, mode)` 对 `tools === undefined` 安全返回 `[]`，防止 `turn/start` 崩溃。
  - 新增 `registerModeTool(ctx, defineTool(...))`，在工具注册阶段即根据当前 `pixel` 模式改写 GUI 工具参数描述，不依赖 `system-prompt/assemble` 下发 `tools`。

---

## 3. 验证与构建命令（已在仓库核实）

在本仓库根目录下执行：

```bash
# 全量类型检查
pnpm typecheck

# 全量单测（node:test + @dsh-orb/computer-use vitest）
pnpm test

# 构建所有工作区包及 bundle 产物
pnpm build
```

注意事项：
1. 若修改 `packages/computer-use/src/macos-sck-capture.swift`，需重新编译通用二进制和 dylib 到 `packages/computer-use/native/`，然后执行 `pnpm --filter @dsh-orb/computer-use build`（会自动运行 `copy-native.mjs`）。
2. `packages/bundle` 的 `pnpm --filter dsh-orb build` 会执行 `node ./scripts/assemble.mjs` 组装最终可安装插件包。
3. 本机 macOS 本地插件部署目录位于 `~/.dsh/profiles/desktop/node_modules/dsh-orb`。

---

## 4. 交接后的待办事项（Next Steps）

### P0：将 `3a89f1f` 同步部署到远端 Windows 机器
- **背景**：Windows 端（`<windows-host>`，此前通过 `@windows-harness-remote` 部署）仍停留在 `4c30c27`，尚未包含前台 Computer Use 的 `1280px` 限幅、`HALFTONE StretchBlt`、`pixel` 默认模式、`VIEWPORT_CHANGED` 守卫以及 DSH 0.2.x `system-prompt/assemble` 防崩修复。
- **检查点**：
  1. 在 Windows 上更新代码、安装依赖、构建 bundle 并重启 DeepSeek Harness。
  2. 检查 Windows 端对应 profile 目录下的 `millifraction-coordinates.json`：若历史上写过 `{"enabled": true}`，需确认是否清理或置为 `false`（**代码改默认值不会覆盖已落盘的显式配置文件**）。
  3. 验证 Windows DSH 0.2.x 下启动 Computer Use 不再出现 `Cannot read properties of undefined (reading 'map')`。
  4. 在 Windows 100% / 120% / 150% DPI 缩放及多屏场景下验证前台 Computer Use 点击精度与 `HALFTONE StretchBlt` 截图清晰度。

### P1：双端端到端回归测试
1. **前台 Computer Use（macOS + Windows）**：
   - 验证在 `pixel` + `1280px` 限幅下，点击/输入/拖拽是否稳定命中目标，不再出现 30%+ 偏移。
   - 验证窗口被移动或缩放时 `VIEWPORT_CHANGED` 能否正常拦截并引导模型重新观察，同时不产生误报。
2. **后台桌面模式（macOS + Windows）**：
   - 验证 `desktop_open_app` → `desktop_find` / `desktop_inspect` → `desktop_batch` / `desktop_act` 在复杂应用（macOS 系统设置、微信、Office/WPS、Electron 应用）下的稳定性与端到端耗时。
   - 重点关注 Windows 端 `win-native.ts` 在窗口最小化还原、多屏异构 DPI、输入法激活状态下的中文粘贴与点击表现。

### P2：已知架构与演进观察点
1. **Windows UIA 树获取仍有子进程开销**：`win-native.ts` 已经把截图与鼠键动作放到进程内完成，但 AX/UIA 树快照（`snapshot` / `find`）仍经由 `agent-desktop.exe` 子进程；若后续觉得 UIA 读取依然偏慢，可考虑把 UIA 探测也做成常驻进程或原生桥接。
2. **既有用户的显式千分比配置迁移**：`defaultMillifraction()` 已改为 `false`，但升级旧版本时如果用户磁盘上已经持久化了 `millifraction-coordinates.json: {"enabled": true}`，仍会沿用千分比；如有必要可评估一次性的配置迁移提示或 UI 开关重置策略。
