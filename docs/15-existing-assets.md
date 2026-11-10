# 悬浮球超级互联：已有资产盘点

> 状态：Draft v0.1（资产盘点）
> 日期：2026-11-10
> 范围：盘点「可以参考 / 直接使用 / 直接修改 / 必须新建」的资产，对齐 [14-interconnect-prd.md](14-interconnect-prd.md)、[16-v0-plan.md](16-v0-plan.md)
> 说明：本文是资产地图，不是排期、报价或技术方案；资产可用度是粗略判断，落地前需按版本验证

## 0. 结论摘要

- **底层技术资产比想象中多**：DSH 的插件/会话/工作区/审批模型、dsh-orb 的桌面悬浮球与双轨 Agent、dsh-Go 的手机操控/悬浮窗/语音/远程客户端、ds-harness-remote 的账号/设备/E2E/Relay/远程会话/文件工具，都已经存在。
- **顶层产品资产明显不足**：第一方多租户账号/控制服务、多 Host 统一客户端/工作区树、跨设备任务编排与共享会话、手机作为节点、审批/审计/运维，基本都要新建或大幅改造。
- **桌面端有一个产品级分叉**：官方 DSH + 插件的单 Host 限制，决定了「统一树 + 官方主聊天区」能否原样实现（PRD D3）。
- **最容易直接复用的是「零件」**：dsh-Go 的手机操控与悬浮窗、dsh-orb 的 Orb/Agent 模式、ds-harness-remote 的协议/客户端/远程工具、DSH 的会话/工作区/审批。
- **最不该低估的是「组装」**：服务、UI、编排、安全、兼容、运维，不是代码量，而是产品复杂度。

## 1. 分类方法

| 分类 | 含义 | 使用方式 |
|---|---|---|
| **直接用** | 不改代码，配置/接入即可 | 作为依赖、服务、API、运行时 |
| **直接改** | fork / 移植 / 修改后使用 | 改代码、改协议、改 UI |
| **参考** | 只借鉴设计、交互、模式 | 不直接复用代码 |
| **新建** | 现有资产覆盖不了 | 新服务/新 UI/新模块 |

另外：

- **可用度**：高 / 中 / 低（粗略，在表格中标注）。
- **验证状态**：展开在第 10 节「验证状态与风险」。
- **许可**：展开在第 9 节「许可与合规」。

## 2. 资产总览

| 来源 | 角色 | 许可 | 版本（以仓库为准） | 在 PRD 中的位置 | 主要用法 |
|---|---|---|---|---|---|
| **dsh-orb**（本仓库） | 桌面悬浮球 + Computer Use + 双轨 Agent | MIT | 0.2.x | 能力 A 桌面、能力 B 的 Agent/后台模式 | 直接用 / 直接改 / 参考 |
| **dsh-Go** | Android DSH 客户端 + 手机操控 + 远程客户端 | AGPL-3.0；`sdk/`、`examples/` MIT | 1.0.x | 能力 A 手机、能力 B 手机端/远程 | 直接改 / 参考 |
| **ds-harness-remote** | 账号/设备/E2E/Relay/远程会话/远程工具 | MIT；完整 Server 未开源 | 0.6.4 | 能力 B 的账号/通道/远程会话/文件 | 直接用 / 直接改 / 参考 |
| **DSH** | 插件/Agent/会话/工作区/审批/客户端 | MIT | 0.2.2-rc.1 | 全产品底座 | 直接用 / 参考 |
| **文档/工具链** | 可行性、需求、构建、测试 | 同各仓库 | — | 降低未知、复用工程能力 | 参考 / 直接用 |

---

## 3. dsh-orb（本仓库）资产

### 3.1 资产清单

| 资产 | 位置 | 提供什么 | 用法 | 可用度 | 注意事项 |
|---|---|---|---|---|---|
| 悬浮球 Helper | [`packages/helper`](../packages/helper) | Electron 球窗口、面板、拖拽/吸边、transcript、Shiki/KaTeX、工具卡、历史/新建、问答卡 | **直接用/直接改**（桌面）；**参考**（手机） | 高 | Electron 没有 Android 构建；手机端不能直接搬 |
| Computer Use | [`packages/computer-use`](../packages/computer-use) | 13 个 GUI 工具、macOS/Windows 后端、截图/坐标模式、观察边框、截图排除、TCC 引导 | **直接用/直接改**（桌面）；**参考**（手机） | 高 | Android 落到 unsupported；手机 CU 走 dsh-Go 手机操控 |
| Host | [`packages/host`](../packages/host) | 会话、权限、模型、路由、helper 生命周期、历史、设置、语音、更新 | **直接用/直接改**（桌面） | 高 | Linux 不建球；移动端需要新的宿主适配 |
| Voice | [`packages/voice`](../packages/voice) | 唤醒词、ASR、TTS、本地模型、语音队列 | **直接用**（桌面）；**参考/不可用**（手机） | 高（桌面） | `sherpa-onnx-node`/`node-cpal` 无 Android 构建 |
| Client Settings | [`packages/client-settings`](../packages/client-settings) | 主窗口「悬浮球」设置页、模型/权限/语音/外观 | **直接用**（桌面）；**参考**（手机） | 高 | 手机端设置要原生重做 |
| Native Selection / Lasso | [`packages/native-selection`](../packages/native-selection)、[`packages/computer-use/src/lasso.ts`](../packages/computer-use/src/lasso.ts)、[`packages/host/src/lasso.ts`](../packages/host/src/lasso.ts) | 划词、套索、选区 | **参考** | 中 | 桌面专属；手机端 MVP 不做 |
| Desktop preset | [`packages/desktop`](../packages/desktop) | `agent-desktop` 后台桌面能力 | **参考** | 中 | 桌面后台 Worker 模式；不是跨设备 mesh |
| Bundle | [`packages/bundle`](../packages/bundle) | 安装包、组合包、preset 注入、bundle 构建 | **直接改** | 高 | 移动端/mesh 需要新的 preset/入口 |
| 文档 | [`docs/10-android.md`](10-android.md) | Android 可行性、墙、MVP | **参考** | 高 | 已识别 Electron/后端/悬浮窗/坐标等墙 |
| 文档 | [`docs/13-background-desktop.md`](13-background-desktop.md) | 后台桌面操作、可见性、安全 | **参考** | 高 | 后台桌面模式，不是跨设备 |
| 文档 | [`docs/14-interconnect-prd.md`](14-interconnect-prd.md) | 产品需求 + 端到端场景 | **直接用** | 高 | 需拍板 D1–D12 |
| 测试/构建 | `package.json`、`pnpm-lock.yaml`、`packages/*/tests` | monorepo、vitest、typecheck、构建、发布 | **直接用/直接改** | 高 | 需补 mesh/移动端测试 |

### 3.2 结论

- 桌面 Orb 的**产品形态、Agent 模式、后台会话、完成通知、设置体系**已经成熟，是能力 A 桌面侧和能力 B 的 Agent 参考实现。
- 但它是 **Electron + 桌面 Computer Use**，不能直接搬到 Android；手机端只能参考交互与 Agent 模式，UI/语音/CU 要用 dsh-Go 的零件重做。
- `code_agent` 的双轨、后台完成通知、preset/权限/模型，是 `device_agent` 跨设备编排最直接的参考。

---

## 4. dsh-Go 资产

> 仓库：<https://github.com/ccch1mneyyy/dsh-Go>；许可 AGPL-3.0，`sdk/`、`examples/` MIT；品牌/素材另有限制。

### 4.1 资产清单

| 资产 | 位置（仓库路径） | 提供什么 | 用法 | 可用度 | 注意事项 |
|---|---|---|---|---|---|
| 手机操控 MCP | `app/android/.../phone/PhoneToolCatalog.kt`、`PhoneGuest.kt`、`McpServer.kt`、`PhoneCore.kt` | `screen/tap/type/scroll/key/tap_xy/handoff`、元素优先、截图、确认/交还、任务串行 | **直接用/直接改** | 高 | 以 `--patch` 挂在引擎根上的 MCP 服务 `phone`，所有 preset 自动继承（模型看到 `mcp__phone__*`）；只对本机引擎、非安全模式；主屏独占，另一会话等 30 秒后报错 |
| 无障碍截图/驱动 | `app/android/.../phone/a11y/ScreenShooter.kt`、`MainScreenDriver.kt`、`TreeCapture.kt` | 截图、带编号图、元素树、动作后校验、前台识别 | **直接用/直接改** | 高 | API 30–33 整屏、34+ 窗口；截图含 overlays 需隐藏 |
| 安全/确认 | `app/android/.../phone/SafetyGate.kt`、`ControlOverlay.kt`、`PhonePrompts.kt` | 敏感页/密码/付款/首次 App 确认、handoff、停止 | **直接用/直接改** | 高 | 跨设备审批路由要另做 |
| 控制悬浮条 | `app/android/.../phone/a11y/ControlOverlay.kt`、`OverlayCapsule.kt`、`OverlayBall.kt` | 胶囊/卡片/小球、暂停/停止、插话、截图隐藏 | **直接改/参考** | 高 | 与 Orb 球的仲裁要设计 |
| 宠物悬浮窗 | `app/android/.../pet/PetOverlay.kt`、`AskBar.kt`、`OverlayAccess.kt`、`EdgeSnap.kt`、`OverlayWindowOwner.kt` | 全局悬浮窗、拖拽吸边、问一句输入条、按住说话、键盘/IME、气泡 | **直接改/参考** | 高 | 最接近 Orb 手机端的窗口/输入条骨架 |
| 录音/转写 | `app/android/.../voice/WavRecorder.kt`、`VoicePlugin.kt`；Dart `voice_controller.dart`、`voice_bridge.dart` | 16k WAV、系统/引擎 ASR、按住说话、静音回退 | **直接改** | 高 | 手机端语音要接 Orb 发送流程 |
| 原生聊天/会话 | `app/lib/ui/chat/*`、`app/lib/state/*` | 聊天、工具卡、审批、附件、模型、权限、会话列表 | **直接改/参考** | 高 | 统一树/多 Host 主聊天要改 |
| 远程客户端 | `packages/dsh_remote/` | 账号、配对、E2E（Noise）、Relay/WebRTC/TURN、Host 列表、连接、会话、上传下载 | **参考** | 中 | 单活动 Host（连另一台会断开上一台），满足不了 3–5 台互联；手机入网改为在本机引擎里跑与电脑相同的 Node 插件（见 17 第 6 节） |
| 插件系统/宿主 UI | `app/lib/plugins/native/*`、`runtime/bridge/dsh-go-bridge/` | 原生插件面（胶囊/面板/工具卡/设置）、桥接 | **参考/直接改** | 中 | 没有跨 App 悬浮球面；统一树槽位不足 |
| 本机引擎/运行时 | `runtime/`、`app/android/.../runtime/` | Android PRoot、DSH 0.2.2-rc.1（Node 24.22.1）、插件安装、引擎生命周期 | **直接用/直接改** | 高 | 引擎里没有 ds-harness-remote Host 插件，手机现在不能被其他设备连接；作为节点需要装插件并设计安全边界 |
| 设计文档 | `docs/design/plugin-seams.md`、`native-plugins-protocol.md`、`pets.md`、`phone-overlay.md`、`voice-input.md` | 插件 slot、原生 UI、宠物/悬浮条、语音 | **参考** | 高 | 说明现有边界与可扩展点 |
| 测试/构建 | `app/` Flutter tests、`packages/dsh_client`/`dsh_remote` tests、`runtime/tests`、`tooling/` | Android 构建、远程 E2E、运行时测试 | **直接用/直接改** | 高 | 真机验证是硬要求 |

### 4.2 结论

- 手机 Orb 的**球/面板/语音/截图/手机 CU**零件基本齐了：宠物悬浮窗 + 问一句 + 手机操控 + 原生聊天。
- 手机端的**账号/远程/会话/文件**有现成客户端 `dsh_remote`，但它是「单活动 Host」，也不能让手机被连接；多设备互联改为在本机引擎里跑与电脑相同的 Node 插件。
- 手机作为**被调用节点**（Host）还没有产品化；需要把 Host 能力装进本机引擎，并设计安全边界。
- AGPL 是复用 dsh-Go 代码时必须先决策的许可条件。

---

## 5. ds-harness-remote 资产

> 仓库：<https://github.com/liguobao/ds-harness-remote>；许可 MIT；完整 Server/Remote Web 未开源。

| 资产 | 位置 | 提供什么 | 用法 | 可用度 | 注意事项 |
|---|---|---|---|---|---|
| 协议/加密 | `packages/protocol`、`packages/crypto` | 设备身份、Noise IK、连接/控制帧、刷新/回执 | **直接用/直接改** | 高 | 与 DSH 版本/客户端要对齐 |
| 客户端核心 | `packages/client-core` | 连接、隧道、RPC、WebRTC、文件传输 | **直接用/直接改** | 高 | Dart 客户端在 dsh-Go；Node 侧需另接 |
| Host 插件 | `packages/plugin` | Host 注册、账号、设备、远程工具注入 | **直接用/直接改** | 高 | 远程工具默认开启；审批在目标原生 UI |
| 远程工具 | `packages/plugin/src/remote-tools.ts`、`remote-session-tools.ts` | `remote_list_hosts`、`remote_list_workspaces`、`remote_create_session`、`remote_send_message`、`remote_wait_sessions`、`remote_read_session`、`remote_upload_file`、`remote_download_file`、`remote_interrupt_session`、`remote_get_operation` | **直接用/直接改/参考** | 高 | 低层 API；目标默认 preset；审批/完成通知要包装 |
| 最小 Server | `apps/server` | Docker、单账号、JSON、设备注册/token、WebRTC/TURN/Relay、设备状态页 | **直接改/直接用** | 中 | 单账号；多租户/门户/命名要新建 |
| 完整 Server | 独立、未开源 | 多账号、OAuth/扫码、配对、Admin、Remote Web | **不可用** | — | 不能直接部署；只能参考设计 |
| 文档 | `docs/server.md`、`protocol.md`、`remote-tools.md`、`device-pairing-v1.md`、`end-to-end-encryption.md` | 账号/设备/协议/配对/加密/远程工具设计 | **参考** | 高 | 设计与最小实现要分开看 |

### 5.1 结论

- 能力 B 的「账号、设备、E2E、通道、远程会话、文件传输」有成熟底座，MIT 可改。
- 缺的是**第一方多租户服务**、**多 Host 统一客户端/UI**、**高层编排/审批/完成通知**。
- 远程工具是「低层原语」，不是产品级 `device_agent`；目标会话的 preset/审批/通知需要产品层补齐。

---

## 6. DSH 平台资产

| 资产 | 提供什么 | 用法 | 可用度 | 注意事项 |
|---|---|---|---|---|
| 插件系统 | 插件加载、preset、tools、bundle | **直接用** | 高 | 插件不能改官方主聊天区 |
| Agent/会话 | Agent loop、session、workspace、projection、approval、question、attachment | **直接用** | 高 | 单 Host 客户端；远程会话是另一套 Host |
| 客户端 slots | `sidebar.workspaces`（单槽，官方占用）、`sidebar.panellist`（列表）、`shell.overlay`、session row 插槽等 | **直接用/直接改** | 中 | 统一多设备树/主聊天区受单 Host 限制（D3） |
| 官方桌面端 | DSH Web/Electron 壳、设置、插件市场 | **直接用** | 高 | 不可随意改主聊天区；fork 才能做完整统一 UI |
| 远程 Host API | 工作区/会话/流/审批/文件 | **直接用** | 高 | 需要 Host 插件与账号 |
| 许可 | MIT | **直接用** | 高 | 依赖/素材各自许可 |

### 6.1 结论

- DSH 是**产品底座**：会话、工作区、审批、附件、Agent 模型都可以直接用。
- 但官方桌面客户端是**单 Host**；插件只能加侧栏面板/行操作，不能把多 Host 会话塞进官方主聊天区。D3 必须早拍板。

---

## 7. 文档、经验与工具链资产

| 资产 | 位置 | 作用 | 用法 |
|---|---|---|---|
| Android 可行性 | [`docs/10-android.md`](10-android.md) | Electron/后端/悬浮窗/坐标/AGPL 等墙与 MVP | 参考 |
| 后台桌面操作 | [`docs/13-background-desktop.md`](13-background-desktop.md) | 后台 Agent 的可见性、安全、前后台边界 | 参考 |
| 产品需求 | [`docs/14-interconnect-prd.md`](14-interconnect-prd.md) | 产品定义、FR、v1、场景、验收 | 直接用 |
| 桌面架构 | [`docs/02-architecture.md`](02-architecture.md)、[`docs/04-addenda.md`](04-addenda.md) | helper/host/Computer Use 设计 | 参考 |
| 语音 | [`docs/05-voice.md`](05-voice.md)、[`docs/07-voice-listen.md`](07-voice-listen.md) | 唤醒/ASR/TTS/队列经验 | 参考 |
| 选区/套索 | [`docs/11-selection.md`](11-selection.md)、[`docs/12-lasso.md`](12-lasso.md) | 桌面选区交互 | 参考/不做 |
| UI 原型 | [`.dsh-notes/`](../.dsh-notes) | 球、面板、语音、设置的历史原型 | 参考 |
| 构建/测试 | `pnpm`、vitest、Flutter tests、runtime tests、release/update | 工程能力 | 直接用/直接改 |

---

## 8. PRD 需求映射

### 8.1 能力 A：悬浮球在场

| 需求 | 可用资产 | 用法 | 还缺什么 |
|---|---|---|---|
| A1 长按语音 | dsh-Go `WavRecorder`、宠物问一句、语音控制器；dsh-orb voice | 直接改 | Orb 录音/发送流程、上滑取消、失败回退 |
| A2 发送时截图 | dsh-Go `ScreenShooter`、悬浮控件隐藏、无障碍 | 直接改 | 截图与消息同发、球/面板隐藏、隐私提示 |
| A3 手机 CU | dsh-Go 手机操控 MCP、安全/确认、控制条 | 直接用/直接改 | Orb preset/policy、动作后状态、停止 |
| A4 本机后台 Agent | dsh-orb `code_agent`/preset；DSH 标准 preset | 直接用/直接改 | 手机端后台会话/完成通知/插话 |
| A5 Orb 面板 | dsh-orb transcript；dsh-Go 原生聊天/问一句 | 直接改 | 手机浮层面板、输入法、状态、历史 |
| A6 不虚拟屏 | dsh-Go 手机操控设计、无障碍共享屏幕 | 直接用 | 产品文案/交互约束 |

### 8.2 能力 B：超级互联

| 需求 | 可用资产 | 用法 | 还缺什么 |
|---|---|---|---|
| B1 账号/服务 | ds-harness-remote 协议/客户端/最小 Server；dsh-Go `dsh_remote`（参考） | 直接改/新建 | 第一方多租户、内置+自建、门户、命名（v0 先做单租户：管理员口令 + 配对码） |
| B2 设备/命名/在线 | 远端 Host 列表/presence、最小 Server 设备表 | 直接改 | 默认名、当前设备改名、只读策略、撤销 UI |
| B3 统一树 | DSH 工作区/会话 API；dsh-Go 原生列表；dsh-remote | 新建/直接改 | 多 Host 聚合、三层树、实时状态、离线 |
| B4 远程会话 | ds-harness-remote 插件的远程网关、远端 session 流、`$events` 交互、文件 API；`dsh_remote` 参考 | 直接改/新建 UI | 多 Host 主会话区、输入/暂停、审批路由 |
| B5 跨设备调度 | `remote_*`、dsh-orb `code_agent` 模式 | 参考/直接改 | `device_agent`、任务生命周期、完成通知、共享会话 |
| B6 文件双向 | `remote_upload_file`/`download_file`、DSH 附件、dsh-Go 文件 | 直接改 | 任务级附件 UX、手机照片、路径/大小/清理 |
| B7 状态/通知 | dsh-orb 完成通知；dsh-Go 通知/气泡；DSH 会话状态 | 参考/直接改 | 远程任务状态、设备离线、等待确认 |
| B8 安全 | E2E、设备 token、手机确认、最小 Server 撤销 | 直接用/新建 | 范围/审批路由、审计、一键断开、手机节点 |
| B9 设置/门户 | dsh-orb 设置；dsh-Go 插件设置；最小 Server 状态页 | 直接改 | 互联模块、内置/自建、门户只读、当前设备名 |
| B10 多端 | dsh-orb 桌面；dsh-Go 手机 | 直接改 | 桌面统一体验（D3）、手机完整树、双端一致 |

---

## 9. 许可与合规

| 资产 | 许可 | 复用注意 |
|---|---|---|
| **dsh-orb** | MIT | 可商用/修改/分发；保留版权与许可；品牌/第三方素材按各自声明 |
| **dsh-Go** | AGPL-3.0；`sdk/`、`examples/` MIT | 修改/分发/作为网络服务需评估 AGPL 义务；名称、标识、Deepy/鲸娘素材不在 AGPL 内 |
| **ds-harness-remote** | MIT；完整 Server/Remote Web 未开源 | 协议/客户端/最小 Server 可改；完整 Server 不能直接部署；托管服务另有条款 |
| **DSH** | MIT | 可直接用/改；依赖与素材各自许可 |
| **Electron/Node/Flutter/Android** | 各自许可 | 按依赖许可与分发要求 |

**建议：**

- 继续让 dsh-orb 保持 MIT；不要把 AGPL 代码直接搬进 MIT 包而不做许可评估。
- 如果基于 dsh-Go 改手机端并分发，提前决定：AGPL 开源、双许可、还是独立实现。
- 自建服务是你们自己的代码/部署；完整上游 Server 未开源，不能假设可直接用。
- 品牌/素材（dsh-Go、Deepy、鲸娘等）不要直接复用到 Orb 产品。

---

## 10. 验证状态与风险

### 10.1 已验证/部分验证

- dsh-orb 桌面 Computer Use：macOS/Windows 已有产品验证；Linux 加载但不建球。
- dsh-Go 手机操控：Android 无障碍截图/点击/输入、确认/交还、控制条；不同 ROM 仍需真机回归。
- dsh-Go 语音：系统/引擎 ASR、宠物问一句、录音转写；后台录音/静音回退有处理。
- `dsh_remote`：账号/配对/E2E/Relay/WebRTC/TURN、远程会话/文件；对上游 0.6.0 有 E2E；真机/跨公网仍需验证。
- ds-harness-remote 远程工具：Host 注入、列 Host/工作区、建/发/等/读、上传/下载；目标审批在原生 UI。
- DSH 插件/session/workspace/approval：官方能力；桌面单 Host。

### 10.2 未验证/风险

| 风险 | 说明 | 影响 |
|---|---|---|
| 多 Host 并发 | 最小 server 在客户端发起新连接时断掉它的全部旧 Link（`gateway.ts:525`）；插件 Client 与 dsh-Go `dsh_remote` 都只保存一个活动 Host；Host 侧已支持多客户端 | 3–5 台互联的前提，必须改 |
| 桌面统一 UI | 官方 DSH 单 Host、插件槽位有限 | D3 产品承诺 |
| 手机作为 Host | 手机引擎里没有 Host 插件；派到手机的标准模式会话会继承手机操控工具 | 电脑→手机、安全 |
| 远程审批 | 远程工具文档写「在原生 UI 处理」；但远程通道放行 `$events`、`$events/result`、`userQuestions/answer`，远程 peer 可应答，需实测 | 跨设备审批/提问 |
| 心跳/离线 | 最小 server 判离线下限写死 75 秒 | PRD 要求 ≤ 30 秒 |
| 证书 | 客户端不支持固定证书或自定义 CA | 公网 IP + 自签证书 |
| 目标 preset | 远程会话默认目标 preset；标准模式无 GUI/CU | 远程 GUI 任务 |
| 文件路径 | 上传要本机绝对路径（经中继上限 20 MiB）；下载上限 50 MiB、落在 `~/Downloads/dsh-remote-*`；没有进度、不续传；手机相册要开「访问手机文件」（挂到 `/sdcard`） | 文件体验 |
| 许可 | dsh-Go AGPL；完整 Server 未开源 | 分发/服务模式 |
| 版本兼容 | 三端锁 DSH 0.2.2-rc.1；插件/协议版本 | 连接/功能 |
| 安全 | 跨设备 RCE、账号被盗、提示注入 | 产品上线 |

---

## 11. 建议的复用策略

### 11.1 直接用

- **DSH**：插件、preset、session、workspace、approval、question、attachment。
- **dsh-Go 手机操控/悬浮窗/语音**：作为手机 Orb 的手和嘴。
- **dsh_remote**：只作参考（单活动 Host）；手机入网用与电脑相同的 Node 插件。
- **ds-harness-remote 协议/最小 Server**：作为账号/通道原型。
- **dsh-orb 桌面 Orb/CU/双轨**：桌面侧产品与 Agent 模式。

### 11.2 直接改

- **dsh-Go**：Orb 浮层/面板、发送时截图、统一树、手机 Host、远程审批。
- **dsh-orb bundle/preset**：手机 preset、mesh 入口、桌面/移动分平台。
- **ds-harness-remote 最小 Server**：v0 改为管理员口令 + 配对码、多连接、节点、心跳阈值（见 17 第 3 节）；多租户、OAuth、审计在 v0 之后。
- **ds-harness-remote plugin/client-core**：多对端连接、证书固定、文件进度；同一套代码也装进手机引擎。

### 11.3 参考

- dsh-orb helper 的球/面板/transcript 交互（手机端重做）。
- `docs/10-android.md` 的墙与 MVP。
- `docs/13-background-desktop.md` 的后台 Agent 边界。
- ds-harness-remote 的完整 Server 设计、协议、配对/加密。
- DSH 客户端 slot/单 Host 限制。

### 11.4 必须新建

- 第一方多租户账号/控制服务 + 门户 + 命名/在线/撤销/审计。
- 多 Host 统一客户端/工作区树/远程会话 UI（桌面取决于 D3）。
- `device_agent` 编排、任务卡、完成通知、共享会话/审批路由。
- 手机作为节点/Host 的产品与安全。
- 运维/商业/支持体系。

### 11.5 不要直接做

- 把 Electron helper 搬到 Android。
- 把 dsh-Go AGPL 代码直接搬进 MIT 包而不做许可评估。
- 假设完整 ds-harness-remote Server 可直接部署。
- 在官方 DSH 插件里强行替换主聊天区/多 Host（除非接受 fork 或 D3 折中）。
- 把「任务级附件」做成「全量同步盘」。

---

## 12. 下一步

1. **确认许可/分发策略**：dsh-Go AGPL、dsh-orb MIT、ds-harness-remote MIT/完整 Server 未开源。
2. **确认 PRD 的 D1/D3/D4/D6**：目标用户、桌面路线、树的范围、审批位置。
3. **选服务路线**：v0 已定为 fork 最小 Server（见 16、17）；多租户服务在 v0 之后再定。
4. **定第一个验证**：见 17 第 8 节的 B0 清单（含一个客户端同时连 3 台 Host）与 A0 清单。
5. **把本盘点转成依赖/风险/里程碑表**（按团队与时间）。

---

## 附录 A：主要源码/文档入口

- dsh-orb：
  - [`packages/helper`](../packages/helper)
  - [`packages/computer-use`](../packages/computer-use)
  - [`packages/host`](../packages/host)
  - [`packages/voice`](../packages/voice)
  - [`packages/bundle`](../packages/bundle)
  - [`docs/10-android.md`](10-android.md)
  - [`docs/13-background-desktop.md`](13-background-desktop.md)
  - [`docs/14-interconnect-prd.md`](14-interconnect-prd.md)
- dsh-Go：
  - <https://github.com/ccch1mneyyy/dsh-Go>
  - `app/android/.../phone/`
  - `app/android/.../pet/`
  - `app/android/.../voice/`
  - `packages/dsh_remote/`
  - `docs/design/plugin-seams.md`
  - `docs/design/phone-overlay.md`
  - `docs/plugins/slots.md`
- ds-harness-remote：
  - <https://github.com/liguobao/ds-harness-remote>
  - `packages/plugin/src/remote-tools.ts`
  - `packages/plugin/src/remote-session-tools.ts`
  - `apps/server/`
  - `docs/remote-tools.md`
  - `docs/server.md`
  - `docs/protocol.md`
- DSH：
  - <https://github.com/deepseek-ai/deepseek-harness>

## 附录 B：资产成熟度速览

| 层 | 已有 | 缺口 | 成熟度 |
|---|---|---|---|
| 桌面 Orb/Agent | dsh-orb | 跨设备编排/统一 UI | 高 |
| 手机 Orb 零件 | dsh-Go 手机操控/悬浮窗/语音 | Orb 集成/面板/发送流程 | 中 |
| 账号/设备/通道 | ds-harness-remote、dsh_remote | 第一方多租户服务/门户/命名 | 中 |
| 远程会话/文件 | dsh_remote、remote tools | 多 Host UI/任务级附件 UX | 中 |
| 统一工作区树 | DSH/DSH slots、远端 API | 多 Host 客户端/树/主会话区 | 低 |
| 安全/审批/审计 | E2E、设备 token、手机确认 | 范围/审批路由/审计/手机节点 | 低—中 |
| 运维/商业 | 最小 Server/Docker | 多租户运营/支持/计费 | 低 |

> 成熟度是粗略判断，用于讨论优先级，不作为承诺。