# 悬浮球超级互联 v0：三仓库拆分与接口约定

> 状态：Draft v0.1
> 日期：2026-11-10
> 范围：服务端、电脑悬浮球、手机悬浮球分三个仓库独立开发；完成后在设备的设置页粘贴配对串即可互联
> 关联：[16-v0-plan.md](16-v0-plan.md)（计划与验收）、[17-implementation-plan.md](17-implementation-plan.md)（实现细节）
> 说明：本文定「代码放哪、仓库之间靠什么对接」。17 里的模块设计不变，只是分到三个仓库；两份文档冲突时，仓库归属以本文为准

---

## 0. 结论摘要

- **三个仓库**：`dsh-mesh`（新，fork ds-harness-remote）、`dsh-orb-android`（新，fork dsh-Go）、`dsh-orb-cordis`（本仓库）。
- **服务端仓库不只放服务器**。每台设备都要装的互联插件（连接、配对、多对端、设备树、`device_agent`、文件回传）也放在 `dsh-mesh`，发布成一个 DSH 插件包 `@dsh-mesh/plugin`。原因有两个：
  1. 服务端和设备侧连接代码共用 `packages/protocol`（心跳常量、帧格式、注册接口），必须一起改、一起发版。分开放，每改一次协议就要同步三个仓库。
  2. 电脑和手机跑的是同一套 Node 插件（17 第 6.1 节）。放在任何一个端的仓库里，另一个端都得依赖它。
- **依赖只有一个方向**：电脑仓库和手机仓库都依赖 `dsh-mesh` 发布的产物，彼此之间不依赖。
- **「填入即互联」靠两件事**：
  1. 管理页生成一条**配对串**，里面有服务器地址、配对码和证书指纹，设备上只粘贴这一项（4.1）；
  2. `@dsh-mesh/plugin` 提供本机接口 `POST /.dsh-mesh/v1/pair`，校验指纹、提交配对码、注册、上线一次做完（第 3 节）。

  电脑的设置页和手机的互联页都只调这个接口，自己不碰协议。
- **独立开发靠先冻结约定、再给假数据**：`@dsh-mesh/plugin` 的第一个版本（R0）就带假数据模式。电脑和手机可以先用 R0 把界面做完，后面换成真实版本，不用改界面代码（第 5 节）。

---

## 1. 三个仓库

| 仓库 | 来源 | 许可 | 负责 | 发布产物 |
|---|---|---|---|---|
| **`dsh-mesh`**（新） | fork [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) `0.6.4` | MIT | 服务器、管理页、部署脚本；设备侧互联插件（连接层 + 互联核心）；协议；假数据模式 | 服务器 Docker 镜像；`@dsh-mesh/plugin` 的 `.tgz`；`SHA256SUMS` |
| **`dsh-orb-cordis`**（本仓库） | — | MIT | 电脑悬浮球；Mesh 窗口；设置页「互联」板块；`device_agent` 的 persona；把 `@dsh-mesh/plugin` 打进 dsh-orb 安装包 | `dsh-orb-x.y.z.tgz` |
| **`dsh-orb-android`**（新） | fork [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) `1.0.14` | AGPL-3.0 | 手机悬浮球（原生球、录音、截图、面板）；`orb-phone` preset；`background_agent`；把 `@dsh-mesh/plugin` 打进本机引擎；App 内互联页 | APK |

**`dsh-mesh` 的目录**（在 fork 的 monorepo 上增改）：

```
apps/server/            # 改：配对码、节点、多连接、心跳、管理监听、关账号接口（17 第 3 节）
apps/server/web/        # 改：管理页（节点表、配对串 + 二维码、连接记录）
packages/protocol/      # 改：心跳常量、meshApi 版本号
packages/crypto/        # 不动
packages/client-core/   # 改：证书固定、多对端连接原语
packages/plugin/        # 改：连接层（Host 半边、注册、证书固定）；身份目录改为 ~/.dsh/dsh-mesh/
packages/mesh/          # 新：互联核心（17 第 4.2 节的 peers / tree / interactions / device-agent / files / guard / routes）
packages/mesh-plugin/   # 新：对外发布的 @dsh-mesh/plugin，打包上面两层
deploy/                 # 新：compose、Caddy、自签证书脚本、备份
tests/contract/         # 新：本机接口 v1 的契约测试（第 4.3 节）
```

上游的 `apps/browser`、`apps/vscode`、`apps/android`、`packages/tui*` 不删，也不参与 v0 构建与发布，方便以后合并上游。

**`packages/webrtc` 不能去掉**：插件一加载就 import 它（`service.ts:33`、`server-connection.ts:1`、`client-connection.ts:3`、`client-secure-transport.ts:1`）。它本身是纯 TS，只依赖 protocol，要打进 `@dsh-mesh/plugin`。真正的原生库 `werift`、`@roamhq/wrtc` 是惰性加载的（`werift-rtc.ts:151`、`:166`），打包时列为外部依赖、不随包发布；只用 Relay 时不会被加载。插件的运行时依赖 `ws`、`zod`、`qrcode`、`@xterm/*`（`packages/plugin/package.json:84-91`）也要一起打进去。

**许可**：`dsh-mesh` 与本仓库都是 MIT；`dsh-orb-android` 是 AGPL-3.0，可以打包 MIT 的 `@dsh-mesh/plugin`。手机仓库参考本仓库 `code_agent` 写 `background_agent` 时保留 MIT 版权声明即可。

---

## 2. 依赖方向与发布

```
                 dsh-mesh（服务器 + @dsh-mesh/plugin）
                 ├── 服务器镜像 ──────────────→ 阿里云 YOUR_SERVER_IP
                 └── @dsh-mesh/plugin-x.y.z.tgz
                        │                         │
                        ▼                         ▼
               dsh-orb-cordis              dsh-orb-android
         （打进 dsh-orb 安装包）     （打进 PRoot 本机引擎）
```

- **一个版本号管两样**：`dsh-mesh` 打 tag `vX.Y.Z` 时，同时发服务器镜像和插件包。服务器和插件按同一个版本部署。
- **消费方锁死版本和哈希**：
  - 本仓库：`packages/bundle/package.json` 依赖 release 里的 tgz 地址，哈希记在 `pnpm-lock.yaml`；`scripts/assemble.mjs` 把它拷进安装包。
  - 手机仓库：dsh-Go 现在**没有**安装额外插件 tgz 的机制。DSH 由 `npm install` 按 `runtime/locks/dsh-0.2.2-rc.1/package-lock.json` 安装（`build-runtime.sh:254-262`），bridge 按路径拷到 `/opt/dsh-go/dsh-go-bridge`（`build-runtime.sh:392`、`runtime/lib/rtbuild.py:30`）。要新增一段：用 `build-runtime.sh` 现有带 sha256 校验的 `fetch`（`:95-106`）下载 tgz，解到 `/opt/dsh-go/plugins/dsh-mesh`，overlay 按路径加载；tgz 的哈希加进构建输入哈希（`:404-408`），换版本时引擎会重建。
- **DSH 版本三个仓库一致**：都锁 `0.2.2-rc.1`。要升级时，`dsh-mesh` 先发兼容版本，另外两个仓库再跟。
- **只装一份互联插件**：`@dsh-mesh/plugin` 与官方 `ds-harness-remote` 插件不能同时加载（都会注册 Host、改官方网关）。dsh-orb 安装时检测到官方插件就提示用户停用；手机引擎里本来没有官方插件。

---

## 3. 「填入即互联」流程

### 3.1 用户视角

1. 管理员经 SSH 隧道打开管理页，点「添加设备」，填备注（例如「书房 Mac」）。
2. 管理页显示一条配对串和对应二维码，30 分钟内有效，只能用一次。
3. 在设备上打开互联设置：
   - 电脑：DSH 设置 → 「互联」板块；
   - 手机：dsh-orb-android App → 「互联」页（可扫码）。
4. 粘贴配对串，本机名称可以不填（默认 `Mac1` / `Windows1` / `Phone1`），点「连接」。
5. 15 秒内显示「已连接 · 本机名 Mac1」和其他设备列表；Mesh 窗口与手机互联页里出现其他设备。

整个过程不改配置文件、不重启 DSH 或手机引擎。

### 3.2 插件内部做什么

`POST /.dsh-mesh/v1/pair { pairing, name? }`，按顺序执行，任何一步失败就停下，返回该步的错误：

| 步 | 动作 | 失败时的 `error` |
|---|---|---|
| 0 | 本机已配对到**另一台**服务器 → 直接拒绝 | `already_paired` |
| 1 | 解析配对串（4.1） | `bad_pairing` |
| 2 | 用配对串里的指纹固定证书，请求 `GET https://<地址>/health` | `unreachable`、`fingerprint_mismatch` |
| 3 | 比较 `/health` 返回的 `meshApi` 与本机插件支持的版本 | `server_incompatible` |
| 4 | 生成本机 Host、Client 两个身份（已有则复用），调 `register-with-code`；成功后**立即**把地址、指纹、token 和 `pending: true` 写入 `state.json` | `code_invalid`、`code_used`、`code_expired`、`rate_limited` |
| 5 | 调 `register-owned-role` 注册 Client 身份，挂到同一节点 | `register_failed` |
| 6 | 填了 `name` 就改名 | `name_taken`（不算失败：返回成功，附 `warning`） |
| 7 | 在进程内按新配置重建 Host 与 Client 运行时（参照上游 `replaceServer`，`index.ts:365-380`），启动连接，拉取对端列表；清掉 `pending` | `connect_failed` |

- 成功：HTTP 200，`{ ok: true, node: { nodeId, name, platform }, peers: MeshNode[], warning? }`。
- 失败：HTTP 4xx/5xx，`{ error, message, step }`。与其他接口的错误格式一致（4.3），只多一个 `step`。`message` 是给用户看的中文/英文句子（下表）。
- 每一步都有超时，整体不超过 15 秒。
- **第 4 步之后中断**（崩溃、断网）：`state.json` 里是 `pending: true`，用户再点「连接」时跳过第 4 步，从第 5 步续做，不再消耗配对码。
- **被管理员撤销后重新配对同一台服务器**：旧身份的 token 已失效，第 4 步收到 401 时丢弃旧身份、重新生成再注册。
- 退出互联（`POST /unpair`）会撤销本机两个身份，清掉 `state.json` 和身份目录。
- 配对码只在这一次请求里用，不落盘。

| `error` | HTTP | 给用户的提示 |
|---|---|---|
| `already_paired` | 409 | 本机已加入另一台服务器（<地址>）的互联，请先退出 |
| `bad_pairing` | 400 | 配对串格式不对，请从管理页重新复制 |
| `unreachable` | 502 | 连不上服务器 <地址>，请检查网络或服务器是否在运行 |
| `fingerprint_mismatch` | 502 | 服务器证书和配对串里的指纹不一致，可能连错了服务器，已停止连接 |
| `server_incompatible` | 409 | 服务器版本（meshApi <n>）和本机互联插件（meshApi <m>）不兼容，请先升级 |
| `code_invalid` / `code_used` / `code_expired` | 400 / 409 / 410 | 配对码无效 / 已被使用 / 已过期，请在管理页重新生成 |
| `rate_limited` | 429 | 尝试次数过多，请 1 分钟后再试 |
| `register_failed` | 502 | 服务器拒绝了本机的注册（<服务器原因>），请重新生成配对码再试 |
| `connect_failed` | 502 | 已配对，但暂时连不上中继，会自动重试 |
| `name_taken`（warning） | 200 | 名称「<名称>」已被占用，暂用 <默认名>，可在设置里再改 |

`<地址>` 取自配对串，不写死。服务端 `register-with-code` 对应返回：码不存在 400、已用 409、过期 410、限流 429（17 第 3.2 节）。

### 3.3 唯一的数据来源

- 服务器地址、证书指纹、节点身份都只由 `@dsh-mesh/plugin` 保存，目录是 `os.homedir()/.dsh/dsh-mesh/`。不要写死路径：手机在 PRoot 下是 `/root/.dsh/dsh-mesh/`，但 dsh-Go 还有直接 glibc 启动模式（`DshProcess.kt:83`），家目录可能不同。
- 电脑设置页和手机互联页**不另存**这些值，显示时都读 `GET /.dsh-mesh/v1/status`。
- 手机仓库要保证 App 升级、引擎重装时这个目录不丢。已核实 dsh-Go 升级引擎时保留 `/root`（`RuntimeInstaller.kt:199-231`）；换启动模式时要再确认。

---

## 4. 跨仓库约定 v1

下面这些**从现在起冻结**，三个仓库都照它并行开发。之后要改，必须升版本号并在 `dsh-mesh` 的 CHANGELOG 里写明（第 6 节）。

### 4.1 配对串

```
dshmesh://YOUR_SERVER_IP:443/pair?v=1&code=TESTPAIR&fp=Qm9n...（43 字符）
```

| 字段 | 说明 |
|---|---|
| 主机与端口 | 公网 IP 或域名；端口省略时为 443 |
| `v` | 配对串格式版本，现在是 `1` |
| `code` | 8 位配对码，大写字母数字，不含 `0/O`、`1/I` |
| `fp` | 服务器证书公钥（SPKI）的 SHA-256，base64url 编码，不带填充 |

- 管理页同时给出二维码，内容就是这条串。手机互联页可以复用 dsh-Go 现有的 ML Kit 扫码。
- 两个设置界面都要提供「手动填写」：地址、配对码、指纹三栏，拼成同一条串后调 `pair`。
- 指纹固定的是**公钥**，不是整张证书。服务器换证书时沿用同一把私钥，指纹不变，设备不用重新配对。

### 4.2 插件接入方式

消费方只写这几行，不配置连接细节：

```yaml
# 应用级（电脑：cordis.patch.yml 的 app-level 行；手机：dsh-go-bridge overlay）
- id: dsh-mesh
  name: '@dsh-mesh/plugin'
  config:
    platform: android            # 只有手机填。不填时用 process.platform（电脑一份 patch 同时服务 Mac 与 Windows）；手机的 PRoot 里它是 linux，必须覆盖
    incomingPreset: standard     # 其他设备派来的任务用哪个 preset
    remoteToolGuard: ['mcp__phone__*']   # 只有手机填：远程发起的会话默认不能调这些工具
    receiveDir: /sdcard/Download/DSH-Go/mesh   # 结果文件默认落点；用户在 /prefs 里改过就以 /prefs 为准；不可写时退回插件自己的目录
    mock: false                  # 开发用，见第 5 节

# preset 内（电脑：preset-computer-use；手机：orb-phone，A5 起）
- id: tool-device-agent
  name: '@dsh-mesh/plugin/device-agent'
```

`@dsh-mesh/plugin` 自己保证以下几点，消费方不用、也不能改：

- 设备同时是 Host 和 Client；
- 只用 Relay；
- **不向任何 preset 注入 `remote_*` 工具**；
- 不开远程终端；
- 不在官方 DSH 侧栏加入口。

这些就是 17 的 D-15。两种做法由 `dsh-mesh` 在 B0 后自己选：插件内部直接实例化 Host 运行时，不加载上游插件的 DSH 入口；或者加载上游入口但写死这些配置。

> 若 B0 第 10 步（单独实例化 Host 运行时）不成立，兜底**不能**是「侧栏入口能隐藏就隐藏」——那样本节「不在官方侧栏加入口」就不成立。已核实 `TypertGatewaySwitch.local()` 只返回绑定过的本地调用，**补丁只在 `install()` 里装**，所以「不加载上游入口」这条路天然不会碰官方侧栏；兜底固定为 fork 上游 `index.ts` 的 `activate()`、删掉侧栏与 settings 注册，**不允许加载未修改的上游入口**（见 `docs/19-v0-decisions.md` 的 T3）。

### 4.3 本机接口 `/.dsh-mesh/v1/*`

挂在本机 DSH 的 web 服务上：电脑是 DSH 本机端口，手机是 `127.0.0.1:3080`。鉴权与本仓库 `/.dsh-orb/*` 相同，走 `ctx.connection.admit` / `isAuthenticated`。

- **电脑设置页**运行在 DSH 网页里，本来就带着会话 cookie。
- **helper 窗口**用自己的令牌访问 `orb-host`，不直接调这些接口，由 `orb-host` 在进程内转调同一套服务（4.4）。
- **手机 Flutter 互联页**现在没有现成的鉴权：dsh-Go 的运行令牌只用来换会话 cookie（`island_gate.dart:150`，令牌在 `runtime_bridge.dart:186`），Dart 侧没有给本机引擎发请求的 HTTP 客户端。手机仓库要先做一个：用 `GET /?token=<运行令牌>` 换 cookie，存进 Dart 的 cookie jar，之后所有 `/.dsh-mesh/v1/*` 请求都带上；引擎重启、令牌变化时重新换。这是 17 第 6.5 节的第 0 步。
- **增量通道用「游标 + 长轮询」，SSE 只当优化**：`ctx.webServer.register` 给的是原始 `res`，理论上能流式写，但 DSH 的 web 层是否压缩、缓冲、有没有空闲超时都未验证（本仓库现有路由全是定长 JSON 或图片，`routes.ts:701-706`、`:757-764`）。所以 v0 的默认实现是**长轮询**：请求带 `since=<cursor>`，服务器挂起最多 25 秒，有新事件立即返回，超时返回空批加新 cursor。它是定长响应，不依赖流式行为，而且自带断点续传。B0 第 12 步验证通过后，可在同一路径上加 `Accept: text/event-stream` 分支切 SSE——**事件 JSON 形状不变**，消费方不用改代码。

| 方法 | 路径 | 用途 | 谁用 |
|---|---|---|---|
| GET | `/status` | `{ paired, server: { url, fp }, node, connection: 'unpaired' \| 'connecting' \| 'connected' \| 'offline', peersOnline, peersTotal }` | 两端设置页 |
| POST | `/pair` | 第 3.2 节 | 两端设置页 |
| POST | `/unpair` | 退出互联 | 两端设置页 |
| POST | `/name` | `{ name }` 改本机名 | 两端设置页 |
| GET / PUT | `/prefs` | `{ allowIncoming, allowedCallers, allowGuardedTools, receiveDir }`；`allowGuardedTools` 在手机上显示为「允许其他设备操作本机屏幕」 | 两端设置页 |
| GET | `/nodes` | `MeshNode[]`（17 第 7.1 节） | 树、设置页 |
| GET | `/tree` | 设备 → 工作区 → 会话 的快照 | 树 |
| GET | `/events?since=<cursor>` | 节点上下线、树变化、交互出现/撤下、任务状态；`{ items, cursor }`，长轮询最多挂 25 秒 | 树、卡片 |
| GET | `/sessions/:nodeId/:sessionId/page` | 历史分页 | 会话视图 |
| GET | `/sessions/:nodeId/:sessionId/stream?since=<cursor>` | 实时事件；`{ items, cursor }`，同样长轮询 | 会话视图 |
| POST | `/sessions/:nodeId/:sessionId/prompt` | `{ text, attachments? }`；仅任务会话，否则 `session_not_remote_controllable` | 会话视图 |
| POST | `/sessions/:nodeId/:sessionId/cancel` | 停止这一轮；仅任务会话，否则同上 | 会话视图 |
| GET | `/interactions` | 未决审批/提问（`MeshInteraction[]`） | 卡片 |
| POST | `/interactions/:eventId/answer` | `MeshInteractionAnswer` | 卡片 |
| GET | `/tasks` | `DeviceTask[]`（含回传文件与进度） | 任务卡、附件区 |

- **会话事件不重新定义**：`stream` 与 `page` 里的每一帧，就是 DSH `session/follow` / `session/page` 的原始事件，外面包一层 `{ nodeId, sessionId, seq, event }`；长轮询的 `items` 就是这些帧的数组，`cursor` 取最大 `seq`。电脑的 `transcript-model.js` 和手机的 `ui/chat` 本来就解析 DSH 事件，各自直接渲染。
- **`cursor` 语义**：按节点内单调递增的 `seq` 记账，不按时间戳；断线重连或进程重启后，先 `GET /tree` 与 `/sessions/…/page` 重建基线，再用上一次的 `cursor` 续拉。`cursor` 过期（落后太多）时服务端返回 `{ items: [], cursor: <最新>, reset: true }`，消费方重建基线。
- **错误格式统一**：`{ error: string, message: string }`，`message` 可直接展示。
- **会话接口的拒绝码**：对**非任务会话**调 `/sessions/:nodeId/:sessionId/prompt` 或 `/cancel` 返回 `session_not_remote_controllable`（403）。v0 只允许对 `device_agent` 派出的任务会话输入（决策 P2），UI 把输入框与停止置灰并展示 `message`。
- **审批可答者**：发起任务设备 + 目标设备本机；第三台打开会话只显示卡片。这是 UI 策略，协议层不强制（决策 P3）。
- **契约测试**：`dsh-mesh/tests/contract/` 用固定数据跑每个接口的请求与响应形状，真实模式和假数据模式都要通过。消费方若发现响应与文档不符，就去 `dsh-mesh` 提 issue，不在自己仓库里打补丁兼容。

### 4.4 进程内服务

同一个插件还在应用级 `provide('mesh', MeshService)`，方法与 4.3 一一对应，类型从 `@dsh-mesh/plugin/types` 导出。本仓库的 `orb-host` 用它给 helper 的 Mesh 窗口转发；手机仓库用不到。

### 4.5 模型工具

- `device_agent` / `device_agent_status` / `device_agent_stop` 的参数与返回值以 17 第 4.5 节为准，属于约定 v1。
- persona 由消费方写：本仓库写在 `preset-computer-use`，手机仓库写在 `orb-phone`。工具名或返回字段变了，两边 persona 都要跟着改，所以也属于冻结范围。

### 4.6 版本兼容

| 版本号 | 在哪 | 规则 |
|---|---|---|
| `meshApi` | 服务器 `/health`、插件常量 | 服务器与插件不一致时，配对与连接都返回 `server_incompatible`；v0 期间服务器和插件同版本部署 |
| `/.dsh-mesh/v1` | 本机接口路径 | 只加字段不升版本；删字段或改含义开 `v2`，`v1` 保留一个版本 |
| 配对串 `v` | 配对串 | 同上 |

---

## 5. 各仓库怎么独立开发

| 仓库 | 不依赖别人就能做的 | 需要 `dsh-mesh` 哪个版本 |
|---|---|---|
| `dsh-mesh` | 全部：用本机 Docker 起服务器，起多个 DSH profile 当多台设备（17 B0 第 7 步的做法） | — |
| `dsh-orb-cordis` | 设置页「互联」板块、Mesh 窗口、审批卡、persona：先接 R0 的假数据模式 | 真配对要 R1，真树和会话要 R2，派任务和审批要 R3 |
| `dsh-orb-android` | A0–A4 全部（悬浮球、截图、精简工具集、后台），完全不涉及互联 | 互联页先接 R0 假数据；A5 要 R3 |

**假数据模式**（`mock: true`，R0 就有）：

- 本机接口全部可用。
- 返回 3 个假节点，每个节点 2 个工作区、若干会话；其中 1 个节点每 60 秒上下线一次。
- `/events` 与 `/stream` 按固定脚本产生一轮对话，中间触发一次审批；长轮询按 `since` 分批返回。
- `pair` 按配对码返回固定结果，契约测试和界面都能稳定复现：`TESTPAIR` 成功；`BADCODE1` → `code_invalid`；`USEDCODE` → `code_used`；`OLDCODE1` → `code_expired`；`SLOWDOWN` → `rate_limited`；`NAMETAKE` → 成功并带 `name_taken` 警告；地址填 `unreachable.test` → `unreachable`；指纹填 43 个 `A` → `fingerprint_mismatch`。
- 两个端的界面代码写一次，切换真实模式时只改 `mock: false`。

**开发用服务器**：`dsh-mesh/deploy/dev/compose.yaml` 在本机起服务器、自签证书和管理页，并打印一条可用的配对串。电脑和手机开发者不用碰阿里云。手机在局域网里填电脑的 IP；模拟器填 `10.0.2.2`。

---

## 6. 三个仓库同时开工

三个仓库**从第一天起并行**，谁都不等谁开工。之间只靠第 4 节的约定对接，约定以本文为准，从现在起就算冻结（R0 只是把它做成可运行的包）。

| 阶段 | `dsh-mesh` | `dsh-orb-cordis`（本仓库） | `dsh-orb-android` |
|---|---|---|---|
| **第一天起** | B0 实验；服务端改造（配对码、节点、多连接、心跳、证书固定） | 照第 4.3 节写设置板块与 Mesh 窗口，先用本仓库内的静态假数据（按第 4.3 节的响应形状写 JSON） | A0–A4：悬浮球、录音、截图、精简工具集、后台，完全不涉及互联；Dart 侧本机引擎 HTTP 客户端 |
| **R0 发布后** | 继续 R1 | 把静态假数据换成插件的 `mock: true`，界面代码不变 | 引擎打包插件（`mock: true`），互联页接假数据 |
| **R1 发布后** | 继续 R2、R3 | 设置板块切真实模式，2 台电脑「填入即互联」（第一段） | 手机「填入即互联」 |
| **R2 / R3 发布后** | 硬化、修 bug | Mesh 窗口、派任务接真实数据，跑 16 第 7.1.1 节；审批接真实数据后跑 7.1.2 | A5 入网；跑 16 第 7.3 节 |

- **只有一种情况要回头改别的仓库**：第 4 节的约定本身要变。这时只在 `dsh-mesh` 改约定文档并升版本，另外两个仓库按 CHANGELOG 跟进，不允许在消费方仓库里私自兼容。
- **人手分配**：三个人各管一个仓库最顺；两个人时，一人管 `dsh-mesh`，另一人在电脑界面与手机悬浮球之间切换（手机 A0–A4 不依赖任何人）。

### 6.1 发布节奏与集成点

| `dsh-mesh` 版本 | 内容 | 对应 17 | 解锁 |
|---|---|---|---|
| **R0** | 插件骨架在电脑 DSH 和手机 PRoot 里都能加载；本机接口 v1 全部在假数据模式下可用 | 与 B0 同时做，尽早发 | 两端从静态假数据换成插件的假数据模式 |
| **R1** | 服务器可部署；配对串、`pair` / `unpair` / `status` / `nodes` / `name` 真实可用；多连接（含客户端同时连多个 Host，4.4 的实验在 B0 做完）；证书固定；心跳 | B1 | **两端「填入即互联」可以真测**；手机 6.5 第 1 步 |
| **R2** | 设备树、会话只读与实时流 | B2 的互联核心部分 | 第一段 M1；手机互联页的树与会话 |
| **R3** | 任务会话输入/停止、`device_agent`、文件回传、远程工具拦截；审批/提问 | B3、B4 的互联核心部分（审批属第二段） | 第一段 M2；第二段审批；手机 6.5 第 2 步与 A5 |

集成点只有两处，都在消费方仓库里：

- **本仓库**：升级 `packages/bundle` 里锁定的 tgz → 跑 `bundle/tests/install.test.mjs` → 在 2 台电脑上跑 16 第 7.1.1 节，再加第三台跑 7.1.2。
- **手机仓库**：升级 runtime 锁文件 → 重建引擎 → 跑 17 第 6.5 节的前置验证 → 跑 16 第 7.3 节。

---

## 7. 各仓库的验收

| 仓库 | 自己的验收 | 跨仓库验收 |
|---|---|---|
| `dsh-mesh` | 17 第 3.3 节 8 条；契约测试真实/假数据两种模式都通过；用 2 个 DSH profile 跑通配对、树、派任务（3 台在第二段） | — |
| `dsh-orb-cordis` | 设置板块与 Mesh 窗口在假数据下完成全部交互；`bundle` 安装测试包含 `@dsh-mesh/plugin` | 第一段：16 第 7.1.1 节 8 条（两台电脑）；第二段：16 第 7.1.2 节 13 条（3 台） |
| `dsh-orb-android` | 16 第 7.2 节 7 条；互联页在假数据下完成全部交互 | 16 第 7.3 节 6 条（5 台） |

**「填入即互联」单独验一次**（16 第 7.1.1 节第 1 条、第 7.3 节第 1 条）：

- 设备是全新安装，`~/.dsh/dsh-mesh/` 不存在。
- 只在设置页粘贴配对串、点「连接」。
- 不改任何配置文件，不重启。
- 15 秒内显示已连接和其他设备。
- 用错误的指纹、用过的码、过期的码各试一次，提示与第 3.2 节的表一致。

---

## 8. 证书：不能用 Caddy 的自动内部证书

- Caddy 的 `tls internal` 会自动签发短期证书并定期轮换，私钥也跟着换，固定的指纹会频繁失效。
- 改为一次性生成自签证书：10 年有效，SAN 写服务器 IP；Caddy 用 `tls /certs/cert.pem /certs/key.pem` 加载。`deploy/` 提供生成脚本，同时输出 SPKI 指纹。
- 服务器从同一个证书文件计算指纹，管理页生成配对串时带上。
- 以后若换成公开 IP 证书（17 Q1），续期时沿用同一把私钥，指纹不变。

---

## 9. 开仓步骤

1. 两个仓库已建好，本地在 `dsh-orb-all` 下，`upstream` 跟踪原仓库，`origin` 是自己的仓库：
   - https://github.com/mini-yifan/dsh-mesh （上游 liguobao/ds-harness-remote）
   - https://github.com/mini-yifan/dsh-orb-android （上游 ccch1mneyyy/dsh-Go）
2. `dsh-mesh` 中：
   - 约定已写入 `docs/contract-v1.md`，**以后以那一份为准**，本文第 3、4 节只作总览；
   - 还没做：把插件包名改为 `@dsh-mesh/plugin`，身份目录改为 `~/.dsh/dsh-mesh/`；加 `packages/mesh`、`packages/mesh-plugin`、`deploy/`、`tests/contract/`。
3. `dsh-orb-android` 中：
   - 17 第 5、6 节和 16 第 7.2、7.3 节已复制为 `docs/v0-phone-orb.md`、`docs/v0-acceptance.md`；
   - 还没做：改应用名、包名与图标（17 Q7）。
4. 本仓库保留 14–19 号文档作为总计划（19 是产品决策记录，冲突时以它为准）；电脑端的实现细节继续写在 17 第 4 节。
