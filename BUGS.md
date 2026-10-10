# dsh-orb 缺陷清单

静态阅读当前源码后的缺陷记录。没有改代码，也没有在桌面端把每一条都跑一遍。下面每一条都能在对应文件里对上错误的分支或公式。

划词工具栏在 README 里已经强制关闭，相关问题单独放在最后，当前用户路径走不到。

## 高

### 1. `web_fetch` 卡片抛 `ReferenceError`，同一帧后面的对话更新被丢掉

`packages/helper/assets/shell.js` 的 `buildWebCard` 在抓取结果上写了 `fetch.append(url, meta)`。`url` 在这个模块里没有定义，执行到这里就是 `ReferenceError`。HTTP 状态和截断标记也因此挂不上去。

`stage()` 先把这一帧的消息从队列里拿出来，再逐条绘制，循环外面没有 `try/catch`。工具卡片在抛错前已经把正文清空。一次 `web_fetch` 结果会留下一张空卡片，同一帧里排在它后面的块和回合状态都不会画出来。

### 2. 重叠截图时，悬浮球的遮罩会被提前关掉

`packages/host/src/overlay-guard.ts` 的 `withCapture` 只在深度从 0 变成 1 时发送 `overlay-capture active: true`。结束时只要这次调用发过 begin，就在自己的 `finally` 里发送 `active: false`，不看此时是否还有别的截图在进行。

Helper 侧 `packages/helper/src/cloak.ts` 对 capture 是引用计数。第一次调用的 end 会把计数减到 0，第二次截图仍在读屏幕。截图不在屏幕锁里，两个 Computer Use 会话可以重叠。结果是悬浮球、工具条或观察框出现在模型看到的截图里。

### 3. Windows 延迟更新和用户重新打开应用抢同一份包

`packages/host/src/deferred-install.ts` 里，退出后的脚本只等旧进程消失，再睡 1.5 秒就执行 `pnpm add`。没有一个进行中的标记让下一次启动能看见。`takeDeferredOutcome` 只读 `pnpm` 结束后才出现的 `result.json`。

设置页会提示退出再打开。用户如果在 `pnpm` 替换 `dsh-orb` 的过程中重新打开，会加载或锁住写了一半的包。这正是这条路径想避开的 `EPERM`，安装也可能停在半删除状态。

### 4. 延迟安装丢掉已经批准的原生模块构建

`packages/host/src/update.ts` 的 `install(approvedBuilds)` 只把批准列表传给进程内的 `installBundle`。Windows 上如果探测到已映射的原生镜像，或者 `pnpm` 随后报文件锁，`deferUntilExit` 只保存 `profileDir`、`spec`、`registry`、`parentPid`。退出后的脚本始终是普通的 `pnpm add`。

包依赖 `koffi`，所以进程内路径才有 `pendingBuilds` 和“允许构建”的重试。走文件锁这条路时，用户在设置里批准构建不会到达 `pnpm`。更新会跳过 `koffi` 的构建，或在每次退出后以同样的方式失败。

### 5. Windows 点击丢掉修饰键，结果却报告成功

`packages/computer-use/src/plugin.ts` 接受 `modifiers`，并传给 `backend.click`。macOS 后端会按住这些键再点击。`packages/computer-use/src/windows.ts` 的 `click` 不读 `input.modifiers`，只移动并点击。工具结果仍会回显模型请求的修饰键。

Shift 多选、Ctrl 点链接、Alt 点菜单都会变成普通点击。模型以为修饰键已经按住。

### 6. Windows 提权窗口判断看的是前台进程，失败时放行

`packages/computer-use/src/windows-native.ts` 的 `targetBlocksInput` 只比较**当前前台窗口**的完整性级别和本进程。读 token 失败得到 `undefined`，被当成“没有提权”。`packages/computer-use/src/windows.ts` 的 `hotkey` 在这个检查之前就调用 `SetForegroundWindow`。

悬浮球或其他非提权窗口在前台、被观察的窗口是管理员程序时，点击和输入会被放行。UIPI 随后静默丢掉 `SendInput`，没有错误。`hotkey` 则会报“无法移动键盘焦点”，并让模型改去点击，而点击正是这条静默失败的路径。

### 7. Windows 热键焦点是全局的，且截图会在没有锁的情况下改写它

`createWindowsDesktopBackend` 在 `packages/computer-use/src/index.ts` 里只构造一次，所有会话共用。`listScreens` 把选中的窗口写进闭包里的 `observed`。`hotkey` 发键之前会把焦点切到这个 hwnd。

`wait`、`long_wait`、`screenshot`、`list_apps` 和首帧预览都会调用 `listScreens`，而且不经过 `withScreenLock`。会话 B 的截图可以换掉会话 A 刚记住的窗口。会话 A 的下一步 `hotkey`（例如 Ctrl+W）会激活 B 的窗口并在那里按键。

### 8. macOS 桌面截图上的光标圆环上下颠倒

`packages/computer-use/src/macos-sck-capture.swift` 的 `compositeCursor` 在需要排除悬浮窗时运行。指针的 `point.y` 是距捕获区域**顶部**的距离。Core Graphics 上下文原点在左下角。

光标位图用 `image.height - top` 做了翻转。圆环直接画在 `point.y` 上，没有翻转。指针在窗口顶部时，圆环出现在底部，反过来也一样。光标精灵仍靠近真实位置，模型被要求相信的那个圆环指向错误的行。

### 9. 排队中的 `code_agent` 跟进会被当成上一轮已经结束

`packages/computer-use/src/code-agent-completion.ts` 的 `intervalHasStarted` 在 `code.status === 'running'` 时直接返回真，即使这次 `requestId` 还在收件箱里。跟进任务排在正在跑的回合后面时，监视器不等这次提示被取走，就对**当前**回合调用 `whenIdle()`。

当前回合结束、排队提示还没开始的那一段空档会让监视器收工。完成通知引用的是上一轮的 `lastAssistantText`。真正的跟进随后运行，但已经没有监视器在看它。

### 10. 取消 macOS 长按时，鼠标按键会保持按下

`packages/computer-use/src/macos.ts` 把按下和抬起放在同一个 `osascript` 里。`runHidScript` 把工具的 `AbortSignal` 交给子进程，取消会杀掉这个进程。Node 侧没有再补一次抬起。

`long_press` 会按住 1 到 10 秒，取消回合时很容易停在 `LEFT_DOWN` 和 `LEFT_UP` 之间。之后的点击会变成拖拽。`click`、`drag` 和带修饰键的点击也是同一个窗口：修饰键已经按下，抬起还在被杀掉的脚本里。Windows 的 `longPress` 在 `finally` 里会抬起，这条路径做不到。

### 11. 完成态的后台任务芯片画出 `[object SVGSVGElement]`

`packages/helper/assets/icons.js` 的 `icon()` 返回 SVG 元素。`packages/helper/assets/shell.js` 的 `agentChip` 在完成、停止、结束三种状态里执行 `status.innerHTML = icon(...)`。把元素赋给 `innerHTML` 会把它转成字符串。

进行中状态正确地 `append` 了一个转圈。另外三种状态的图标槽显示文字 `[object SVGSVGElement]`，而不是勾、停止或警告图标。

## 中

### 12. 段落软换行被粘成一行，紧跟的表格被吃进段落

`packages/helper/assets/markdown.js` 的 `renderParagraph` 用空字符串拼接连续非空行。只有行尾两个空格或反斜杠才插入 `<br>`。`isBlockStart` 认识标题、围栏、引用、列表和分隔线，不认识表格行。

CommonMark 的软换行应渲染成空格。`Hello\nworld` 会变成 `Helloworld`。模型经常在一句话后面直接写表格；没有空行时，`| a | b |` 不会成为块边界，整张表变成段落里的原文。现有测试只覆盖了空行之后的表格。

### 13. 终端、阅读、搜索卡片上的复制按钮没有绑定

`wireCopyButtons` 只从 `renderMarkdownBody` 调用。`buildTerminalCard`、`buildReadCard`、`buildSearchCard` 会创建 `.term-copy`、`.cb-copy`、`.search-copy`，但不会走这个绑定。

绑定逻辑还只复制卡片里的 `pre`。终端输出和搜索结果是普通 `div`，即使补上监听，复制到的也是空字符串。Markdown 代码块的复制仍然有效。

### 14. “展开更多”点一次后按钮消失

`packages/helper/assets/shell.js` 的 `cappedRows` 在点击时先 `expand.remove()`，只有 `open` 变回 false 才把按钮放回去。打开时走不到放回的分支，按钮已经离开文档。

阅读、搜索、diff 卡片都用这个函数。多出来的行会出现一次，之后没有控件可以收起。

### 15. 延迟加载的语法高亮不会再刷已完成的代码块

`packages/helper/assets/highlight.js` 用 `WeakRef` 记住根节点。语法加载完成时，回调把 `WeakRef` 本身传给 `upgradeCodeBlocks`。那个函数要求参数有 `querySelectorAll`，`WeakRef` 没有，于是直接返回。`deref()` 没有被调用。

TypeScript、shell、JSON 随包加载，不受影响。Python、Go、Rust 等延迟语法如果在代码块定稿之后才到达，这块代码会一直保持纯文本。流式更新故意跳过高亮，定稿后的这一次是唯一机会。

### 16. 设置页重新获得焦点时，会用旧的 GET 覆盖正在保存的值

`packages/client-settings/client.js` 在每次 `window` `focus` 时调用 `load()`，用 GET 结果整份替换 `snapshot`，并把 `busy` 设为 false。`mutate()` 用 POST 结果做同样的事。两次请求没有序号。

`window.confirm`（毫分坐标开关）会在 `mutate()` 开始前让窗口获得焦点，GET 和 POST 同时在飞。文件选择器和保存过程中切回窗口也是同一竞争。后到的响应胜出，页面可以在服务端已经存好新头像、模型或毫分坐标之后，跳回旧值。`packages/bundle/client.js` 里是同一段逻辑。

### 17. Windows 点击和拖拽在等待被取消时不抬起按键

`longPress` 在 `finally` 里抬起。`clickAt` 和 `drag` 是按下、`await delay`、再抬起。50 毫秒按住、双击间隔或拖拽步进期间如果 abort，`delay` 拒绝，抬起执行不到。`chord` 同样：20 毫秒修饰键间隔里取消，Ctrl、Alt 或 Win 会保持按下。

### 18. macOS Fn 标志用错了位

`packages/computer-use/src/macos.ts` 里 `FLAG_FN` 是 `0x00008000`。`kCGEventFlagMaskSecondaryFn` / `NX_SECONDARYFNMASK` 是 `0x00800000`。

带 `fn` 的热键会设置一个 AppKit 不当成 Fn 的位，功能键组合不会被识别成 Fn 和弦。

### 19. macOS 热键表没有 F4

Apple 的 `kVK_F4` 是 `0x76`（118）。键表有 F1–F3 和 F5–F20，从 `pageup: 116` 直接跳到 `end: 119`。`hotkey ["f4"]` 在 macOS 上抛 `unknown key`。Windows 接受 F1–F12。

### 20. 多个修饰键抬起时，第一次就把全部标志清掉

`clickWithModifiers` 在每个键按下时带上完整的修饰掩码，抬起时 `postKey` 的 flags 是 `0`。Cmd+Shift 点击或三键热键里，第一个键抬起就告诉 Core Graphics 已经没有任何修饰键。和弦会提前松开，或者某个修饰键卡住。

### 21. 热键名 `delete` 在两个系统上不是同一个键

macOS 把 `delete` 和 `backspace` 都映射到键码 51（`kVK_Delete`，退格）。Windows 把 `delete` 映射到 `VK_DELETE`（`0x2E`，向前删除），`backspace` 才是 `0x08`。同一份工具说明里的 `hotkey ["delete"]` 在 macOS 删光标前的字符，在 Windows 删光标后的字符。macOS 也没有 `kVK_ForwardDelete`（117）的名字。

### 22. 截图矩形和点击坐标对小数窗口框的取整不一致

`regionCaptureSpec` 对 `screencapture -R` 分别 `round` 原点、宽和高。点击用 `round(x + 比例 * width)`，用的是没有先取整的框。

窗口在 `x = 100.4`、`width = 200.4` 时，图像覆盖全局 `[100, 300)`。25% 处的点击是 `round(100.4 + 50.1) = 151`，对应图像列是 51，而图像上 25% 的列是 50。CGWindow 的框经常带小数，边缘和窗口中部的点击会偏开模型看到的控件。

### 23. Windows `open_app` 会激活标题里包含名字的第一个窗口

`packages/computer-use/src/windows-native.ts` 的 `activateApp` 按 Z 序从上到下找。进程名要完全相等，窗口标题则是 `title.includes(wanted)`。`open_app("code")` 可以激活标题里带 “source code” 的浏览器标签，只要它排在 `Code.exe` 前面。`open_app("word")` 可以命中任何可见标题里的 “word”。工具随后返回 `activated`。

### 24. 打开路径的黑名单只有 Unix 前缀

`packages/computer-use/src/open.ts` 的 `PATH_BLACKLIST` 是 `/System`、`/etc`、`/usr` 等。注释要求在 `realpath` 之前就拒绝系统路径，这样 `/etc` 在 Windows 上也能读成禁止。`C:\Windows`、`C:\Windows\System32`、`C:\Program Files` 都不会命中，`open_in_finder` 会打开它们。

### 25. 粘贴后恢复剪贴板时只保留字符串

macOS `pasteText` 和 Windows `typeText` 都只读出文本格式，清空剪贴板，粘贴，再写回那个字符串。用户复制的图片或文件列表没有文本，或者只有附带的文本。每次 `input_text` 之后，剪贴板变成空字符串或残缺字符串。

### 26. `screenshot` 改剪贴板时不持有屏幕锁

`typeText` 在粘贴和恢复剪贴板的整段时间里持有 `withScreenLock`。`screenshot` 的 `copyImageToClipboard` 没有这把锁。另一个会话的截图可以插在“写入文本”和 Ctrl/Cmd+V 之间；粘贴的 `finally` 也可以用旧文本盖掉用户刚复制的截图。

### 27. 继续同一个 `code_agent` 时，上一轮完成监视不会取消

`packages/computer-use/src/code-agent.ts` 的 `recordDelegation` 把新的 `AbortController` 追加进 `watches`，旧的继续跑。`code-agent-registry.ts` 的 `record` 会卸掉上一条书签的事件订阅，但不会 `abort` 旧控制器。`code_agent_stop` 才是唯一会中止这些控制器的路径。

会话在排队的跟进期间一直保持运行时，旧监视器的 `whenIdle()` 会在后来的空档里resolve，并用新任务的 `lastAssistantText` 去报告旧任务。

### 28. Windows 键发送时没有 `KEYEVENTF_EXTENDEDKEY`

`VK_LWIN`（`0x5B`）的扫描码是 `E0 5B`，属于扩展键。`EXTENDED_KEY_NAMES` 包含方向键和 `delete`，不包含 `win`、`cmd`、`meta`。`hotkey ["win"]` 或 `["win","e"]` 发出去时扩展位是 0，开始菜单和 Win 组合键不会登记。`tests/windows.spec.ts` 期望 `key:91:down:0`，把这个行为记成了正确结果。

### 29. Windows 前台记忆可能停在悬浮球自己身上

`packages/host/src/orb.ts` 的 `accept()` 在处理 `hello` 时立刻 `foreground.start()`，并马上采样一次。`chrome-windows` 是同一条连接上的下一条消息，第一次采样时 chrome 列表还是空的。

如果悬浮球在 `loadFile` 之后、连接建立之前已经是前台（用户点了球），它的 HWND 会被记住。之后的采样会跳过已经进入 chrome 列表的 HWND，但不会清掉 `remembered`。提交时 `SetForegroundWindow` 把焦点还给悬浮球，Computer Use 会把球当成用户正在用的应用。

### 30. 后一条被中断的消息会把上一条已经完成的回答标成中断

`onAssistant` 先把 `turnInterrupted` 设为真，再降级上一条最终回答。`block()` 在这个标志为真时，给每个已经结束的 assistant 块加上 `interrupted: true`。降级发生时标志已经打开，`responseKeys` 也已清空，上一条回答会被重新发布成“已中断”。

停止半截回合时，更早的那条完整回复也会被画成中断。

### 31. 停止回合在取消失败时仍把界面标成已停止

`stopTurn` 在 `sessionController.cancel` 抛错后只打日志，然后仍然 `drain()` 和 `finishTurn()`。`finishTurn` 也不绑定被停止的那一回合。`await cancel` 期间 `onPrompt` 可以开始新的提示，这次停止会把新回合标成结束。

球上显示已停止，代理仍在跑；或者刚在停止之后发出的消息立刻显示为结束。

### 32. 被替换的流式尝试仍会接收后续分片

新的 `start` 对同一 turn/step 会丢掉旧尝试的块，但不会从 `attemptPositions` 里删除旧的 `attemptId`。只有 `end` 帧会删。旧尝试的后续 chunk 仍能解析到这个 turn/step，并写回刚刚清空的步骤。

重试时，已经放弃的半截回答会混进新回答。这只在旧尝试的 chunk 晚于新 `start` 到达时发生。

### 33. 镜像 404 会把 GitHub 失败显示成“没有新版本”

`curlText` 把 HTTP 404 变成 `''`，不是 `undefined`。`fetch` 把任何非 `undefined` 的响应都记成 `answered = true`，包括这个空的 404。随后 GitHub 传输失败返回 `undefined` 时，函数因为 `answered` 已置位而返回 `null`。`check()` 把 `null` 当成仓库明确回答“没有 release”，清掉 `error` 并写入 `checkedAt`。

镜像尚未同步、GitHub 又不可达时，设置卡片显示检查成功、没有更新、也没有网络错误。自动检查会因此静默一小时。

### 34. Electron 运行时的下载锁可以在持有者还活着时被抢走

`packages/host/src/electron-runtime.ts` 的失败者在 `mkdir` 冲突后立刻调用 `lockExpired`。胜者已经建好目录、还没写 `owner` 文件时，读文件失败落入 `catch`，被当成锁已过期。失败者删掉锁并开始自己的下载。`process.kill(pid, 0)` 的任何错误，包括 `EPERM`，也被当成进程已死。同仓库的延迟安装脚本把 `EPERM` 当成进程仍在。

两次首次运行可以解压到同一个运行时目录，留下损坏的 Electron。

### 35. 遮罩确认超时被当成成功

`packages/host/src/orb.ts` 的 `waitAck` 在 1 秒内没有 `overlay-ack` 时调用 `finish(false)`，Promise resolve。中止才会 reject。`withCapture` 随后照常截图。

Helper 卡住或太慢时，截图里仍然有悬浮球。

## 低

### 36. 对话超过 200 块时，宿主删了块但不通知球

`packages/host/src/orb.ts` 的 `block()` 在超过 200 条时只从 `blockOrder` 和 `blocks` 里删最旧的一项。真正通知球的是 `dropBlock`，它会发 `block-drop`。这条上限路径不发。

长会话之后，球上仍留着宿主已经忘掉的块，其中包括仍标记为进行中的块。

### 37. 设置 POST 的非法 JSON 没有响应

`packages/host/src/routes.ts` 的 `readJson` 直接 `JSON.parse`，更新、模型、跳转和开关这些路由都没有 catch。头像上传单独处理了“太大”。解析失败时处理函数在 `writeHead` 之前就拒绝。

坏的 POST 会挂住设置请求。官方 web 服务器如果不接住这个拒绝，它会变成未处理的 rejection；本插件已经把未处理 rejection 视为会退出官方宿主的情况。

### 38. 吸边复原忽略左右任务栏

`packages/helper/src/geometry.ts` 的 `insideBallOrigin` 用显示器 `bounds` 加 5 像素算 x，y 则夹在 `workArea` 里。底部任务栏在工作区之外，y 会躲开它。左右任务栏同样在工作区之外，x 不看工作区。停靠标签也贴着 `bounds`。

有侧边任务栏时，标签会钻到任务栏下面，球滑回来时也在任务栏下面。自由拖动走 `clampedBallOrigin`，那条路径仍留在工作区内。

### 39. 仓库里提交的 bundle 设置页缺少“延迟更新”提示

`packages/client-settings/client.js` 的 `updateNotice` 有 `update.deferred` 分支和 `updateDeferred` 文案。`packages/bundle/client.js` 是 `dsh-orb/client` 在 `assemble.mjs` 覆盖之前导出的那份，它的 `updateNotice` 只有更新中、错误、需要重启和有新版本，没有 deferred。

宿主在新文件替换不了已加载的原生镜像时会广播 `state: 'deferred'`。这份已提交的客户端不渲染该状态。`pack.mjs` 会先从 `client-settings` 重新组装，新打出来的 tarball 是对的。直接链接当前仓库树安装则不是。延迟更新之后，这个设置页既不显示失败，也不提示退出再打开。球自己的状态行仍会说。

### 40. Windows 光标半透明边缘按直通 alpha 混合

`packages/computer-use/src/cursor.ts` 把 `GetDIBits` 得到的 32 位光标按直通 alpha 混合。若这些颜色已经预乘，半透明边缘会偏暗。不透明像素（alpha 255）不受影响，热点也不变。

这个前提还没有被证实。`tests/cursor.spec.ts` 把直通公式写成了期望值。修复方案把它标成待验证，本次不要改混合公式。确认 `GetDIBits` 的输出之后再决定改不改。

## 已关闭的划词工具栏

README 写明入口已去掉，偏好里强制关闭。下面的问题在代码里，当前不会出现在界面上。

### Windows 选区锚点不是 DIP，没有矩形时落到 (0, 0)

`packages/native-selection/src/windows-native.js` 在 `GetBoundingRectangles` 没有四个数时仍输出 `x = 0`、`y = 0`。`packages/native-selection/src/windows-dispatch.js` 只要这两个字段是数字就带上坐标。`packages/host/src/selection.ts` 用它们覆盖鼠标抬起时的锚点。脚本没有把物理像素换成 DIP。观察框在 Windows 上会走 `screenToDipRect`，选区不走。

有文字但没有矩形时，工具条锚在虚拟屏幕原点。有矩形时，坐标是 PowerShell 进程的屏幕坐标。100% 单显示器上可能重合；125%、150% 或混合 DPI 时对不齐。

### Windows 选区读取可以乱序返回

每次左键抬起都新开一次 `powershell.exe`（最长约 1.5 秒），没有代次。较新的空读取可以先结束并被忽略，较旧的读取随后发出用户已经点掉的选区。鼠标按下只会藏起工具条，这条事件会把它再显示出来。

### macOS 双击和三击不读选区

`packages/native-selection/src/macos-selection.swift` 只在按下后移动至少 8 像素时才在左键抬起读取选区。双击选词和三击选段达不到这个位移，`shouldRead` 保持 false。Windows 在每次左键抬起都读，两边不一致。工具条在 macOS 上只会在拖选之后出现。
