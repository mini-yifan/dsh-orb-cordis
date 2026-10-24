# 修订记录

> 2026-09-28 对照源码和本机官方预览之后，对初版分析的修改。实施不要以本文的旧结论为准；规格在 [01-analysis.md](01-analysis.md)、[02-architecture.md](02-architecture.md)、[03-plan.md](03-plan.md)。
>
> 初版分析的日期也是 2026-09-28。下面「保留」的条目已经写进新的三份规格。「改掉」的条目不要再实现。

## 1. 保留并写进规格的

这些和源码一致，新文档直接采用了。

- Host 以 `ELECTRON_RUN_AS_NODE=1` 启动，插件进程里没有 `electron` 模块。
- 用户安装单位是带 `dsh.bundle.patch` 的 bundle。`dsh plugin add` 有 registry、绝对路径、tarball、git 四种 spec。
- 官方 CLI 不能管理 `desktop` profile。桌面安装走应用内插件页，`desktopPnpm.runExternalMarketPluginInstall` 存在。
- `tool-computer-use` 是 `"private": true`，要改名再发布。13 个 GUI 工具、`code_agent` 的 `whenIdle` + `followup`、可选的 `orbCodeAgentModel` / `orbCoordinateMode` 都属实。
- `floating.js` 除了 fetch，还有 `window.dshDesktop`。preload 必须在 helper 里复刻，否则页面第一行就没有 API。
- `ui-settings-orb` 在官方主窗口拿不到 `dshDesktop.orb`，会静默隐藏。数据面改 HTTP。
- `orb-agent-models.ts` 和壳侧 `orb-permission.ts` 要搬进 Host，不能只搬 desktop-host 里那几个被动服务。
- 依赖必须钉住官方发布版本。初版分析记录的 dist-tag 现象仍然有效：`latest` 偏旧，新版本在 `next`。编译对照的版本是 `0.1.7-rc.2`。安装范围是 `>=0.1.7-rc.2 <0.3.0-0`，不包含 `0.3.0` 的预发布版。
- Windows Computer Use 用 koffi 调系统 DLL，没有单独的预编译产物。划词的预编译工作主要在 macOS。
- 行数：`floating-window.ts` 961、`floating.js` 1448、`preload.ts` 88、`orb-agent-models.ts` 102，以及初版分析列出的其它文件行数，在当前 fork HEAD 上仍然相符。`api.floating` 31 处、`api.backend` 2 处、`api.locale` 1 处，也相符。

## 2. 改掉的

### 2.1 helper 运行时

初版分析把「spawn 官方 `process.execPath`，去掉 `ELECTRON_RUN_AS_NODE`，把我们的入口脚本喂进去」写成已经核实的主路径，下载 Electron 只是失败后的兜底。

源码只证明 Host 是用官方可执行文件以 Node 模式拉起的。已打包的 Electron 启动自己的 `app.asar`，额外参数不会换成另一份 main。官方 `single-instance.ts` 在拿不到锁时直接 `quit`。桌面版和 `dsh web` 的 helper 都使用下载的通用 Electron。`DSH_ORB_ELECTRON_PATH` 只给开发。

### 2.2 紧凑聊天

初版分析打算原样 vendor `ui-overlay-chat`，并让球的 iframe 打开 `index.html?surface=overlay`。

官方 `ui-layout` 总会注册 `root`。fork 能让出这个槽，是因为它改了官方包 `packages/client/ui-layout`，并在 `packages/api/session-controller` 里新增了 `overlayClientSurface`。官方 `0.1.7-rc.2` 没有这个导出。再注册同一个 `root` 会抛错；若 client 包去 import 不存在的导出，还可能让整个 Web UI 加载失败。

对话 UI 做在 helper 里。不修改、不替换官方 `ui-layout`。

### 2.3 preset 的两条通道

初版分析要求同时插入 `dsh-agent-preset` 行，以及 `agent-presets` + `computerUsePresetRoot` 目录。依据是 `apps/desktop-host/tests/overlay.spec.ts` 和 `apps/desktop-host/config/desktop.cordis.patch.yml`。

该 yml 不在当前 HEAD 里。官方 preset 注册表读的是声明行上的 `name`、`description`、`order`、`plugins`。旧的 `$DSH_HOME/.agent-presets/` 目录不再被读取。`preset-root.ts` 不进入发布物。显示名「Computer Use 模式」写在声明的 `config.name` 上。

### 2.4 `dsh-app://` 与 `listen: false`

初版分析把自定义 scheme、`listen: false`、`desktop-fetch.ts` 说成 fork 独有，并说官方桌面只提供 loopback。

官方壳同样注册了 `dsh-app`，并用 `forwardWebRequest` 转到 Host 的 loopback。`desktop-fetch.ts` 在当前 fork 里只被自己的测试引用。官方和当前 fork 的桌面 Host 都在听 TCP，并发送 `ctx.connection.authenticatedUrl(...)`。规格采用这条官方基址。helper 可以自己再注册一个 `dsh-app` 做转发，那是为了少改 `floating.js`，不是因为官方没有 scheme。

### 2.5 打开主窗口

初版分析写官方没有 URL scheme。官方 `main.ts` 在打包应用里调用 `setAsDefaultProtocolClient('dsh')`，`dsh://open` 会聚焦主窗口。macOS 用 `open dsh://open`。

### 2.6 原生模块被签名拦住

初版分析把「官方 Desktop 的 library validation 可能拦住 koffi 和 dylib」列为低到中风险，并要求阶段 1 第一天在官方桌面上实测。

2026-09-28 已在 `/Applications/DeepSeek Harness.app` `0.1.7-rc.2` 上实测：

- `codesign` 显示 hardened runtime，且 `com.apple.security.cs.disable-library-validation` 为真。团队 ID `NAN929V4UM`。
- 该可执行文件在 `ELECTRON_RUN_AS_NODE=1` 下加载了 koffi、ad-hoc 的 `libmacos-sck-capture.dylib` 和 ad-hoc 的 `macos-sck-napi.node`。
- 同一进程执行 `screencapture` 得到 160×160 PNG；执行 `osascript` 读到前台应用名。
- 同一进程调用 ScreenCaptureKit napi 的 `capture()` 超过 30 秒无输出，进程已结束。这不是签名拒绝，是 Node 模式没有 Cocoa 主循环，而 dylib 在等主队列。

因此 Mac 上「装了插件却完全不能 Computer Use」不成立。规格改为：常规截图和点击继续走子进程；采集排除放在 helper 窗口上。

### 2.7 计数

初版分析把 client 插件从 70 改成 71。按 `packages/` 里带 `dsh.client` 的包计算，官方 `master` 是 68 个，fork 另加 `ui-overlay-chat` 和 `ui-settings-orb`，合计 70。这个数字不参与实现。真实 bundle（去掉 `@local` 模板和测试 fixture）仍是 11 个，这一点保留。

## 3. 产品决定

这些是审核时一起定下来的，初版分析里没有写清楚。

- 用户只安装 `dsh-orb` 一个插件，就同时得到 preset 和悬浮球。
- 球跟着官方 dsh 进程。菜单是「停用悬浮球」，不是退出整个官方应用。
- 权限弹窗上的名字用官方应用或终端，引导文案照实写。
- Linux 不建球。
- 不把「等官方合并一个建窗 API」放进计划。

## 4. 截图必须带鼠标(2026-09-30)

Agent 执行期间看不到光标:点偏了无法自查,会误判为「点了没反应」。规格补一条:鼠标在采集范围内就必须出现在截图里,范围外可不管。两条采集路径都改:

- 常规路径(生产唯一路径,排除表恒空):`screencapture -x` 加 `-C`,由 WindowServer 把系统光标原位烤进全屏图,sips 裁剪后光标随裁剪保留。本机 macOS 26 实测光标位置与真实指针一致。
- SCK helper 路径(CLI 与 dylib 共用):`SCScreenshotManager` 的 `showsCursor` 在各版本上表现不一且窗口滤镜根本不含光标层,改为 `showsCursor = false` + 捕获后手动合成:SkyLight `CGSCopyCursor`(macOS 26 已无此符号,回落 `NSCursor.currentSystem`)取真实光标位图,再画一圈红底白边的定位环,环心即指针精确位置——热点换算按返回 CGImage 的实际倍率(`representations.first` 可能低于实际返回的倍率,曾导致尖端偏 5pt)。指针在区域外(留 12pt 边距)则原图返回,光标隐藏时不画,避免幻影。

合成逻辑带 `-D DSH_SCK_COMPOSITE_TEST` 独立测试入口(合成 2x 位图实拍验证尖端与环心重合)。本机 SCK 的内容枚举拿不到 displays 且流启动失败(macOS 26 环境先在问题),region 路径端到端仍以实机为准;Windows 的 GDI `capturePng` 同样不含光标,留待后续(已解决,见第 10 节)。

## 5. Agent 执行期间遮蔽悬浮球(2026-09-30)

对齐原版 deepseek-harness 的 overlay guard 语义:悬浮球平时可被截图/录屏(用户手动截图照常含球),但 Agent 自己的采集里必须看不到自家 chrome——否则球进观察图,Agent 可能对着球点击。覆盖球、划词工具条、观察框三个窗口,Windows 与 macOS 一致生效。

- helper 侧(packages/helper/src/cloak.ts + overlays.ts):refcount 遮蔽,`capture`/`input` 两个计数,任一 >0 即对所有 chrome 窗口 `setContentProtection(true)`;计数归零恢复常开状态。input 区间额外把球设为点击穿透(`setIgnoreMouseEvents(true, {forward:false})` + `blur`),让 CGEvent/SendInput 落到下层应用。观察框在 Windows 保留静止态保护(原版 observation-frame-window 同款,它停在观察区外围整轮可见)。新增 `overlay-capture {id, active}` socket 消息,与 `overlay-input` 对称;helper 随 host 断连退出,计数不跨进程存活,无需 reset 管道。
- host 侧(packages/host/src/overlay-guard.ts):`withCapture` 从直通改为真握手——depth 0 且 helper 在线时发 `overlay-capture begin`,等 ack 后再等 50ms(保护开关到达 WindowServer/WDA 的裕量)才放行采集,finally 补发 end(失败吞掉,helper 重启自愈)。input 区间内的嵌套 capture 不再发消息:整个 HID burst 期间保护本来就由 input 计数持有,省两次往返和 settle。
- 平台差异说明:原版 macOS 靠 SCK 按 CGWindowID 排除、Windows 靠 WDA_EXCLUDEFROMCAPTURE;本 fork 的采集路径是 `screencapture -x -C`(无法按 id 排除),故 macOS 也走动态 NSWindowSharingNone——效果与原版一致(采集瞬间从截图中消失,物理屏幕始终可见),但用户录屏时球会在每次 Agent 采集的几百毫秒里短暂消失,Windows 原版本就如此。
- 球窗口创建时的两处常开 `setContentProtection` 与工具条的一处已删除:静止态必须可被截取,开关全权归遮蔽。
- 测试:helper/tests/cloak.test.ts(静止态/区间开关/穿透/refcount 嵌套/窗口销毁容错/reset),host/tests/selection.test.ts 改写 overlay guard 组(capture 握手、无 helper 直通、input 内嵌套不发、失败仍补 end)。

补丁(同日):实测点击仍会落在球上——`setIgnoreMouseEvents` 设置后 WindowServer 的命中测试要过几十毫秒才提交,而 helper 应用完立即回 ack,Agent 的 CGEvent/SendInput 与这个提交赛跑。原版 `floating-window.ts` 的 `OVERLAY_GUARD_INPUT_APPLY_MS = 80` 就是为此存在("Milliseconds Electron waits after click-through before acking input begin, so WindowServer hit-testing has committed"),fork 从未移植。现补上:cloak.ts 新增 `scheduleCloakAck`,input-begin 的 ack 延迟 80ms 再回(从应用点击穿透那一刻起算;helper 繁忙时 timer 晚触发则裕量自动拉长),ack 到达即 host 放行 HID 的信号——时序与原版 helper 侧延迟完全一致;capture 区间与 input-end 仍立即回 ack。这个裕量是平台无关的,Windows(SendInput)与 macOS(CGEventPost)同样生效。

## 6. 悬浮球文字可选中复制 + 消息复制按钮与 Token 用量(2026-09-30)

对齐主窗口 chat 语义:悬浮球展开框里的对话内容此前全局 `user-select: none`,一个字都选不中,也没有任何复制入口。

- 可选中:`floating.css` 保持 html/body 全局 none(球/工具条等 chrome 不受拖选干扰),`#transcript` 单独放开 `user-select: text`,`#transcript button` 再收回 none;helper 的 `context-menu` 在 `params.hasSelection` 时放行系统菜单(Copy),裸右键仍是球自身菜单,与 `isEditable` 同一处理。
- 消息动作行(官方 MessageIconActions 的极简版,无 Fork/点赞/点踩):用户气泡下方右对齐一个复制图标按钮,复制气泡原文;assistant 回复下方一个复制图标按钮(复制原始 markdown,经 WeakMap 随 upsert 更新)+ Token 用量 pill。流式期间动作行隐藏,落定后出现;折叠语义不破坏(动作行在 block 内,随 `data-response` 折叠)。
- Token 用量:官方 `assistant/message` 事件本就带 `usage?: TokenUsage`(dsh-session 事件表),host 在 `onAssistant` 落定时把 usage 挂到该消息最后一个 assistant 块上单独再广播一条(推理块不带);`block()` 合并语义为「带 usage 即替换、不带则保留前值」,消息降级(response 反标记)与 finishTurn settleBlock 都经同一合并,usage 不丢。渲染端 pill 文案 `{count} tok`、总计 = 未缓存输入 + 缓存读 + 缓存写 + 输出(官方 UsagePill 的 billed 口径,不信 provider total),缩放格式与官方 formatTokens 一致(999 → `999`,1234 → `1.2K`,≥1M → `1.2M`),悬停 title「本轮用量」/「Turn usage」。
- 复制实现抽出 `writeClipboard`(navigator.clipboard 优先,execCommand 回落),卡内代码块复制与消息复制共用;消息按钮复制成功后图标换勾 1.2s。
- 新增 COPY/CHECK 两个 16px current-color 图标(icons.js)。测试:transcript-model 组补 tokenUsageTotal/formatTokenCount/usageLabels 与页面接线断言,host runtime 组新增「usage 只落在收尾回复块」用例(含降级保留)。Electron 44 冒烟实测:气泡/正文 computed user-select=text,动作行与用量 pill 正常渲染。

## 7. 悬浮球外观与语言跟随主窗口(2026-09-30)

球窗口、划词工具条与主窗口设置页此前不跟随官方「外观/语言」设置:CSS 的暗色 token 都在(键 `body[data-ds-dark-theme]`,从上游搬来),但页面只按系统 `prefers-color-scheme` 点亮;文案则各自读 `navigator.language`——系统英文 + dsh 设中文时,主窗口全中文、悬浮球设置页却是英文。现在两边都镜像官方设置文档(`ui-theme.preference`、`locale.preference`):

- host(packages/host/src/appearance.ts):经官方 `settings` 服务 `describe()` 读两个命名空间,订阅 `settings/document-updated`(cordis `emit` 无 thisArg 时全量投递,普通 `ctx.on` 即可收到);变化经 `setAppearance()` 存进 OrbRuntime 并广播 `appearance {theme, locale}` socket 消息,helper 连上时 `accept()` 补发,`launch()` 再把当前值塞进 `DSH_ORB_APPEARANCE` 环境变量——启动即正确,不等 socket 握手。
- helper 主进程:`nativeTheme.themeSource` 指到存储的偏好(`system`/缺省回落系统),renderer 的 `prefers-color-scheme` 随之而动(与官方 preload-theme 同机制),`updated` 事件(含 OS 换肤)把解析后的 `{dark, locale}` 推给球与工具条;原生菜单和千分比弹窗文案改读镜像语言(存储偏好 zh/en 前缀命中,否则按系统语言,与官方 detectBrowserLocale 的回落次序一致)。工具条窗口的转发走 overlays.ts 新增的 `appearance()` 方法。
- 球页面(shell.js):`messages`/`chatLabels`/`usageText` 改为可变,appearance 消息触发 `refreshAllText()`——静态文案收进 `applyStaticText()`(自查询,避免 TDZ),权限菜单/历史列表/进行中的提问卡/TCC 门(存最近一次状态)/过程组标签全部按新字典重绘,transcript 按 `blockData`(每个 block key 的最后一条消息)重跑 updateToolNode/updateAssistantNode,已渲染块的语言即时切换。`removeBlock`/`clearTranscript` 同步清理 blockData。
- 划词工具条:CSS 补 `body[data-ds-dark-theme]` 暗色变量(取值同球壳 floating.css),标签文案改走 `applyUiLanguage`,暗色与语言都经 `orb:appearance` 推送,matchMedia 作连接前的回落。观察框无文字,不动。
- 设置页(client-settings/client.js):`copy()` 改读 `<html lang>`(dsh-client-locale 会把解析后的语言落在上面,`zh-CN`),回落 navigator;组件挂 MutationObserver 重渲染,设置节随主窗口语言即时切换。开关配色改用官方 token(`--dsw-static-neutral-bluish-00` 滑块、`--dsw-alias-button-info-fill` 开态),明暗两态都成立。
- 测试:host/tests/appearance.test.ts(读取、缺省、事件过滤、去重、服务缺失),runtime 组新增「appearance 握手补发与变更推送」;设置页测试补「跟随 <html lang>」用例。Electron runtime 冒烟(.zcode/smoke/):真实 preload 通道灌 appearance,球页 zh↔en 切换(标题/占位/aria)、nativeTheme dark→body 属性 + 面板底色 rgb(255,255,255)→rgb(21,21,23)、工具条文案与暗色背景,SMOKE-PASS。

补丁（同日）：真机上复制按钮点了没反应——球是 `showInactive` 的非激活 panel，点击时 `document.hasFocus()` 为 false，Chromium 的 `navigator.clipboard.writeText` 直接 reject（"Document is not focused"），而回落只在 API 不存在时触发，被拒绝即静默返回。改走主进程：preload 新增 `copy(text)`（`orb:copy`，ipcRenderer.send），helper main 收到后 `clipboard.writeText`（fromBall 校验 + 100 万字符上限）——主进程写剪贴板不依赖文档焦点。`writeClipboard` 优先走桥，navigator.clipboard/execCommand 保留为无 preload 时的回落；代码块卡片的复制按钮同路径一并修好（此前同病）。Electron 44 冒烟：点击两个消息复制按钮，`pbpaste` 读回的正是所复制的正文。

## 8. 划词功能全面下线(2026-09-30)

划词功能存在 bug,先从所有 UI 撤下并全局关闭,代码保留待修复后再放开:

- 右键菜单(packages/helper/src/menu.ts):删掉「划词工具栏」复选框项,`ContextMenuState.selectionEnabled` 与 `ContextMenuActions.setSelection` 一并移除;helper main.ts 的 `ChromeState`/`readChrome`/`showMenu` 同步删字段。
- 设置页(packages/client-settings/client.js):删掉「划词工具栏」卡片、「划词不可用」横幅与 zh/en 四条 selection 文案。
- 强制关闭(packages/host/src/preferences.ts):`readSelection` 不再读 `selection-toolbar.json` 里的 `enabled`,恒返回 `false`——默认与已开启过的 profile 全部落到关闭态;文件里的 `translateTargetLanguage` 仍读取。socket `set-selection` 与 `POST /.dsh-orb/selection` API 保留但无 UI 入口,写入值重启后被忽略。
- chrome 广播(orb.ts `publishChrome`)不再携带 `selectionEnabled`(helper 已不读)。
- 测试:menu 组更新菜单项列表与索引;preferences 组断言默认 false 且已存 `enabled: true` 的文件读回 false;runtime 组 set-selection 用例改发 `enabled: true` 验证 socket 写路径(默认已 false,原用例 waitFor 瞬时通过导致文件未落盘 ENOENT);设置页组改为反向断言 client.js 源码不含「划词」/`selectionToggle`。222 项全过,`pnpm build` 装配后 bundle/helper 产物无「划词」字样。

## 9. 悬浮球内置动图头像(2026-09-30)

头像此前只有「上传一张」和「恢复默认」两个选择。现在设置页给出 6 张内置动图,点一下即换,上传与恢复默认照旧;内置资源是真动画 GIF,在设置页缩略图和球上都照常播放。

- 资源(`packages/helper/assets/avatars/`):6 张 512×512 / 45–51 帧 / 3.0–3.4s 的源动图按 256×256 重编码(ffmpeg `scale=256:256` + `palettegen`/`paletteuse`,`-loop 0`,帧数与逐帧延时原样保留),单张 1.9–2.5 MB,合计约 12 MB(原图 39 MB)。球是 72px,256 在 3x 屏上仍有余量;`point`/`rice`/`heart`/`cheer`/`cheeks`/`smile` 对应指点/干饭/比心/欢呼/托腮/微笑。
- 分发路径:内置 GIF 不走 socket 也不走 data URL——球页面按相对路径 `avatars/<file>.gif` 自己读盘(helper 的 `fetchAvatar` 有 2.5 MB 上限,兆级 GIF 走那条路必然失败,且 base64 会卡住每次 chrome 广播)。host 只发描述:`{type:'avatar', kind:'preset', src:'avatars/heart.gif', version}`,上传仍是 `kind:'custom'`(走原 HTTP 取字节 → data URL),默认是 `kind:'default'`。helper 侧新增 `packages/helper/src/avatar.ts` 专职解析,`src` 只接受 `^[a-z0-9][a-z0-9_-]*(/[a-z0-9_-]+)*\.gif$`(挡掉父目录跳转与 `file:` 等 scheme),不合法即回落默认。球页面(shell.js)不用改:`onAvatar` 本来就接受相对路径。
- 存储(packages/host/src/preferences.ts):`orb-avatar.json` 升为单一事实源,`{kind:'preset', preset}` 选内置、`{kind:'custom', mime}` 上传、旧版只有 `{mime}` 的文件仍按上传读。`avatarSelection()` 每次都对磁盘现状校验,未知 preset id(插件降级/资源被删)或半写状态一律回落自带 GIF。一个 profile 只有一张头像:上传会覆盖 preset 选择,选 preset 会删掉上传的字节。`avatarVersion()` 从 `orb-avatar` 的 mtime 改为 `orb-avatar.json` 优先(preset 只写 meta,版本必须跟着动),浏览器预览与球的重取都以此为缓存键。
- 路由(packages/host/src/routes.ts):新增 `GET/.dsh-orb/avatar/preset/<id>`(设置页画廊取字节,未知 id 404,不走 helper token 旁路)与 `POST /.dsh-orb/avatar/preset {preset}`(400 invalid-preset);`GET /.dsh-orb/avatar` 现在按当前选择返回内置/上传/自带三选一。快照新增 `avatarPresetId`(当前选中的 id)与 `avatarPresets[]`(id + url);画廊 URL 不带 `?v=`,否则任一次头像变动都会让设置页重取 6 张兆级 GIF。目录清单在 `packages/host/src/avatar-presets.ts`,相对路径由 host 生成,因此路径布局只此一处;id → 文案的字典在设置页(client.js `avatarPresetNames`),host 不持有 UI 文案。
- 设置页:头像卡片在上传/恢复默认下面多一排动图缩略图(48px 圆形,自带预览 72px),选中项描边用官方 `--dsh-alias-button-info-fill`,点击 POST 选,`aria-pressed` 跟随快照;`avatarPresets` 缺失时整排不渲染(老 host 不会画出空框)。
- 测试:helper 新增 avatar 组(src 合法性、custom 需要 version、旧消息回落);host preferences 组补「一个 profile 一张头像」全流程(选/传互斥、未知 id、半写状态、旧 meta);routes 组补画廊列表、字节、鉴权、目录穿越、选中后 `/avatar` 返回同一份字节、非法 id 400;runtime 组补「连上即发 avatar 描述、选 preset 后带 src」;设置页组按 host 真清单渲染画廊并断言每个 id 都有中文名(host 加 preset 而设置页漏文案会直接红)、点击 POST 的 body、选中描边;bundle 装配清单改为遍历 `assets/avatars/` 全量断言。`pnpm typecheck` 与全量测试通过。
- Electron 冒烟(`.zcode/smoke/orb-avatar-smoke.cjs`,装配后的 `dist/helper/assets`):按生产通道灌 `orb:avatar` 字符串,断言内置 GIF 在真实 CSP 下解码成功(256×256)、静止态照旧冻结成 still(canvas 快照,256×256)、展开/运行时球面真的在动——用 `capturePage` 对球的矩形连续取帧,静止态 4 帧完全相同(排除重绘伪影的对照),播放态 8 帧帧帧不同;灌 `''` 后回到自带 512×512 头像。SMOKE-PASS。冻结首帧是 fork 既有语义(离线省电),内置动图与自带头像行为一致:静止收起时定格首帧,展开/运行/提问时播放。

## 10. Windows 球抢焦点:排除自身窗口、提交后交还前台、截图补光标(2026-09-30)

Windows 上的实测反馈:在浏览器里点球、输入、回车提交后,**Agent 把悬浮球自己当成了"用户正在使用的应用"**——观察边框照着球画。根因两条,叠加才发作:

- Windows 上球是可激活的普通窗口(`packages/helper/src/main.ts`:`focusable: true`,`type: 'panel'` 只在 darwin 设置),点它就把系统前台抢过去,`GetForegroundWindow` 当场变成球的面板。
- 选观察窗口的逻辑本来就会跳过 overlay —— 但那条排除列表**从没接线**:`packages/host/src/overlay-guard.ts` 里 `withCapture` 一直硬编码 `run({ excludeWindowIds: [] })`。macOS 不需要它(非激活 panel 从不当前台),所以这个缺口一直没暴露;接到 Windows 就表现为"跳过列表为空 → 前台是谁就认谁 → 认成球"。

三处修复,全部按 `win32` 门控,macOS 路径与行为不变。

- **排除自身窗口(主修复)**:helper 新增 `packages/helper/src/chrome-windows.ts`——`windowIdFromHandle(buffer)` 把 Electron 的原生句柄转成与 host 侧 `hwndId()` 同一个数值(指针宽度 → `Number(BigUInt64)`,要求安全整数;两边对不上排除就是空转),`collectChromeWindowIds()` 仅 win32 产出。socket 连上、发完 `hello` 后追加一条 `{type:'chrome-windows', ids:[球,工具条,观察边框]}`(断线重连会重发;窗口是进程级单例,不需要变更推送)。host 侧 `orb.ts` 新增校验(`readWindowIds`:正整数安全整数、≤16 条、**任一条不合法即整条丢弃**,宁可退回"不排除"也不做半份排除)并按 socket 存,`chromeWindowIds()` 取并集,guard transport 新增 `chromeWindowIds?()`,`withCapture` 的两个分支都填入 `run({ excludeWindowIds })`。顺带修掉一个隐藏缺口:HID 区间内的嵌套采集此前恒拿空数组,也就是"点击动作之后的那张复采"仍会认错窗口——现在同样带着排除表。macOS 侧 helper 不上报 → 列表恒空 → 与原行为逐字节一致。
- **提交后交还前台**:host 新增 `packages/host/src/windows-foreground.ts`(win32-only,koffi 惰性 `createRequire`,与 `tcc.ts` 同一写法):250ms 采样 `GetForegroundWindow`,跳过 chrome 句柄,记住最后一个**非球**的前台窗口。`orb.ts` 在 helper 连上时 `start()`、断开与 `halt()` 时 `stop()`,并在 `onPrompt` 里、`sessionController.prompt` 之前 `restore()`——用与 computer-use `becomeForeground` 同款的 Alt + `SetForegroundWindow`(本进程没收到最后一次输入时 `SetForegroundWindow` 会被忽略,补一次 Alt 转移即可),保证早于 `agent/pre-step` 的首次采集;目标窗口已关闭则静默跳过。只在提交时触发,看历史/点菜单/收起面板都不动前台。
- **Windows 截图补鼠标光标**(补齐第 4 节的尾巴):macOS 生产路径是 `screencapture -x -C`,由 WindowServer 把真实光标原位烤进图;Windows 的 GDI `BitBlt` 不含光标层,于是 Agent 点偏了无法自查。新增 `packages/computer-use/src/cursor.ts`(纯函数:`cursorDrawPlacement` 按热点换算并留 12px 边界余量、指针更远则不画、光标隐藏不画、空/非有限值一律不画;`resolveCursorAlpha` 优先 alpha 通道、无 alpha 的旧式光标回落 AND mask;`compositeCursor` alpha 混合并裁剪;`flipRows` 行翻转)。`windows-native.ts` 的 `capturePng` 在 `BitBlt` 与 `GetDIBits` 之后合成:`GetCursorInfo`(`CURSOR_SHOWING`)+ `GetIconInfo`(热点 + 两个位图),`GetIconInfo` 交出的两个位图 `DeleteObject` 防 GDI 泄漏,新增 `DSH_CU_CURSORINFO`/`ICONINFO`/`BITMAP` 结构与 x64 布局断言;采集栅格改为翻转成 top-down 后 `encodeBgraPng(bottomUp=false)`。镜像的是 macOS 生产路径(真实光标、原位),不含 SCK 备用路径那圈红白定位环。
- 测试:computer-use 新增 `cursor.spec.ts` 14 例(热点定位、越界/边距、隐藏光标、DPI 缩放、alpha 混合、mask 回落、行翻转);helper 新增 `chrome-windows.test.ts` 4 例(8/4 字节句柄、0 与非安全整数、平台门控、句柄读取失败);host 新增 `overlay-guard.test.ts` 3 例(句柄流入两个分支、无 helper 时也排除、macOS 式空列表)与 `windows-foreground.test.ts` 4 例(记住用户窗口、忽略 chrome、持续采样与停止、原生调用抛错不致命);`runtime.test.ts` 新增 socket 级用例(上报 → guard 的 `excludeWindowIds`、畸形载荷整条丢弃,harness 补 `provide` 捕获与 overlay 自动 ack 以免等满 1s 超时)。新增 12 个 node:test 用例 + 14 个 vitest 用例,`pnpm typecheck`、`pnpm build` 通过;全量与改动前基线对照:新增用例全过,失败数不变(见下条)。
- **Windows 实机待验证(本仓库此前零 Windows 实测记录)**:① `getNativeWindowHandle()` 的 HWND 与 `listWindows().hwnd` 是否相等——这条不成立则排除列表空转,需临时打点核对;② `WDA_EXCLUDEFROMCAPTURE` 是否真把球挡在 GDI `BitBlt` 之外(第 5 节的遮蔽机制在 Windows 从未实测),若无效则加 win32 门控的兜底:采集区间直接隐藏 chrome 窗口;③ HID 期间点击穿透是否落在下层窗口、且不把球重新激活;④ 混合 DPI 多屏下光标位置与大小;⑤ 端到端:浏览器在前台 → 点球 → 输入 → 回车 → 观察边框围住浏览器、截图无球、光标可见、前台已交还。
- **Windows 上既有的测试失败(与本次改动无关,改动前后基线一致,均为环境性)**:`host/tests/preferences.test.ts` 与 `runtime.test.ts` 的 millifraction 用例(win32 默认千分比坐标,测试按 macOS 默认值写)、`client-settings` 的设置页用例(Windows 检出为 CRLF,测试正则按 LF 写)、`bundle` 的装配用例(`symlinkSync` 在 Windows 需要开发者模式/管理员,EPERM)。另 `computer-use` 的 `open.spec.ts`/`tools.spec.ts` 用 POSIX 路径(`/etc`)在 Windows 必失败——后者顺带暴露一个真实缺口:`open_in_finder` 的 `PATH_BLACKLIST` 只有 POSIX 前缀(`open.ts`),Windows 上 `C:\Windows` 这类路径不受护栏保护,且分隔符按 `/` 匹配,留待后续单独处理。

## 11. Windows 右键菜单「打开主窗口」没反应(2026-09-30)

现象:Windows 上悬浮球右键 → 打开主窗口,毫无反应;macOS 正常。排查与修复:

- **系统层没问题**:注册表里 `dsh` 协议注册正确(`"…\DeepSeek Harness.exe" "%1"`),在干净环境里 `cmd /c start "" dsh://open` 实测能把最小化的主窗口唤醒。
- **对照实验定位根因**:同一条命令加上 `ELECTRON_RUN_AS_NODE=1` 就完全没反应。host 正是以纯 Node 模式被官方应用拉起的,它 spawn 的 `cmd` 继承了这个标记,Windows 于是也以 Node 模式启动 `DeepSeek Harness.exe`——单实例转发根本没发生,自然不会弹窗。helper 启动早有同样处理(`orb.ts` 的 `delete env.ELECTRON_RUN_AS_NODE`,注释写明"保证 electron 当 app 跑"),打开主窗口这条路径此前漏了。
- **修复**(`packages/host/src/open-main.ts`):新增 `openEnvironment()`——复制环境并删掉 `ELECTRON_RUN_AS_NODE`,`spawnOpen` 用它作为子进程环境。macOS 走 `open`,由 LaunchServices 启动应用、拿不到这个环境,因此不受影响(该函数在 darwin 上是惰性的)。
- **验证**:真机在 `ELECTRON_RUN_AS_NODE=1` 下调用真实 `openMainWindow`,最小化的主窗口被唤醒并成为前台(`IsIconic=False`、前台窗口即主窗口);修复前同一条件无反应。
- **测试**:`host/tests/open-main.test.ts` 新增用例(删标记、保留其余变量、不改动调用方对象)。

## 12. 副屏窗口截图返回主屏画面(2026-10-08)

现象:双屏(主屏 MacBook 1470×956@2x + 副屏 1920×1080@1x,副屏在主屏正上方)下,让 Agent 操作副屏上的窗口——观察框彩带正确围住副屏窗口,但 Agent 收到的截图始终是**主屏**内容。

- **观察框正确、截图错误说明两者走了不同数据源**:彩带由 `screens[0].bounds`(CGWindow 全局点坐标)直接摆位,而截图像素来自另一条路径——所以问题只可能在采集。
- **根因(本机 macOS 26.4 实测)**:`screencapture` 不带 `-D`/`-R` 时**只写主屏**。实测 `screencapture -x -t jpg full.jpg` → 2940×1912(= 主屏 1470×956 的 2 倍图),与 `-D 1` 完全相同;`-D 2` 才是副屏的 1920×1080。而 `packages/computer-use/src/macos.ts` 的常规路径是「整屏 `screencapture` + `sips --cropOffset` 裁窗口矩形」,裁切坐标按 `bounds × 该窗口所在屏的 scale` 计算,并且 `Math.max(0, …)` 把负的原点直接抹平。副屏窗口(原点 -218,-1080)于是被裁成 `0,0,1920×1080`——正好是主屏左上角那一块,尺寸还恰好等于窗口尺寸,所以从尺寸上看不出异常。
- **修复**:常规路径改成 `screencapture -x -C -R x,y,w,h`(全局点坐标,与 CGWindow bounds 同一套 top-left 坐标系)。`-R` 由系统自己解析该矩形属于哪块显示器,并按那块显示器的像素倍率出图,负坐标、混合 DPI、副屏在主屏上方/左侧等布局一并解决;`sips` 两步走被删掉(少一次进程、少一次全屏 JPEG)。JXA 侧新增 `screenAt()`:在原有 `screenIndex()` 基础上多返回**翻转过 y 轴**的显示器 frame(`sy = primaryHeight - f.origin.y - f.size.height`),随窗口 JSON 以 `screen` 字段上报;`ScreenInfo.bounds` 在 `screenFromFrontmost` 里先与该 frame 求交——因为 `-R` 会丢弃显示器之外的部分,不裁的话彩带、栅格与 0–1000 点击映射会变成三个矩形。窗口完全不在该显示器上时不再上报 surface(`listScreens` 返回 `[]`,观察只剩 `<frontmost_app>` 标签),而不是让 `-R` 以 "does not intersect any displays" 失败并被包装成「缺少屏幕录制权限」。
- **`-R` 此前被误判为不可用**:旧注释写「`screencapture -R` fails on this OS」。本机复测:`-R -218,-1080,1920,1080` → 1920×1080(副屏,1x)、`-R 0,0,1470,956` → 2940×1912(主屏,2x)、`-R -218,-1080,400,300 -C` 正常出图;只有把坐标填成 Cocoa 左下原点(`-R 100,1000,400,300`、`-R -218,2036,…`)才会 `does not intersect any displays` 退出 1——那条注释大概率就是这么来的。
- **实测验证(真实前台窗口,只比对元数据与数值,不看画面内容)**:改动后 `listScreens()` 返回当前副屏全屏窗口 `bounds {-218,-1080,1920,1080} scale 1`,真实采集得到 1920×1080 的 JPEG。与 `screencapture -x -D 2`(系统认定的副屏)做灰度平均绝对差:新路径 **0.55**(两次实拍间的内容抖动),旧路径主屏裁切 **13.67**——数值上确认新路径拿到的就是副屏。随后前台换成主屏窗口(`bounds {0,33,1470,923} scale 2`)再采一次,得到 2940×1846,与 `bounds × scale` 完全一致。
- **顺带发现的第二个缺陷:`sips` 裁切会静默退化成整图**:窗口矩形贴近主屏右/下边缘时,`sips --cropOffset` 偶发不裁,而退出码仍是 0、不报错。合成图复现:2940×1912 输入 + `--cropOffset 66 0 -c 1846 2940` → 输出仍是 2940×1912(改成 `-c 1845 2940` 就正常出 2940×1845),同一命令在 400×300 输入上却正常;真实场景也命中过——主屏最大化窗口的旧路径产出的是整块主屏栅格(2940×1912),而 `bounds` 只是窗口矩形,画面与 0–1000 点击映射因此对不上。`-R` 一步出图后这条路径整体消失。
- **测试**:`tests/macos.spec.ts` 更新 3 例(单次 `-x -C -R` 调用、参数按逻辑点、`sips` 断言删除),新增 4 例:副屏负原点窗口保持全局坐标不被抹平、跨显示器边缘的窗口裁到显示器内、窗口完全落在显示器外时返回 `[]`、畸形 `screen` 字段退化为不裁切;JXA 断言补 `screenAt`/`found.screen`/y 轴翻转公式。`pnpm typecheck`、`pnpm build`、`pnpm test` 通过(仅剩两例环境性失败:本机沙箱不允许在 `$HOME` 建临时目录与写 `~/.npm` 缓存,把 `HOME`/`npm_config_cache` 指到工作区后全绿)。
- **装机**:构建产物已按最小面同步进实际加载的两处 profile(`~/.dsh/profiles/desktop/node_modules/dsh-orb/dist/computer-use`,桌面版正在用的 0.1.5;以及 `~/.dsh/profiles/web/…`),只替换 `dist/computer-use` 并删掉两个旧 chunk,`package.json` 版本不动——重启应用/`dsh web` 后生效;要让改动可持久复现(避免下次 `pnpm install` 还原成已发布的 0.1.5),仍需按 RELEASE 流程发 0.1.6。

## 13. 设置页加「更多动图」入口(2026-10-12)

内置动图固定 6 张,想换别的只能自己去外面找图再上传。设置页「内置动图」那一排的右边现在多一个「更多动图」链接,点开就是 [dshgif.hicp.fun](https://dshgif.hicp.fun/) 图库;在图库下载 GIF 后,照旧用上面的「选择图片」上传即可。

- 落地方式(packages/client-settings/client.js):链接就放在那排缩略图的剩余空间里,`margin-left: auto` 靠右、`align-self: center` 与缩略图垂直居中,12px、用主题信息色 `--dsw-alias-button-info-fill`(与选中描边同色)、悬停加下划线。它是 `<a href="https://dshgif.hicp.fun/" target="_blank" rel="noopener noreferrer">`,不是 `button` + `window.open`:桌面版主窗口的 `setWindowOpenHandler` 只把 `http(s)` 的 window open 交给 `shell.openExternal`,其余一律 deny——真链接正好命中这条通道,落到系统默认浏览器;在浏览器里打开设置页则是普通新标签。有 `href` 还顺带拿到中键点击、右键「在新标签页打开」与悬停状态栏。
- **尺寸是按实测定死的**:第一版把它做成第七个瓦片,结果被挤到第二行、很难看。量用户截图(1138×610,卡片 559px,内容宽 559−2−32=525px,6 个 72px 瓦片加 5×6px 间距占 462px)得剩余空间只有 **63px**,于是链接只留标签本身:12px × 4 字 = 48px,加 6px 间距正好落进那 63px;带 ↗ 箭头(+约 14px)或按 72px 瓦片排都会换行,这就是第一版翻车的原因。窗口再窄时它整体换行、由 `margin-left: auto` 靠右收尾,不会撑破排版。
- 与内置动图的关系:host 侧一行没动,仍只发 `avatarPresets`;URL 与文案都归设置页,纯客户端改动,老 host 配新 client 一样成立。画廊入口不看 `avatarPresets`:老 host 不发这一项时,整排不再整个不渲染,而是只留画廊入口(加 `is-alone` 取消 `margin-left: auto`,免得孤零零地贴右),并把「内置动图」标题一起省掉,此时那排改带 `aria-label`。入口不参与 `disabled`:fieldset 的 disabled 管不到 `<a>`,何况逛图库跟球在不在、有没有正在保存都无关。文案随 `<html lang>` 走 zh/en,`title` 里写明图库域名。
- 顺带修掉一个热重载缺陷:`apply()` 原来只在 `document.getElementById('dsh-orb-settings-style')` 为空时才插样式节点,而上一轮插件留下的 `<style>` 在热重载后仍在文档里,于是新标记配旧规则——用户截图里那个下划线裸链接就是这个状态(新 `<a>` 没拿到新 CSS)。现在改成复用同一个节点、每次重写 `textContent`。
- 测试(packages/client-settings/tests/section.test.mjs):画廊那排断言为「内置数量 + 1」,并断言最后一片是 `<a>`、className 只有 `dsh-orb-set-more`(不再借用瓦片样式)、href/target/rel/title 齐全、children 恰好是 `['更多动图']`(多一个装饰箭头都会红),且整页没有任何指向图库的 `fetch`;新增一例把 `avatarPresets` 清空后重载,断言标题消失、只剩带 `is-alone` 的链接,再切到 en 断言文案变 `More animations` 而 URL 不变;新增一例二次 `apply()`:样式节点仍只有一个且内容被重写。设置页 11 例、bundle 装配 4 例(含既有的「仓库 client.js 与设置页源文件同步」)全过。
- 装机:改动只在 client 半边,已按最小面把装配后的 `client.js` 同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`(桌面版正在用的 0.1.6;`packages/bundle/client.js` 与源文件逐字节同源,只差模块 id)。host 与 helper 未动,刷新主窗口(host 若缓存了旧 bundle 则重开应用)后设置页就是新的一排。`~/.dsh/profiles/web` 那份还停在 0.1.2,本次未动。

## 14. 悬浮球右键菜单加「打开悬浮球设置」(2026-10-12)

需求:右键球 → 一步打开主窗口并落在设置里的「悬浮球」页,不必先打开主窗口再自己点设置、点分区。菜单行插在「打开主窗口」下面,`enabled` 复用同一面 `openMain` 标志——设置面板只存在于主窗口里,没有主窗口就没有这一行可点。

- **三层链路**:helper 菜单写 `{type:'open-settings'}`(`packages/helper/src/menu.ts` + `main.ts`)→ host `orb.ts` 布防 `settingsTarget` 并照旧 `dsh://open` 拉起/聚焦主窗口 → 主窗口的 client 插件轮询 `/.dsh-orb/settings-open` 后把设置面板切到 `orb` 分区。
- **复用书签跳转那条桥,而不是新造一条**:`/jump` 已有的形状原样照搬——GET **不消费**(只做 TTL 检查)、POST 用布防时间戳确认、TTL 30s(常量改名 `MAIN_WINDOW_TARGET_TTL_MS`,两个目标共用,注释写明是"球发起的、要等冷启动的目标")。这样冷启动时球点击 → 应用刚起来、插件还在组合,第一次轮询拿不到 shell 也不会把点击丢掉,目标留到确认或过期。时间戳同时是客户端去重键:确认丢包时下一次轮询只重发确认,不会反复把面板拽回这一页。`routes.ts` 里 GET 返回 `{at}`、POST 校验 `at` 是有限数(非法 400),两条都放在平台门控之上,与 jump 同层。
- **为什么必须摸 slot ledger**:官方没有"打开指定分区"的 API。生成契约里 `settings.section` 的属主只拿到 `close`(文档原话:外壳拥有面板可见性与导航),`settings.launcher` 的 `openSettings()` 不带分区 id 且是 `single` 槽、已被 `AccountMenu` 占,`settings.onboarding` 的 `openSection(id)` 只在首启引导挂着,`dsh://` 只做 `focusPrimaryWindow()`。唯一通路是外壳注册 `sidebar.settings` 时把 store 句柄留在了 ledger 上(`store: {...shellHandle, create: () => shellInstance}`),于是 `ctx.slots.entries('sidebar.settings')` → `entry.store.create().actions.openSection('orb')`。
- **首版踩的坑:句柄在 entry 上,不在 `options` 里**(实测:重启后点菜单只打开主窗口)。`SlotCore.register` 把 entry 拼成 `{ component, options: { key, id, order, label, priority }, …, store }`——`options` 只保留那五个渲染字段,store 句柄是 **entry 自己的顶层字段**;服务层的挂载轴读的也是 `entry.store`(`ui-renderer` 的 `storeOf: (entry) => entry.store === void 0 ? void 0 : this.resolveStore(entry.store, …)`)。首版照搬了调研结论里的 `entry.options.store`,于是每轮都拿不到句柄、静默返回 false——表现正是"只打开主窗口"。修复:`entry.store ?? entry.options.store`(后者留作兼容),并把测试里的假 entry 改成与 `SlotCore.register` 同形(`{ component, options: {}, store }`)。**这个形状就是回归点**:改回 `options.store` 后新增用例立刻红(已实测),避免以后又一次"测试跟着错误假设一起绿"。
- **三道防线**(这段代码碰的是官方内部面,不能"打不着也当打着"):① 自己那行 `settings.section` 不在 ledger 上就不开——`openSection` 不校验 id,否则会开出一个没有导航项的空面板;② `create()` 连调两次不是同一个实例就跳过——那是裸 store 句柄,新建出来的实例没人渲染,开它等于什么都没发生;③ 上述任一不成立都返回 false,调用方**不发确认**,目标留到 TTL,期间每次轮询重试。任何一道失效时的表现都退化为"只打开主窗口",不会假装成功。
- **测试**:helper 菜单列表断言加一行并补 en 侧 `enabled:false`;`host/tests/routes.test.ts` 扩成 jump+settings 一例(GET 非消费、重复读仍在、非法 `at` 400、POST 确认后归 null、未授权 401);`host/tests/runtime.test.ts` 新增 socket 级一例(未点击时为空、点击后布防、重复读不变、确认后清空、用错时间戳确认不动新目标);`client-settings/tests/section.test.mjs` 新增一例覆盖冷启动重试(先无 shell 不开也不确认,挂上 shell 后才开并确认)、确认丢包只重发不重开、新时间戳再开一次、裸句柄不开、分区下架不开。全量 `pnpm typecheck` / `pnpm test` / `pnpm build` 通过(node:test 263 例、vitest 294 例全绿)。
- **装机**:三处产物按最小面同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`——`client.js`(设置页)、`dist/host/index.js`(host 消息与路由)、`dist/helper/lib/main.js`(菜单行),覆盖前先备份到 `~/.dsh/dsh-orb-installed-backup-<时间戳>/`,并用 `cp` 到临时名再 `mv` 落位(避免就地写穿 pnpm 可能留下的硬链接)。host 与 helper 都是进程启动时加载,需**重启应用**后生效(重启会一并换掉球进程);只改 client 半边时刷新主窗口即可。`~/.dsh/profiles/web` 那份仍是 0.1.2,本次未动。
- **已知限制**:`entry.store` / `actions.openSection` / `activeId` 都是官方未导出的内部字段,官方改结构即静默失效(点这一行仍会打开主窗口,只是不落到设置页);真要长期稳定,得等官方给出带分区 id 的公开入口。

## 15. 上传图库 GIF 后球上没反应(2026-10-12)

现象:在设置页点「选择图片」,从图库下载的 GIF 选好点打开,球上头像不变。查 profile:`~/.dsh/profiles/desktop/` 里**没有 `orb-avatar` 字节文件**,`orb-avatar.json` 是 `{kind:'preset',preset:'cheeks'}`(17:04:37 写入,即用户随后点了内置动图)——上传从头到尾没到过 host。

- **先排除球侧**:上传路径的产物就是一条 data URL(`helper` 取字节 → base64 → `orb:avatar`),而既有冒烟只覆盖内置动图。临时 Electron 冒烟(/tmp 下,复用 `.zcode/smoke/smoke-avatar-preload.cjs` 与真实 `floating.html`)把图库里两个真实 GIF(1.17 MB、**2.59 MB**)按生产通道灌进去:断言 `naturalWidth === 256`、data URL 真的被绘制(球矩形截图的像素与上一张不同)。两条都过——**球能显示 2.59 MB 的上传图**,问题不在显示侧。
- **根因是 2 MB 上限,而且拒绝得几乎看不见**:设置页在 `file.size > 2 * 1024 * 1024` 时直接 `return`,只写一行 `avatarError`;那行用的是 `.dsh-orb-set-error`,而当时 `.dsh-orb-set-banner, .dsh-orb-set-error { color: inherit }` 让它和正文同色、位置又在按钮下方,不盯着看就当没发生。量用户图库(https://dshgif.hicp.fun/items.json):50 张里 **10 张超过 2 MB**,`3d_*` 那批 2.09–2.59 MB 且排在最前面——顺手加的「更多动图」入口正好把人送进唯一会被拒的那批文件里。
- **上限统一提到 4 MB**(覆盖图库全部 50 张):`host/src/preferences.ts` 的 `MAX_AVATAR_BYTES`,设置页新增同值常量 `AVATAR_MAX_BYTES`;卡片文案里的 `{limit}`、超限提示里的 `{limit}` 都由它渲染,改一处三个地方跟着走。球是 72px、图库 GIF 是 256×256,4 MB 的量级在 helper 里每次 chrome 广播多几十毫秒(实测 2.59 MB 的 data URL 一次绘制无感),可接受。
- **helper 的读取上限跟着走,并锁住这个不变量**:`packages/helper/src/main.ts` 里原来的 `2_500_000` 硬编码提到 4.5 MB,并搬进 `packages/helper/src/avatar.ts` 作为导出常量 `MAX_AVATAR_RESPONSE_BYTES`。两个上限分居两个包,一旦 helper 的低于 host 的,host 收下的上传会被 helper **静默丢掉**(`fetchAvatar` 返回 undefined → 直接 return,球保持旧图、没有任何提示),所以新增单测直接断言 `MAX_AVATAR_RESPONSE_BYTES > MAX_AVATAR_BYTES`——改任一侧而忘了另一侧就直接红。
- **提示改成能自证**:`avatarError` 旁边加一个 `avatarSize`,超限时渲染「图片 5.3 MB,超过 4 MB 上限。」(host 侧 413 那个分支没有尺寸,回落成「图片超过 4 MB。」);颜色改用官方 `--dsw-alias-state-error-primary`(全站失败提示本来就有这个 token),不再和正文同色。另补一条 `unreadable`:本地读文件失败过去被 `void file.arrayBuffer().then(...)` 吞掉(没请求、没提示、球上没反应),现在说「读不到这个文件,请重新选择一次。」。
- **测试**:设置页 12 例(超限那条改成断言带尺寸的整句、新增「读不到文件」一例、文案与上限同源);`host/tests/routes.test.ts` 新增一例——2.6 MB 的合法 GIF 在 4 MB 上限下被接受并落成 `{kind:'custom'}`,同时断言上限大于 2.6 MB(图库最大那张过得去);`helper/tests/avatar.test.ts` 新增跨包不变量一例。`pnpm typecheck` 通过。
- **装机**:client.js / dist/host/index.js / dist/helper/lib/main.js 三处按第 14 节的流程(先备份到 `~/.dsh/dsh-orb-installed-backup-<时间戳>/`,再 `cp` 到临时名 `mv` 落位)同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`。这次动到了 host 与 helper,所以**必须重启应用**才生效(顺带会把第 14 节的菜单行一起带上去)。

## 16. 后台 agent 书签该消失时不消失、不该消失时自己消失(2026-10-13)

现象:后台 Code agent 的书签有时在任务跑完的瞬间自己消失,有时又一直挂着、必须点一下才走。启动侧(调用 `code_agent` 就登记书签)没有问题,问题全在"消失规则"。

- **根因是已读的粒度**:`host/src/orb.ts` 的书签条只有一条过滤规则——`state === 'running' || !readAgentIds.has(sessionId)`;而 `readAgentIds` 原先只在 `openAgent()` 里写入,既不判断书签状态、也从不清理。于是"已读"是**按会话(session id)永久**的,书签却是**按一段任务**的:① 运行期间点书签(跳去主窗口看进度)也算已读,这一段跑完后书签一翻成 `completed` 就被同一行过滤掉——表现为"一完成就自己消失";② 用同一个 `session_id` 续做时 `registry.record()` 复用同一条会话,上一段留下的已读标记会把续做那一段的完成书签一并吞掉。没被标记过的那次则表现为"挂着小红点,点一下才消失"(既有 `runtime.test.ts` 一例固化的正是这条,却没覆盖运行中点的情况)。
- **修法两条**:(1) `openAgent()` 先向注册表要这条书签的实时状态,只有**已完成/已停止**的才记已读并重推(点运行中的书签只跳转,点多少次都不消费);(2) `agentItems()` 在每次组包时对 `running` 的书签清掉该 session 的已读标记——这样续做(新一段开始跑)会重新武装书签,它跑完后照样是未读。两条合起来即"执行期间点不掉,完成后点一下才消失",且新一段任务重新算未读。
- **测试**:`host/tests/runtime.test.ts` 新增一例「consumes a bookmark only once its task has finished」——运行中点击只布防跳转、完成后书签以 `unread` 回来、此时点击才退休、同一 session 续做后再次以 `unread` 回来。该用例在旧逻辑下实测超时失败(`waitFor` 等不到未读书签),在新逻辑下通过;既有那例(点已完成书签即退休)保持不改。全量 `pnpm test`(node:test 272 例 + vitest 312 例)与 `pnpm typecheck` 通过。
- **装机**:只动到 host,按第 14 节流程把 `packages/bundle/dist/host/index.js` 备份后同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`(备份在 `~/.dsh/dsh-orb-installed-backup-<时间戳>-bookmark-read/`)。host 在进程启动时加载,**需重启应用**生效。

## 17. 完成的书签要能"就地扔掉":× 图标 + 不跳主窗口(2026-10-13)

需求(用户原话):后台 agent 做完任务后,有时并不想进主窗口看内容,但也不想让书签一直挂着;原来必须点书签(等于强制跳主窗口)才能让它消失。要改成——**悬浮展开后,末尾不是红点而是一个小图标,点它直接移除书签**。

- **交接面**:新增一条助手→宿主消息 `agent-dismiss`(`shell.js` → `preload.cjs` 的 `dismissAgent` → `helper/src/main.ts` 的 `orb:agent-dismiss` → `host/orb.ts` 的 `dismissAgent()`),与 `agent-open` 平行,但**不布防跳转、不聚焦主窗口**。
- **只有跑完的才可丢弃**:`dismissAgent()` 与 `openAgent()` 一样先读注册表实时状态,`running`(以及注册表答不上来)一律拒绝——运行期间那张书签是任务唯一的痕迹,停任务仍是 `code_agent_stop` 的事。测试用"拒绝时连推送都不该多一次"来锁这条(拒绝分支只 return,不 `pollAgents`),把 `state === 'running'` 判断删掉后该用例立刻红(实测 4 次推送 vs 期望 3 次)。
- **标记与结构**:红点 `span.agent-chip-unread` 删除,改成一个 `.agent-chip-dismiss` 按钮(12px 的 × 图标,`CLOSE` 加进 `icons.js`)。**按钮不能嵌按钮**(无效标记且会吞掉内层点击),所以 chip 从 `<button>` 改成 `<div>` 容器:内部 `.agent-chip-open`(状态 + 时长 + 任务名,点击=跳主窗口)与 `.agent-chip-dismiss` 两个按钮各自独立;hover/`:focus-within` 触发展开的规则从 `:focus-visible` 换成 `:focus-within`,键盘 Tab 到任一控件都能展开。
- **收起来那一行的取舍**:64px 的收起态装不下"状态 + 时长 + ×",时长会被切成半个数字贴着 ×(肉眼看像乱码)。所以加一条 `.agent-chip[data-dismiss="true"]:not(:hover):not(:focus-within) .agent-chip-time { display: none }`——收起时只留 `✓ ×`,展开后时长回来;`.agent-chip-open` 加 `overflow: hidden`,让收起的尾巴裁在自己盒子里,永远盖不到 × 上。
- **验证**:除了 `host/tests/runtime.test.ts` 新增的「dismisses a finished bookmark without opening the main window」(丢弃后 `takeJump()` 为空、运行中被拒、拒绝不多推送)与 `helper/tests/shell-render.test.ts` 的结构/桥接守卫,这次还写了真机渲染冒烟 `.zcode/smoke/orb-agent-strip-smoke.cjs`(复用第 15 节那套 Electron 冒烟办法):加载真实 `floating.html`,走生产通道灌 `orb:agents`,断言 收起 64px→展开 220px、`✓`/`×` 各就各位、`querySelectorAll('.agent-chip button button').length === 0`、点 × 只调 `dismissAgent` 而点chip 主体只调 `openAgent`,并截两张图(`/tmp/orb-strip-collapsed.png`、`-expanded.png`)肉眼确认。首轮冒烟就抓到上面那条"时长半个数字"的排版问题,改完 `SMOKE-PASS`。
- **装机**:这次动到 host + helper(主进程与 preload)+ 球页面资源,同步 `dist/host/index.js`、`dist/helper/lib/main.js`、`dist/helper/preload.cjs`、`dist/helper/assets/{shell.js,icons.js,floating.css}` 到 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`(先备份)。**需重启应用**生效。

## 18. 球面板里的数学公式排版(2026-10-13)

需求(用户原话):悬浮球面板里数学公式渲染不出来,要"在悬浮球显示框上也能完整地很好地显示数学公式"。

- **根因是两套渲染器**:主窗口走 ui-primitives 的 `parseGfmWithMath`(remark-math + rehype-katex),球内是自研的 `packages/helper/assets/markdown.js`——只做 GFM,TeX 一路没有,所以 `$$…$$` 原样当段落文字吐在面板里。
- **双 arm 与主窗口同构**:`renderMarkdown(text, { live })` 现在有结算/流式两条 arm,对应 Harness 的 `parseGfmWithMath` / `parseGfm`。流式期间(`live: true`,思考与正文都走)不认公式——半个 `$` 或没写完的 `\frac{` 不会在中途闪一次 KaTeX 报错,结算后(`running` 翻 false)同一段文本重新渲染成公式。分隔符四种都认:`$…$`、`$$…$$`、`\(…\)`、`\[…\]`;`$$`/`\[` 在行首起块(同行收尾或后续行以 `$$`/`\]` 收尾),行内 `$` 守住"开括号后非空白、闭括号前非空白",所以 `价格 $100 与 $200 元` 保持字面,`\$`、行内代码、代码围栏一律不解析。
- **公式在强调之前先掩码**:`renderInlineText` 把公式换成私用区占位符再跑链接/裸 URL/强调,最后回填 HTML——`**粗 $x$ 体**` 这种跨公式的成对标记因此仍然成立(不掩码时会各留一个裸 `**`)。这里顺手修掉一个潜在死循环:链接模式从模块级全局正则改为每次调用新建,否则 `anchor()` 递归回来会把外层 `lastIndex` 顶到内层文本上、光标倒退导致无限拼接(实测 `RangeError: Invalid string length`)。
- **排版侧与 shiki 同构**:新增 `assets/math.js`(懒加载 vendor 包、`data-math-rendered` 幂等标记、启动 `setTimeout` 预热),`src/vendor-katex.ts` 抄 ui-primitives `katex.ts` 的三段错误链(strict → `strict:'ignore'` → 红字 error span,失败绝不再抛)。`scripts/vendor-katex-assets.mjs` 在 vendor 构建后把 `katex.min.css` 的 `@font-face` 裁成只剩 woff2(helper 只有 Chromium)并把 20 个字面拷进 `assets/vendor/katex/`(320 KB),缺任何一张直接构建失败。**版本卡 `^0.16.47`,与主窗口 dist 里 bundled 的那份一致**,同一个公式两边排版相同。
- **窄面板的横向策略**:主窗口只给 `.katex-display` 加 `overflow-x: auto`,但面板内容宽只有 280px,居中的块一旦比盒子宽,左半截是滚不到的。所以球里再补 `.katex-display > .katex { width: max-content; min-width: 100% }`:窄于面板时 `min-width` 撑满、照旧居中,宽于面板时滚动内容正好等于公式宽度、从左端开始可以滚到底。行内公式沿用主窗口 compact 那条"给所在块加 `overflow-x: auto`",保证 `#transcript` 自己永远不出现横向滚动(冒烟里断言 `scrollWidth - clientWidth === 0`)。
- **测试**:`helper/tests/markdown.test.ts` 新增 6 例(块级/行内四种分隔符、TeX 转义、货币与代码保护、跨公式强调、流式 arm 保持字面);新增 `helper/tests/math.test.ts` 6 例——其中两例是**功能用例**(直接在 Node 里 import 构建出来的 `assets/vendor/katex.js`,断言 inline/display/坏输入三种输出;以及裁过的 CSS 只含 woff2 且每张字面都在),构建产物缺失时 `skip` 而不是静默通过;`bundle/tests/install.test.mjs` 的产物清单补上 `math.js`、`vendor/katex.js`、`katex.min.css`、`KaTeX_Main-Regular.woff2`。另写真机渲染冒烟 `.zcode/smoke/orb-math-smoke.cjs`(复用第 17 节那套:真实 `floating.html` + 生产 `orb:block` 通道灌块),10 项断言——块级/行内都出 KaTeX、坏公式落 error span、KaTeX 字体真的加载、流式块保持 `$$` 源码、结算块全部 `data-math-rendered`、`#transcript` 无横向溢出且宽公式可滚、`$100` 仍是字面——外加明暗两张截图,`SMOKE-PASS`。
- **装机**:只动到 helper 的页面资源,按第 14 节流程 `rsync -a --delete packages/bundle/dist/ "$P/dist/"` 进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/`(先备份 `dist/` 到 `~/.dsh/dsh-orb-installed-backup-<时间戳>-math/`)。这次**不必重启应用**:helper 在窗口创建时读资源,`kill` 掉 `dsh-orb-helper` 后 host 1 秒内自动拉起新进程即可生效。真机确认:球的历史会话里那条「1. 不可压缩 NS 方程」的 `$$…$$` 已经排版成公式,同一屏的 ```` ```latex ```` 卡片仍是源码卡片。

## 19. 0.1.7 拉取后的 Windows 复核:修掉 8 处缺陷(2026-10-15)

把 main 从 `5f0e575` 快进到 `e5611a1`(35 个提交)后,在 Windows x64 上按 `computer-use` / `host` / `helper+native-selection` 三面复核。结论:**没有一项是这 35 个提交引入的新回归**——最重的那条所在的 chunk 与当时线上运行的版本逐字节相同——但确有真缺陷,一并修掉。本节只记改动与理由;装机未做,线上仍是 0.1.6。

- **UWP 窗口的 app 身份不一致(最重)**:`listWindows` 对 `ApplicationFrameWindow` 有 `coreWindowPid` 特判,而新的校验函数 `windowAppName` 没有,于是同一个窗口答出两个名字——观测记录写 `SystemSettings`,校验回 `ApplicationFrameHost`,`restoreObservedFocus` 判定不符直接抛错,**`hotkey` 在任何商店应用上永远发不出按键**。本机实测:hwnd 263268(「设置」)属于 `ApplicationFrameHost`(PID 4292),真正的 `SystemSettings`(PID 14404)`MainWindowHandle = 0`(它没有顶层窗口,UI 挂在 frame 的子 CoreWindow 上)。修法是把派生收成一个纯函数 `appOwnerPid(className, ownPid, coreWindowPid)`(放 `windows-foreground.ts`,不加载 koffi),`listWindows` 与 `windowAppName` 都走它;第三参用 thunk 是刻意的——`coreWindowPid` 要 `EnumChildWindows`,不能让每个普通窗口都付这个代价。测试新增 `computer-use/tests/windows-owner.spec.ts` 4 例:帧取 CoreWindow 的 pid、无子窗口回退自身、非帧**根本不调用**探测(钉住惰性),外加源码钉桩「`windows-native.ts` 里恰好 2 处 `appOwnerPid(`、且不再出现 `ApplicationFrameWindow` 字面量」——只改一处正是这次的成因。
- **下载锁可无退避忙等**:`withDownloadLock` 的 `continue`(清扫过期锁后重试)跳过了超时判断与 250 ms 退避,而 `lockExpired` 在锁目录**不存在**时也返回 `true`(把「没有锁」当成「锁已过期」)。两者叠加:只要 `rename` 因**非锁原因**被拒(Windows 上 Defender/索引器占着刚建好的 staging 目录就是 EPERM/EACCES),循环就以文件系统速度空转,10 分钟上限永远到不了,`resolveElectronBinary` 永不返回、球起不来。修法:超时判断移到循环体开头(任何路径都回到它),`lockExpired` 在 `stat` 失败时改答 `false`(没有可清扫的东西,应当退避)。暴露面只在「首次下载 Electron」;本机运行时早已下载,所以不在 0.1.7 部署路径上。新增一例断言锁路径不存在时返回 `false`。
- **剪贴板快照为空时被静默清空**:`restoreClipboard` 无条件 `EmptyClipboard()`,而告警条件是 `restored === 0 && entries.length > 0`——恰好在「什么都没抓到」时闭嘴。4K 屏 Win+Shift+S 的 CF_DIB 约 33 MB,超出 16 MiB 快照预算,于是下一次 `input_text` 把用户的截图抹掉且不吭声。修法:`ClipboardSnapshot` 增加 `dropped`(看见但复制不了的格式:GDI 句柄、超预算),新增纯函数 `clipboardRestoreIncomplete(snapshot, restored)` 判定「有没有东西没还回去」,`restoreClipboard` 用它告警。测试在 `windows.spec.ts` 新增 3 例(丢失已复制格式、只丢未复制格式、本来就空则不吭声)。
- **`open_app` 匹配收紧过头**:新的分段相等规则让 `open_app("edge")` 打不开「New tab - Personal - Microsoft Edge」(段是 `microsoft edge`,进程名是 `msedge`)。但收紧本身是对的——既有测试要求 `code` **不**匹配 `source code review`。所以只补一条:**段以 `wanted` 结尾且前一字符是空格**也算命中(`text.endsWith(\` ${wanted}\`)`)。`edge`/`microsoft edge` 命中,`code`/`source code review` 仍不命中(段尾是 `review`),`Straightedge`、`Knowledge` 也不误命中。`app-match.spec.ts` 补正反 4 例。
- **选区 DPI 探测失败时返回未换算的物理坐标**:`monitorScale` 在 `GetDpiForMonitor` 返回非 0 时 `return 1`,而 1 是**真实的 100% 读数**——用它顶替失败,等于把物理像素冒充 DIP 交给调用方,与函数自己「失败的代价只是坐标」的注释相反。修法:探测答不出来就抛错,调用方(第 112-123 行的 try/catch)退化成「只给文本与 pid、不给坐标」,正是注释所述的意图。`host/tests/selection.test.ts` 补两条源码钉桩。
- **已完成的延迟安装仍被报为「安装中」**:`deferredInstallInProgress` 只在 `status.json` 读取成功后才看 `result.json`,`status.json` 已删时回落到 `installPendingAfterExit`(`job.json` 新鲜 30 s 内即判在装);而脚本尾部 `rmSync(jobFile)` 无保护,Windows 上被占用就中断,`job.json` 留了下来。结果是刚装完的一次安装被报成在装,`apply()` 跳过 `stageNativeImages()` 与 `exemptReleaseAge()`、`waitForInstall` 把 `runtime.start()` 按住最多 30 s。修法:无 status 分支先看 `result.json`(调度侧第 70 行在写 job 前会删掉旧结果,所以「存在结果」就等价于「本次已出结果」,不需要比 mtime),脚本尾部两个 `rmSync` 包 try/catch 并记日志。`deferred-install.test.ts` 补一例。
- **`writeProfileFile` 无重试且失败被静默吞掉**:Windows 上目标被 pnpm/OneDrive/扫描器占着时 `renameSync` 会 EPERM/EACCES/EBUSY。修法:抽出 `renameWithRetry(from, to, rename = renameSync)`(5 次、50/100/150/200 ms 退避,沿用仓库既有的 `Atomics.wait` 同步等待),失败时删掉 staged 再抛;`exemptReleaseAge` 保持「尽力而为、不抛给调用方」,但把「文件在、只是写不进去」这一种从静默改成 `console.error`——少了豁免,用户看到的是「点了更新却没反应」。`update.test.ts` 补 3 例(两次被拒后成功、始终失败用满 5 次、写不进去时不留 `.dsh-orb-tmp` 且不抛)。
- **源码钉桩测试在 CRLF 检出上必红**:本机 `core.autocrlf=true`,工作区是 CRLF,而钉桩正则锚在 `\n` 上。`helper/tests/shell-render.test.ts` 7 例、`update.test.ts` 新增的那例都栽在这里。修法是读取时把 `\r\n` 折成 `\n`(钉的是代码内容,与行尾无关),`shell-render.test.ts` 抽一个 `source()` 助手统一 6 处读取。**这不是产品缺陷**:把 `shell.js`/`floating.css` 临时转成 LF 后同一批用例全过,已实测。
- **验证**:`pnpm typecheck` 通过;`pnpm build` 通过(KaTeX 资源仍齐);computer-use vitest 全绿;node:test 除 1 例 POSIX 夹具(用 `#!/bin/sh` 造假 `pnpm`、以 `:` 分隔 PATH,产品代码本身在 win32 上正确)外全绿。**未部署**:构建产物留在仓库,`~/.dsh/profiles/desktop/node_modules/dsh-orb/` 一个字节未动(版本仍 0.1.6)。
- **未改的两项**:① 停靠滑出动画到显示边缘、标签落在工作区边缘,有侧边任务栏时是观感跳变——那是第 522-523 行注释写明的刻意选择,且与 `unsnap()` 的滑入起点对称;② 选区矩形跨不同 DPI 显示器时只按左上角缩放,需要按角逐点换算,而该功能当前被强制禁用。

## 20. dsh 0.2.1 更新后,球里一发指令就报 unknown prompt variable "{{cwd}}"(2026-10-17)

现象:桌面版 dsh 更新到 `0.2.1-rc.1` 后,在悬浮球的显示框里输入任何指令,本轮直接失败:`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model`——请求还没发出去就被提示词组装挡下,球看起来「不能用了」。

- **根因:官方撤掉了 `cwd` 这个提示词变量**。旧包 `dsh-agent-loop@0.1.7-rc.2` 注册三个变量(`provider`/`model`/`cwd`,见旧 `lib/index.js` 第 1549-1551 行),`0.2.1-rc.1` 只剩前两个;而 `dsh-system-prompt` 的插值是**严格**的(两版这段代码逐字相同):遇到未注册的 `{{name}}` 直接抛错,而不是替换成空串。本插件的 Computer Use preset 在 persona 里写了 `suffix: Your working directory is {{cwd}}.`,于是每次组装都在这里炸。官方这次把迁移写进了 `dsh-system-prompt/README.zh.md` 第 79 行:自定义 persona 模板不得依赖内置 `cwd` 变量,请从 home、profile、invocation 的 `personaSuffix` 与 preset 的 `suffix` 里删掉那句,并指出工作目录服务已经提供必需的当前目录上下文。
- **删掉这句不丢信息**:`0.2.1` 的 `dsh-working-directory` 把 `Current working directory: "…".` 作为 **required** 运行时上下文注入(`required: true`,见该包 `lib/index.js` 第 42-48 行),而该服务就在 `dsh-base` 的补丁里(`cordis.patch.yml` 第 167 行 `- id: working-directory`)。本项目自己的会话快照里也有这一行,所以 persona 里那句本来就是重复的,删掉后模型照样知道工作目录;`{{model}}` 保留,它仍然注册。
- **改动两处**:`packages/bundle/cordis.patch.yml`(真正装机的那份)删掉 `suffix` 一行并写清为何不能再加,`packages/computer-use/presets/computer-use/agent.cordis.yml`(测试与独立组合用的那份)同步删掉,并改掉原先那句「`{{model}}` 和 `{{cwd}}` 都可解析」的注释。
- **回归守卫**:`packages/computer-use/tests/preset.spec.ts` 新增一例「references only the prompt variables the agent loop registers」——扫这两个文件里所有 `{{name}}`,只允许 `provider`/`model` 出现;按加载器真正看到的语义**忽略注释行**(注释里点名 `{{cwd}}` 是刻意留给后来人的警告,不该让守卫自己红)。把文件换回旧文本实测立刻红(`unknown: ['cwd']`),修好的文本 `unknown: []`。
- **验证**:拿仓库依赖里的 `dsh-system-prompt`(插值代码与新版逐字相同)做了一次真实组装:只注册 `provider`/`model` 时,旧后缀抛出的**正是用户看到的那句原话**,新后缀正常渲染且 `{{model}}` 解析出模型名。`pnpm --filter @dsh-orb/computer-use test` 321 例全绿(29 个文件)。
- **装机**:这次只动配置、没动代码,按第 14 节流程把 `packages/bundle/cordis.patch.yml` 备份到 `~/.dsh/dsh-orb-installed-backup-<时间戳>-dsh-0.2.1-cwd/` 后同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/cordis.patch.yml`(临时名 + `mv` 落位)。desktop profile 没声明 `patchReload: live`,配置在启动时读取,所以**必须重启应用**才生效。旁注:`~/.dsh/profiles/web/node_modules/dsh-orb/` 是一份 `0.1.2` 的旧副本(Oct 7),而该 profile 的 package.json 已指向 `file:…/packages/bundle`——要用 web profile 应当先 `pnpm install` 重新链接到修好的仓库,而不是手改那份旧文件。

## 21. 球里点历史对话,进的是新会话而不是那一段(2026-10-17)

现象(承接第 20 节,同一轮 dsh 0.2.1 更新):点球面板的历史按钮、再点其中一段旧对话,面板没回到那一段,而是当场多出一个未命名的新对话。同一根因还有第二张面孔:**每次重启应用,球都丢掉上一次的会话**,静默从空白对话开始。

- **根因:官方把 `sessionController.create` 的语义收窄成「给新对话复用空白会话」**。旧版 `create` 里是 `agents.ensureSession(sessionId, cwd, request.sessionId !== void 0, preset)`——传 `sessionId` 即「创建或认领(adopt)」那一段。`0.2.1` 的 `createSession` 换成 `claim`:命名会话只有在**还是空白(没开始过回合)**、属于请求的工作区、且没有别的写者时才复用;官方 README 第 45 行原话是「已开始的命名 Session 保持不变,**改为新建一个 Session**」。本插件的 `openSession()` 与启动恢复 `createSession()` 都靠「传 sessionId 打开」,于是两处都被静默换成新会话——用户点历史看到的正是这个新会话。
- **改用官方为此提供的入口 `resolveAgent`**:`ctx.sessionController.resolveAgent(sessionId)` 在**两版**里都是「解析或恢复一个普通会话」(旧版 `lib/types/index.d.ts:66` 已声明;两版实现都是 `ApiSessionAgentController.resolve(sessionId)`),活着的 Agent 原样返回,冷的按持久化恢复,并且用会话自己记录下的 preset 重新挂载(`composeAgent(presetForObservation(...))`)。所以新增私有方法 `openConversation(sessionId)`,两处都走它:历史打开 = `resolveAgent` + `adopt(请求的那一段)`;启动恢复先试 `resolveAgent(saved)`,失败才删 `floating-session.json` 并 `create` 一段新的。`newSession()` 不动——它本来就要新会话,`create` 不带 sessionId 仍是正确用法。
- **不自己重抄一遍官方策略**:没有直接调 `ctx.agents.resume(...)` 再拼 `agentOptions`/preset setup——那正是 `resolveAgent` 内部在做的事(还负责并发恢复去重、子代理会话围栏、preset 适用性断言)。照抄一份等于把官方策略变成自己的维护负担,而这次踩的坑恰恰是「官方语义变了、插件还在按旧语义写」。
- **回归测试改成忠实的新语义**:`host/tests/runtime.test.ts` 的假 `sessionController` 里,`create` 对「已有历史的命名会话」改为 mint 另一个 id(注释写明这就是 0.2.1 的契约),新增 `resolveAgent`(会话在内存或 list 里就答 `{agent}`,否则 `{error: session/not-found}`),`session-keep` 的会话体改为首次 create/resolve 时按持久化语义种下。两条断言随之收紧:打开历史后 `calls.resolve` 末项是 `session-keep`、`calls.create` 计数不变(没有新会话被铸出来)、广播与 `floating-session.json` 都停在 `session-keep`;另加一条新用例「restores the saved conversation on startup instead of minting an empty one」——预置 `floating-session.json` 与 list 行,发一句话,断言 prompt 落在旧 id 且 `create` 一次都没调。
- **验证**:把 `packages/host/src/orb.ts` 还原成旧代码后跑同一批用例,**两条新用例必红**(27 过 2 挂),修复后 29 例全绿——回归点被钉住。`pnpm typecheck` / `pnpm test`(node:test + vitest 321 例)/ `pnpm build` 全部通过。
- **装机**:只动 host,按第 14 节流程把 `dist/host/index.js`(连 `index.d.ts`)备份到 `~/.dsh/dsh-orb-installed-backup-<时间戳>-session-open/` 后同步进 `~/.dsh/profiles/desktop/node_modules/dsh-orb/dist/host/`(临时名 + `mv`)。host 在进程启动时加载,**需重启应用**生效。
- **遗留**:修复前每点一次历史都会真的铸出一个空会话,它们仍在历史列表里(不是幻觉);而 `floating-session.json` 现在指向的多半正是这样一个空会话,所以重启后球可能先落在空白对话上——从历史里点回那一段即可。要清理那些空壳会话得走官方会话存储,本次未动。

## 22. 下载运行时的提示看不见：改成醒目卡片 + 「重新下载」按钮(2026-10-19)

现象(承接第 1 节那条用户反馈的正根):装完插件没有球的人,进 设置 → 悬浮球 只看到一行灰色小字「悬浮球运行时没有下载成功。关闭后再打开可再试一次。」和一个**没有边框、没有底色**的「重试」,排版上紧跟页面介绍行「更改写入当前配置。」。实测计算样式:错误行与介绍行颜色**完全相同**(dark 下都是 `color(srgb 0.976471 0.980392 0.984314 / 0.72)`,13px/400),而页面自己也**只在这一页**提示——主窗口、会话列表都没有任何提示。两条具体缺陷:

- **错误色从未生效**:`.dsh-orb-set p`(0,1,1)压过 `.dsh-orb-set-error`(0,1,0),而插件里每一处 `.dsh-orb-set-error` 都是 `<p>`,所以红色 token(`--dsw-alias-state-error-primary`,dark 下 `#f25a5a`)**一次都没轮到**。同理,「重试」用的是 `.dsh-orb-set-ghost`(`border-color: transparent`、无底色),视觉上像正文里的一句话。
- **按钮做的事和文案说的不是一回事**:文案让用户「关闭后再打开」,而下载**没有断点续传**(每次全新 `curl -o .electron-<随机>.zip`,`finally` 删掉 zip 与 staging),所以重启 = 从 0 开始;反倒是那个不显眼的按钮能走 `setBallEnabled(true)` → `runtimeRetries = 0`(注释原文 "A manual retry grants a fresh download budget"),比重启更有效。

改动:

- **客户端**:`helperNotice` 重写为 `runtimeNotice` —— 带色调的卡片(等待=蓝、失败=红,`color-mix` 边框 + 10% 底色)、圆点标记(失败 `!`、等待 CSS 转圈)、加粗标题、正文,以及**主按钮**(填充 `--dsw-alias-button-info-fill`),不再是 ghost。等待态**也给按钮**:下载被打断或卡住时,用户不必等退避也不必重启。文案改写为「点「重新下载」立即从头再下一次——不用重启应用」,并把 helper 反复退出那条并入同一组件(标题「悬浮球没能启动」,按钮仍是「重试」,走原来的 `/.dsh-orb/ball`)。
- **CSS**:补 `.dsh-orb-set p.dsh-orb-set-error` 把错误色真正落到段落上(其余错误文案同样受益);通知块用 `.dsh-orb-set-notice*` 独立类,正文显式 `color: inherit` 以脱离那条 72% 灰的公共规则。
- **host**:新增 `POST /.dsh-orb/runtime/redownload` → `OrbRuntime.redownloadRuntime()`:取消在飞的下载(`AbortController` 贯穿取 SHASUMS、`curl`、`unzip`/`Expand-Archive` 与下载锁等待)、删掉被杀进程留下的 `.electron-*.zip` 与 `.electron-staging-*`、重置重试预算并立刻重新开始。被取消的那次用 `code: 'dsh-orb-download-cancelled'` 标记,`beginRuntime` 见到它**不计失败、不写 `helperError`**(否则一次手动重下会凭空烧掉一次重试并闪一下失败态)。方法不 await 整段下载:一次下载跑几分钟,由设置页按 `helperPhase` 跟随,和首次启动同一条路。

验证:

- 单测:`client-settings/tests/section.test.mjs` 那一例重写为断言两种 tone、标题/正文文案、按钮指向 `/.dsh-orb/runtime/redownload`,以及 helper-exited 仍指向 `/.dsh-orb/ball`;`host/tests/routes.test.ts` 新增一例(新路由命中 control、回读快照已是新一次尝试、老 host 没有该方法时答 404);`host/tests/electron-runtime.test.ts` 新增 3 例(取消后不再等锁、清理只动 `.electron-*` 而保留已完成的运行时、取消标记只认自己的 code)。
- `pnpm typecheck` / `pnpm test`(node:test 全绿 + computer-use 321 例)/ `pnpm build` 全部通过。
- **真实 UI 端到端**:用临时 `DSH_HOME` 装本次打包产物(`--version 0.1.9-uinotice2`),另起一份 `dsh web`,无头 Chrome 打开真实设置页截图:失败态是红色卡片 + 主按钮;点击后确实发出 `POST /.dsh-orb/runtime/redownload`,界面立刻切到蓝色等待卡片;再把 `DSH_ORB_ELECTRON_PATH` 指向一个可执行文件后再次点击,host 日志由 `ENOENT: … access '/tmp/orb-shot/fake-electron'` 变为 `helper started pid 78834` —— 证明按钮真的重跑了整条运行时解析,而不是只改了界面。用户的 52455 实例与 `~/.dsh` 全程未动,临时 home 与临时目录已删除,仓库里只留打包用的临时版本号 tarball(验证后即删)。
- **未做**:主窗口/会话列表侧的提示(本次只要求设置页内显眼)。慢网 5 分钟硬超时(`--max-time 300`)与 100 KB/s 下限仍在,所以「下不完」这件事本身没变——变的是用户现在看得见、点得动。

## 23. 慢网下运行时永远下不完(2026-10-19)

现象(承接第 22 节,同一轮真机复现里量到的硬根因):全新 home 装 0.1.9,首次启动开始拉 130 MB,日志反复出现 `curl: (28) Operation too slow. Less than 100000 bytes/sec transferred the last 20 seconds`,第一次尝试下到 **93 MB 被掐断**,之后每次重试都从头再来;预算用尽→失败卡片→点「重新下载」→还是失败。**这个网络下,球永远出不来。**

- **根因一:单次传输有总时长上限**。`downloadVerifiedZip` 给 zip 传了 `--max-time 300`。复现当时实测 CDN 只有 **159 KB/s**,5 分钟最多 48 MB——也就是说**低于约 433 KB/s 的连接数学上不可能下完**(Windows 157 MB 要 ~525 KB/s),重试多少次都一样,因为每次都会被同一个上限砍掉。
- **根因二:失败即丢弃,没有断点续传**。zip 用 `randomBytes` 随机戳命名,每次尝试前 `rm` 掉,`finally` 再删一次;curl 也没有 `-C -`。于是 93 MB 白下,用户点「重新下载」也是从 0 开始——最坏情况下把同样的字节付费(和时间)付到预算耗尽。
- **修法**:①去掉 zip 的总时长上限,只留停滞检测(`--speed-limit` 从 100000/20s 放宽到 **20000/30s**:慢线不是死线,只有"停止供数"才该被放弃);②同一资产的传输固定写一个可续传的 partial(`.electron-<asset>.partial`),存在即 `-C -` 续传;③校验失败(整份字节是坏的)与"服务端拒绝续传"(curl 33/36,或 416 以 exit 22 到达)时才删掉 partial 从零来;④`purgeRuntimeArtifacts` 改为**保留**本资产的 partial、只清 staging 与旧命名残留——所以「重新下载」现在是"接着下"而不是"从头下",文案同步改成「立即接着下——已经下好的部分不会重来」;⑤锁的属主陈旧上限从 20 分钟提到 **3 小时**(传输可能合理地跑很久,这个上限只用于识别 pid 被复用)。
- **验证(限速代理,可重复)**:写了一个 HTTP CONNECT 限速代理(`/tmp` 内,未入库),实测经代理 300,460 B/s ≈ 配置的 300 KB/s。全新 home 装 `0.1.9-slownet`,主机带 `https_proxy` 启动:①90 秒后 partial = 26,296,320 B(≈292 KB/s,与限速吻合);②**`kill -9` 掉主机与 curl**(模拟强退,连 `finally` 都不跑),partial 与带死属主的锁都留在原地;③重启主机 → 日志 `resuming the download at 34205696 bytes`,**与留在盘上的字节数逐字节相同**,陈旧锁被自动清扫,没有重新下载任何一个字节;④传输途中停滞检测触发过一次(`Operation too slow`,20000 B/s/30s),curl 内部重试后**接着**下完;⑤`Electron 44.0.0 is ready` → `helper started pid 26458` → `ball 1386,476 96x96`,球出现。整段下载远超旧的 300 秒上限——旧代码在同一条件下必然失败。
- **已知边缘**:若主机被强杀而 curl 变成孤儿(与本案相同),孤儿会继续往同一个 partial 追加,重启后的新尝试也从同一位置续传,两份写入叠加 → 最终校验失败 → 删掉 partial 从零重来。代价是一次重下,不会装上一份坏运行时(校验是硬闸门)。
- **未做**:`withDownloadLock` 的"等锁 10 分钟"没动——只在两个主机共用一个 home 时才会遇到,等 10 分钟比早失败更糟,故保持。

## 24. 球里「新建」堆出一大堆删不掉的未命名对话(2026-10-19)

现象(用户截图):在球面板连点几次「新建」、一句话都不发,再打开「历史」就是一串「未命名对话」;点几次多几条,**而且删不掉**。主窗口同一个工作区里不会这样:点多少次「新会话」,列表里始终只有当前那一个空白会话。

- **根因一:球每次点「新建」都真的铸一个会话**。`newSession()` 无条件 `sessionController.create({ workspaceId, agentPreset: 'computer-use' })`,不带 `sessionId`;官方 `session.create` 是 `const sessionId = request.sessionId ?? brandString(...)`——**不给 id 就必定新铸一个**。主窗口走的是 `reuseOrCreateBlank()`(`dsh-client-ui-workspace/lib/client.js:798`):先在当前工作区里找**已有的空白会话**,找到就 `create({ workspaceId, sessionId })` 复用(还空白才允许 adopt),找不到才新建。
- **根因二:球的历史不过滤空白**。`historyRecords()` 只按"工作区 + computer-use 预设"过滤(`isHistoryRow`),`blank` 一概不看;而主窗口的 `sessionVisible()` 是 `session.blank && session.id !== current → false`——**空白会话只显示当前那一个**。所以堆出来的空会话在主窗口里看不见,在球里全露出来。
- **为什么删不掉**:球没有单条删除;主窗口把空白会话隐藏了,选都选不到;设置页的「旧会话清理」只按保留期限把**更旧的**会话移到系统回收站,默认又是"永久保留"。三处都够不着。
- **修法**:①`newSession()` 先读官方列表的 `blank` 标记,**当前会话还空白就只重置面板、不铸会话**;有内容才新建(与主窗口的复用语义一致,球是单会话 UI,只复用它自己那一个,不会跳到别处)。②`historyRecords()` 隐藏空白会话、保留当前那个(对齐 `sessionVisible`)。③**一次性清扫**:`HistoryCleaner.sweepBlanks()` 把"空白 × 非当前 × 未 attach × 非 pinned/archived × 5 分钟前 × computer-use 预设"的会话走**原有**的 archive + 系统回收站通道(`trashTree`,带 manifest,可恢复),所以升级后旧的那一堆会自己消失。④`scheduleBlankSweep()` 每个 profile 只跑一次,marker(`blank-sweep.json`)只在清扫**真的跑过**之后才写——服务不可用/正在清理时 `sweepBlanks` 抛错、marker 不写,下次启动再试,避免"记成已清扫但什么都没做"。
- **测试**:`history.test.ts` 一例(旧空白被移入回收站并 archive;有内容的、5 分钟内的、attached、pinned、archived、当前会话、standard 预设一律不动;第二次运行 0 条);`runtime.test.ts` 两例(在空白会话上发 `{type:'new'}` **不**再产生 `create`,有内容时才产生;`history` 消息里当前空白可见、其它空白隐藏),以及 `scheduleBlankSweep` 一例(只跑一次;失败不写 marker、下次重试;"确实 0 条"要写 marker)。
- **未做**:球面板本身没有可驱动的验证通道(helper 是不带调试端口的独立 Electron),所以"点按钮"那条路径由 host 层 socket 集成测试覆盖(它就是按钮实际发的消息),没有另做 UI 截图。

## 25. 插话从官方 steer 改为硬停旧轮 + 新任务(2026-10-21)

现象:Agent 正在等一个约 30 秒的工具时,用户说「大肥鱼,把明天的也查一下」,气泡能上屏,但要等当前工具/这一步结束,Agent 才看到这句;交互上像"卡住半分钟"。

- **原因**:官方 `steer` 不中断当前模型输出和工具,只在下一步开头把插话交给模型。长工具下等待时间等于工具剩余时间。
- **决定**:插话不再用 `steer`。命中时 `sessionController.cancel` 旧轮(等同点「停止」),等官方 `turn/end` 后把原话作为 `mode:'queue'` 的新消息发送,另起一轮。用户气泡在命中时就画,不 cancel 完成;旧轮剩余正文静音到新任务 `beginTurn()`。
- **官方边界**:`cancel` 会 abort 模型流和当前步,但 `runGroup` 会等已经 dispatch 的工具 settle;工具响应 `exec.signal` 才会立刻结束。不响应取消的工具仍会推迟新任务。`cancel` 保留收件箱(`keepInbox: true`),旧轮排队的其他消息可能随新轮交付。
- **实现**:见 `packages/host/src/voice.ts` 的 `interject()`/`resumeAfterInterjectFailure()`、`packages/host/src/orb.ts` 的 `pendingInterject`/`onInterject()`/`startPendingInterject()`/`consume('turn/end')`。不调 `stopTurn()`(它会手动 `finishTurn`,旧轮迟到的 `turn/end` 可能误停新轮);`turn/end` 之后再 `submitPrompt()`。
- **交互细节**:连续插话以最新一句为准;停止、退下、手动打字、切会话都会清 pending 并删气泡;硬插话由 Host 直接发送,不经过页面 `voice-prompt`,因此不拼划词 chip、不走页面的 TCC 门。命令模式的普通语音输入不变。
- **测试**:`runtime.test.ts` 新增执行中硬停、只剩余收尾、`cancel` 失败、连续插话、`prompt` 失败五例;`voice.test.ts` 增加插话后 `muted/off`、旧轮结束后新任务恢复播报、`resumeAfterInterjectFailure()` 三处断言。

## 26. TTS 播报时插话失效:装配包漏了 macOS 采集程序(2026-10-23)

现象:Agent 正文正在播放时,用户说「大肥鱼,……」没有任何反应;停下播报后同样的句子可以正常插话。语音唤醒、普通语音输入、退下都正常,所以看起来像「回声消除被关掉了」。

- **根因:回声消除代码没丢,采集程序没装进包。** `packages/bundle/scripts/assemble.mjs` 只把 `voice/lib` 拷进 `dist/voice/`,没有拷 `packages/voice/prebuilds/`。子进程的 `captureBinary()` 在 `dist/voice/prebuilds/...` 下找不到 `dsh-orb-voice-capture`,于是改用 `node-cpal`,并且如实上报 `mic: { open: true, aec: false }`;Host 的 `listenMode()` 在 `bodyBusy && !echoCancel` 时按既有降级规则返回 `off`。所以不是 VPIO 失效,是 VPIO 根本没被拉起来。
- **修法:** `assemble.mjs` 现在把整个 `voice/prebuilds` 装到 `dist/voice/prebuilds`(子进程的 `./prebuilds` 查找路径),并对 Darwin/Windows 采集程序显式 `chmod 755`。`bundle/tests/install.test.mjs` 在链接安装和 tarball 解包两条路径都断言采集程序存在且可执行,避免以后再把装配链改漏。
- **可观测性:** `child.ts` 在找不到采集程序时写 debug 日志 `capture helper missing; node-cpal has no echo cancellation`,在 `ready` 时写 `mic open source=native|cpal aec=...`;`host/src/voice.ts` 同步记录收到的 `mic` 事件。以后同类问题打开 `dsh-orb-voice-debug.on` 就能一眼看出降级原因。
- **验证:** `pnpm build`;`node --test packages/bundle/tests/install.test.mjs` 4/4;host+voice 122/122;`pnpm typecheck` 通过。
- **装机:** 备份 `~/.dsh/profiles/desktop/node_modules/dsh-orb/dist/voice` 后,把新 `packages/bundle/dist/voice/` 同步进 profile(含 `prebuilds`),然后只 `kill` 掉语音子进程(host 会在 1 秒内重新 fork),**不必重启应用**。debug 日志确认新子进程为 `mic open source=native aec=true`,且 `dsh-orb-voice-capture` 作为子进程 PID 存在。此后 `echoCancel` 为真,正文播放期间听法回到 `interject`,插话恢复。
- **未做:** Windows 采集程序的 `.exe` 仍未入库;本次只修复 macOS 的装配遗漏。若在 Windows 上打包,`prebuilds/win32-x64` 需要先由 `build:native:win` 生成并一起提交。

## 27. 收起后关唤醒、或固定后关语音输入,麦克风仍然亮着(2026-10-23)

现象:只开语音输入、关掉唤醒后,球明明收起了,系统麦克风指示仍亮;只开唤醒、关掉语音输入后,球固定住,麦克风也仍然亮。必须把另一列也关掉才会释放。

- **根因:听法和占麦是两套判断,占麦那套不看固定状态。** `listenMode()` 里唤醒只在 `!pinned` 时可达、语音输入只在 `pinned` 时可达;但 `holdsDevice()` 只判断“哪一列开着且模型齐全”,再加一个提问卡例外,不看 `pinned`,也不看当前 `mode`。于是:
  - 唤醒关、语音输入开、球收起 → `mode: 'off'`(语音输入不可达),`device: true`(语音输入列还开着);
  - 语音输入关、唤醒开、球固定 → `mode: 'off'`(唤醒不可达),`device: true`(唤醒列还开着)。
  子进程只按 `device` 开关采集(`micWanted()` / `syncMic()`),`mode: 'off'` 只是不把音频喂给 KWS/VAD,并不会关掉采集流,所以麦克风指示一直亮。
- **修法:** `holdsDevice()` 改成 `DeviceInput`,把 `pinned`、`agentBusy`、`bodyBusy`、`interjectEnabled`、`echoCancel` 一起纳入判断:
  - 提问卡 → 释放;
  - 执行中/播报中 → 只要插话列能跑就占麦(与固定状态无关);
  - 其他 → 收起时看唤醒列,固定时看语音输入列。
  回复/停止这类短暂的 `off` 不单独开洞:当前固定状态下还有可达列就保持,没有就释放,避免反复开关采集设备。Host 的 `pushListen()` 和 `microphone()` 共用新的 `deviceWanted()`,所以主动释放时 `microphone()` 返回 `null`(不误报“麦克风不可用”),只有设备该开却没开时才返回 `false`。
- **测试:** `listen.test.ts` 新增可达列/插话两组断言;`voice.test.ts` 新增两个完整场景(关唤醒收起、关语音输入固定)并修正提问卡用例里旧的“固定+仅唤醒仍占麦”断言。`pnpm typecheck` / `pnpm test`(511 例,509 过 2 跳过;computer-use 322 过)/ `pnpm build` 全绿。
- **装机:** 改的是 Host 判断,只重启语音子进程不够,必须重启 DeepSeek Harness 才生效;`dist/host` 与 `dist/voice` 已同步进 desktop profile。

## 28. 收起时系统音量仍被 VPIO 压低:只在展开且转写时启用(2026-10-24)

现象:语音总开关和唤醒开着时,球收起、没有执行任务,整个系统的扬声器声音仍然明显变小;关掉语音才恢复。VPIO 的 other-audio ducking 是 unit 在跑就生效,macOS 26.4 上 `.min` 也压约 16 dB,和球有没有在干活无关。

- **修法:** 子进程按当前 `mode` 选采集源,不再一直用原生采集:
  - `wake`(收起、只听唤醒)→ `node-cpal` 普通采集,不启 VPIO;
  - `command`(固定面板等指令)/ `interject`(执行中或收尾播报听插话)→ 原生 VPIO;
  - `off` → 关麦。
  `command` 只在面板固定时可达,`interject` 只在执行中/收尾把面板留住时可达,所以这两种模式就是“球展开且 ASR 在工作”;收起时不会再有 VPIO。
- **切换:** `syncMic()` 发现模式要求另一种采集源时,先关旧源再开新源,但**不清 ring**——`wake→command` 的 300ms 预卷仍用来 seed VAD。原生启动失败仍回退 `node-cpal` 并上报 `aec:false`;原生曾经 ready 过的话沿用原有的 1 秒重试/三次降级。
- **边界:** 展开后 `interject` 期间(TTS 播报、Agent 执行)仍会压系统音量,这是这次选定的退一步行为;收起、只唤醒、看视频/打游戏、主窗口用语音时不再受影响。球固定 command 但用户没说话时也会压,因为 command 本身就是 ASR 开着。
- **未做:** 没有实现“只有用户开口时才压”。VPIO 没有按句开关的公开 API,启停 unit 会有延迟和首字风险;真要实现得走系统回采 AEC,见后续讨论。
- **测试:** `listen.test.ts` 新增 `wantsNativeCapture()` 的四种模式/回退断言;`child-capture.test.ts` 原有 native 用例保持通过(缺省 listen 仍按 command/interject 开原生);`pnpm typecheck`、voice 101 例串行、host+helper 45 例通过。
- **装机:** 只改语音子进程,不需要重启 DSH;替换 `dist/voice/lib/child.js` 后 kill 语音子进程,host 会在 1 秒内重新 fork(见第 26 节)。

## 29. 试用全软件 AEC:完全不启 VPIO(2026-10-24,分支 feat/voice-software-aec)

现象:TTS 一开始播报,系统音量突然变低;这是 `interject` 切到 VPIO 后 ducking 作用于包括 TTS 在内的整个输出。第 28 节的“按 mode 启用 VPIO”只能把压低限制在展开时,不能消掉 TTS 播报时的突变。

- **试用分支:** `feat/voice-software-aec`,从 `docs/orb-voice` 分出;语音侧取 `18737dd` 的软件 AEC,不再默认拉起原生采集。
- **实现:** 生产环境走 `node-cpal` 普通采集;`packages/voice/src/aec.ts` 用实际送喇叭的 TTS PCM 做参考,按 16 kHz 采样帧对齐,500 ms 互相关锁 bulk delay,256 抽头 NLMS 做残差消除,滤波在 `aec-worker.ts` 独立线程。子进程 `mic` 消息上报 `aec:true`,所以 Host 现有的 `bodyBusy && !echoCancel` 降级判断仍会放行 `interject`,这次没有改 Host;`DSH_ORB_VOICE_AEC=native` 可退回 VPIO 实验,`off` 退回纯文字过滤。
- **效果:** 不启 VPIO,所以系统音量在收起、展开、TTS 播报、Agent 执行时都不再被压低。代价是软件 AEC 只消球自己的 TTS,不消浏览器/音乐/视频;这些声音会进 ASR,靠 `echo.ts` 的文字过滤兜底。
- **边界:** 回声抑制量约 5.7 dB,弱于 VPIO;双讲时靠文字过滤。外部声音大时,插话/命令识别可能被干扰。
- **测试:** `pnpm typecheck`;voice 102 例串行(含新增 `aec.test.ts`);host+helper 45 例;`pnpm build`。
- **装机:** 只改语音子进程;把 `dist/voice` 的新 `child.js` / `aec-worker.js` 等同步进 profile,kill 语音子进程即可,不需要重启 DSH。
- **未合入:** 本分支是试用分支;第 28 节的 VPIO 限定策略仍留在 `docs/orb-voice`。Host 的 `listen.ts` 降级条件没有改,若 AEC 失败/关闭,正文播报期间仍按旧规则停止插话。

## 30. 软件 AEC 试用补丁:TTS 期间不喂 VAD + KWS 早停(2026-10-24, feat/voice-software-aec)

现象:第 29 节的软件 AEC 单独上线后,TTS 残响仍高于 VAD 阈值;圆点常亮、ASR 一直转 TTS,插话被并进 TTS 段后按回声丢掉。

- **修法:** TTS 播放期间不把 AEC 输出喂给 VAD/电平条;用 sherpa-onnx 流式 KWS 在**原始麦克风**上听 `interjectKeyword`。命中后发 `barge`,Host 立即 `stop-speak` 并静音本轮剩余正文,但保留 Agent 任务。
- **命令捕获:** barge 时把最近约 500ms 原始麦克风 seed 给 VAD,再继续喂 AEC 输出;ASR 回来用 `cutAtKeyword()` 丢掉关键词及之前内容,`stripEcho()` 清理 TTS 尾巴;utterance 带 `interject:true`,Host 不再要求文本里有关键词。
- **圆点:** TTS 期间 VAD 不工作,所以圆点不亮、ASR 不转 TTS;barge 之后圆点才亮,表示正在转写用户命令。TTS 结束没有 barge 时保留 500ms 静默期,避免 AEC 队列里的尾巴再点亮。
- **边界:** 插话要通过关键词触发(KWS 或 ASR 兜底);外部视频/音乐仍会进 command 模式 ASR;KWS 在 TTS 里听到关键词可能误停(停播比把 TTS 上屏安全)。
- **测试:** `echo.test.ts` 关键词切点/trim;Host `barge` 停播与 `interject:true` 用例;后续补 TTS 期间不喂 VAD 的集成验收。
- **装机:** Host 和子进程都改,必须重启 DeepSeek Harness。

## 31. 系统回采 AEC:CoreAudio process tap + 连续参考(2026-10-24, feat/voice-software-aec)

第 30 节把 TTS 期间的 VAD 关掉、只靠 KWS,插话仍然受关键词漏检影响;而且软件 AEC 的参考只有 TTS,外部视频/音乐仍会进 ASR。这一节把参考换成**整个系统输出**。

- **回采:** macOS 14.2+ 的 CoreAudio process tap。新增原生 helper `packages/voice/native/macos-system-audio.swift`:`CATapDescription(stereoGlobalTapButExcludeProcesses: [])` 建全局 tap,私有 aggregate device 只含 tap,`AudioDeviceCreateIOProcIDWithBlock` 读 48 kHz 输出,downmix 成 mono Float32 从 stdout 输出。`muteBehavior = .unmuted`,不改变默认输出设备,不需要 BlackHole/多输出设备。
- **子进程:** `SystemTapCapture` 把 helper 的 48 kHz mono 用 `sherpa.LinearResampler` 降到 16 kHz,作为 `EchoCanceller` 的连续参考。`setContinuous()` 只在第一次拿到 tap PCM 时锚定当前麦克风帧,之后 TTS 的 `setActive()` 不再重置参考;滤波器 1024 抽头、步长 0.04,权重跨句保留。TTS 播放路径不再喂自己的 PCM 参考,避免两个参考混在一起。
- **听法:** 有系统参考时 VAD 在 TTS 期间**继续工作**,不再置零/不再 `vad.reset`;圆点只在 VAD 真的检测到人声时亮。KWS/barge 保留为早停手段,漏检时 ASR 也能在 TTS 里听到关键词。
- **回退:** helper 缺失、启动失败或没有 tap 数据时,`systemReference=false`,回到第 30 节的 TTS 参考 + VAD 抑制 + KWS;原生 VPIO 仍可用 `DSH_ORB_VOICE_AEC=native` 强制。
- **验证:** helper 单独跑,48 kHz 输出在 `say` 期间 peak 0.63、RMS 0.097;`aec.test.ts` 新增连续参考用例(1024 抽头)通过;voice 113 例串行、host+helper 46 例、typecheck 通过。装机日志:`system-aec ready rate=48000`、`system-aec reference on`,helper 进程在跑。
- **边界:** 第一次启动 tap 约 0.5–0.8 s,这期间没有参考;tap 启动前已经播放的声音无法消。外部视频/音乐也会被回采,但 AEC 只按线性房间路径消,非线性/削波残留仍可能进 ASR。系统输出设备切换时 tap 是否跟随需要真机验收。
- **装机:** 只改语音子进程和 helper,Host 不再改;把 `dist/voice` 和 `prebuilds/darwin-universal/dsh-orb-system-audio` 同步进 profile,kill 语音子进程即可,不需要重启 DSH。
