# 悬浮球超级互联 v0 实现方案

> 状态：Draft v0.2（实现方案）
> 日期：2026-11-10
> 范围：三条工作流（服务端 + 电脑插件端 / 手机端悬浮球 / 手机入网）的模块划分、接口约定、验收与排期
> 上游：[14-interconnect-prd.md](14-interconnect-prd.md)（产品需求）、[15-existing-assets.md](15-existing-assets.md)（资产盘点）、[16-v0-plan.md](16-v0-plan.md)（v0 计划）
> 说明：本文是**实现层**文档，把 16 的计划落到仓库、模块、接口和验证步骤；不含排期承诺。文中「已核实」指对照了 `/tmp/ds-harness-remote`（0.6.4）、`/tmp/dshgo`（dsh-Go 1.0.14）和本仓库源码

---

## 0. 结论摘要

- **规模是 3–5 台设备，这改变了连接层**：现有服务端和客户端都是「一个客户端一次连一台 Host」。服务端在客户端发起新连接时会断掉它的全部旧连接，客户端运行时也只保存一个活动 Host。多设备互联必须改服务端的连接规则，并在客户端为每个对端维护一条连接（4.4）。这是 B0/B1 的头号任务。
- **复用 remote 插件时要关掉它自带的模型工具**：插件默认 `remoteTools.enabled: true`（`packages/plugin/src/config.ts:214`），会在应用级给所有 preset 注入 `remote_*` 工具。不关的话，手机悬浮球的精简工具集会被撑大，电脑上也会绕过 `device_agent` 的在线检查。所有节点都配 `remoteTools.enabled: false`，远程终端 `terminal.enabled: false`。
- **服务端不用从零写**：ds-harness-remote 的 `apps/server` 是可自部署的单账号服务（Node/TS、JSON 持久化、Noise E2E、Relay、Docker）。v0 在 fork 上改：配对码注册、多连接、心跳阈值、管理页、设备自改名、管理员撤销、证书固定。
- **配对链路已有一半**：客户端已有 `authorizeHostWithCode` → `POST /api/v1/devices/register-with-code`，开源最小 server 没实现这个端点。配对码不落盘，由插件的控制端点一次性提交；Client 身份再用服务端已有的 `register-owned-role` 注册。
- **会话协议不用新造**：远程通道的白名单已包含 `session/follow`、`session/prompt`、`session/cancel`、`session/page`、`workspace/follow`、`workspaceFiles/*`。
- **审批和提问很可能也不用自建转发**：白名单里有 `$events`、`$events/result`、`userQuestions/answer`，远程连接创建的 peer 带 `interactions: 'answer'`，客户端测试里有经 `$events/result` 回 `allowed-once` 的用例。B0 验证一个远程设备能否收到并应答目标机上的审批。成立就直接用；不成立再退回目标端自建应答器（4.6）。
- **手机悬浮球用精简工具集**：Shell、网页检索与抓取、向用户提问，加上 dsh-Go 的手机操控工具（`mcp__phone__*`），另有派后台、派设备两个调度工具。需要后台干活时交给 dsh-Go 的**标准模式**。dsh-Go 的手机工具是挂在引擎根上的 MCP 服务，所有 preset 自动继承，所以新建精简 preset 时不用单独接（5.2）。
- **手机入网用同一套 Node 插件**：dsh-Go 本机引擎就是 PRoot 里的 Node + DSH，可以直接装 fork 后的 remote 插件和 `@dsh-orb/mesh`，手机因此成为与电脑相同的完整节点。不用 dsh-Go 的 Dart `dsh_remote`，它是单 Host 客户端，也不能当 Host（第 6 节）。
- **手机悬浮窗是原生 Kotlin 视图**：`ui/chat` 的 Flutter 组件不能在浮层里复用，Orb 面板必须原生重做（5.5）。现有「截图并问」会跳 App 且不自动发送，Orb 需要一条新的「发送即截图」回路。互联页在 App 内，可以用 Flutter。
- **版本三端一致**：DSH `0.2.2-rc.1`。ds-harness-remote `0.6.4` 适配这个版本；dsh-Go runtime 默认锁同一版本（`runtime/build-runtime.sh:40`，Node `24.22.1`）。

---

## 1. 已锁定的决策

来自需求对齐与 [16-v0-plan.md](16-v0-plan.md)：

| 编号 | 决策 | 对应 16 | 影响 |
|---|---|---|---|
| D-1 | **公网 IP 直连**，不买域名、不备案；客户端**必须**固定服务器证书指纹 | V0-2、V0-15 | 现有客户端不支持，要新增（3.2-7） |
| D-2 | 服务端**不做账号体系**：管理员口令 + 一次性配对码，管理员手动加设备 | V0-1、V0-3、V0-4 | 新增配对码模型与 `register-with-code` |
| D-3 | **fork ds-harness-remote** 的 server / plugin / client-core；只用 Relay | V0-7 | 保留 Noise、Relay、token 刷新、文件分块 |
| D-4 | **3–5 台设备同时互联**；电脑先验收，手机独立验收后入网 | V0-6 | 多连接是 B1 必做 |
| D-5 | **所有远程会话**都可看、可输入、可停止 | 2.3 | Mesh UI 不区分「任务会话」和「普通会话」 |
| D-6 | 「暂停」= **停止当前这一轮**（`session/cancel`），补一条消息继续 | V0-13 | 不做原地冻结/恢复，不回滚已改文件 |
| D-7 | 审批/提问卡**弹在派发这条任务的设备上**，目标设备本机也能答，先答者生效；其他设备只在树里显示「等待确认」 | 7.1 第 8 条 | 避免 5 台设备同时弹卡 |
| D-8 | DSH 的审批/提问**不自动拒绝**；等待超过 10 分钟，在发起设备和目标设备各提醒一次；用户可随时停止 | V0-14 | 不设自动超时。dsh-Go `SafetyGate` 的手机屏幕确认卡是手机本机的安全机制，沿用它自己的 30 秒超时（超时 = 不执行），不在此列 |
| D-9 | Mesh UI 是**悬浮球侧独立窗口**，不改官方 DSH 左栏 | V0-5 | 复用 helper 的 transcript 渲染 |
| D-10 | **手机悬浮球 Agent 只用精简工具集**；调度工具只交出任务 | V0-10 | 新增 `orb-phone` preset |
| D-11 | **手机后台 Agent 用 dsh-Go 标准模式**（`standard`），不自动放行审批 | V0-11 | 调度工具的目标 preset 可配置 |
| D-12 | 其他设备派到手机的会话，**默认不能调用手机屏幕操作工具** | V0-12 | 手机端互联插件挂工具拦截 |
| D-13 | 派发前检查目标在线；离线直接返回「未派发」，不建会话 | 4.4 | `device_agent` 先查在线 |
| D-14 | 管理员改名不锁定；设备本机仍可再改 | V0-8 | 不做 `nameLockedByAdmin` |
| D-15 | 所有节点关掉 remote 插件自带的 `remote_*` 模型工具与远程终端 | V0-10 | 模型只通过 `device_agent` 跨设备 |

---

## 2. 三条工作流的边界

```
┌──────────────────────── 工作流 A：手机端悬浮球（独立）────────────────────────┐
│  dsh-Go fork → Orb（全局球 + 长按语音 + 发送截图 + 精简工具集 + 手机 CU       │
│  + 原生面板 + 本机标准模式后台）                                              │
│  交付：Android APK，独立验收（A0–A4）                                        │
└──────────────────────────────────────────────────────────────────────────────┘

┌───────────────────── 工作流 B：服务端 + 电脑插件端 ──────────────────────────┐
│  服务端（阿里云 YOUR_SERVER_IP）：管理页 + 配对 + 在线 + 多连接 Relay + E2E      │
│  电脑插件（dsh-orb 新增 mesh 包）：身份 + 多对端连接 + 树 + device_agent       │
│  Mesh UI（helper 新窗口）：设备→工作区→会话树 + 远程会话 + 审批/提问卡         │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── 工作流 C：手机入网（A5）────────────────────────────┐
│  在手机本机引擎里加载 B2 的同一套插件；App 内互联页；悬浮球 device_agent；     │
│  手机作为被调用端（后台任务、文件回传、屏幕操作开关）                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

A 与 B 完全并行。C 依赖 B4（即 16 的 M2，`device_agent` 与文件回传可用）与 A4。里程碑编号对照见第 8 节开头。

**共享约定**（三条线都要遵守，先定下来避免返工）：

1. 一台物理设备 = 一个**节点**（`nodeId`），在服务端对应 Host、Client 两个身份（3.2-2）；树、管理页、改名、撤销都按节点处理。
2. 设备身份私钥只在设备本地（`identity-store.ts`；目录 `~/.dsh/ds-harness-remote/servers/<sha256(origin)[:24]>/<role>/`）。
3. 一切跨设备内容走 E2E；服务端只转发密文。
4. 「会话」是唯一的工作单位，文件是会话的附件。
5. 互联的本机 HTTP 路由由 `packages/mesh` 自己注册（4.8），电脑和手机共用，不放进 `packages/host`（手机上没有 host 包）。
6. 错误必须是可读的具体原因，不允许长时间无响应。

---

## 3. 工作流 B：服务端

### 3.1 现状（fork 基线，已核实）

| 能力 | 文件 | 现状 |
|---|---|---|
| HTTP 路由 | `apps/server/src/server.ts` | `auth/login`、`auth/refresh`、`devices/register`、`devices/register-owned-role`、`devices`、`devices/:id`、`devices/:id/presence`、`devices/:id/name`、`devices/self`（DELETE）、`account/devices`、`turn/credentials`、`health`、静态页 |
| WS 中继 | `apps/server/src/gateway.ts` | Hello → 认证 → 建 Link → 转发密文帧；心跳、速率限制 |
| 持久化 | `apps/server/src/store.ts` | 单 JSON 文件，设备描述 + token 摘要 |
| 鉴权 | `server.ts` | 环境变量单账号 + 密码；Web 用 HttpOnly Cookie，设备用 access/refresh token |
| 来源校验 | `server.ts:229`、`gateway.ts:142` | 带 `Origin` 的请求必须等于 `DSH_SERVER_PUBLIC_URL`；设备客户端不带 `Origin`，不受影响 |
| 心跳 | `apps/server/src/config.ts:22-29`、`gateway.ts:161-182` | 默认 25 秒一次；判离线 = `max(75_000, 间隔 × 3)`，下限写死 75 秒；超时检查放在心跳定时器里，每个间隔才扫一次，实际判离线最多再晚一个间隔 |
| 在线/上次在线 | `server.ts:223`、`store.ts:125` | `online` 取网关实时连接；`lastSeenAt` 只在握手时写，断开不写 |
| 设备列表 | `server.ts:287` | `GET /api/v1/devices` 只允许 Client 身份调用，只列 Host，带 `online`、`lastSeenAt` |
| 改名 | `server.ts:296` | `accountAuth`，设备 token 不能改 |
| 撤销 | `server.ts:276`、`store.ts:115`、`gateway.ts:136` | 只有设备自撤销 `DELETE /devices/self`；撤销后网关立即断开连接 |
| 多连接 | `gateway.ts:426`、`gateway.ts:525` | 同一身份新控制连接会替换旧的；**客户端发起 `connect.request` 时会断掉它的全部旧 Link** |
| Web 页 | `web/src/*.tsx` | Landing / 登录 / 设备状态页（`DevicesPage.tsx` 带改名按钮，无撤销） |
| 部署 | `Dockerfile`、`compose.yaml` | Node 22 slim，`server-data` 卷 |

### 3.2 要改的地方

**（1）鉴权：账号密码 → 管理员口令 + 配对码**

客户端已有的链路（已核实）：

- `packages/plugin/src/server-api.ts:305` 的 `authorizeHostWithCode(identity, code)` 调 `POST /api/v1/devices/register-with-code`，body 是 `{ v: 1, code, device: descriptor }`，成功返回 `TokenPair`。码会被 `trim().toUpperCase()`。只有 Host 身份能调。
- 配对码**不落盘**：由控制端点 `host.registration-code.submit`（`{ code }`）或 configure 负载里的 `registrationCode` 一次性提交（`control-runtime.ts:209-215`、`:256`）。
- Client 身份随后用已有的 `POST /api/v1/devices/register-owned-role` 注册：用 Host 身份的设备 token 鉴权，要求两个身份角色不同（`server.ts:265-270`）。

所以服务端补 `register-with-code`，客户端的注册流程基本不用改；互联设置页只需把配对码交给上面的控制端点（4.8）。

配对码模型（写入 `store.ts` 的 state，版本升到 `version: 2`）：

```
PairingCode {
  id: string
  codeHash: string      // sha256(code)
  label: string         // 管理员备注，如 "书房 Mac"
  platform?: string     // 预填，可被设备上报覆盖
  createdAt: number
  expiresAt: number     // 默认 30 分钟
  usedAt?: number       // 一次性
  nodeId?: string       // 兑换后绑定
}
```

新路由：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/admin/login` | 口令 | 返回管理员会话 Cookie（只在管理监听上，见 3.2-6） |
| GET | `/api/v1/admin/nodes` | 管理员 | 节点列表（名称、平台、版本、在线、上次在线） |
| POST | `/api/v1/admin/pairing-codes` | 管理员 | 生成配对码（明文只返回一次）；同时返回服务器证书指纹 |
| GET | `/api/v1/admin/pairing-codes` | 管理员 | 列出未使用/已使用的码（只显示前缀） |
| DELETE | `/api/v1/admin/pairing-codes/:id` | 管理员 | 作废 |
| POST | `/api/v1/admin/nodes/:id/revoke` | 管理员 | 撤销节点的 Host、Client 两个身份 |
| POST | `/api/v1/admin/nodes/:id/rename` | 管理员 | 管理员改名（特权，不锁定） |
| POST | **`/api/v1/devices/register-with-code`** | 凭码 | 校验码 → 建节点、绑定 Host 身份 → 返回 token |

- 兑换成功立即写 `usedAt`、绑定 `nodeId`；同一码二次使用返回 409。
- 失败限流按 IP + 码前缀；码只存哈希。
- 码格式 8 位大写字母数字，排除 `0/O`、`1/I`。
- `devices/register`（账号鉴权）不再对外使用。

**（2）节点：一台设备两个身份**

`role: 'both'` 的插件在服务端有 Host、Client 两个身份，各自一套 token。v0 加一层节点：

- `register-with-code` 创建节点并绑定 Host 身份；`register-owned-role` 注册 Client 身份时，按来源 Host 身份把它挂到同一节点。
- 管理页、改名、撤销、默认名都按节点；`GET /api/v1/devices`（Client 调，列 Host）返回的每项带 `nodeId`、节点名，树里以此去掉本机。
- 默认名按平台计数：`Mac1` / `Windows1` / `Phone1`，域内唯一。

**（3）多连接（3–5 台的前提）**

- `gateway.ts:426`：同一身份只保留一条控制连接，这条不改。一个节点的 Host 身份和 Client 身份各一条控制连接。
- `gateway.ts:525`：客户端发 `connect.request` 时会断掉它的全部旧 Link。改为**只替换同一对（Client, Host）之间的旧 Link**，不同 Host 的 Link 并存。
- Host 侧已经支持多客户端：`connection-controller.ts` 用 `Map<connectionId, ActiveConnection>`，同一 `peerDeviceId` 的新连接只替换自己（第 78–89 行）。
- 规模：5 个节点时每个 Client 最多 4 条 Link，全网最多 20 条，Relay 只转发密文，2C2G 够用；要监控带宽。
- B0 验证：一条客户端控制连接能否承载多条 Link（帧里是否按 Link 寻址）。不能的话，再评估每个对端一条控制连接，代价是服务端放宽 `gateway.ts:426`。

**（4）心跳与在线（目标：各端 ≤ 30 秒看到离线）**

- 心跳间隔 10 秒；判离线阈值 20 秒（`间隔 × 2`，代码允许的最小倍数 `HEARTBEAT_DISCONNECT_MS_MIN_FACTOR = 2`）。`HEARTBEAT_DISCONNECT_MS_FLOOR` 由 75 秒改为 20 秒（`config.ts:28`），协议常量（`packages/protocol/src/index.ts:68-71`）同步改。
- 超时检查从心跳定时器里拆出来，每 2 秒扫一次。这样服务端最迟约 22 秒判离线；只放宽阈值、仍按心跳间隔扫的话，最坏要 30 秒以上。
- 判离线后服务端立即断开该设备，并通知与它有 Link 的对端；各端 `packages/mesh` 再每 5 秒查一次 `GET /api/v1/devices` 兜底。合计各端最迟约 27 秒看到离线。
- 客户端：Host 控制连接超时是 `max(15_000, 间隔 × 3)`，10 秒间隔下 30 秒，只影响自身重连；`adaptive-transport.ts:554` 写死的 75 秒改成跟随服务端下发的间隔。
- `lastSeenAt` 在断开时也落盘（现在只在握手时写）。
- 树与管理页用同一个在线来源：网关实时连接 + `lastSeenAt`。
- 手机上 10 秒心跳的耗电与流量在 6.5 实测。

**（5）改名与撤销**

- 设备自改名：`POST /api/v1/devices/:id/name` 由 `accountAuth` 改为设备 token 鉴权，只允许改**同一节点**；同时更新节点下两个身份。
- 管理员改名：`/admin/nodes/:id/rename`，不锁定；之后设备本机仍可改。
- 管理员撤销：新增，撤销节点下两个身份；沿用 `store.revoke` → `onInvalidate` → 网关立即断开（`gateway.ts:136`）。各端树在下一次列表/在线变化时移除该节点。

**（6）管理页与 Origin**

- 公网监听（443 → 容器）只提供设备 API、WS 和 `/health`。不提供 Web 页面、管理路由，也**关掉账号相关接口**：`auth/login`、`auth/me`、`auth/logout`、`account/devices`、账号鉴权的 `devices/register`。
- 管理页单独监听：容器内绑 `0.0.0.0:8081`，`compose.yaml` 只发布到宿主机回环 `127.0.0.1:8081:8081`。管理员用 `ssh -L 8081:127.0.0.1:8081 <服务器>` 打开 `http://127.0.0.1:8081`（容器内若只绑 127.0.0.1，宿主机经端口映射访问不到）。
- 这个监听的期望 Origin 是 `http://127.0.0.1:8081` 与 `http://localhost:8081`，与公网监听的 `DSH_SERVER_PUBLIC_URL` 分开校验。否则浏览器带的 `Origin` 会被 `server.ts:229` 拒成 403。本地隧道端口必须用 8081。
- 管理页复用 `web/src/DevicesPage.tsx` 的表格与 `api.ts`：
  - 节点表：名称（可改）、平台、版本、在线、上次在线、操作（撤销）；
  - 配对码区：生成（备注 + 平台）、列表、作废；生成时显示服务器证书指纹；
  - 连接记录：最近 N 条「哪个节点什么时候连了哪个节点」（仅连接层元数据）。
- 页面文案写明：**管理页看不到会话内容**。

**（7）TLS 与证书固定**

- 已核实：客户端**不支持**固定证书或自定义 CA，走平台默认 TLS（`server-api.ts`、`server-connection.ts`、`adaptive-transport.ts` 都没有相关配置）。自签证书下现有客户端连不上。
- fork 的客户端新增配置 `serverCertSha256`：HTTP 请求与 WS 连接都按指纹校验服务器证书，不匹配就拒绝。电脑和手机用的是同一套 Node 代码，改一处即可。这项属于 B1：没有它，自签证书下设备连不上服务器。
- 指纹在管理页生成配对码时显示；设备在互联设置里与配对码一起填写，或填合并后的配对串 `CODE#指纹`。
- **固定指纹是必须的**（16 V0-15）。B0 顺带查能否为公网 IP 签发公开证书并自动续期；能签就用公开证书，但客户端照样固定指纹，换证书时随配对串下发新指纹。
- 反向代理用 Caddy，SAN 填 IP。

**（8）部署清单（阿里云）**

```
安全组：只开 443（TCP），SSH 限来源 IP、只用密钥
容器：server（Node 22）+ caddy（TLS 终止）
管理监听：容器内 0.0.0.0:8081，compose 只发布 127.0.0.1:8081，经 SSH 隧道
卷：server-data（JSON + token 摘要 + 配对码哈希）
监控：容器健康检查 + 磁盘/内存/带宽告警
备份：每日拷贝 server-data 到 OSS 或另一台机器
```

> 这台机器是 2C2G、200 Mbps 峰值、12 月 10 日到期，要现在续费。

### 3.3 退出标准

1. 管理页能生成配对码；设备用码接入；重复/过期码被拒。
2. 管理页看到 3 个节点的名称/平台/在线/上次在线（每个节点只显示一行；5 个节点在 M4 回归）。
3. 用 B0 第 7 步的多连接脚本，一个 Client 同时与 3 个 Host 保持 Link，互不替换。
4. 拔网线后 25 秒内管理页显示离线。
5. 撤销节点后，两个身份的 token 立即失效、连接断开。
6. `tcpdump` 抓到的中继流量无法解出会话内容；证书指纹不对时客户端拒绝连接。
7. 公网 443 上请求 `auth/login`、`account/devices` 返回 404。

---

## 4. 工作流 B：电脑插件端

### 4.1 现状（fork 基线，已核实）

| 能力 | 文件 | 现状 |
|---|---|---|
| Host 角色 | `packages/plugin/src/service.ts`（`HostPluginRuntime`） | 本机 Harness 注册为 Host，按连接创建 bridge（`service.ts:100`），`context.peerDeviceId` 即调用方 |
| Client 角色 | `packages/plugin/src/client-runtime.ts` | **单活动 Host**：`private connected?: ConnectedRemote`、单个 `TypertGatewaySwitch`（第 88–96 行） |
| 双角色 | `packages/plugin/src/index.ts`、`config.ts` | `role: 'host' \| 'client' \| 'both'` |
| 远程调用白名单 | `harness-remote-bridge.ts:112-213` | 含 `$events`、`$events/result`、`session/{follow,prompt,cancel,page,list,create,…}`、`workspace/{follow,…}`、`workspaceFiles/{list,stat,read,readBytes,…}`、`userQuestions/{answer,attachWait}`；不含文件写入/删除 |
| 远程 peer 权限 | `owner-peer.ts:60` | 以 `interactions: 'answer'` 创建，可应答交互；不能代答别的客户端的事件（`gateway/interactions-forbidden`） |
| 高层工具 | `remote-tools.ts`、`remote-session-tools.ts` | `remote_list_hosts`、`remote_read_session`、`remote_send_message`、`remote_wait_sessions`、`remote_upload_file`、`remote_download_file`、`remote_interrupt_session` 等 |
| 文件传输 | `remote-file-upload.ts`、`remote-file-download.ts`、`workspace-transfer-limits.ts` | 上传 64 KiB 分块，经中继上限 20 MiB；下载 256 KiB 分块，上限 50 MiB，落在 `~/Downloads/dsh-remote-*`；**没有进度事件，失败不续传** |
| 插件路由隧道 | `plugin-route-bridge.ts:8` | 白名单只有 `api/bot` |
| 默认配置 | `config.ts:208-214` | `remoteTools.enabled` 默认 true（应用级注入 `remote_*` 工具，所有 preset 可见，`index.ts:466`、`remote-tools.ts:154`）；`terminal.enabled` 默认 true |

### 4.2 目标结构

在 dsh-orb 仓库新增 `packages/mesh`（`@dsh-orb/mesh`），作为 DSH 插件：

```
packages/mesh/
  package.json          # name @dsh-orb/mesh, main lib/index.js, exports ./device-agent
  tsconfig.json         # extends ../../tsconfig.base.json
  tsdown.config.ts      # entry: index + device-agent；deps.neverBundle 全部 @deepseek-ai/*
  src/
    index.ts            # 应用级插件：节点身份、连 relay、provide('meshRegistry')、注册 /.dsh-orb/mesh/* 路由
    peers.ts            # 多对端连接：Map<nodeId, RemoteHandle>（见 4.4）
    tree.ts             # 设备→工作区→会话 的镜像与合并
    interactions.ts     # 审批/提问：每个对端的 $events 流 + 应答（见 4.6）
    device-agent.ts     # preset 内工具：device_agent / _status / _stop
    device-agent-completion.ts  # 完成通知 + 结果文件回传
    files.ts            # 上传/下载封装：进度、整份重试、落点
    guard.ts            # 手机端：远程会话的手机屏幕工具拦截（见 6.4）
    routes.ts           # /.dsh-orb/mesh/* 本机路由（电脑 Mesh 窗口与手机 App 共用）
    relay-client.ts     # 到 fork 后 server 的连接与证书固定
  tests/
    device-agent.spec.ts
    peers.spec.ts
    interactions.spec.ts
```

**两个插件要分开注册**：

- `packages/mesh/index.ts` 是**应用级**插件，和 `orb-host`、`orb-code-agent-registry` 同级，在 `cordis.patch.yml` 的 app-level 行里注册。
- `packages/mesh/device-agent.ts` 是**preset 内**插件，插在 `preset-computer-use` 的 `plugins:` 列表里，紧挨 `tool-code-agent`。工具只能这样进模型视野。
- **不要在 preset 里 `provide`**：应用级服务只能从顶层行提供。

**bundle 侧改三处**：`packages/bundle/package.json` 加依赖与 `./mesh`、`./mesh/device-agent` 导出；`scripts/assemble.mjs` 加拷贝；`tests/install.test.mjs` 的 `ownNames()` 断言列表加新 specifier。

**与 ds-harness-remote 的关系**：`packages/mesh` 依赖 fork 后的 `@dsh-remote/plugin` 暴露的 `HostPluginRuntime` 与连接原语（`ClientConnection`、`RemoteTypertGateway`），不复制实现，方便合并上游修复。

### 4.3 双角色与对等节点

每台设备都是 `role: 'both'`：

- Host 半边：把本机的 `session/*`、`workspace/*`、`workspaceFiles/*`、`$events` 暴露给所有对端（已支持多客户端）。
- Client 半边：同时连接所有其他节点的 Host（4.4）。

remote 插件在所有节点上的固定配置：

```yaml
role: both
remoteTools: { enabled: false }   # 不给模型注入 remote_*；跨设备只走 device_agent
terminal: { enabled: false }      # v0 不开放远程终端
forceRelay: true                  # v0 只用 Relay
```

remote 插件自带的侧栏入口会出现在官方 DSH 侧栏里，B0 确认能否隐藏；不能隐藏就保留，不影响「DSH 左栏工作区不改」。

### 4.4 多对端连接（B0/B1 的头号任务）

**已核实的约束：**

| 位置 | 约束 |
|---|---|
| 服务端 `gateway.ts:525` | 客户端 `connect.request` 会断掉它的全部旧 Link（3.2-3 改） |
| `client-runtime.ts:88-96` | 单一 `connected` 与单一 `TypertGatewaySwitch` |
| `typert-gateway-switch.ts:46` | 只给官方网关打一个补丁，用于把官方 UI 指向一台远程 Host |
| `client.ts:347` | UI 单例 `window.__DS_HARNESS_REMOTE_CLIENT_ACTIVE__` |
| `ClientConnection` / `AdaptiveTransport` | 不是模块单例，可在同一进程里创建多个 |

**做法**：

- `packages/mesh/peers.ts` 自己持有 `Map<nodeId, RemoteHandle>`。每个 `RemoteHandle` = 一条 Link + 一个 `RemoteTypertGateway`，带独立的重连与退避。
- 不碰 `TypertGatewaySwitch` 与官方 UI 单例。它们服务「官方 UI 切到一台远程 Host」的场景，原样保留。
- 对端列表来自 `GET /api/v1/devices`（Client 身份调用），按 `nodeId` 去掉本机。
- 树订阅：每个对端一条 `workspace/follow` + `session/list`；打开的会话才开 `session/follow`。5 台时常驻流约 4 × 2 条。

**B0 实验**：一个进程里对本地 server 并发建 3 个 `RemoteHandle`，先用原版 server（预期在 `connect.request` 处互相断开），再用改过的 server，验证：

1. 三条 Link 同时在线，互不替换；
2. 各自的 `session/follow` 流独立；
3. 一个对端断线重连不影响其他两个；
4. 内存/句柄占用。

### 4.5 `device_agent`：跨设备派任务

模板是现有的 `code_agent`（`packages/computer-use/src/code-agent.ts`）：

| `code_agent` | `device_agent` |
|---|---|
| `sessionController.create({ agentPreset: 'desktop' })` | 目标节点上远程 `session/create`（`standard` preset） |
| `sessionController.prompt({ mode: 'queue' })` | 远程 `session/prompt` |
| `watchCodeAgentCompletion`（本机 `whenIdle()`） | 订阅目标会话的 `session/follow`，盯 `turn/start` → `turn/end` |
| `followup(createUserMessage(...))` | 同样的 followup，正文标明来源设备与回传文件的本机路径 |
| `code_agent_status` / `_stop` | 本机任务表 + 远程 `session/cancel` |

**工具签名（草案）**：

```
device_agent({
  device: string,          // 设备名或 nodeId；必填
  task: string,            // 任务描述；必填
  workspace?: string,      // 目标工作区名或 id；'new' 表示新建任务目录
  session_id?: string,     // 继续已有远程会话（重试也走这里）
  attachments?: string[],  // 本机绝对路径，先上传再 prompt
})
→ { accepted: true, created, device, session_id, task_id }
→ { accepted: false, reason: 'offline', device, last_seen_at }      // 不建会话
→ { accepted: false, reason: 'needs_workspace', workspaces: [...] } // 模型应询问用户

device_agent_status({ device?: string })
→ { count, tasks: [{ device, session_id, task_id, task, status, files }] }

device_agent_stop({ device: string, session_id: string })
→ { accepted }
```

**派发规则**：

- **先查在线**：目标的 `RemoteHandle` 未连接，或服务端 presence 为离线，就返回 `offline`，不建会话。
- **工作区**：没给 `workspace` 时返回目标的工作区列表，由模型调 `ask_user` 让用户选；用户说「新建」才用 `'new'`（落在目标 `~/.dsh/mesh-tasks/<taskId>/`）。
- **去重**：`task_id` 由发起端生成，写进远程会话标题与首条消息。断线重连后先在目标 `session/list` 里按 `task_id` 查，查到就接着跟，不重复创建。
- **派发后断线**：任务显示「状态未知」，重连后对账；不假装完成。
- **重试**：失败后用同一个 `session_id` 再发一条消息。

**结果文件回传**（16 7.1 第 9 条）：

1. 派发时在任务正文里约定：交付文件放到工作区下的 `.mesh-out/<taskId>/`。
2. 目标这一轮结束后，发起端用 `workspaceFiles/list` 列这个目录（白名单内）。
3. 逐个用下载原语取回，落到 `~/Downloads/dsh-mesh/<设备名>/<taskId>/`（fork 时把落点改成参数）。
4. 记入 mesh 任务表的 `files`（名称、大小、来源设备、本机路径、状态）。这些是**任务附件**，不是 DSH 原生会话附件：在 Mesh UI 的任务卡与附件区显示，悬浮球的完成通知里写本机路径。

**文件传输要补的**：

- 进度：fork 的分块循环加进度回调，上抛到 Mesh UI。
- 失败：整份重试（现有实现失败即清理临时文件，不支持续传）。
- 上限：现有上传经中继 20 MiB、下载 50 MiB。v0 对用户统一按 20 MB 提示，并做成可配置。

**`code_agent` 里有一半的 API 在远程场景不存在**：

| `code_agent` 用的 | 远程替代 |
|---|---|
| `ctx.get('agents').get(id)` / `agent.whenIdle()` | 订阅远程 `session/follow` |
| `agent.followup(...)` | 只能 followup **本机**的调用方（派发它的那颗球） |
| `code.ctx.on('approval/request')` | 走远程交互通道（4.6） |
| `agent.session.deriveMessages()` | 远程 `session/page` 或 `follow` 的记录 |
| `attachUnattendedCodeAgent(code)` | **绝对不能对远程用**，会把用户该批的审批全部放行 |

**completion 的处理**：

- 不能只看 `running === false`：排队期间可能还是 false。要盯住 `turn/start` → `turn/end`（参考 `code-agent-completion.ts` 的 `waitUntilIntervalStarts`）。
- 断线重连后重新订阅，用 `sessionId + turnId` 去重，不重复发完成通知。
- 用户手动停止与自然结束要区分，通知文案不同（参考本地版 `lastTurnEndedUserAborted`）。

### 4.6 审批与提问

**首选：走 DSH 自带的远程交互通道（B0 验证）**

已核实的事实：

- 白名单含 `$events`（交互事件流）、`$events/result`（应答）、`userQuestions/answer`、`userQuestions/attachWait`。
- 远程 peer 以 `interactions: 'answer'` 创建（`owner-peer.ts:60`），可以应答。
- 应答必须来自收到该事件的同一个客户端，代答别的客户端的事件会被拒成 `gateway/interactions-forbidden`（`tests/harness-rc1.test.ts:37`）。
- 应答格式见 `tests/client-reconnect.test.ts:106`：`$events/result { clientId, eventId, outcome: { kind: 'result', value: 'allowed-once' } }`。传输中断时在途的应答返回 `TRANSPORT_CLOSED`，不会重放。

**设计**：

- 每个 `RemoteHandle` 打开一条 `$events` 流，收目标节点上的审批与提问。
- 按 D-7 路由：派发这条任务的设备弹卡；其他设备只在树里显示「等待确认」，打开该会话时才显示卡片。
- 应答通过同一个 `RemoteHandle` 发 `$events/result`（审批：`allowed-once` / `rejected`）或 `userQuestions/answer`（提问）。
- 重连后重新拉取未决交互，在途应答失败就提示用户再点一次。
- 目标设备本机原生 UI 仍可答，先答者生效；另一侧的卡片撤下并显示「已在 <设备名> 处理」。
- 敏感操作的额外确认仍由目标设备决定。手机上的 `SafetyGate` 确认只在手机上出现，不转发。
- D-8：不自动拒绝；等待超过 10 分钟，在发起设备与目标设备各提醒一次。

**B0 要回答的四个问题**：

1. 远程客户端的 `$events` 流能否收到**由它发起**的会话的审批？能否收到别的会话的审批？
2. 多个客户端同时连着时，是否每个都收到？
3. 一方应答后，另一方与目标本机的卡片是否撤下？
4. 断线重连后，未决交互能否重新拿到？

**后备（只在 B0 证伪时启用）**：在目标端插件按连接作用域挂 `approval/request` 与 `user-questions/request` 应答器（`code-agent-unattended.ts` 用的是同一挂点），把请求经 `plugin-route-bridge` 的新路由 `api/mesh` 转给发起端，发起端答完再回传；本地先答则用 `AbortController` 撤回转发。`ApprovalOutcome` 取值是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，v0 只回前两个。

### 4.7 Mesh UI

**位置**：`packages/helper` 新增 `mesh.html` + `mesh.js`，与 `floating.html` / `shell.js` 同级。普通 `BrowserWindow`（有边框、可调大小、进任务栏，约 960×640），由 host 通过 IPC 打开。

```
┌──────────────────────────────────────────────────────────────┐
│ 本机：书房 Mac   服务：YOUR_SERVER_IP  ● 已连接 4/4    ⟳ 重连  │
├───────────────────────┬──────────────────────────────────────┤
│ ▾ 本机（书房 Mac）     │  公司 Windows · Q4 报价 · 改报价单     │
│   ▾ 品牌改版           │  ─────────────────────────────────── │
│     · 设计说明 v3      │  [user] 把标题改成蓝色                │
│ ▸ 公司 Windows ●在线   │  [tool] read_file  报价单.md          │
│   ▾ Q4 报价            │  [tool] edit_file  （等待审批…）      │
│     · 改报价单 等待确认 │  ┌────────────────────────────────┐  │
│     · 客户资料 完成    │  │ 允许修改《报价单.md》吗？        │  │
│ ▸ 家里 Mac ●在线       │  │   [允许本次]  [拒绝]            │  │
│ ▸ 随身手机 ●在线       │  └────────────────────────────────┘  │
│ ▸ 测试机 ○离线 2 分钟前 │  附件：报价单.md ← 公司 Windows       │
│                       │  [ 输入指令…              ] [ 停止 ] │
└───────────────────────┴──────────────────────────────────────┘
```

**实现要点**：

- 菜单入口：`packages/helper/src/menu.ts` 加「打开互联」。
- 左侧树数据来自 `/.dsh-orb/mesh/*` 路由（`packages/mesh/routes.ts`）：本机走 `session/list` + `workspace/follow`；对端走各 `RemoteHandle`。离线设备保留最后一次快照并标灰，显示上次在线。
- 右侧 transcript 复用 `shell.js` 的 `transcript-model.js` 与 `chat.css`。
- **流按会话寻址**：消息帧带 `{ nodeId, sessionId }`，不能复用现在的单会话广播。
- **审批/提问卡是新组件**：helper 现在只有 ask-user 问答卡，没有权限审批卡。
- 「停止」按钮调远程 `session/cancel`，文案是「停止这一轮」。
- 附件区显示任务的结果文件、来源与本机路径，点击在文件管理器中显示。
- 刷新用「流 + 快照」两级，不轮询。
- 中文/英文文案表；跟随系统深浅色；树与输入框可键盘操作（上下选择、回车打开、Esc 回到树）。
- 完成提示沿用现有两样：模型态 followup、书签条芯片。仓库里没有现成的 Electron `Notification` 封装。

### 4.8 设置页「互联」板块

新开一个 `settings.section`，不塞进现有悬浮球页：

```javascript
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'orb-mesh',
  order: 26,
  label: () => copy().nav,   // '互联' / 'Interconnect'
  inject: () => ({}),
}, OrbMeshSection))
```

板块内容：

- 服务地址（默认 `https://YOUR_SERVER_IP`）、证书指纹、配对码（或配对串）、连接测试；
- 本机名称（可改）；
- 设备列表（只读，显示在线/上次在线）；
- 安全：允许被调用开关（默认开）、允许的调用方设备、文件接收目录。

**数据走向**：

- 配对码不落盘，直接交给 remote 插件的控制端点 `host.registration-code.submit`。
- 服务地址、证书指纹写进 remote 插件的配置，是唯一来源；mesh 自己的偏好文件只存权限与接收目录。不要在两处各存一份服务地址。
- 路由由 `packages/mesh/routes.ts` 注册在 `/.dsh-orb/mesh/*`，设置页与 Mesh 窗口都用它。`packages/host` 只负责打开窗口与深链（复用 `/.dsh-orb/settings-open` 机制加 `openSection('orb-mesh')`）。

### 4.9 别漏掉 persona

`preset-computer-use` 的 persona 现在有一整段讲 `code_agent`（`cordis.patch.yml` 第 27–34 行）。`device_agent` 要对应一段：

- 什么时候派到别的设备，什么时候留在本机；
- 设备或工作区不确定时先问；
- 返回 `offline` 时直接告诉用户未派发，不要重试；
- 派完告诉用户在哪台设备跑；
- 完成通知到了，用回传文件的本机路径收尾。

不加这段，工具注册了模型也不会用，或者乱用。

### 4.10 要模仿的测试

| 现有测试 | mesh 对应 |
|---|---|
| `computer-use/tests/code-agent.spec.ts` | `mesh/tests/device-agent.spec.ts`（vitest + 假远程网关）：离线不派发、needs_workspace、task_id 去重、完成 followup、停止与自然结束区分 |
| `computer-use/tests/code-agent-registry.spec.ts` | mesh 任务表 |
| `computer-use/tests/code-agent-registry-mount.spec.ts` | mesh 应用级挂载 + 手机工具拦截 |
| `computer-use/tests/loader-composition.spec.ts` | mesh preset 行 |
| `host/tests/routes.test.ts` | `/.dsh-orb/mesh/*` |
| `client-settings/tests/section.test.mjs` | 新 section |
| `bundle/tests/install.test.mjs` | 新 specifier |
| `helper/tests/shell-render.test.ts` | Mesh 窗口 |

新增：`peers.spec.ts`（3 个假对端并发、单个重连不影响其他）、`interactions.spec.ts`（审批路由、先答者生效、重连后重新拉取）。

### 4.11 退出标准

对应 [16-v0-plan.md](16-v0-plan.md) 7.1 的 12 条，逐条可验；额外加：

- 3 台电脑两两同时在线，任意一台断线 30 秒内其余两台显示离线，恢复后自动重连、树恢复、未丢消息。
- 发起设备离线时，目标设备仍能独立完成或审批。
- 模型在悬浮球里能正确选择 `device_agent` 或 `code_agent`（persona 生效）。

---

## 5. 工作流 A：手机端悬浮球

### 5.1 现状（fork 基线，已核实）

`/tmp/dshgo`（dsh-Go `1.0.14`）：

| 能力 | 文件 | 现状 |
|---|---|---|
| 手机操控工具 | `phone/PhoneGuest.kt:7-71`、`PhoneToolCatalog.kt`、`McpServer.kt` | 引擎启动时写入 `/opt/dsh-app/phone/phone.patch.yml`，以 `--patch` 在**根上**插入 MCP 服务 `phone`；**所有 preset 自动继承**，模型看到 `mcp__phone__{apps,open,intent,notify,clipboard,screen,collect,tap,type,scroll,key,tap_xy,handoff}`。前提：「手机操控」开关打开且不在安全模式 |
| 屏幕串行 | `phone/PhoneTaskSessions.kt:245-491`、`SerialWorker.kt`、`McpServer.kt:131` | 主屏独占；另一个会话要用屏幕时最多等 30 秒，然后返回「屏幕或应用资源正被另一个对话使用…」；后台槽默认 1、最多 3 |
| 内置 preset | `@deepseek-ai/dsh-web-app`；`runtime/bridge/dsh-go-bridge/cordis.patch.yml` | `standard`（标准模式）、`ptc`、`minimal`、`cordis`；dsh-Go 自加 `dsh-go-companion`、`dsh-go-companion-full`。可用 overlay 插入新 preset |
| 工具包 | `runtime/locks/dsh-0.2.2-rc.1/package-lock.json` | `@deepseek-ai/dsh-tool-bash`、`dsh-tool-web`、`dsh-tool-ask-user` 都随 DSH 打包 |
| 悬浮窗 | `pet/PetOverlay.kt`、`OverlayWindowOwner.kt`、`EdgeSnap.kt` | **原生 Kotlin View**；`TYPE_ACCESSIBILITY_OVERLAY` 或 `TYPE_APPLICATION_OVERLAY`；拖拽、吸边、长按菜单、气泡 |
| 悬浮球骨架 | `phone/a11y/OverlayBall.kt`、`ControlOverlay.kt`、`OverlayCapsule.kt` | 48 dp 球 + 停靠 + 按住停止 |
| 问一句输入条 | `pet/AskBar.kt` | 按住说话已实现（滑出取消、最少 0.3 秒、静音阈值 400 ms）；原生 `EditText`，IME 已特殊处理 |
| 截图 | `pet/PetScreenshot.kt`、`phone/a11y/ScreenShooter.kt` | 全走无障碍；API 34+ `takeScreenshotOfWindow`；API 30–33 hide-for-capture + `takeScreenshot`；`hideForCaptureWithReceipt` 有引用计数 |
| 安全确认 | `phone/SafetyGate.kt`、`PhonePrompts.kt`、`ControlOverlay.kt` | 银行/支付拒绝表、微信逐次确认、`ask`/`task`/`always` 三档、`handoff`、确认卡 30 秒超时 |
| 语音 | `voice/WavRecorder.kt`、`VoicePlugin.kt`、`MicArbiter` | 16 kHz 单声道 PCM16；SenseVoice 优先，回退系统 ASR；录音只在原生侧 |
| 本机引擎 | `runtime/`、`runtime/build-runtime.sh:40-41` | PRoot + DSH `0.2.2-rc.1` + Node `24.22.1`；`dsh web` 在 `127.0.0.1:3080`；ABI 只有 arm64-v8a / x86_64 |
| 通知 | `notify/ChatNotifier.kt`、`state/notify_state.dart`、`runtime/DshService.kt` | 一轮结束、等审批、等回答都能发系统通知；App 不在前台时也能发（进程存活即可）；`DshService` 前台服务保活引擎 |
| 手机文件 | 设置「访问手机文件」 | 授权后内部存储挂到引擎的 `/sdcard`；默认关，切换会重启引擎 |
| 聊天 UI | `app/lib/ui/chat/*` | 在 Flutter Activity 里，不在悬浮窗里 |

**两个硬约束**：

1. **悬浮窗是原生 Kotlin 视图，不是 Flutter。** 没有任何浮层能跑 Flutter 组件，`ui/chat` 的 transcript / 工具卡 / 审批卡都依赖 Activity。
2. **`PetScreenshot` 现在的用法不是「发送时截图」。** 菜单「截图并问」会隐藏浮层、截图、**打开 App**、填进输入框，**不自动发送**。Orb 需要「松手即截图并随消息发出，全程不切 App」的新回路。

### 5.2 Orb preset：精简工具集

在 dsh-Go fork 的 `runtime/bridge/dsh-go-bridge/cordis.patch.yml` 里新增一个 preset，照桌面 `preset-computer-use` 的写法：

```yaml
- insert:
    - id: preset-orb-phone
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: orb-phone
        name: 悬浮球
        description: 精简工具集：Shell、网页检索与抓取、向用户提问、手机操控。
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                （手机悬浮球人设：先看用户说话时的截图；屏幕操作在这里做；
                要读写文件、跑命令、长任务时交给后台；什么时候派到别的设备……）
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: compaction             # 与桌面相同的压缩组，不是工具
            name: cordis:group
            ...
          - id: tool-background-agent  # A4 加入：派本机标准模式后台（5.3）
            name: '@dsh-orb/phone-background-agent'
          - id: tool-device-agent      # A5 加入：派其他设备（6.3）
            name: '@dsh-orb/mesh/device-agent'
```

- **手机操控工具不写在列表里**：`mcp__phone__*` 由根上的 MCP 服务提供，所有 preset 自动继承。Orb 首次引导必须打开无障碍与「手机操控」开关；没打开时 Orb 只能做文字问答，要明确提示。
- 两个调度工具只负责把活交出去，不直接读写文件或操作屏幕。
- **各阶段模型应看到的工具**（每个里程碑导出一次核对；不应出现文件读写、todo、子代理、`remote_*` 等）：

| 阶段 | 模型可见工具 |
|---|---|
| A0–A3 | `bash`、网页检索与抓取、`ask_user_question`、`mcp__phone__*` |
| A4 | 上面 + `background_agent` / `background_agent_status` / `background_agent_stop` |
| A5 | 上面 + `device_agent` / `device_agent_status` / `device_agent_stop` |

### 5.3 后台：dsh-Go 标准模式

- 工具名 `background_agent`（另有 `_status`、`_stop`），由小包 `@dsh-orb/phone-background-agent` 提供。它复用 `code_agent` 的派发与完成通知逻辑（`packages/computer-use/src/code-agent.ts`、`code-agent-completion.ts`），把这部分逻辑抽成可配置的共享模块：目标 preset = `standard`，**不挂 `attachUnattendedCodeAgent`**（`code_agent` 现在写死目标 `desktop` 并自动放行，见 `code-agent.ts:353`）。桌面的 `code_agent` 行为不变。
- 后台会话的审批与提问不自动处理：dsh-Go 已有「等审批/等回答」系统通知（`ChatNotifier`）；Orb 面板的任务卡显示「等待确认」，点开可在面板里答（5.5）。
- **屏幕共用**：标准模式也继承了 `mcp__phone__*`。派发时在任务正文写明「后台任务，除非任务本身需要，不要操作手机屏幕」。即使后台去操作，dsh-Go 也保证同一时间只有一个会话占主屏，另一方等 30 秒后拿到可读错误，Orb 把这句原因告诉用户。
- A0 验证：抽出的共享模块在 PRoot Node 下能加载，不牵出桌面原生依赖（computer-use 包里的 macOS/Windows 后端）。
- 完成后：Orb 会话收到 followup → 面板更新；App 不在前台时由 `ChatNotifier` 发「后台任务完成」。

### 5.4 要串起来的流程

现有零件是分开的，Orb 要做一条原子流程：

```
长按球
  → 录音开始（原生 WavRecorder，走 AskBar 那条路径，不走 VoiceInputController）
  → 球旁出现独立的小波形窗（不改球窗口尺寸）
  → 松手
      ├─ 上滑取消 → 丢弃录音，回 idle
      └─ 正常 → 转写与截图并行：
           1. ASR 转写（SenseVoice 优先，回退系统 ASR）
           2. hideForCapture(true) 隐藏球 + 面板，等约 120 ms
           3. 截图（API 34+ 窗口截图；30–33 显示器截图）
           4. hideForCapture(false) 恢复
  → 组装消息：{ text: 转写, image: 截图路径 }
  → 投递到 Orb 自己的会话（orb-phone preset）
  → 面板展开，显示「已收到 + 截图缩略图」
  → Agent 看截图 → 调 mcp__phone__* 操作当前屏，或调度工具派后台
```

> 三条边界：
> 1. **必须先隐藏再截图**，用 `hideForCaptureWithReceipt()` 拿到被隐藏的窗口 id，事后可断言「球确实被隐藏」。
> 2. **截图失败不阻断发送**：`SECURE` / `ACCESSIBILITY_REQUIRED` / `UNSUPPORTED` 时只发文字，并加一句「当前屏不可截」。现有 `PetScreenshot.Error` 已覆盖。
> 3. **全程不打开 Activity**。

**必须新建/改的部分**：

| 项 | 现状 | 要做 |
|---|---|---|
| 长按 → 录音 → 松手发送 | `AskBar` 有，`OverlayBall` 的「按住」是**停止** | 把 AskBar 的触摸语义搬到球上 |
| 录音路径 | `VoiceInputController` 在 `paused`/`hidden` 时主动取消 | Orb 必须走原生 `WavRecorder` |
| 发送时截图 | 「截图并问」会跳 App、不自动发送 | 新写 `OrbScreenshot.kt` |
| 截图里没有球 | `hideForCaptureWithReceipt()` 返回被隐藏的窗口 id | Orb 窗口纳入 `CaptureVisibility` 引用计数 |
| 面板 | 浮层只有输入条 | 原生面板（5.5），A0 就有最小版 |
| 审批/问答卡 | Flutter `ApprovalCard` 在 Activity 内 | 面板里做原生卡（允许本次 / 拒绝 / 选项回答） |
| preset | 无 | `orb-phone`（5.2） |
| 完成后回到 Orb | 有 `ChatNotifier` / 气泡，不是 Orb 形状 | 面板状态更新 + 通知 |

### 5.5 面板

**宿主选型：原生面板**（Kotlin 精简 transcript），不在浮层里跑 Flutter（需要第二个 `FlutterEngine`，IME、焦点、生命周期都没验证过），也不点球进 Activity（违背「不离开当前 App」）。

**分阶段的内容**（与 16 第二段第 5 条对齐）：

| 阶段 | 面板内容 |
|---|---|
| A0 | 最近若干条消息（纯文本）+ 状态行 + 停止 |
| A1 | 截图缩略图 |
| A2 | 工具状态行（「正在点击…」「等待确认」） |
| A3 | 历史（Orb 会话列表，纯文本）、新建、审批/提问卡 |
| A4 | 后台任务卡（运行中/等待确认/完成/失败，点开看最后结果） |

不做 Markdown/代码高亮；需要完整阅读时提供「在 App 中打开」。输入沿用 AskBar 的实现，不新造。

### 5.6 关键风险与拆解

| 风险 | 说明 | 拆解 |
|---|---|---|
| **后台录音被静音** | 现有两个前台服务都是 `specialUse`，没有 `microphone` 类型；API 29+ 有 `isClientSilenced`；各厂商策略不同 | **A0 第一件事**：另一个 App 在前台时按住球录音，量是否静音、拿到多少字节；不成立就补 `microphone` 类型前台服务 |
| 发送时截图的时序 | hide 没有合成器确认，靠 120 ms 估计；`FLAG_SECURE` 页全黑 | A1 单独验证：微信/银行/游戏各截一张；API 30 与 34 两条路径 |
| 前后台抢屏幕 | 标准模式也有手机工具 | dsh-Go 的主屏独占 + 30 秒等待；Orb 转述错误 |
| 厂商悬浮窗/无障碍限制 | `canDrawOverlays` 会撒谎；无障碍会被杀 | 沿用 1×1 窗口探测；优先无障碍 overlay |
| 引擎在后台被回收 | PRoot + Node 重；电池优化 | A4 验证：派长任务后离开 App 10 分钟，看是否跑完并通知 |
| ASR 延迟 | PRD 要求 3 秒内看到消息 | 先显示「转写中」；SenseVoice 优先 |
| **AGPL-3.0** | `app/` 是 AGPL；品牌/素材不在 AGPL 内 | 先内部自用；对外分发前做许可评估；换自己的名字与美术 |

### 5.7 Android 兼容基线

- 继承 dsh-Go：**minSdk 26、targetSdk 28、只出 arm64-v8a 与 x86_64**（`app/android/app/build.gradle.kts:45-65`）。
- 无障碍是硬依赖（截图 + CU）。
- 截图：API 34+ 窗口级；API 30–33 hide-for-capture；低于 API 30 不支持截图。
- 构建链：Linux x86_64、JDK 17、Flutter 3.47.7、AGP 9.1.0、Kotlin 2.4.0。

### 5.8 退出标准

对应 [16-v0-plan.md](16-v0-plan.md) 7.2 的 7 条；额外加：

- `orb-phone` 会话的工具清单与 5.2 表中 A4 一行一致。
- 截图里不出现球和面板（窗口 id 集合 + 像素比对）。
- 银行/密码页只发文字并提示。
- 长按不说话（< 0.3 秒或静音）不会发空消息。
- **另一个 App 在前台时，长按球说话能正常录音并发送。**

---

## 6. 工作流 C：手机入网（A5）

### 6.1 为什么用同一套 Node 插件

已核实：

- dsh-Go 的 Dart 远程客户端 `packages/dsh_remote` 是**单活动 Host**（`README.md:100`：一台设备只允许一条 Host 连接，连另一台会断开上一台），满足不了 3–5 台互联。
- dsh-Go 的本机引擎里**没有** ds-harness-remote 的 Host 插件（runtime lock 里没有），手机现在不能被别的设备连接。
- 本机引擎就是 PRoot 里的 Node 24 + DSH `0.2.2-rc.1`，和电脑上的 DSH 是同一个运行时。

所以手机入网 = 在本机引擎里加载与电脑相同的 fork 后 remote 插件（`role: 'both'`）和 `@dsh-orb/mesh`。协议、证书固定、多对端连接、`device_agent`、文件回传都直接复用，手机与电脑的行为一致。

### 6.2 接入方式

- 打包：把两个插件加进 dsh-Go fork 的 runtime 构建（`runtime/` 的锁文件与 `rtbuild.py` 的插件安装段），由 `dsh-go-bridge` 的 overlay 注册为应用级插件。配置与电脑相同（4.3）：`remoteTools.enabled: false`、`terminal.enabled: false`、`forceRelay: true`。否则 `remote_*` 会出现在 `orb-phone` 和手机标准模式里。
- 只用 Relay：确认 remote 插件在 Relay 模式下不加载 WebRTC 原生库；PRoot 里装不上就保持惰性加载。
- 身份目录在 PRoot 的 `/root/.dsh/ds-harness-remote/…`，随 App 数据保存；App 升级不能丢。
- App 内 Flutter「互联」页通过本机引擎的 `/.dsh-orb/mesh/*` 路由（`127.0.0.1:3080`）读写：服务地址/证书指纹/配对码、本机名、设备树、远程会话（看/输入/停止/审批）。远程会话的 transcript 可复用 `ui/chat` 组件（在 Activity 内）。
- 互联页的开关：「允许被其他设备调用」（默认开）、「允许其他设备操作本机屏幕」（默认关，6.4）、「访问手机文件」入口（跳到 dsh-Go 现有设置；切换会重启引擎，要提示）。
- 悬浮窗里的 Orb 面板只显示悬浮球派出的任务卡与审批/提问卡，不放整棵树。

### 6.3 手机作为发起端

- `orb-phone` preset 加入 `tool-device-agent`；persona 加一段：要写到别的设备上的文件、或只有电脑能做的事，用 `device_agent`。
- 结果回到手机：完成通知进 Orb 会话，面板更新；结果文件落到 `/sdcard/Download/DSH-Go/mesh/<设备名>/<taskId>/`（需开「访问手机文件」），否则落在引擎内目录并提示。

### 6.4 手机作为被调用端

- 其他设备派来的会话跑 dsh-Go 的 `standard` preset。它会继承 `mcp__phone__*`，所以要拦截。
- **屏幕操作拦截（D-12）**：`packages/mesh/guard.ts` 在应用级挂 `ctx.tools.guard`（本仓库 `code-agent-registry.ts:122` 用的是同一机制）。Host 侧 bridge 记录由远程 peer `session/create` 或 `session/prompt` 触发的会话；这些会话调用 `mcp__phone__*` 时，如果「允许其他设备操作本机屏幕」关着，就拒绝并返回「这台手机不允许其他设备操作屏幕」。
- 开关打开时：dsh-Go 的控制条照常显示，并加一行「来自 <设备名> 的任务正在操作手机」；`SafetyGate` 不变，敏感操作仍在手机上确认。
- **手机文件作为附件**：打开「访问手机文件」后，后台 Agent 可用 Shell 在 `/sdcard/DCIM/…` 找照片，拷到 `.mesh-out/<taskId>/`，由发起端按 4.5 的流程取回。全程不操作手机界面。
- **保活**：引擎靠 `DshService` 前台服务；被系统回收时手机就是离线，各端 30 秒内显示。A5 验证锁屏 10 分钟后仍在线。

### 6.5 A5 前置验证（可以提早做）

1. 在手机引擎里手工装 fork 的 remote 插件，Relay 模式连上 B1 服务器，电脑能看到手机这个 Host。
2. 电脑对手机 `session/follow` / `session/prompt` / `session/cancel` 正常。
3. 手机作为 Client 同时连两台电脑。
4. 拦截生效：电脑派来的会话调用 `mcp__phone__screen` 被拒；本机 Orb 会话不受影响。确认工具执行上下文能拿到会话 id；拿不到就改在 Host bridge 层拦截。
5. 10 秒心跳下的耗电与流量，锁屏 10 分钟是否掉线。

### 6.6 退出标准

对应 [16-v0-plan.md](16-v0-plan.md) 7.3 的 6 条，并在 5 台同时在线时回归 7.1。

---

## 7. 接口约定（三条线共享）

### 7.1 节点与设备身份

```ts
MeshNode {
  nodeId: string            // 兑换配对码时生成
  name: string              // Mac1 / 书房 Mac
  platform: 'darwin' | 'win32' | 'android' | 'linux'
  hostDeviceId: string      // Host 身份
  clientDeviceId?: string   // Client 身份
  online: boolean
  lastSeenAt?: number
  harnessVersion?: string
  appVersion?: string
}

DeviceDescriptor {          // 每个身份一份（沿用 ds-harness-remote）
  deviceId: string
  role: 'host' | 'client'
  identityKey: string       // 公钥（base64）
  nodeId: string            // v0 新增
}
```

### 7.2 会话状态（树里显示用）

```
'idle' | 'running' | 'waiting-approval' | 'waiting-question' | 'failed' | 'unknown'
```

> `offline` 是设备级状态。离线设备下的会话显示为 `unknown` + 上次已知状态。

### 7.3 交互（审批/提问）

```ts
MeshInteraction {           // 由目标节点 $events 流上的事件映射而来
  nodeId: string            // 目标节点
  sessionId: string
  eventId: string
  clientId: string          // 收到事件的那条流；应答必须原路返回
  kind: 'approval' | 'question'
  toolName?: string
  reason?: string
  originNodeId?: string     // 派发这条任务的节点（来自任务表），决定在哪弹卡
  createdAt: number
}

MeshInteractionAnswer {
  eventId: string
  outcome: 'allowed-once' | 'rejected'   // 审批
  answers?: unknown                      // 提问，按 userQuestions/answer 的格式
  answeredBy: string                     // nodeId
}
```

### 7.4 任务派发

```ts
DeviceTask {
  taskId: string
  originNodeId: string
  targetNodeId: string
  sessionId: string
  workspaceId?: string
  status: 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled' | 'unknown'
  files: Array<{
    name: string
    size: number
    direction: 'out' | 'in'      // out = 发给目标；in = 回传本机
    localPath?: string
    state: 'transferring' | 'done' | 'failed'
    progress?: number            // 0–1
  }>
  createdAt: number
  updatedAt: number
}
```

---

## 8. 里程碑与建议顺序

**与 16 的编号对照**：

| 16 | 17 |
|---|---|
| B0 验证 | B0 |
| M0 连接 | B1 |
| M1 看见 | B2 |
| M2 动手 | B3 + B4 |
| M3 电脑验收 | B5 |
| A0–A4 | A0–A4 |
| A5 入网 | A5 |
| M4 全量验收 | M4 |

### 工作流 B（服务端 + 电脑插件）

| 里程碑 | 目标 | 关键动作 | 退出 |
|---|---|---|---|
| **B0 实验**（2–3 天） | 确认真实基线 | 见下方 B0 清单 | 一份「能复用 / 要改 / 被卡」结论 |
| **B1 连接** | 配对 + 多连接 + 在线 | fork server：`register-with-code`、节点、`connect.request` 只替换同对 Link、心跳 10/20 秒 + 2 秒扫描、管理监听、关账号接口；fork 客户端：证书固定 | 3.3 的 7 条 |
| **B2 看见** | 多设备树 + 只读会话 | `packages/mesh`：peers、tree、routes；Mesh 窗口左树 + 右 transcript | 3 台电脑互相看到工作区/会话，实时 |
| **B3 动手** | 输入 + 停止 + 审批/提问 | `session/prompt`、`session/cancel`；`interactions.ts` + 审批/提问卡 | 能发指令、能停止；远程审批在发起设备答 |
| **B4 派发** | `device_agent` + 文件双向 | 三个工具、在线检查、工作区询问、去重、结果文件回传、进度、persona | Mac 派任务给 Windows 并收回结果文件；同时派给第三台 |
| **B5 电脑验收** | 硬化 | 安全/性能/运维 | 16 7.1 的 12 条全过 |

**B0 清单（按顺序做，每步写结论）**

1. **服务端起得来**：在 `YOUR_SERVER_IP` 上用官方镜像 `docker compose up`，`/health` 可达；配 Caddy 自签证书，确认 `curl -k` 通、不带 `-k` 失败。顺带查能否为公网 IP 签公开证书。
2. **插件装得上**：Mac 和 Windows 各装官方 `ds-harness-remote`，用原版 server 的账号密码模式连上（只为 B0 对照；fork 后公网关闭账号接口）。同时确认 `remoteTools.enabled: false` 后 `remote_*` 从模型工具里消失，以及侧栏入口能否隐藏。
3. **两端能互连**：Mac 作 Client 连 Windows，`session/follow` 有实时输出，`session/prompt` 能发，`session/cancel` 能停。
4. **文件能来回**：`remote_upload_file` 与 `remote_download_file`，记下上限与失败表现。
5. **审批与提问**：让 Windows 上由 Mac 发起的会话触发审批（改文件/跑命令）和 `ask_user_question`，回答 4.6 的四个问题。**结论决定 4.6 用首选还是后备。**
6. **一台 Host 多个客户端**：两台客户端同时连 Windows，确认 `connectedPeers()` 有两个、互不替换。
7. **一个客户端多台 Host**：一个进程里并发连 3 个 Host（可在本机起多个 profile）。先用原版 server 记下在 `gateway.ts:525` 被断开的现象，再打补丁复测。同时确认一条控制连接能否承载多条 Link。
8. **`register-with-code` 缺失确认**：对原版 server 发请求，确认 404。
9. **离线检测**：原版下拔网线测判离线时间（预期 75–100 秒），打补丁（10 秒心跳、20 秒阈值、2 秒扫描）后复测：服务端 ≤ 22 秒，各端 Mesh ≤ 27 秒。

### 工作流 A（手机端悬浮球）

| 里程碑 | 目标 | 关键动作 | 退出 |
|---|---|---|---|
| **A0 球与说话** | 长按 → 发送文字 | 球窗口（起点 `OverlayBall`）+ 长按录音 + 松手发送 + 上滑取消；`orb-phone` preset 骨架；最小面板 | 说完，面板里出现文字与回复 |
| **A1 截图** | 发送时带截图 | `OrbScreenshot`：隐藏 → 等待 → 截图 → 恢复 → 投递 | 消息里有文字和截图，图中无球 |
| **A2 手机 CU** | 精简工具集 + 当前屏操作 | `orb-phone` persona 与工具清单定稿；接 `SafetyGate` | 能完成「点按钮/填表单」，敏感步骤需确认 |
| **A3 面板** | 历史/新建/审批卡 | 原生面板补齐（5.5） | 不打开主界面也能完成一轮 |
| **A4 后台** | 标准模式后台 Agent | 调度工具（目标 `standard`，不自动放行）+ 任务卡 + 通知 | 长任务后台跑完并回到 Orb |

**A0 清单（按风险从高到低）**

1. **后台录音是否被静音（最高风险，先做）**：装现有 App，打开宠物悬浮窗，切到微信/浏览器，用 AskBar 按住说一句。记录 `isClientSilenced`、字节数、转写结果。不通过就先补 `microphone` 类型前台服务。
2. **工具链能出包**：`bash runtime/build-runtime.sh arm64-v8a` 后 `bash tooling/build-apk.sh -f arm64`，装到真机。
3. **引擎能跑**：PRoot 里 DSH `0.2.2-rc.1` 起来，`127.0.0.1:3080` 可访问，能跑一轮对话。
4. **无障碍与手机操控**：`PhoneA11yService` 连上；「手机操控」开关打开后标准模式能看到 `mcp__phone__*`。
5. **精简 preset 生效**：插入 `orb-phone`，导出工具清单，与 5.2 表中 A0–A3 一行一致。
6. **调度工具能加载**：从 `code_agent` 抽出的派发模块在 PRoot Node 下加载，能以 `standard` 建后台会话（为 A4 做准备）。
7. **球能显示**：`OverlayBall` 在目标 ROM 上可见、可拖、可停靠。
8. **截图无球（两条 API 路径）**：各截微信、银行、游戏一张。

### 工作流 C（手机入网）

| 里程碑 | 目标 | 关键动作 | 退出 |
|---|---|---|---|
| **A5 入网** | 手机作为完整节点 | 6.5 前置验证 → runtime 打包两个插件 → App 互联页 → Orb `device_agent` → 屏幕拦截 | 16 7.3 第 1–5 条 |
| **M4 全量验收** | 5 台 | 16 7.3 第 6 条 + 5 台回归 7.1 | 全过 |

**并行建议**：B0/B1 与 A0 同时开始。6.5 的第 1–2 步在 B1 上线后就能做，不必等 A4。

---

## 9. 风险清单

| 风险 | 影响 | 应对 | 归属 |
|---|---|---|---|
| **多对端连接** | 树只能一台台看，达不到 3–5 台 | B0 第 7 步先验；改 `gateway.ts:525`；客户端自管 `RemoteHandle` | B |
| 远程审批/提问语义 | 卡挂住或重复 | B0 第 5 步；首选原生通道，后备自建转发 | B |
| 证书固定要新写 | 自签下客户端连不上 | B1 里给 fork 客户端加 `serverCertSha256` | B |
| 离线阈值写死 75 秒、按心跳间隔扫 | 达不到 ≤ 30 秒 | 10/20 秒 + 2 秒扫描；改 `adaptive-transport.ts:554`；对端 5 秒兜底查询 | B |
| remote 插件默认注入 `remote_*` | 精简工具集被撑大、绕过在线检查 | 所有节点 `remoteTools.enabled: false`；每个里程碑核对工具清单 | B/A/C |
| 文件无进度、不续传 | 大文件体验差 | 加进度回调；整份重试；20 MB 提示 | B |
| 服务器 12/10 到期、2C2G | 中途断服 | 现在续费；监控 5 台的中继带宽 | B |
| **后台录音被静音** | Orb 核心交互不成立 | A0 第一步测；补 `microphone` 前台服务 | A |
| **浮层不能跑 Flutter** | 面板不能复用 `ui/chat` | 原生面板 | A |
| 「截图并问」≠「发送时截图」 | 会跳 App、不自动发送 | 新写 `OrbScreenshot` | A |
| 前后台抢屏幕 | 后台任务误操作屏幕 | 任务正文约束 + dsh-Go 主屏独占 | A |
| ROM 限制悬浮窗/无障碍被回收 | 部分机型球不显示 | 无障碍 overlay；1×1 探测 | A |
| 引擎在后台被回收 | 长任务中断、手机掉线 | A4/A5 验证；掉线明确显示 | A/C |
| **remote 插件在 PRoot 里跑不起来** | 手机无法入网 | 6.5 提早验证；只用 Relay；WebRTC 惰性加载 | C |
| 远程操作手机屏幕 | 安全 | 默认关 + 工具拦截 + 明显提示 + 手机上确认 | C |
| dsh-Go AGPL + 品牌素材 | 分发受限 | 先内部自用；换名换图；对外前许可评估 | A/C |
| 版本漂移 | 升级 DSH 后插件不兼容 | 三端锁 `0.2.2-rc.1`；CI 跑 bundle 校验 | A+B+C |

---

## 10. 待确认（不阻塞开工）

| # | 问题 | 建议默认 |
|---|---|---|
| Q1 | 证书来源 | 默认自签；B0 第 1 步查公开 IP 证书。两种都固定指纹 |
| Q2 | 文件接收目录 | 电脑 `~/Downloads/dsh-mesh/`；手机 `/sdcard/Download/DSH-Go/mesh/` |
| Q3 | 中继单文件上限 | 20 MB，可配置 |
| Q4 | 会话列表范围 | v0 显示「本机全部 + 远程全部」，不做过滤/搜索 |
| Q5 | 手机面板是否接受「原生精简版」 | 接受：分阶段见 5.5，不做 Markdown 渲染 |
| Q6 | Orb 是否要补 `microphone` 前台服务 | 视 A0 第 1 步；被静音就必须补 |
| Q7 | Orb 是否沿用 dsh-Go 品牌 | 分发前必须换名换图；内部自用可暂用 |
| Q8 | 第 4、5 台设备 | M4 必须凑足 5 台：另一台电脑或虚拟机，加 x86_64 Android 模拟器（dsh-Go 出 x86_64 包）或第二台手机 |

---

## 11. 第一批可执行任务

按依赖排序：

**服务端与客户端连接层（B1）**
1. fork ds-harness-remote，在服务器用官方镜像跑起来，确认 `https://IP` + 自签证书行为；查公开 IP 证书。
2. `store.ts` 加配对码与节点（version 2）；实现 `register-with-code`；`register-owned-role` 挂到同一节点。
3. `gateway.ts:525` 改为只替换同一对（Client, Host）的旧 Link；心跳 10 秒、阈值 20 秒、超时检查每 2 秒一次；断开时写 `lastSeenAt`。
4. 改名改为设备 token + 同节点；新增管理员改名、管理员撤销节点。
5. 管理监听（容器内 `0.0.0.0:8081`，只发布到宿主机 `127.0.0.1:8081`）+ `/admin` 页面（节点表、配对码区、连接记录、证书指纹）；公网监听不提供 Web 页面，关掉账号接口。
6. fork 客户端加 `serverCertSha256`（HTTP + WS）。
7. 部署脚本：Caddy + 自签证书 + 只开 443 + 备份。

**电脑插件（B2–B4）**
1. 所有节点的 remote 插件配置：`role: both`、`remoteTools.enabled: false`、`terminal.enabled: false`、`forceRelay: true`。
2. 起 `packages/mesh` 骨架：`package.json` / `tsconfig.json` / `tsdown.config.ts`，`src/index.ts` 只做 `name` + `inject` + 空 `apply`，先让 `pnpm typecheck` 过。
3. 多对端实验（4.4），产出结论。**这条决定后面所有连接管理代码的形态。**
4. `peers.ts` + `tree.ts` + `routes.ts`：本机走 `sessionController.list`，对端走 `RemoteHandle`；`session/follow` + `workspace/follow` 两级。
5. helper 加 `mesh.html` / `mesh.js`（普通窗口），左树 + 右 transcript（只读）；菜单加「打开互联」。
6. 接 `session/prompt` 与 `session/cancel`；`interactions.ts` + 审批/提问卡（按 B0 第 5 步结论）。
7. 设置章节 `orb-mesh`（`order: 26`）：配对码交给 `host.registration-code.submit`，服务地址与指纹写 remote 插件配置。
8. `device_agent`：在线检查、工作区询问、去重、结果文件回传、进度；persona 段落；patch 接线（app-level `orb-mesh`、`preset-computer-use` 加 `tool-device-agent`）；bundle 三处。

**手机端（A0/A1）**
1. **先做风险验证**：后台录音是否被静音。
2. 工具链出包，真机装上；确认「手机操控」开关后标准模式能看到 `mcp__phone__*`。
3. 在 `dsh-go-bridge` overlay 里插入 `orb-phone` preset，导出工具清单核对。
4. `OrbOverlay`：以 `OverlayBall` 为起点做可拖动球；长按录音（原生 `WavRecorder`）；松手发送；上滑取消；最小面板。
5. `OrbScreenshot`：隐藏 → 120 ms → 截图 → 恢复 → 随消息投递；失败降级只发文字。
6. 调度工具：从 `code_agent` 抽出派发与完成通知的共享模块，`@dsh-orb/phone-background-agent` 以 `standard`、不自动放行加载，工具名 `background_agent`。

**手机入网（可在 B1 上线后提早做 6.5 的第 1–2 步）**
1. 在手机引擎里手工装 fork 的 remote 插件，Relay 模式连 B1 服务器。
2. 电脑对手机的看/发/停。
