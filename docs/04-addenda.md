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
