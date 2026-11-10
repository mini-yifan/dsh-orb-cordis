# 悬浮球超级互联 v0 实现方案

> 状态：Draft v0.1（实现方案）
> 日期：2026-11-10
> 范围：两条并行工作流（手机端悬浮球 / 服务端 + 电脑插件端）的模块划分、接口约定、验收与排期
> 上游：[14-interconnect-prd.md](14-interconnect-prd.md)（产品需求）、[15-existing-assets.md](15-existing-assets.md)（资产盘点）、[16-v0-plan.md](16-v0-plan.md)（v0 计划）
> 说明：本文是**实现层**文档，把 16 的计划落到仓库、模块、接口和验证步骤；不含排期承诺

---

## 0. 结论摘要

- **服务端不用从零写**：ds-harness-remote 的 `apps/server` 已经是一个可自部署的单账号服务（Node/TS、JSON 持久化、Noise E2E、Relay、WebRTC/TURN、设备状态页、Docker），v0 只需把它改成「管理员口令 + 一次性配对码」，并补管理页。
- **配对链路已有一半**：客户端侧已经有 `authorizeHostWithCode` → `POST /api/v1/devices/register-with-code` 的完整实现，但开源的最小 server 没实现这个端点。v0 只需补服务端，客户端不用改。
- **电脑插件不用换协议**：ds-harness-remote 的 `packages/plugin` 已经支持 `role: 'both'`（同时做 Host 和 Client），并已把 Harness 的整套 Typert 调用经 E2E 通道转发（`harness-remote-bridge.ts` 的 allowlist 包含 `session/*`、`workspace/*`、`session/follow`、`session/control`）。v0 的「看、输入、暂停」不需要新造会话协议。**同时，Host 侧本来就支持多台设备并发连接**（`connection-controller.ts` 的 `Map` + `connectedPeers()`），只有 Client 侧是「单活动 Host」。
- **审批转发是唯一必须新写的核心能力**：远程通道的 allowlist 里**没有任何 approval 端点**，`remote-tools` 的文档也明确写「handle approvals in the native UI」。而 DSH 侧已经有现成挂点（`approval/request` waterfall，见 `packages/computer-use/src/code-agent-unattended.ts`），可以在目标端插件上挂一个转发 answerer。
- **手机端零件齐、但有一处硬约束**：`AskBar` 的按住说话、`OverlayBall` 的球骨架、`ScreenShooter` 的 hide-then-capture、`PhoneToolCatalog` 的手机 CU、`SafetyGate` 的确认都是现成代码。但**悬浮窗是原生 Kotlin 视图，不是 Flutter**——`ui/chat` 的组件不能在浮层里复用，Orb 面板必须原生重做（见 5.4）。另外「截图并问」现在会跳 App 且不自动发送，Orb 需要一条新的「发送即截图」回路。
- **版本三端一致**：本机 DSH 是 `0.2.2-rc.1`，ds-harness-remote `0.6.4` 的适配基线正是它；dsh-Go 的 Android runtime 也锁在同一版本（PRoot + Node 24.22.1）。
- **最大不确定性集中在三处**：多 Host 并发（现有 client 是「一个活动连接」）、审批转发的应答语义、以及公网 IP 直连 + 自签证书的部署细节。三处都在 M0/M1 早期就能验证。

---

## 1. 已锁定的决策

来自需求对齐（本轮讨论）与 [16-v0-plan.md](16-v0-plan.md)：

| 编号 | 决策 | 影响 |
|---|---|---|
| D-1 | 用**公网 IP 直连**，不买域名、不备案 | 服务端 `DSH_SERVER_PUBLIC_URL=https://<IP>`；客户端固定证书指纹（TOFU + pin） |
| D-2 | 服务端**不做账号体系**：管理员口令 + 一次性配对码 | 替换 `auth/login`，新增配对码模型 |
| D-3 | **fork ds-harness-remote** 的 server / plugin / client-core | 保留 Noise、Relay、token 刷新、文件分块 |
| D-4 | 两台电脑（Mac + Windows）验收；**手机端并行、v0 不接互联** | 两条工作流解耦，互不阻塞 |
| D-5 | **所有远程会话**都可看、可输入、可暂停 | Mesh UI 不区分「任务会话」和「普通会话」 |
| D-6 | 「暂停」= **取消当前这一轮**（`session/cancel`），补一条消息即可继续 | 不做原地冻结/恢复 |
| D-7 | 审批转发到**触发这条指令的发起设备**，目标设备同时也能批；谁先应答算谁 | 归属由连接的 `peerDeviceId` 天然确定，不需要给 prompt 打标记 |
| D-8 | 发起设备离线时，任务继续等；目标设备仍可批 | 不做超时自动拒绝 |
| D-9 | Mesh UI 是**悬浮球侧独立窗口**，不改官方 DSH 左栏 | 复用 helper 的窗口与 transcript 渲染 |

---

## 2. 两条工作流的边界

```
┌──────────────────────────────── 工作流 A：手机端 ────────────────────────────────┐
│  dsh-Go fork → Orb（全局球 + 长按语音 + 发送截图 + 手机 CU + 面板 + 本机后台）      │
│  交付：Android APK，独立验收；不连 mesh，不知道设备/账号/服务端的存在               │
└──────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────── 工作流 B：服务端 + 电脑插件端 ───────────────────────────┐
│  B1 服务端（阿里云 YOUR_SERVER_IP）：管理页 + 配对 + 在线 + Relay + E2E            │
│  B2 电脑插件（dsh-orb 新增 mesh 包）：设备身份 + 多 Host 连接 + 树镜像 + device_agent│
│  B3 Mesh UI（helper 新窗口）：设备→工作区→会话树 + 远程会话 + 审批卡              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**唯一的共享面**：`packages/protocol`（帧格式）与 `packages/crypto`（Noise）。v0 阶段手机端不依赖它们，因此两条线可以完全并行；后续手机接入 mesh 时再复用。

**共享约定**（两条线都要遵守，先定下来避免后期返工）：

1. 设备身份 = Ed25519/X25519 密钥对，私钥只在设备本地（`identity-store.ts` 已有实现）。
2. 一切跨设备内容走 E2E；服务端只转发密文。
3. 「会话」是唯一的工作单位，文件是会话的附件。
4. 错误必须是可读的具体原因，不允许长时间无响应。

---

## 3. 工作流 B：服务端

### 3.1 现状（fork 基线）

ds-harness-remote `apps/server` 已有：

| 能力 | 文件 | 现状 |
|---|---|---|
| HTTP 路由 | `src/server.ts` | `auth/login`、`auth/refresh`、`devices/register`、`devices`、`devices/:id/name`、`me`、`turn/credentials`、`health`、静态页 |
| WS 中继 | `src/gateway.ts` | Hello → 认证 → 建 Link → 转发密文帧；心跳、速率限制、tombstone |
| 持久化 | `src/store.ts` | 单 JSON 文件，设备描述 + token 摘要（设备私钥/明文不落盘） |
| 鉴权 | `src/server.ts` | 环境变量单账号 + 密码（scrypt 校验），Web 用 HttpOnly Cookie，设备用 access/refresh token |
| 来源校验 | `src/server.ts:229`、`src/gateway.ts:142` | `Origin` 必须等于 `DSH_SERVER_PUBLIC_URL` |
| Web 页 | `web/src/*.tsx` | Landing / 登录 / 设备状态页（`DevicesPage.tsx`，已支持改名） |
| 部署 | `Dockerfile`、`compose.yaml` | Node 22 slim，`server-data` 卷 |

### 3.2 要改的地方

**（1）鉴权：账号密码 → 管理员口令 + 配对码**

> **先在代码里确认一件事**：插件侧已经存在完整的「设备授权码」客户端链路——`server-api.ts:305` 的 `authorizeHostWithCode(identity, code)` 会调 `POST /api/v1/devices/register-with-code`，body 是 `{ v: 1, code, device: descriptor }`，成功返回 `TokenPair`；`control-runtime.ts:256` 已经在 profile 里消费这个码。
> 但**开源的最小 server 没有实现这个端点**（`apps/server/src/server.ts` 只有 `auth/login` 和账号鉴权的 `devices/register`）。
> 所以这是「客户端有、服务端缺」——v0 只需在 fork 的 server 里实现 `POST /api/v1/devices/register-with-code` 并在管理页生成码，**客户端一行不用改**。这是本方案里最省工的一处。

- 保留 `DSH_SERVER_ACCOUNT/PASSWORD` 作为**管理员**凭据，但只用于 `/admin`，不再用于设备。
- 新增配对码模型（写入 `store.ts` 的 state，版本升到 `version: 2`）：

```
PairingCode {
  codeHash: string      // sha256(code)
  label: string         // 管理员备注，如 "书房 Mac"
  platform: string      // 预填，可被设备上报覆盖
  createdAt: number
  expiresAt: number     // 默认 30 分钟
  usedAt?: number       // 一次性
  deviceId?: string     // 兑换后绑定
}
```

- 新路由：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/admin/login` | 口令 | 返回管理员会话 Cookie |
| GET | `/api/v1/admin/devices` | 管理员 | 设备列表（含在线、上次在线、平台、版本） |
| POST | `/api/v1/admin/pairing-codes` | 管理员 | 生成配对码（返回明文一次） |
| GET | `/api/v1/admin/pairing-codes` | 管理员 | 列出未使用/已使用的码（只显示前缀） |
| DELETE | `/api/v1/admin/pairing-codes/:id` | 管理员 | 作废 |
| POST | `/api/v1/admin/devices/:id/revoke` | 管理员 | 撤销 |
| POST | `/api/v1/admin/devices/:id/rename` | 管理员 | 管理员改名（特权） |
| POST | **`/api/v1/devices/register-with-code`** | 凭码（无 token） | **客户端已在调用的端点**，v0 补实现：校验码 → 绑定 identityKey → 返回 access/refresh token |

- `devices/register` 的账号鉴权分支保留（管理员从网页注册用），但设备主路径改为 `register-with-code`。
- 兑换成功后立即写入 `usedAt` 并绑定 `deviceId`；同一码二次使用返回 409。
- 失败限流按 IP + 码前缀；码只存哈希（与现有 token 摘要策略一致）。
- 码格式建议 8 位大写字母数字（客户端会 `toUpperCase()` 归一），排除易混字符（`0/O`、`1/I`）。

**（2）设备命名规则**

- 默认名：`Mac1` / `Windows1` / `Phone1`，在 `store.register` 时按平台计数生成，域内唯一。
- 当前设备改名：沿用现有 `POST /api/v1/devices/:id/name`，但**只允许设备用自己的 token 改自己**（现有实现是 `accountAuth`，需改为 `deviceAuth` + `id === self`）。
- 管理员改名：新增 `/admin/devices/:id/rename`，并在设备描述里记 `nameLockedByAdmin: true`，此后设备端改名返回 409 并提示「管理员已设定名称」。
- 门户/其他设备只读。

**（3）在线状态**

- 现有 `gateway.peers` 已经能给出在线集合。补：`lastSeenAt` 在断开时落盘；`/admin/devices` 返回 `online`、`lastSeenAt`。
- 离线检测沿用现有心跳（25s 间隔 / 75s 判定），已满足 PRD 的「≤30 秒」。

**（4）管理页**

- 复用 `web/src/DevicesPage.tsx` 的表格与 `api.ts`，新增 `/admin` 路由：
  - 设备表：名称（可改）、平台、版本、在线、上次在线、操作（撤销）。
  - 配对码区：生成（备注 + 平台 + TTL）、列表、作废。
  - 审计区：最近 N 条「谁在什么时候连了谁」（仅连接层元数据）。
- 明确写进页面文案：**管理页看不到会话内容**（服务器只有密文）。

**（5）公网 IP + 自签证书**

- `DSH_SERVER_PUBLIC_URL=https://YOUR_SERVER_IP`。
- 反向代理用 Caddy 或 Nginx，自签证书（SAN 填 IP）。**客户端必须 pin 指纹**，不能依赖系统信任链。
- 现有 `Origin` 校验在浏览器场景是保护；设备端是我们自己的客户端，不带 `Origin`，逻辑不变。但**管理页走浏览器**，`https://IP` 会触发证书警告——v0 的做法：管理页只监听 `127.0.0.1:8080`，通过 SSH 隧道访问，不对公网暴露。

**（6）部署清单（阿里云）**

```
安全组：只开 443（TCP），SSH 限来源 IP
容器：server（Node 22）+ caddy（TLS 终止）
卷：server-data（JSON + token 摘要）
监控：容器健康检查 + 磁盘/内存告警
备份：每日拷贝 server-data 到 OSS 或另一台机器
```

> 注意：这台机器是 2C2G、200 Mbps 峰值、12 月 10 日到期。Relay 只转发密文，2C2G 足够 v0 两台设备；但要给 `server-data` 的增长留监控。

### 3.3 退出标准

1. 管理页能生成配对码；设备用码接入；重复/过期码被拒。
2. 管理页看到两台设备的名称/平台/在线/上次在线；普通页面只读。
3. 撤销设备后，该设备的 token 立即失效、连接断开。
4. `tcpdump` 抓到的中继流量无法解出会话内容。

---

## 4. 工作流 B：电脑插件端

### 4.1 现状（fork 基线）

| 能力 | 文件 | 现状 |
|---|---|---|
| Host 角色 | `packages/plugin/src/service.ts`（`HostPluginRuntime`） | 把本机 Harness 注册为 Host，接收远程调用 |
| Client 角色 | `packages/plugin/src/client-runtime.ts` | 连到指定 Host，建立 E2E 通道 |
| 双角色 | `packages/plugin/src/index.ts:296,317`、`config.ts:109` | `role: 'host' \| 'client' \| 'both'`，两套 runtime 各自独立 |
| 远程调用白名单 | `packages/plugin/src/harness-remote-bridge.ts:112` | `session/*`、`workspace/*`、`session/follow`、`session/control`、`workspaceFiles/*` 等 |
| 高层工具 | `packages/plugin/src/remote-tools.ts`、`remote-session-tools.ts` | `remote_list_hosts`、`remote_read_session`、`remote_send_message`、`remote_wait_sessions`、`remote_upload_file`、`remote_download_file`、`remote_interrupt_session` 等 |
| 文件传输 | `remote-file-upload.ts`、`remote-file-download.ts` | 分块 + 大小上限；下载落在 `<home>/Downloads/dsh-remote-*` |
| 插件路由隧道 | `packages/plugin/src/plugin-route-bridge.ts` | 已能把本机插件的 `api/bot` 路由经 E2E 转发（含 `approval-answer` 操作） |

### 4.2 目标结构

在 dsh-orb 仓库新增一个包 `packages/mesh`（`@dsh-orb/mesh`），作为 DSH 插件：

```
packages/mesh/
  package.json          # name @dsh-orb/mesh, main lib/index.js, exports ./device-agent
  tsconfig.json         # extends ../../tsconfig.base.json; module ESNext + Bundler（同 computer-use）
  tsdown.config.ts      # entry: index + device-agent；deps.neverBundle 全部 @deepseek-ai/*
  src/
    index.ts            # 应用级插件：注册设备、连 relay、provide('meshRegistry')
    device-agent.ts     # preset 内工具：device_agent / _status / _stop
    device-agent-completion.ts  # 完成通知（照 code-agent-completion.ts）
    identity.ts         # 设备密钥、deviceId、名称（复用 ds-harness-remote identity-store）
    peers.ts            # 多 Host 连接管理（见 4.4）
    tree.ts             # 设备→工作区→会话 的镜像与合并
    approval.ts         # 审批转发（answerer 挂载 + 路由）
    protocol.ts         # E2E 消息：tree / follow / prompt / cancel / approval / files
    relay-client.ts     # 到 fork 后 server 的连接
  tests/
    device-agent.spec.ts   # 照 code-agent.spec.ts 写（vitest + 假 sessionController）
    relay-client.spec.ts
```

**两个插件要分开注册，位置不能错**（这条最容易踩）：

- `packages/mesh/index.ts` 是**应用级**插件，和 `orb-host`、`orb-code-agent-registry` 同级，在 `cordis.patch.yml` 的 app-level 行里注册。
- `packages/mesh/device-agent.ts` 是**preset 内**插件，必须插在 `preset-computer-use` 的 `plugins:` 列表里，紧挨着现有的 `tool-code-agent`。因为「preset 的 plugins 列表就是工具集」，工具只能这样进模型视野。
- **不要在 preset 里 `provide`**：仓库里已有注释说明「Preset services require isolate realms: codeAgentRegistry」，应用级服务只能从顶层行提供。

**bundle 侧要改三处**：`packages/bundle/package.json` 加 `workspace:*` 依赖与 `./mesh`、`./mesh/device-agent` 两个导出；`scripts/assemble.mjs` 加一行拷贝；`tests/install.test.mjs` 的 `ownNames()` 断言列表要加新 specifier（它现在断言的是精确清单）。

**与 ds-harness-remote 的关系**：`packages/mesh` 依赖 fork 后的 `@dsh-remote/plugin` 暴露的 `HostPluginRuntime` / `ClientModeRuntime`，不复制其实现。这样上游修 bug 可以直接 merge。

### 4.3 双角色与「对等节点」

现有 `role: 'both'` 已经能同时注册 Host 和 Client 身份。v0 的每个设备都是 `both`：

- Host 半边：把本机的 `session/list`、`workspace/follow`、`session/follow`、`session/prompt`、`session/cancel` 暴露给对端。
- Client 半边：连接对端，调用上面这些端点。

**要注意的现有语义**（已核实）：`ClientModeRuntime` 内部是**单一的** `connected?: ConnectedRemote` 和单一 `TypertGatewaySwitch`，即「当前活动 Host」。这是 4.4 的核心问题。

### 4.4 多 Host 并发（M1 的头号风险）

**已核实的现状，两边不对称**：

- **Host 侧本来就是多连接**：`ConnectionController` 用 `Map<connectionId, ActiveConnection>` 保存所有活动连接（`connection-controller.ts:95`），`connectedPeers()` 返回去重后的设备列表，`peerDeviceId()` 只在「恰好一个对端」时才返回 id。唯一的排他规则是：**同一个 `peerDeviceId` 的新连接会替换旧连接**（`replaced` 逻辑，第 78–83 行），不同设备之间互不影响。
  → 结论：**一台机器同时被多台设备连接，现有实现就支持**。这直接支撑「Windows 同时被 Mac 和手机看」。
- **Client 侧是单活动 Host**：`ClientModeRuntime` 里是 `private connected?: ConnectedRemote`（单数），`TypertGatewaySwitch` 只保存一个 `remoteInvoke`/`remoteTarget`。它服务的场景是「一个客户端连一台机器」。
  → 结论：**「一棵树里同时看 N 台设备」需要每个对端一个独立连接**。

**方案（推荐 A，先做实验）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 多实例** | 每个对端建一份独立的 `ClientConnection` + `RemoteTypertGateway`，绕开 `TypertGatewaySwitch` 的单活动约束；`packages/mesh` 自己持有 `Map<deviceId, RemoteHandle>` | 需确认 `AdaptiveTransport` 可多实例共存（每条连接独立 WS 或独立 WebRTC）；需自己实现每个 handle 的重连与退避 |
| **B. 单连接 + 切换** | 只保持一条活动连接，切设备时重连 | 违背「一棵树同时在线」，切换有秒级延迟；不推荐 |

**M1 第一件事**：写一个最小脚本，在一个进程里并发建立 3 条 `ClientConnection` 到本地 server，验证：

1. 三条连接能否同时 `connected`（不互相替换）；
2. 各自 `session/follow` 流是否独立；
3. 内存/句柄占用（每条连接的 WS + Noise 状态）。

结论决定 4.4 走 A，还是需要在 fork 里把 `ClientModeRuntime` 改成多实例句柄。

### 4.5 `device_agent`：跨设备派任务

模板是现有的 `code_agent`（`packages/computer-use/src/code-agent.ts`），结构一一对应：

| `code_agent` | `device_agent` |
|---|---|
| `sessionController.create({ agentPreset: 'desktop' })` | 远程 `session/create`（目标设备的标准 preset） |
| `sessionController.prompt({ mode: 'queue' })` | 远程 `session/prompt` |
| `watchCodeAgentCompletion`（本机 `whenIdle()`） | 订阅目标会话的 `session/follow`，等 `turn/end` |
| `followup(createUserMessage(...))` | 同样的 followup 通知，正文标明来源设备 |
| `code_agent_status` / `_stop` | 远程 `session/list` 过滤 + `session/cancel` |

**工具签名（草案）**：

```
device_agent({
  device: string,          // 设备名或 deviceId；必填
  task: string,            // 任务描述；必填
  workspace?: string,      // 目标工作区名或 id；省略时落到该设备的默认任务目录
  session_id?: string,     // 继续已有远程会话
  attachments?: string[],  // 本机绝对路径，先上传再 prompt
})
→ { accepted, created, device_id, session_id }

device_agent_status({ device?: string })
→ { count, tasks: [{ device_id, session_id, task, status }] }

device_agent_stop({ device: string, session_id: string })
→ { accepted }
```

**关键差异（`code_agent` 里有一半的 API 在远程场景不存在）**：

| `code_agent` 用的 | 本地 | 远程 | 替代做法 |
|---|---|---|---|
| `sessionController.create` | ✅ | ❌ | 在**目标设备**上 create（走 RPC） |
| `sessionController.prompt({mode:'queue'})` | ✅ | ❌ | 远程 `session/prompt` |
| `sessionController.inspect` / `selectModel` | ✅ | ❌ | 远程同接口 |
| `ctx.get('agents').get(id)` | ✅ | **❌ 不存在** | 无法拿到远程的 live Agent |
| `agent.whenIdle()` | ✅ | **❌** | 订阅远程 `session/follow`，看 `running` 变 false |
| `agent.followup(...)` | ✅ | **❌ 远程** | 只能 followup **本机**的调用方（派发它的那颗球） |
| `agent.inbox` / `code.ctx.on('approval/request')` | ✅ | **❌** | 审批必须在目标端挂 answerer |
| `agent.session.deriveMessages()` | ✅ | ❌ | 用远程 `session/page` 或 `follow` 的 records |
| `attachUnattendedCodeAgent(code)` | ✅ | **❌ 绝对不能对远程用** | 会把用户该批的审批全自动放行 |
| `workspaceRegistry.resolveByPath` | ✅ | ❌ | 目标端的工作区 id |

**所以 completion 的写法要变**：`code_agent` 是「等 `code.whenIdle()`，再 `caller.followup()`」，两步都在本进程。`device_agent` 是「等远程 `session/follow` 显示出这一轮结束，再 `caller.followup()`」——后半段仍在本机（派发它的那颗球），前半段跨网络。实现时要处理：

- **不能只看 `running === false`**：一次 `prompt` 排队期间 `running` 可能还是 false，会误判完成。要盯住 `turn/start` → `turn/end` 这一对事件（`code-agent-completion.ts` 里 `waitUntilIntervalStarts` 处理的正是同类问题）。
- 断线重连后重新订阅，**不能重复发完成通知**（用 `sessionId + turnId` 去重）。
- 用户手动取消（`session/cancel`）与自然结束要区分，通知文案不同（本地版已有 `lastTurnEndedUserAborted` 的判定逻辑可参考）。
- 目标设备离线 → 通知「设备离线，任务状态未知」，不要假装完成。

### 4.6 审批转发（核心新能力）

**DSH 侧的挂点**（已核实）：

- 审批：`approval/request` 是 Cordis waterfall，`code-agent-unattended.ts` 用 `code.ctx.on('approval/request', ..., { prepend: true })` 挂应答器，返回 `'allowed-once'`。
- 问答：`user-questions/request` 同理。
- 会话事件：`approval/asked`（含 `id`、`toolName`、`callId`、`reason`）和 `approval/decided`（含 `outcome`）都会写进 session 日志。

**归属可以精确确定，不需要额外标记**（已核实）：Host 侧的 bridge 是**按连接**创建的（`service.ts:100` 的 `new HarnessRemoteBridge(...)` 在 `connections` 的每连接回调里），并且 `context.peerDeviceId` 就是调用方设备。也就是说，「这条 approval 是哪个远端触发的」在 Host 侧本来就已知。

**设计**：

```
目标设备（B）侧：
  packages/mesh/src/approval.ts
    - 在每建的连接作用域里挂 approval/request answerer
    - 只有「该会话本轮是由 peerDeviceId 这个远端 prompt 触发的」才转发
      （判断依据：本连接作用域内的 session/follow 发起 + session/prompt 未结束）
    - 转发 { approvalId, sessionId, toolName, reason, callId } 给 A，挂起
    - 本地原生 UI 若先答，直接 resolve；先到者决定
    - 应答到达 → resolve('allowed-once' | 'rejected')

来源设备（A）侧：
  - 收到审批请求 → 在 Mesh UI 弹审批卡（悬浮球面板只在悬浮球派出任务时弹）
  - 用户点允许/拒绝 → 回传 { approvalId, outcome: 'allowed-once' | 'rejected' }
```

> `ApprovalOutcome` 的封闭取值是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（见 `dsh-user-approval/lib/types/types.d.ts`）。v0 只回前两个；`cancelled` 用于发起侧撤回，`unavailable` 由 DSH 自己产生。

**传输通道**：复用 `plugin-route-bridge.ts` 的机制——它已经能把「本机插件路由」经 E2E 转发，并已支持 `approval-answer` 这个 operation 名（现在用于 ds-bot）。我们在 fork 的 `PLUGIN_ROUTE_ALLOWLIST` 里加上 `api/mesh`，在 mesh 包里注册对应路由：

```
POST api/mesh  { endpoint: 'approval-ask' | 'approval-answer' | 'question-ask' | 'question-answer', payload }
```

**必须处理的边界**：

1. **双向都能答**：A 应答后，B 本地的原生审批卡要能被撤销。`ApprovalService.request` 的注释写明「aborting withdraws the question」，所以用一个 `AbortController` 在 A 应答时 abort 掉本地请求即可。
2. **发起设备离线**：请求保留在 B 的内存里，B 本地仍可答；A 重连后若请求已结束，补一条「已由目标设备处理」的通知，不重复弹。
3. **会话不是远程发起的**：本连接作用域里挂的 answerer 只覆盖经该连接触发的 prompt，本地会话完全不受影响。
4. **敏感操作**：不因为「发起设备已批准」就跳过目标设备的额外确认策略；审批策略仍由目标设备决定。
5. **超时**：DSH 的 `request(req)` 要求「有打开的 turn」，没有内建超时。我们要自己给转发加一个上限（建议 5 分钟），超时后按 `rejected` 处理并告知发起侧，避免任务永久挂住。

**问答（`ask_user_question`）**：同样的路径。优先级 P1，v0 可先只做审批，问答退回「去目标设备回答」。

### 4.7 Mesh UI

**位置**：`packages/helper` 新增一个 `mesh.html` + `mesh.js`，与现有 `floating.html` / `shell.js` 同级。窗口类型是普通 `BrowserWindow`（非透明、非置顶），由 host 通过 IPC 打开。

```
┌──────────────────────────────────────────────────────────────┐
│ 设备：[书房 Mac ▾]  服务：YOUR_SERVER_IP  ● 已连接    ⟳ 重连  │
├───────────────────────┬──────────────────────────────────────┤
│ ▾ 本机（书房 Mac）     │  公司 Windows · Q4 报价 · 改报价单     │
│   ▾ 品牌改版           │  ─────────────────────────────────── │
│     · 设计说明 v3      │  [user] 把标题改成蓝色                │
│   ▸ 设计说明           │  [tool] read_file  Q4报价单.xlsx      │
│                       │  [tool] edit_file  （等待审批…）      │
│ ▸ 公司 Windows ●在线   │  ┌────────────────────────────────┐  │
│   ▾ Q4 报价            │  │ 允许修改《Q4 报价单》吗？        │  │
│     · 改报价单 ⟳运行中 │  │   [允许本任务]  [拒绝]          │  │
│     · 客户资料 ✓完成   │  └────────────────────────────────┘  │
│ ▸ 随身手机 ○离线 2h    │  ─────────────────────────────────── │
│                       │  [ 输入指令…              ] [ 暂停 ] │
└───────────────────────┴──────────────────────────────────────┘
```

**实现要点**：

- **窗口类型**：普通 `BrowserWindow`（`resizable: true`、有边框、进任务栏、约 960×640），**不要**用 `type: 'panel'`、不要 `alwaysOnTop: 'screen-saver'`、不要 transparent——那是球和浮层的配置。Mesh 是一个正常窗口。
- 菜单入口：`packages/helper/src/menu.ts` 已有「打开主窗口」「打开悬浮球设置」，加一行「打开互联」。
- 左侧树的数据来自 `tree.ts`：本机走 `session/list` + `workspace/follow`；对端走每个 `RemoteHandle` 的同名调用。离线设备保留最后一次快照并标灰。
- 右侧 transcript 复用 `shell.js` 里的 `transcript-model.js` 与 `chat.css`（已经是原生 DOM 渲染 + Shiki/KaTeX，不引入框架）。
- **流必须按会话寻址**：host 现在只推「一个本地会话」的 `block`/`question`（球的当前会话）。Mesh 要的是多设备多会话，消息帧必须带 `{ deviceId, sessionId }`，不能复用现有的单会话广播。
- **审批卡是新组件**：helper 现在**没有**审批卡 UI（球只有 ask-user 的问答卡，不是权限审批）。要新建，数据来自 `approval.ts`，两种回答：`allowed-once` / `rejected`。
- 「暂停」按钮调用远程 `session/cancel`。
- 状态刷新：`session/follow` 和 `workspace/follow` 都是流，用「流 + 快照」两级，不轮询。
- **没有现成的 OS 通知模块**：仓库里「后台完成」是三样东西——模型态 followup、书签条芯片（host 每秒 poll 一次）、未读语义。跨设备完成通知沿用前两样，不要去找 Electron `Notification` 的现成封装（没有）。

### 4.8 设置页「互联」板块

现有机制：`packages/client-settings/client.js` 通过 `ctx.slots.inject('settings.section', ...)` 注册悬浮球设置（`id: 'orb'`、`order: 25`），页面用相对路径 fetch 打 `/.dsh-orb/*`（靠 Cookie）。host 半边只有个空壳 `src/index.ts`。

**推荐做法：新开一个 `settings.section`**，而不是塞进现有悬浮球页：

```javascript
// client.js 里再注册一个
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'orb-mesh',
  order: 26,
  label: () => copy().nav,   // '互联' / 'Interconnect'
  inject: () => ({}),
}, OrbMeshSection))
```

理由：现有悬浮球页已经很大（`client.js` 约 176k），再塞进去难维护；而且设置页的卡片顺序有测试断言，插卡片会连带改测试。

板块内容：

- 服务地址（默认填 `https://YOUR_SERVER_IP`）、配对码输入、连接测试。
- 本机名称（可改）。
- 设备列表（只读）。
- 安全：允许被调用开关（默认开）、允许的调用方设备、文件接收目录。

**host 侧要动的文件**：

- `packages/host/src/preferences.ts`：新增 profile 文件（如 `orb-mesh.json`：relay 地址、设备名、配对状态）。
- `packages/host/src/routes.ts`：新增 `/.dsh-orb/mesh/*` 路由与 snapshot 字段（现在完全没有互联相关路由）。
- 或者由 `packages/mesh` 自己注入 `webServer` 注册独立前缀——两种都行，但**快照要能到设置页**，所以要么并进 `/settings` 的返回体，要么新开一个 GET。
- 深链：球菜单现在能 arm `/.dsh-orb/settings-open` 让主窗口打开悬浮球那一节；互联可以复用同一机制加一个 `openSection('orb-mesh')`。

### 4.9 别漏掉 persona

新工具要进模型视野，除了注册工具，还得**在 `preset-computer-use` 的 persona 里告诉模型什么时候用它**——现有 persona 就有一整段在讲 `code_agent` 的用法（`cordis.patch.yml` 第 27–34 行附近：什么时候该派、什么时候留在本机、派完怎么回复用户）。`device_agent` 需要对应的一段：怎么判断设备、不确定时先问、派完告知在跑、完成通知到了怎么收尾。

**不加这段的后果**：工具注册了但模型不会用，或者乱用。

### 4.10 要模仿的测试

| 现有测试 | 覆盖什么 | mesh 对应 |
|---|---|---|
| `computer-use/tests/code-agent.spec.ts` | create+queue、继续、cwd slug、模型选择与恢复、status/stop、完成 followup、inject 身份 | `mesh/tests/device-agent.spec.ts` 直接照这个结构改（vitest + 同样的假 `sessionController` / `Agent`） |
| `computer-use/tests/code-agent-registry.spec.ts` | record/list/stop/complete/dropCaller | mesh 的任务注册表 |
| `computer-use/tests/code-agent-registry-mount.spec.ts` | 应用级 provide + `tools.guard` | mesh 应用级插件挂载 |
| `computer-use/tests/loader-composition.spec.ts` | 真实 cordis loader 能挂上 preset | mesh preset 行 |
| `host/tests/routes.test.ts` | 路由鉴权、snapshot、POST 处理 | `/.dsh-orb/mesh/*` |
| `client-settings/tests/section.test.mjs` | section id/order、相对 fetch、卡片顺序 | 新 section |
| `bundle/tests/install.test.mjs` | patch 名字能从假 profile 解析 | 新 specifier |
| `helper/tests/shell-render.test.ts` | transcript DOM | Mesh 窗口 |

测试分层：host / helper 用 Node `node:test`；computer-use 与 mesh（要启 Cordis + 假 DSH）用 vitest。

### 4.11 退出标准

对应 [16-v0-plan.md](16-v0-plan.md) 7.1 的 1–11 条，逐条可验；额外加：

- 审批能从 Windows 回到 Mac 并在 Mac 上应答（4.6）。
- 断线 30 秒内重连，树恢复，未丢消息。
- 发起设备离线时，目标设备仍能独立完成或审批。
- 模型在悬浮球里能正确选择 `device_agent` 或 `code_agent`（persona 生效）。

---

## 5. 工作流 A：手机端

### 5.1 现状（fork 基线）

`/tmp/dshgo`（dsh-Go `1.0.14`）已核实的关键资产：

| 能力 | 文件 | 现状 |
|---|---|---|
| 悬浮窗 | `pet/PetOverlay.kt`（1966 行）、`OverlayWindowOwner.kt`、`EdgeSnap.kt` | **原生 Kotlin View**；`TYPE_ACCESSIBILITY_OVERLAY`（无障碍开时，无需额外权限）或 `TYPE_APPLICATION_OVERLAY`；拖拽、吸边、长按菜单、气泡 |
| 悬浮球骨架 | `phone/a11y/OverlayBall.kt`、`ControlOverlay.kt`、`OverlayCapsule.kt` | **48 dp 球 + 停靠 + 按住停止**，只用 `TYPE_ACCESSIBILITY_OVERLAY`；比宠物更接近 Orb 的球 |
| 问一句输入条 | `pet/AskBar.kt` | 独立可聚焦窗口；**按住说话已实现**（`ACTION_DOWN/UP/CANCEL` + 滑出取消 + 状态行）；最少 0.3 s，静音阈值 400 ms；原生 `EditText`，`onKeyPreIme` 关闭，IME inset 抬升 |
| 截图 | `pet/PetScreenshot.kt`、`phone/a11y/ScreenShooter.kt` | **无 MediaProjection**，全部走无障碍；API 34+ 用 `takeScreenshotOfWindow(window.id)`（悬浮窗天然不在画面里）；API 30–33 用 hide-for-capture + `takeScreenshot(DEFAULT_DISPLAY)`；`hideForCaptureWithReceipt` 有**引用计数**，宠物截图与 Agent 截图可重叠 |
| 手机 CU | `phone/PhoneCore.kt`、`PhoneToolCatalog.kt`、`a11y/*` | 工具：`apps/open/intent/notify/clipboard/screen/collect/tap/type/scroll/key/tap_xy/handoff`；元素树 1-based 编号，快照内有效，动作前重新校验指纹 |
| 安全确认 | `phone/SafetyGate.kt`、`PhonePrompts.kt`、`ControlOverlay.kt` | 银行/支付拒绝表、微信逐次确认、`ask`/`task`/`always` 三档、`handoff`（10 分钟）、确认卡 30 秒超时 |
| 语音 | `voice/WavRecorder.kt`、`VoicePlugin.kt`、`MicArbiter` | 44 字节头 + 16 kHz 单声道 PCM16；设备端 SenseVoice 优先，回退系统 ASR；**录音只在原生侧** |
| 本机引擎 | `runtime/` | PRoot + DSH `0.2.2-rc.1` + Node `24.22.1`；`dsh web` 跑在 `127.0.0.1:3080`；ABI 只有 **arm64-v8a / x86_64** |
| 原生 ↔ 引擎桥 | `phone/PhoneBridge.kt`、`PhoneGuest.kt` | **抽象 Unix socket + MCP over JSON-RPC**（`SO_PEERCRED` 校验 uid + 每次启动随机 token），PRoot 内的 Node 直接连得上；loopback TCP 是回退 |
| 聊天 UI | `app/lib/ui/chat/*`、`state/*` | **在 Flutter Activity 里**，不在悬浮窗里 |

**两个必须写进方案的硬约束**（这是本节最容易被低估的地方）：

1. **悬浮窗是原生 Kotlin 视图，不是 Flutter。** 现有浮层只有：宠物精灵 + 气泡、`AskBar` 输入条、`ControlOverlay` 确认卡。**没有任何浮层能跑 Flutter 组件**，`ui/chat` 的 transcript / 工具卡 / 审批卡全部依赖 Activity 上下文与玻璃质感布局，尺寸也不适合 48 dp 的球。设计要求本身也写明「不抢焦点，不弹 Activity，不在别的 App 上自动展开任何东西」。
2. **`PetScreenshot` 现在的用法不是「发送时截图」。** 它对应的是菜单里的「截图并问」：用户主动点 → 隐藏浮层 → 截图 → **打开 App** → 填进输入框，**不自动发送**。Orb 需要的是「松手那一刻自动截图并随消息一起发出，全程不切到 App」，这是一条新回路。

**接入方式**：Orb 复用 `PhoneBridge` 这条已存在的桥（模型侧看到的能力仍是 DSH 工具），Dart 侧只通过 native plugin 通道驱动 UI 状态，不新开通信路径。但**面板本身是原生视图**（理由见 5.4）。

### 5.2 目标结构

基于 dsh-Go 建分支 `orb`，新增一个「Orb」形态，不破坏原有 App：

```
app/android/.../orb/            # 新原生模块（Kotlin）
  OrbOverlay.kt      # 球窗口：起点是 phone/a11y/OverlayBall.kt，不是 PetView
  OrbGesture.kt      # 长按录音 → 松手发送；上滑取消
  OrbPanel.kt        # 面板窗口（原生视图，见 5.4）
  OrbPanelAdapter.kt # 把 DSH 会话数据映射成原生行的列表适配器
  OrbSender.kt       # 组装「文字 + 截图」并投递到本机会话（新回路）
  OrbScreenshot.kt   # 发送时截图：hide → settle → capture → restore，一条龙
app/android/.../phone/a11y/ControlOverlay.kt   # 改：把 Orb 窗口纳入 hideForCapture 引用计数
app/lib/orb/                    # Dart 侧（不画 UI，只传状态）
  orb_state.dart     # 状态机 idle/recording/thinking/waiting/tool
  orb_channel.dart   # 新增 dsh/orb channel 的 Dart 端
  orb_settings.dart  # Orb 设置（语音、截图、权限）
```

**为什么面板是原生而不是 Flutter**：见 5.4 的选型。核心事实是现有浮层全是 Kotlin View，Flutter 只在 Activity 里画；把 Flutter 塞进悬浮窗需要第二个 `FlutterEngine` + `FlutterView`，IME、焦点、生命周期都是greenfield，风险远大于收益。

### 5.3 要串起来的流程（这是手机端的核心工作）

现有零件是「分开的」，Orb 要做的是**一条原子流程**：

```
长按球
  → 录音开始（原生 WavRecorder，走 AskBar 那条路径，不走 VoiceInputController）
  → 球变形成波形态
  → 松手
      ├─ 上滑取消 → 丢弃录音，回 idle
      └─ 正常 → 三件事（转写与截图可并行）：
           1. ASR 转写（设备端 SenseVoice 优先，回退系统 ASR）
           2. hideForCapture(true) 隐藏球 + 面板，等 ~120ms settle
           3. 截图（API 34+ 走 takeScreenshotOfWindow；30–33 走 display 截图）
           4. 立刻 hideForCapture(false) 恢复
  → 组装消息：{ text: 转写, image: 截图路径 }
  → 投递到本机会话（悬浮球自己的会话）
  → 面板展开，显示「已收到 + 截图缩略图」
  → Agent（computer-use preset）看截图 → 调手机 CU
```

> 三条必须遵守的顺序/边界：
> 1. **必须先隐藏再截图**，`PetScreenshot.capture` 的注释明确写「The caller hides its pet windows first」。用 `hideForCaptureWithReceipt()` 拿到的窗口 id 集合，事后可断言「球确实被隐藏」。
> 2. **截图失败不阻断发送**。`SECURE` / `ACCESSIBILITY_REQUIRED` / `UNSUPPORTED` 时只发文字，并在正文加一句「当前屏不可截」。现有 `PetScreenshot.Error` 枚举已覆盖，不需要新错误分类。
> 3. **全程不能打开 Activity**。现有「截图并问」会跳到 App 里填输入框；Orb 必须在浮层内完成投递。

**必须新建/改的部分**：

| 项 | 现状 | 要做 |
|---|---|---|
| 长按 → 录音 → 松手发送 | `AskBar` 已有，但只在输入条里；`OverlayBall` 的「按住」是**停止**不是录音 | 把 AskBar 的触摸语义搬到球上；球需要「按住变形 + 波形 + 上滑取消」 |
| 录音路径选择 | `VoiceInputController` 在 `paused`/`hidden` 时**主动取消**；`WavRecorder` 走原生 FGS 才行 | Orb 的 PTT **必须走原生 `WavRecorder`**（即 AskBar 那条路径），不能复用 composer 的控制器 |
| 发送时截图 | 「截图并问」是菜单动作，会跳 App、不自动发送 | 新写 `OrbScreenshot.kt` 把「隐藏→截图→恢复→投递」串成一条不切 App 的回路 |
| 「截图里没有球」可验证 | `hideForCaptureWithReceipt()` 返回被隐藏的窗口 id | Orb 窗口要纳入 `CaptureVisibility` 的引用计数（宠物截图与 Agent 截图可重叠，现在是这么处理的） |
| 面板 | App 内有聊天页但不在浮层；浮层只有输入条 | 新做**原生**浮层面板（见 5.4 选型）；先做「最近 N 条 + 状态 + 停止」，工具卡后置 |
| 审批/问答卡 | Flutter `ApprovalCard` 在 Activity 内；宠物气泡只支持短文本 + allowOnce/reject | 面板里做原生审批卡（allowOnce / reject，与气泡能力对齐）；「总是允许」只在 App 内提供 |
| preset / 权限 | dsh-Go 有自己的 preset | 新增 Orb preset：手机 CU 工具 + 本机后台 Agent + 截图附件 |
| 完成后回到 Orb | 有 `ChatNotifier` / 气泡 / live activity，但不是 Orb 形状 | 面板内状态更新 + 通知；面板隐藏且 Activity 不可见时也要能用 |

### 5.4 面板宿主选型（A3 前必须定）

这是手机端最大的架构决策，三条路的代价差异很大：

| 方案 | 做法 | 代价 | 建议 |
|---|---|---|---|
| **A. 原生面板** | Kotlin 重写一个精简 transcript（最近 N 条 + 工具状态行 + 审批卡 + 停止） | 要重写渲染（Markdown/代码高亮不做） | **推荐 v0** |
| **B. 浮层里跑 Flutter** | `FlutterEngine` + `FlutterView` 塞进 `TYPE_APPLICATION_OVERLAY` | 第二个引擎、IME、焦点、生命周期全是 greenfield；`targetSdk 28` 下 overlay 里跑引擎未验证 | 不做，除非 A 证伪 |
| **C. 点球进 Activity** | 球只做入口，面板复用现有聊天页 | 不是「浮层面板」，每次都要切 App，违背 PRD 的「不需要离开当前 App」 | 只作为降级 |

选 A 的额外理由：现有浮层设计明确不抢焦点、不弹 Activity；宠物气泡已经验证了「在浮层里放少量结构信息」是可行的，Orb 面板是这个模式的放大版，不是新范式。

### 5.5 关键风险与拆解

| 风险 | 说明 | 拆解 |
|---|---|---|
| **后台录音被静音** | 没有 `microphone` 类型的 FGS（现有两个 service 都是 `specialUse`）；API 29+ 有 `isClientSilenced`；OEM 各有策略 | **A0 第一件事**：在真机上「另一个 App 前台时按住球录音」，量出是否静音、拿到多少字节。不成立就先补 FGS 类型 |
| **浮层不能跑 Flutter** | 现有浮层全是 Kotlin View | 已在 5.4 选 A（原生面板） |
| **发送时截图的时序** | hide 不是合成器 ACK，靠 120 ms 启发式；`FLAG_SECURE` 页会全黑 | A1 单独验证：微信/银行/游戏各截一张；API 30 vs 34 两种路径 |
| **录音时球在变形** | 球窗口尺寸变化影响录音与焦点 | 用「球 + 独立小波形窗」两窗协作，避免改球窗口尺寸 |
| **厂商悬浮窗/无障碍限制** | `canDrawOverlays` 会撒谎；有厂商开关；无障碍会被杀 | 沿用现有「加 1×1 窗口探测」的做法；优先无障碍 overlay（无需额外权限） |
| **浮层里的 IME** | 现有 AskBar 已经特殊处理（`onKeyPreIme`、`SOFT_INPUT_ADJUST_NOTHING`、inset 抬升） | 面板先只读；输入沿用 AskBar 的成熟实现，不新造 |
| **引擎在后台被回收** | PRoot + Node 重；OEM 电池杀手 | A4 验证：派一个长任务后离开 App 10 分钟，看是否跑完并通知 |
| **ASR 延迟** | 「3 秒内看到消息」是 PRD 指标 | 先展示「转写中」，不阻塞；设备端 SenseVoice 优先（浮层路径本来就只走本地） |
| **前台 App 与 Agent 抢屏** | 用户可能切走 | 沿用 `SafetyGate` + handoff；Orb 层不新增机制 |
| **AGPL-3.0** | `app/` 是 AGPL；`sdk/`、`examples/`、`packages/dsh_remote` 是 MIT；**品牌/素材不在 AGPL 内** | 先内部自用；对外分发前做许可评估；改版必须换自己的名字与美术 |

### 5.6 Android 兼容基线

- 继承 dsh-Go 的版本/ABI：**minSdk 26、targetSdk 28、只出 arm64-v8a 与 x86_64**（无 32 位 ARM）。
- 无障碍是**硬依赖**（截图 + CU 都走它）。没有无障碍时 Orb 只能做纯文字问答。
- 截图能力分层：**API 34+** 有窗口级截图（最干净）；**API 30–33** 走 hide-for-capture + display 截图；**< API 30** 不支持截图。
- 构建链与 App 一致：Linux x86_64 主机、JDK 17、Flutter 3.47.7、AGP 9.1.0、Kotlin 2.4.0。

### 5.7 退出标准

对应 [16-v0-plan.md](16-v0-plan.md) 7.2 的 1–7 条，逐条可验；额外加：

- 截图里不出现球和面板（用 `hideForCaptureWithReceipt` 的 id 集合 + 像素比对双重验证）。
- 银行/密码页触发 `FLAG_SECURE`，只发文字并提示。
- 长按不说话（< 0.3 s 或静音）不会发出空消息。
- **另一个 App 在前台时，长按球说话能正常录音并发送**（这是 A0 的通过条件，不是可选项）。

---

## 6. 接口约定（两条线共享）

即使 v0 手机端不接互联，也要先把下面这些**数据形状**定下来，避免后期改造：

### 6.1 设备描述

```ts
DeviceDescriptor {
  deviceId: string          // 随机 UUID，首次启动生成
  name: string              // Mac1 / 书房 Mac
  platform: 'darwin' | 'win32' | 'android' | 'linux'
  role: 'host' | 'client' | 'both'
  identityKey: string       // 公钥（base64）
  harnessVersion?: string
  appVersion?: string
}
```

### 6.2 会话状态枚举（树里显示用）

```
'idle' | 'running' | 'waiting-approval' | 'waiting-question' | 'failed' | 'offline'
```

> 注意：`offline` 是设备级状态，不是会话级；会话在离线设备下显示为「未知 + 上次已知状态」。

### 6.3 审批请求

```ts
ApprovalAsk {
  approvalId: string
  sessionId: string
  deviceId: string          // 目标设备
  originDeviceId: string    // 发起设备
  toolName: string
  callId?: string
  reason?: string
  createdAt: number
}

ApprovalAnswer {
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
  answeredBy: string        // deviceId
}
```

### 6.4 任务派发

```ts
DeviceTask {
  taskId: string
  originDeviceId: string
  targetDeviceId: string
  sessionId: string
  workspaceId?: string
  status: 'queued' | 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
}
```

---

## 7. 里程碑与建议顺序

两条线独立推进，各自有「先验证再实现」的前置。

### 工作流 B（服务端 + 电脑插件）

| 里程碑 | 目标 | 关键动作 | 退出 |
|---|---|---|---|
| **B0 实验**（1–2 天） | 确认真实基线 | 见下方 B0 清单 | 一份「能复用 / 要改 / 被卡」结论 |
| **B1 连接** | 配对 + 在线 | fork server，实现 `register-with-code` + 管理页；IP + 自签证书上线 | 两台设备用码接入，管理页可见 |
| **B2 看见** | 树 + 只读会话 | `packages/mesh`：identity、peers、tree；Mesh UI 左树 + 右 transcript（只读） | 两台电脑互相看到工作区/会话，实时 |
| **B3 动手** | 输入 + 暂停 | `session/prompt`、`session/cancel` 接到 Mesh UI；设备级允许开关 | 能发指令、能暂停 |
| **B4 派发** | `device_agent` | 三个工具 + 完成通知 + 附件上传 | Mac 派任务给 Windows 并收回结果 |
| **B5 审批** | 审批转发 | `approval.ts` + `api/mesh` 路由 + 审批卡 | Windows 的审批在 Mac 上可答 |
| **B6 验收** | 硬化 | 安全/性能/运维 + 11 条验收 | 全过 |

**B0 清单（按顺序做，每步都要写结论）**

1. **服务端起得来**：在 `YOUR_SERVER_IP` 上用官方镜像 `docker compose up`，确认 `/health` 可达；再配 Caddy 自签证书，确认 `https://IP` 可连（`curl -k` 通过，`curl` 不带 `-k` 失败——这就是需要 pin 的原因）。
2. **插件装得上**：在 Mac 和 Windows 各装 `ds-harness-remote`（官方包），用「账号密码」模式连上，确认设置页出现 Remote 面板。
3. **两端能互连**：Mac 作为 Client 连 Windows（Host），打开一个会话，`session/follow` 有实时输出，`session/prompt` 能发，`session/cancel` 能停。
4. **文件能来回**：`remote_upload_file`（Mac 本地绝对路径 → Windows）与 `remote_download_file`（Windows → Mac `~/Downloads/dsh-remote-*`）。
5. **审批现在什么样**：故意让 Windows 上的会话触发审批（改文件/跑命令），记录审批弹在哪、能否被 Mac 应答、不理会时任务怎么走。**这一步的结论直接决定 4.6 的实现细节**。
6. **多 Client 并发（Host 侧）**：Mac 与第三台（可用另一台虚拟机或本机第二 profile）同时连 Windows，确认 `connectedPeers()` 有两个、互不替换。
7. **多 Host 并发（Client 侧）**：在一个进程里用 `ClientConnection` 并发连 3 个 Host（可用本机起 3 个 server 实例），验证 4.4 方案 A。
8. **`register-with-code` 缺失确认**：对 server 发 `POST /api/v1/devices/register-with-code`，确认 404 —— 印证「客户端有、服务端缺」，确认 B1 的改造范围。

### 工作流 A（手机端）

| 里程碑 | 目标 | 关键动作 | 退出 |
|---|---|---|---|
| **A0 球与说话** | 长按 → 发送文字 | 球窗口（起点 `OverlayBall`）+ 长按录音 + 松手发送 + 上滑取消；投递到本机会话 | 说完，面板里出现文字 |
| **A1 截图** | 发送时带截图 | 新写 `OrbScreenshot`：hide → settle → capture → restore → 投递，全程不切 App | 消息里同时有文字和截图，图中无球 |
| **A2 手机 CU** | 对当前屏操作 | Orb preset 接入 `PhoneToolCatalog` + `SafetyGate`；敏感确认 | 能完成「点按钮/填表单」，敏感步骤需确认 |
| **A3 面板** | 浮层对话面板 | **原生**面板（选型见 5.4）：最近 N 条 + 状态 + 审批卡 + 停止 | 不打开主界面也能完成一轮 |
| **A4 后台** | 本机后台 Agent | 后台会话 + 完成通知（面板隐藏、Activity 不可见时也要能用） | 长任务能后台跑完并回到 Orb |

**A0 清单（先验证再实现，按风险从高到低）**

1. **后台录音是否被静音（最高风险，先做）**：装现有 App，打开宠物悬浮窗，切到微信/浏览器，用 AskBar 按住说一句话。记录 `isClientSilenced`、拿到的字节数、转写是否成功。**这一步不通过，Orb 的核心交互就不成立**，要先给 FGS 补 `microphone` 类型再继续。
   - 注意：现有两个前台服务都是 `specialUse`，没有 `microphone`；composer 的 `VoiceInputController` 在 `paused`/`hidden` 时会主动取消，所以**不能用它做 Orb 的 PTT**。
2. **工具链能出包**：Linux x86_64 + JDK 17 + Flutter 3.47.7 + AGP 9.1.0；`bash runtime/build-runtime.sh arm64-v8a` 后 `bash tooling/build-apk.sh -f arm64`，装到真机。
3. **引擎能跑**：确认 PRoot 里的 DSH `0.2.2-rc.1` 起来、`127.0.0.1:3080` 可访问、能跑一轮对话。
4. **无障碍能开**：`PhoneA11yService` 连上，`takeScreenshot` 可用（截图与 CU 的共同前置）。
5. **球能显示**：`OverlayBall` 在目标 ROM 上可见、可拖、可停靠；记录厂商开关的影响。
6. **截图无球（两条 API 路径都测）**：API 34+ 试 `takeScreenshotOfWindow`；API 30–33 试 `hideForCaptureWithReceipt` + 120 ms settle + display 截图。各截微信、银行、游戏一张，确认无悬浮控件、银行页返回 `SECURE`。
7. **结论**：哪一步在目标机型上不成立，就先解决它，再动 Orb 的 UI。

**并行建议**：B0/B1 与 A0 可以同时开始，互不依赖；B2–B5 与 A1–A4 可以同步推进。

---

## 8. 风险清单

| 风险 | 影响 | 应对 | 归属 |
|---|---|---|---|
| 多 Host 并发不支持 | 树只能一个个看 | B0 先实验；必要时改上游或自管连接 | B |
| 审批应答语义不清 | 审批卡挂住/重复 | B0 摸清 `approval/request` 与 `approval/asked` 事件；v0 先做「一次性允许/拒绝」 | B |
| 自签证书 + IP | 客户端连不上 | 客户端 pin 指纹；管理页走 SSH 隧道 | B |
| 服务器 12/10 到期、2C2G | 中途断服 | 现在决定续费；Relay 只转发密文，够用 | B |
| **后台录音被静音** | Orb 核心交互不成立 | A0 第一步就测；不通过则补 FGS `microphone` 类型 | A |
| **浮层不能跑 Flutter** | 面板无法复用 `ui/chat` | 选原生面板（5.4 方案 A），A3 前定案 | A |
| **「截图并问」不等于「发送时截图」** | 会跳 App、不自动发送 | 新写 `OrbScreenshot` 回路 | A |
| 录音与截图抢时序 | 截图里出现球、或录音被截断 | 松手后串行：转写 → 隐藏 → 截图 → 恢复；实测 settle | A |
| ROM 限制悬浮窗/无障碍被回收 | 部分机型球不显示 | 优先无障碍 overlay（无需额外权限）；沿用 1×1 窗口探测 | A |
| 引擎在后台被 OEM 回收 | 长任务中断 | A4 验证离开 App 10 分钟仍跑完 | A |
| dsh-Go AGPL + 品牌素材限制 | 分发受限 | 先内部自用；改版换自己的名字与美术；对外前做许可评估 | A |
| 版本漂移 | 升级 DSH 后插件不兼容 | 锁版本 + CI 里跑 bundle 校验 | A+B |

---

## 9. 待确认（不阻塞开工）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | 改名冲突：设备改名 vs 管理员改名 | 后写覆盖；管理员改名后锁定（`nameLockedByAdmin`） |
| Q2 | 文件接收目录 | `~/Downloads/dsh-mesh/`，可在设置里改 |
| Q3 | 派任务不指定工作区时落哪 | 目标设备 `~/.dsh/mesh-tasks/<taskId>/` 新建会话 |
| Q4 | 会话列表范围 | v0 只显示「本机全部 + 远程全部」，不做过滤/搜索 |
| Q5 | 审批问答是否 v0 就做 | 审批做；问答 `ask_user_question` 推到 v0.1 |
| Q6 | 手机端是否用同一套 `packages/protocol` | v0 不用，A4 之后再评估 |
| Q7 | 手机面板是否接受「原生精简版」 | 接受（5.4 方案 A）：最近 N 条 + 状态 + 审批卡 + 停止，不做 Markdown 渲染 |
| Q8 | Orb 是否要给 FGS 补 `microphone` 类型 | 视 A0 第 1 步结果；若被静音就必须补 |
| Q9 | Orb 是否沿用 dsh-Go 的品牌 | 分发前必须换名换图（品牌素材不在 AGPL 内）；内部自用可暂用 |

---

## 10. 第一批可执行任务

按依赖排序，可直接派给同事：

**服务端（B1）**
1. fork ds-harness-remote，在服务器用官方镜像跑起来，确认 `https://IP` + 自签证书可行。
2. `store.ts` 加配对码模型（version 2）；实现 `POST /api/v1/devices/register-with-code`（客户端已在调这个端点）。
3. 改 `devices/:id/name` 为设备自改 + 新增管理员改名。
4. `web/` 加 `/admin` 页面：设备表 + 配对码区 + 撤销。
5. 部署脚本：Caddy + 自签证书 + 只开 443 + 备份。

**电脑插件（B2/B3）**
1. 起 `packages/mesh` 骨架：`package.json` / `tsconfig.json` / `tsdown.config.ts`，`src/index.ts` 只做 `name` + `inject` + 空 `apply`，先让 `pnpm typecheck` 过。
2. 多 Host 实验（4.4 方案 A），产出结论——**这条决定后面所有连接管理代码的形态**。
3. `peers.ts` + `tree.ts`：本机走 `sessionController.list`，对端走 `RemoteHandle`；`session/follow` + `workspace/follow` 两级。
4. helper 加 `mesh.html` / `mesh.js`（普通 BrowserWindow，非 panel），左树 + 右 transcript（只读）；菜单加「打开互联」。
5. host NDJSON 加按会话寻址的帧 `{ deviceId, sessionId }`；接 `session/prompt` 与 `session/cancel`。
6. 接设置章节：`settings.section` id `orb-mesh`、`order: 26`；host 加 `orb-mesh.json` 与路由。
7. patch 接线：app-level 加 `orb-mesh`，`preset-computer-use` 里加 `tool-device-agent`，persona 加 `device_agent` 用法段；bundle 三处（exports / assemble / install 测试）。

**手机端（A0/A1）**
1. **先做风险验证**：后台录音是否被 OEM 静音（不通过就先补 FGS `microphone` 类型）。
2. 工具链出包：`build-runtime.sh arm64-v8a` + `build-apk.sh -f arm64`，真机装上。
3. `OrbOverlay`：以 `OverlayBall` 为起点做可拖动球；长按进入录音态（走原生 `WavRecorder`，不走 composer 控制器）；松手发送；上滑取消。
4. `OrbScreenshot`：hide → 120 ms settle → 截图 → restore → 随消息投递，全程不切 App；失败降级只发文字。
5. 面板最小版（**原生**）：最近若干条 + 状态行 + 停止按钮。
