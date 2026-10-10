# dsh-orb 缺陷修复方案

给研发的实施说明。条目编号与 [BUGS.md](BUGS.md) 一致。每条都写了根因、要改的函数、改完的行为，以及建议补的测试。按下面的分组提交，同一组里的改动共享状态，不要拆开。

本文已按 [FIX-PLAN-REVIEW.md](FIX-PLAN-REVIEW.md) 改过一版，并根据二轮复核把三处会实施错的地方写实了：第 7 条的落点（`windowId` 现在到不了插件层，要动五个文件）、第 26 条的 `screenLockState` 导出、第 31 条的 epoch 比较位置。第 40 条不进入本次修复，先做真机验证。

实施前先跑一遍现有套件，改完再跑对应包的测试：

```sh
pnpm typecheck
pnpm test
```

Windows 输入、macOS HID、延迟安装这几组还需要在对应系统上做一次手工验收，单测覆盖不到真实按键和 `pnpm`。

## 建议的提交顺序

| 顺序 | 分组 | 条目 | 原因 |
| --- | --- | --- | --- |
| 1 | 悬浮球对话渲染 | 1、11、12、13、14、15 | 纯前端，可独立验证 |
| 2 | 宿主回合与遮罩 | 2、29、30、31、32、35、36 | 第 2 条和第 35 条必须同一提交，否则 abort 会把遮罩泄漏成永久隐身 |
| 3 | Windows 输入（接口） | 28、23、6 | 先改键标志和查询接口，后面的点击与热键才接得上 |
| 4 | Windows 输入（热键与按住） | 7、5、17 | 第 7 条依赖第 6 条的完整性查询、第 2 条的遮罩深度，还要打通 `backend.ts` / `observe.ts` / `coordinate-mode.ts` 三层才能把 `windowId` 送到插件层 |
| 5 | macOS 输入与截图 | 8、10、18、19、20、21、22 | 都在 `macos.ts` 的 JXA / 捕获路径。第 8 条要连二进制一起提交 |
| 6 | 剪贴板与打开 | 24、25、26 | 会改工具的副作用 |
| 7 | 后台 code agent | 9、27 | 完成通知的时序 |
| 8 | 更新与运行时 | 3、4、33、34、39 | 第 34 条按文中的 rename 方案做，不要用目录 mtime |
| 9 | 设置页与路由 | 16、37 | 第 16 条要连两个轮询入口一起改 |
| 10 | 几何 | 38 | 吸边 |
| 11 | 划词（功能仍关闭） | 文末三条 | 修完不要自行打开入口 |
| — | 待验证，本次不改 | 40 | `GetDIBits` 是否预乘还没有证据，盲改公式会打红现有测试 |

## 1. 悬浮球对话渲染

### 1. `web_fetch` 卡片抛错，丢掉同一帧后续更新

根因：`buildWebCard` 把不存在的变量 `url` 传给 `append`。`shell.js` 是 ES module，这是 `ReferenceError`。`stage()` 已经把这一帧 `splice` 出队列，循环里没有 `try/catch`，抛错后后面的 `block` / `turn` 不再绘制，工具正文也已经被清空。

改 `packages/helper/assets/shell.js`：

- `fetch.append(url, meta)` 改成 `fetch.append(meta)`。URL 在上一行已经挂上。
- `stage()` 的 `for` 循环里，每条消息单独 `try/catch`。失败时 `console.error` 这条消息，继续画后面的消息。不要把整帧丢回队列，那些对象已经不在 `staged` 里了。

验收：一条 `web_fetch` 结果能看到 URL、HTTP 状态，截断时能看到截断标记。同一帧里排在它后面的文本和 `turn` 仍然出现。

测试：给 `buildWebCard` 或渲染入口加一个 fetch 模型用例，断言卡片含 `.web-fetch-meta`，且不抛错。

### 11. 完成态任务芯片显示 `[object SVGSVGElement]`

根因：`icon()` 返回的是 SVG 元素。`agentChip` 对完成 / 停止 / 结束三种状态写了 `status.innerHTML = icon(...)`。元素转字符串就是这段文字。进行中状态用的是 `append`，所以只有那三种坏。

改 `agentChip`：三种结束状态都改成 `status.replaceChildren(icon(...))`。不要再把返回值赋给 `innerHTML`。

验收：完成、停止、结束的芯片状态槽里是 SVG，文本里没有 `[object SVGSVGElement]`。

### 12. 软换行粘在一起，紧挨着的表格进了段落

根因：`renderParagraph` 用 `''` 拼接。CommonMark 软换行是空格，硬换行（行尾至少两个空格，或行尾 `\`）才是 `<br>`。`isBlockStart` 不认识表格，段落循环会把 `| a | b |` 吞进去，到不了后面的 `renderTable`。

改 `packages/helper/assets/markdown.js`：

- 软换行默认拼一个空格。已经以空白结尾的行不要再加空格。硬换行逻辑保持不动。
- 拼接处左右两侧都是 CJK（汉字、假名、谚文）时不要插空格。`注意\n如下` 仍是 `注意如下`。只有至少一侧不是 CJK 时才插空格，例如 `Hello\nworld`、`结果\nOK`。这是产品取舍：CommonMark 一律插空格，中文句子中间多一个空格会被当成新 bug。
- 段落循环在吃下一行之前，若当前行是表格行且下一行是分隔行（现有的 `isTableRow` / `isSeparatorRow`），把这一行留给后面的表格分支，不要推进 `paragraph`。

验收：

- `Hello\nworld` 渲染成 `Hello world`，中间有空格。
- `注意\n如下` 渲染成 `注意如下`，中间没有空格。
- `注意\n\n| x | y |\n| --- | --- |\n| 1 | 2 |` 仍是表格。
- `结果如下\n| x | y |\n| --- | --- |\n| 1 | 2 |` 也是表格，前面的句子单独成段。

在 `packages/helper/tests/markdown.test.ts` 补这两则。现有测试只覆盖了空行之后的表。

### 13. 终端、阅读、搜索卡片的复制按钮没有监听

根因：`.term-copy`、`.cb-copy`、`.search-copy` 是 DOM 建出来的，`wireCopyButtons` 只在 `renderMarkdownBody` 里调用。即便调用了，它也只读 `pre` 的文本。终端输出和搜索结果是 `div`，读出来是空字符串。阅读卡的 `pre` 里还有行号。

改 `shell.js`：

- 抽出 `copyText(button, text)`，点击时 `stopPropagation`，把传入的字符串写入剪贴板。
- 建卡时就绑定，不要依赖 markdown 渲染：
  - 终端：复制命令，再加上 `.term-line` 的输出。没有输出时只复制命令。
  - 阅读：只复制 `.read-content` 的文本，按行拼接，不带行号。
  - 搜索：复制摘要和每条匹配的文本。
- Markdown 代码块继续走 `pre`。

验收：三类卡片点复制，剪贴板里是对应正文。终端卡目前没有整卡折叠，不要把“不会展开或折叠卡片”写成验收。点复制时 `stopPropagation`，不触发标题栏上别的点击行为。补两个用例：终端没有输出时只复制命令；阅读卡复制的正文不含行号。

### 14. “展开更多”点一次后按钮被摘掉

根因：`cappedRows` 的点击处理每次都 `expand.remove()`。打开时 `open === true`，后面那个“再插回去”的分支进不去。收起路径因此也到不了。

改点击处理：按钮一直留在 `target` 末尾。打开时把 `rows.slice(cap)` 追加到按钮前面；收起时把这些行 `remove()`。文案在 `chatLabels.collapse` 和 `` `… ${rows.length - cap}` `` 之间切换。不要 `expand.remove()`。

验收：超过上限的 diff、阅读、搜索卡片可以展开再收起，按钮始终在。

### 15. 延迟语法加载完成后不会重绘已定稿的代码块

根因：`tracked` 里存的是 `WeakRef`。`subscribeGrammarLoaded` 的回调把 `WeakRef` 交给 `upgradeCodeBlocks`。该函数发现参数没有 `querySelectorAll` 就返回。`deref()` 没有被调用。流式过程故意不高亮，定稿后的这一次若语法还没到，就再也没有机会。

改 `packages/helper/assets/highlight.js`：

```js
module.subscribeGrammarLoaded(() => {
  for (const ref of tracked) {
    const root = ref.deref()
    if (root) void upgradeCodeBlocks(root, { track: false })
  }
})
```

`upgradeCodeBlocks` 增加 `track` 参数，默认 `true`。回调里传 `false`，避免每次加载语法都再塞一个新的 `WeakRef`。`sweep` 继续删掉 `deref()` 为空的项。

验收：一个 Python 代码块先以纯文本定稿，语法包随后加载完成，这块的 `pre.cb-plain` 被换成高亮节点。TypeScript 这种随包语法的行为不变。

## 2. 宿主回合与遮罩

### 2. 重叠截图时先结束的调用把遮罩关掉

根因：`withCapture` 用调用本地的 `sentBegin` 决定要不要发 `active: false`。深度从 1 变到 2 的那次调用不发 begin。先返回的那次仍因为自己的 `sentBegin` 发 end。Helper 的 `cloak.ts` 是引用计数，这一下把 capture 计数减到 0，另一路截图还在读屏。`withInput` 已经是“深度回到 0 才发 end”，capture 没有对齐。

改 `packages/host/src/overlay-guard.ts`。begin/end 跟“这一次调用”脱钩，跟深度脱钩：

- `createOverlayGuard` 闭包里增加 `captureOpen`。
- 深度从 0 到 1、当前没有 input 遮罩、helper 还在时，调用 `transport.send({ active: true })`。`waitAck` 在 Promise 执行器里同步 `broadcast`，所以 `send()` 一返回，begin 已经写到 socket。紧接着、在 `await begin` 之前把 `captureOpen` 设为 true。不要写在 `await begin` 成功之后。
- `await begin` 被 abort 或超时拒绝时，helper 已经把 capture 计数加过 1。`finally` 必须还能发出 end。标志若放在 await 之后，拒绝路径不会置位，球会一直停在 content protection 里，之后所有截图都看不到它。
- `finally` 里先减深度。只有 `captureDepth === 0 && captureOpen` 才发 `active: false`，然后把 `captureOpen` 置回 false。发 end 时不要带已经 abort 的 signal，否则 end 自己也会被取消。
- 内层调用不发 end。外层若先返回，此时深度仍大于 0，也不发 end。最后一层返回时由它发 end，即使 begin 是另一层发的。

这一条和第 35 条必须同一提交。第 35 条把超时改成 reject 之后，上面的拒绝路径会经常走到。

`packages/host/tests/overlay-guard.test.ts` 增加：两个 `withCapture` 重叠，先启动的那个先结束。发出的序列是一次 `true`、然后才是一次 `false`，`false` 出现在两个 `run` 都结束之后。再加一条：begin 已发出后 `await` 被 abort，仍然有一次 `active: false`。现有“input 内部的 capture 不再发 capture 消息”的用例保持通过。

### 29. 前台记忆把悬浮球自己记下来

根因：`accept()` 在 `hello` 里调用 `foreground.start()`，`start()` 立刻采样。`chrome-windows` 是后一条消息，第一次采样时排除列表是空的。球的 HWND 被写入 `remembered`。之后的采样见到这个 HWND 已经在排除列表里就直接 return，不会把 `remembered` 清掉。`restore()` 再把焦点设回球。

改 `packages/host/src/windows-foreground.ts` 的 `sample()`：

- 当前前台 HWND 在 `chromeWindowIds()` 里，并且它就是 `remembered` 时，把 `remembered` 置 0。
- `chromeWindowIds()` 仍为空时不要写入 `remembered`。等第一条 `chrome-windows` 到达后再采样。`accept()` 可以继续调用 `start()` 把定时器拉起来，`start()` 里那次同步采样会在排除列表为空时空跑，之后靠 `FOREGROUND_SAMPLE_MS`（250 ms）的下一次 tick 自动接上，不需要为这个消息额外挂钩。
- 已知取舍：如果 helper 始终不上报 `chrome-windows`（旧版 helper），`remembered` 会一直是 0，`restore()` 变成 no-op，首次观察可能读到球。这比记住球再把焦点还给球要安全，接受这个行为。

`packages/host/tests/windows-foreground.test.ts`：先在空排除列表下采样到球的 HWND，随后排除列表包含这个 HWND，再采样一次，`restore()` 不得对这个 HWND 调用 `focus`。

### 30. 中断标志涂到上一条已经完成的回答

根因：`onAssistant` 先执行 `this.turnInterrupted = true`，再对上一条 `responseKeys` 调用 `block()`。`block()` 看到 `turnInterrupted && kind === 'assistant' && !running` 就给块加上 `interrupted: true`。降级旧回答走的就是这条路径。

改 `onAssistant`：先用当前的 `responseKeys` 把上一条最终回答降级完，再根据 `record.interrupted` 设置 `turnInterrupted`。降级期间标志必须仍是 false。本条消息新写的、已经结束的 assistant 块才带 `interrupted`。

测试：构造“上一条 assistant 已是 response，本条 `interrupted: true`”。上一条重新广播出去时没有 `interrupted`，本条未完成的块有。

### 31. 取消失败，或取消期间来了新消息，仍把回合标成结束

根因：`stopTurn` 在 `cancel` 抛错后仍调用 `finishTurn()`。`finishTurn` 不记录它要结束的是哪一次提交。`await cancel` 期间 `onPrompt` 可以把 `turnRunning` 再次设为 true，返回后的 `finishTurn()` 会把这次新提交清掉。

改 `packages/host/src/orb.ts`：

- 增加 `turnEpoch` 和私有方法 `beginTurn()`。它负责 `turnEpoch += 1`、`turnRunning = true`、选区运行标记和 `turn` 广播。下面三处都改走它，不要只加在 `onPrompt` 里：
  - `onPrompt` 进入真正提交之前。
  - `consume` 里的 `turn/start`（约 853 行）。code agent 完成通知会从这里把回合唤醒，不经过 `onPrompt`。
  - `openSession` 里 `row.running` 为真的分支（约 1641 行）。切到一个仍在跑的历史会话也是这样。
- `stopTurn` 记下调用时的 epoch 和 `sessionId`。比较放在 `stopTurn` 自己身上，`finishTurn()` 的签名和所有调用点保持不动：`cancel` 成功、且 epoch 与 `sessionId` 都没变，才 `drain()` + `finishTurn()`。
- `cancel` 抛错时不要 `finishTurn()`。用现有的 `status()` 把失败写到球上，`turnRunning` 保持 true，等真正的 `turn/end` 再收口。
- `finishTurn()` 不要自己比较 epoch。它是 `consume('turn/end')`（约 887 行）、`onPrompt` 的 catch（约 694 行）和 `stopTurn` 三方共用的收口。`turn/end` 是回合的权威关闭者，不能被 epoch 拦住；`onPrompt` 失败时也应当场收口。只有 `stopTurn` 这一次异步等待里的竞态需要判 epoch，所以判在它那里就够。

测试：`cancel` reject 时不广播 `turn running: false`。`cancel` 挂起期间分别插入一次 `onPrompt`、一次 `turn/start`、一次打开仍在运行的历史会话，原来的 `stopTurn` 返回后新回合仍是 `running: true`。

### 32. 旧的流式 attempt 还能把字写回来

根因：同一 turn/step 的新 `start` 会 `rewindLiveStep`，但旧 `attemptId` 仍留在 `attemptPositions`。只有 `end` 帧会删。迟到的 chunk 用旧 id 查到同一个 turn/step，写进刚清空的步骤。

改 `onAssistantStream` 的 `start` 分支：`previous` 存在且不同于新 id 时，先 `this.attemptPositions.delete(previous)`，再 `rewindLiveStep`。

测试：start A、chunk A、start B、再来一个 A 的 chunk。B 的步骤里没有 A 的文本。

### 35. 遮罩确认超时仍继续截图

根因：`waitAck` 超时调用 `finish(false)`，这条路径 `resolve()`。调用方把“没有 ack”当成遮罩已经生效。

改超时分支：`reject(new Error('dsh-orb: overlay ack timed out'))`。不要复用现在超时用的 `finish(false)`。`withCapture` 在 begin 的 `await` 上收到拒绝后，不得调用 `run()`。begin 已经广播出去时，按第 2 条在 `await` 之前置位的 `captureOpen`，由 `finally` 补一次 end。end 不使用已 abort 或已超时的 signal。

验收：helper 不回 ack 时，这次截图失败并带超时错误，画面里不会带上未遮罩的球。agent 收到的是工具错误，可以重试。

### 36. 超过 200 块时球上的节点还在

根因：上限循环自己 `shift` + `delete`，没有走 `dropBlock`。`dropBlock` 才会 `publish({ type: 'block-drop' })`。

把这段改成：

```ts
while (this.blockOrder.length > 200) {
  const oldest = this.blockOrder[0]
  if (oldest === undefined) break
  if (!this.blocks.has(oldest)) {
    // 只可能在 map 写入之前被 push 的瞬时状态遇到；摘掉它，否则 dropBlock 会空转。
    this.blockOrder.shift()
    continue
  }
  this.dropBlock(oldest)
}
```

`dropBlock` 自己会从 `blockOrder` 里摘掉。不要再 `shift` 一次。注意这段在 `blocks.set` 之前，被丢掉的是更旧的 key，那些 key 已经在 map 里，`dropBlock` 删得到。`dropBlock` 在 key 不在 map 里时会静默返回、且不从 `blockOrder` 移除，所以要兜住上面那种 shift，否则有死循环风险。

测试：写入 201 个块，广播序列里有对应的 `block-drop`，helper 侧 `removeBlock` 能把它从 DOM 拿掉。

## 3. Windows 输入

这一组改 `packages/computer-use/src/windows.ts` 和 `windows-native.ts`。`createWindowsDesktopBackend` 全进程只有一个，闭包里的状态就是跨会话共享的。

### 5. 点击丢掉修饰键

根因：`click` 不读 `ClickInput.modifiers`。`plugin.ts` 已经把 `shift` / `cmd` / `option` / `control` 传进来，结果文案也会把它们回显出去。

在 `click` 里，移动并点击前后用现有的 `chord` 按住修饰键。映射：`shift -> 0x10`，`control -> 0x11`，`option` / `alt -> 0x12`，`cmd` / `meta -> 0x5B`。按下、点击、在 `finally` 里按相反顺序抬起。抬起必须发生，即使点击中途 abort（和第 17 条一起做）。

Win 系修饰键的扩展标志按第 28 条处理，但**不要为了这条去改 `postedVk`**——`typeText` 的 Ctrl+A、Ctrl+V 也用 `postedVk(0x11)`，那两条的扩展标志必须是 false。在 `click` 这条路径上自己构造：

```ts
const posted = (vk: number): PostedKey =>
  ({ vk, extended: vk === 0x5B || vk === 0x5C })
```

普通修饰键（shift / ctrl / option）仍然可以和现在一样走 `postedVk`。

没有修饰键时行为与现在相同。工具结果可以继续回显修饰键，因为这次它们真的被按住了。

`tests/windows.spec.ts` 增加 `click({ modifiers: ['shift', 'control'] })`，断言按键顺序是 shift down、ctrl down、左键 down/up、ctrl up、shift up。

### 6. 提权判断看错窗口，读失败就放行

根因：`targetBlocksInput` 用 `GetForegroundWindow()`。点击的目标是坐标下的窗口，热键的目标是即将激活的窗口，两者都不必是当前前台。`integrityRid`（`windows-native.ts` 里约 396 行）把所有异常吞成 `undefined`。条件 `rid !== undefined && rid > selfRid` 为假时函数返回 false，调用方就发 `SendInput`。UIPI 会把这些输入丢掉，函数仍正常返回。

`WindowFromPoint` 目前不存在。`Bindings`、`bind()` 里有 `GetCursorPos` / `SetCursorPos`，没有这个函数。改签名时测试 fake 也要一起改，`tests/windows.spec.ts` 里现在是 `targetBlocksInput: () => false`。

改 `windows-native.ts` 和 `windows.ts` 的 `WindowsDesktopOps`：

- 在 `bind()` 增加 `WindowFromPoint`。Win32 签名是 `HWND WindowFromPoint(POINT)`，参数是一个 `POINT` 结构，不要拆成两个 `int`。坐标与现有 `SetCursorPos` 用同一套屏幕坐标。`WindowsDesktopOps` 增加 `windowFromPoint(x, y): number`，返回 HWND 数值，无效时返回 0。
- `targetBlocksInput(hwnd: number)` 接收要接收输入的 HWND。HWND 为 0 或窗口已不存在时返回 false，不拦截。除此之外，只要拿不到完整性级别（`integrityRid` 返回 `undefined`），就返回 true，拒绝输入。不要去读 `GetLastError`。koffi 下区分 `ERROR_ACCESS_DENIED` 和其他失败不值得，失败关闭已经覆盖提权进程拒绝打开 token 的情况。
- `click` / `drag` / `scroll` / `typeText`：指针移动完成后用 `windowFromPoint` 取点击点上的 HWND，再判断。
- `hotkey`：先对“将要 `focusWindow` 的那个 hwnd”做判断，不通过就抛现有的 `ELEVATED_WINDOW`，不要先 `SetForegroundWindow`。这个 hwnd 就是第 7 条里随 `hotkey` 传入的会话级 `windowId`。传入 undefined（该会话还没有观察结果）时不要回退到现场取前台，直接放过，和第 7 条“没有观察结果就不动焦点”保持一致。不要在 `hotkey` 里为了凑一个 hwnd 去调 `observationOf`。
- 所有 fake，包括 `tests/windows.spec.ts`，改成 `targetBlocksInput: () => false` 的新签名 `(_hwnd) => false`，并补上 `windowFromPoint`。

验收：前台是普通窗口、点击点落在管理员窗口上时，工具抛出提权错误，不发点击。前台是管理员窗口、点击点落在普通窗口上时，点击发出去。fake 在改完签名后 `pnpm test` 能编过。

### 7. 热键焦点被别的会话的 `listScreens` 改掉

根因：`let observed` 写在后端闭包里。任何一次 `listScreens` 都覆盖它，包括不持有 `withScreenLock` 的截图、等待和首帧。`hotkey` 再按这个过期的 hwnd 去 `focusWindow`。

不要改成“在 `hotkey` 里直接调用 `observationOf(host)`”。`observationOf` 通过 `activeCaptureExcludeWindowIds()` 读 `AsyncLocalStorage`（`capture-exclude.ts`）。这个存储只在 `runWithCaptureExcludeWindowIds` 里有值，而 `wrapDesktopBackend` 的 `hotkey` 只包了 `withInput`，没有包 `withCapture`（`overlay-guard.ts` 约 146 行）。`withInput` 在调用 `run()` 之前还有 `await transport.send`。照原文删掉 `observed` 再现场取样，排除列表是 `[]`，`selectWindowsObservation` 不再跳过悬浮球。球若在最前，热键会把焦点设到球自己身上。这比原来的跨会话串窗更容易复现。

裸 `createWindowsDesktopBackend(fake)` 的测试证明不了这一点：那种构造下排除列表本来就是空的，`focusWindow` 拿到哪个窗口都不能说明球被排除了。

热键要回到的是**这一次观察**看到的窗口，不是发键瞬间的前台。`restoreObservedFocus` 的注释写的就是上一次 `listScreens` 的窗口。发键时重新取样会改掉这个行为。

改法。这条要动五个文件，`windowId` 现在到不了插件层：

- `ScreenInfo`（`backend.ts` 约 12 行）加一个可选 `appName`。Windows 的 `screenFromObservation`（约 316 行）填 `selected.appName`，macOS 的 `screenFromFrontmost`（约 562 行）填 `parsed.appName`（`ParsedFrontmost` 本来就有）。它是给 `restoreObservedFocus` 的报错文案用的，可选字段不会影响别的调用方。不想动它就把文案降级成 `window ${windowId}`，别打 `undefined`。
- `ObservedScreen`（`observe.ts` 约 30 行）是中间层，现在只有 `screenIndex / logicalWidth / logicalHeight / scale / image`，**没有 windowId**。加可选 `windowId` 和 `transientWindowIds`。
- `observeDesktop`（`observe.ts` 约 215 行）组装 `ObservedScreen` 时，把 `listed` 里 `ScreenInfo` 的 `windowId` / `transientWindowIds` / `appName` 透传进去。
- `rememberObservation`（`coordinate-mode.ts` 约 200 行）现在只从 `screens[0].image` 取宽高，`observationCache` 的值类型是 `{ width, height }`。把值类型扩成带窗口 id 和 appName，并加一个 `lastObservedWindow(session)` 读取函数。**缓存里那个 `false` 哨兵是 fail-closed 语义（`lastAttachedRaster` 约 216 行依赖它），扩展时不要弄丢。**
- `HotkeyInput`（`backend.ts` 约 119 行）增加三个可选字段：`windowId`、`transientWindowIds`、`appName`。macOS 的 `hotkey` 忽略这三个字段。
- 删掉后端闭包里的 `observed`。`listScreens` 只返回屏幕，不给热键留进程级状态。
- `hotkey` 的 `execute`（`plugin.ts` 约 560 行）把该会话 `lastObservedWindow(session)` 的结果传进 `backend.hotkey`。Windows 侧只用这个参数调用 `restoreObservedFocus`，不要在热键里再调 `observationOf`。
- 该会话还没有观察结果时，不要猜一个前台窗口。直接发键，保持现在“没有 observed 就不动焦点”的行为。

`listScreens` 走 `withCapture`，它的 `excludeWindowIds` 已经排除过悬浮球，所以记住的窗口天然是排除球之后的，可以直接给热键用。会话级缓存也让另一个会话的截图改不了这个值。

`packages/computer-use/src/overlay-guard.ts` 开头注释写着“input 里面的嵌套 capture 仍会发 capture IPC”。宿主实现不是这样：`inputDepth > 0` 时 `cloaked` 为 false，不发 capture 消息，只把 `excludeWindowIds` 交给回调。不要按那句注释去改宿主。

测试要有两层：

- 单元：同一 backend 上，会话 A 的热键传入窗口 A，期间另一次 `listScreens` 选中窗口 B。`focusWindow` 的参数仍是 A。
- 走 `wrapDesktopBackend` 的一条：capture 会话的排除列表包含球的 HWND，`listScreens` 选出的窗口不是球，随后该会话的 `hotkey` 聚焦的也不是球。不要只用裸 backend。

### 17. 取消点击、拖拽或组合键时按键不抬起

根因：`longPress` 把 `mouseButton(false)` 放在 `finally`。`clickAt`、`drag`、`chord` 把抬起写在 `await delay` 后面，abort 时 `delay` 拒绝，后面的抬起不执行。

三条路径都改成：一旦发出 down，对应的 up 放在 `finally`，并且 `finally` 里的 up 不检查 signal。`chord` 记录已经按下的修饰键和普通键，`finally` 按相反顺序全部抬起。第 5 条的点击修饰键用同一套 `finally`。

测试：在 `BUTTON_HOLD_MS` 的 delay 上 abort，断言仍有 `left up`。组合键在修饰键间隔上 abort，断言每个 down 都有 up。

### 23. `open_app` 用标题子串命中无关窗口

根因：`activateApp` 的条件是 `app === wanted || title.includes(wanted)`，并且按 Z 序取第一个。`code` 能命中标题里含 “source code” 的浏览器。

匹配改成两段，仍按 Z 序。进程名这一段不要重写：`processBaseName` 已经 `replace(/\.exe$/iu, '')`，今天 `open_app("code")` 就能中 `Code.exe`。

1. 先只按进程基名完全相等找，大小写不敏感。命中就用它，不再看标题。
2. 没有任何进程名命中时，才看标题：整串相等，或标题以 `wanted` 开头且后面是单词边界。不要用 `includes`。

两段都没有才返回 false，走后面的 `launch`。

测试不要用 `open_app('word')` 对标题 “password”。那条失败只因为不以 “word” 开头，词边界根本没执行。改成：

- 窗口依次是标题 “source code review” 的浏览器、进程名 `Code.exe`。`open_app('code')` 激活 `Code.exe`。
- 只有标题 “Codex” 时，`open_app('code')` 不激活。`e` 后面是字母，不是边界。
- 只有标题 “Notepad” 时，`open_app('note')` 不激活。
- 标题 “Code - main.rs” 或进程名 `Code.exe` 时，`open_app('code')` 激活。空格是边界。

### 28. Win 键没有扩展键标志

根因：`VK_LWIN`（`0x5B`）的扫描码是 `E0 5B`。`windowsKeyIsExtended` 的集合里没有 `win` / `windows` / `meta` / `cmd` / `command` / `super`。`postedKey` 因此给 `extended: false`。开始菜单和 `Win+E` 不会登记。

把这些名字加进 `EXTENDED_KEY_NAMES`。`postedKey` 会因此给 Win 键 `extended: true`。

不要改 `postedVk`。它是通用助手，`typeText` 的 Ctrl+A、Ctrl+V 用 `postedVk(0x11)`，扩展标志必须仍是 false。第 5 条的点击修饰键如果要按 Win，在那个调用点单独写 `{ vk: 0x5B, extended: true }`，不要让 `postedVk` 对所有键返回扩展标志。

更新 `tests/windows.spec.ts`。现有期望是 `key:91:down:0` 和 `key:91:up:0`，编码里末位就是 `extended ? '1' : '0'`。改成 `key:91:down:1` 和 `key:91:up:1`。这是在改正被测试钉死的错误行为。Ctrl 组合键的期望保持 `:0`。

## 4. macOS 输入与截图

### 8. 光标圆环用了左上角坐标画在左下角坐标系里

根因：`compositeCursor` 里 `point.y` 是距捕获区顶部的距离。`CGContext` 原点在左下。光标精灵用 `image.height - top - cursor.height` 翻过一次，圆环的 `ringRect.y` 直接用了 `point.y`。

圆环中心的上下文 y 改为 `CGFloat(image.height) - point.y`。`ringRect` 的 y 是这个中心减去半径。x 和半径不变。光标精灵的公式保持不变。

改 `packages/computer-use/src/macos-sck-capture.swift` 后要重新跑 `packages/computer-use/scripts/build-macos-sck-capture.mjs`。捕获二进制是提交进 git 的，构建产物必须和 Swift 源一起提交。只改源文件时，别人拉下来的二进制仍是旧的，表现是“改了没生效”。

验收：指针贴在窗口上沿时，圆环在上沿；贴下沿时圆环在下沿。精灵和圆环中心重合。

### 10. 取消 HID 脚本后按键和鼠标保持按下

根因：按下和抬起在同一个 `osascript` 里。`runHidScript` 把 `AbortSignal` 交给子进程，取消会杀掉进程，Node 侧没有补抬起。`longPressAt` 的按住时间最长 10 秒，最容易停在 down 和 up 之间。`clickAt`、`drag`、`chord`、`clickWithModifiers` 同样。

释放逻辑放在 `hid()`（`macos.ts` 约 906 行）或 `runHidScript` 内部，一处覆盖 `click`、`typeText`、`scroll`、`hotkey`、`longPress`、`drag`。不要在每个调用点各包一层，必然会漏。

`signal` 已 abort，或这次运行因 abort 失败时，再跑释放脚本。释放脚本直接 `run(OSASCRIPT, [...], {})`，不传 signal，也不要再进 `runHidScript`，否则释放脚本自己也会被杀掉。超时至少 5 秒。冷启动加上 JXA 初始化在慢机器上会到 1–2 秒，“几秒”不够。

释放脚本只做这些事，不依赖被杀掉的那份状态：

- `LEFT_UP`、`RIGHT_UP` 各发一次，位置用当前光标。
- `cmd`、`shift`、`option`、`control`、`fn` 各发一次 key up。

多余的 up 对已经抬起的设备是空操作。

验收：长按进行中取消回合，系统鼠标不再处于拖拽状态，随后的普通点击只点一下。

### 18. Fn 标志位写错

`HID_RUNTIME` 里 `FLAG_FN` 从 `0x00008000` 改为 `0x00800000`（`kCGEventFlagMaskSecondaryFn`）。`chord` 里 `KEY_FN` 已会把这个常量 OR 进 flags，改常量即可。

### 19. 键表缺少 F4

在 `KEY_CODES` 增加 `f4: 118`（`kVK_F4` = `0x76`）。放在 `pageup: 116` 和 `end: 119` 之间，避免再漏看。

测试：`keyCode` 或 `hotkey(['f4'])` 不再抛 `unknown key`，生成的脚本里含键码 118。

### 20. 抬起第一个修饰键时 flags 被写成 0

根因：`clickWithModifiers` 和 `chord` 抬起循环是 `postKey(mods[r], false, 0)`。Core Graphics 把这次事件的 flags 当成“当前已没有任何修饰键”。

抬起时 flags 应是“这一键抬起之后仍然按住的修饰键”。从后往前释放时，剩余掩码是下标 `0 .. r-1` 那些键的标志 OR 在一起。最后一个抬起时掩码才是 0。按下循环可以继续在全部修饰键都声明后使用完整掩码。

只改修饰键的抬起循环。`tapKey` 的按下和抬起都继续用调用方传入的完整 flags，因为这时 Cmd 等修饰键还没抬。不要把整个 `chord` 里所有 `postKey` 都改成剩余掩码。

建议用一组键码做脚本字符串断言：`cmd+shift` 抬起 shift 时 flags 仍含 `FLAG_CMD`，再抬起 cmd 时 flags 为 0。

### 21. `delete` 在 macOS 上实际是退格

根因：键表里 `backspace` 和 `delete` 都是 51（`kVK_Delete`）。Windows 上 `delete` 是 `VK_DELETE`（向前删除），`backspace` 是 `VK_BACK`。工具说明是一套名字。

macOS 改为：

- `backspace: 51`
- `delete: 117`（`kVK_ForwardDelete`）

不要再让两个名字指向 51。Windows 映射不用动。若有测试把 macOS `delete` 期望成 51，把期望改成 117。

### 22. 截图用取整后的矩形，点击用未取整的框

根因：`regionCaptureSpec` 对 x、y、width、height 各自 `round`。`roundedPoint` 算的是 `round(bounds.x + fraction * bounds.width)`，用的是原始小数框。两边不是同一块像素。

抽一个 `roundedRegion(bounds)`，返回 `{ x, y, width, height }`，规则与现在的 `regionCaptureSpec` 相同（宽高至少为 1）。唯一的 `ScreenInfo` 出口是 `screenFromFrontmost`（`macos.ts` 约 562 行），在 `clipToDisplay` 之后、返回之前把 bounds 换成 `roundedRegion` 的结果。捕获参数和 `roundedPoint` 都用这份已经取整的 bounds，不要在旁边再取整一次出另一套矩形。

附在观察上的栅格就是这块取整矩形截出来的。像素模式的 `mapPixelToGlobal` 用 `attached.width / attached.height` 做除法，这两个数必须等于取整后 bounds 截出的图像尺寸。在 `screenFromFrontmost` 或捕获返回处加一句注释，写明这个对应关系。以后改栅格来源时要维持它。

`roundedPoint` 继续对最终全局坐标 `round` 一次。因为 bounds 已经是整数，`round(x + fraction * width)` 落在图像列上。

用文档里的例子做测试：`clipToDisplay` 之后的 bounds 为 `{ x: 100.4, y: 0, width: 200.4, height: 10 }`，离开 `screenFromFrontmost` 的 bounds 是 `{ x: 100, y: 0, width: 200, height: 10 }`，25% 的 x 是 `100 + 0.25 * 200 = 150`，不是 151。

## 5. 剪贴板与打开路径

### 24. Windows 系统目录不在打开黑名单里

根因：`PATH_BLACKLIST` 只有 `/System`、`/etc` 这类 Unix 前缀。`resolveFinderOpen` 在 `realpath` 之前就调用它，所以这些 Unix 前缀在 Windows 上也会被拒绝。`C:\Windows` 匹配不到任何一条。

在 `isForbiddenOpenPath` 里按平台追加判断，保留现有 Unix 前缀（Windows 上仍要拒绝 `/etc` 这种字符串）：

- 规范化分隔符并去掉末尾斜杠后再比。
- 拒绝 `process.env.SystemRoot`（缺省时用 `C:\Windows`）及其子路径。
- 拒绝 `C:\Windows`、`C:\Windows\System32`、`C:\Program Files`、`C:\Program Files (x86)`。大小写不敏感。
- 不要拒绝用户目录，例如 `C:\Users\...\Windows` 这种名字里碰巧带 Windows 的路径。用“路径等于前缀，或前缀后紧跟 `\`”判断。

测试放在 `open` 的现有单测里：`C:\Windows\System32\notepad.exe` 抛禁止打开；`C:\Users\me\notes` 可以通过黑名单（文件不存在时仍是“路径不存在”，那是另一条错误）。

### 25. 粘贴后只把字符串写回剪贴板

根因：两端都是读出文本、清空、写入要粘贴的字符串、粘贴、再清空并把原字符串写回去。图片和文件列表没有文本格式，或者只有附带的文本，清空后就没了。

macOS，改 `pasteText`。保存和恢复都留在同一次 `osascript` 里，`NSData` 不用离开这个进程：

- 清空前遍历 `pasteboardItems`，记下每个 item 的全部 type。对每个 type 用 `dataForType` 取出 `NSData`，在同一段 JXA 里用变量留着。
- 粘贴结束后清空，再按原 item、原 type 写回去。原来没有文本时，不要 `setString` 一个空字符串。
- 不要把保存和恢复拆成两个 `osascript`。真要拆，先把 `ObjC.unwrap` 之后的 `NSData` 落成 base64 或临时文件，否则跨进程传不回去。

手工验收：复制一张图，触发一次 `input_text`，再到预览里粘贴，图还在。

Windows，改 `readClipboardText` / `setClipboardText` 这一对在 `typeText` 里的用法：

- 打开剪贴板后用 `EnumClipboardFormats` 把每种格式的 `HGLOBAL` 拷贝出来。
- `EmptyClipboard` 只发生在保存完成之后。
- 粘贴后按原格式 `SetClipboardData` 放回去。`typeText` 的 `finally` 调用这个恢复函数，不要调用只写 `CF_UNICODETEXT` 的 `setClipboardText`。

单测可以用假的剪贴板操作：恢复时断言 `CF_DIB` 和 `CF_HDROP` 还在，而不只是 Unicode 文本。

### 26. 截图写剪贴板时没有屏幕锁

根因：`typeText` 经 `guiTurn` → `withScreenLock` 包住了“写入、粘贴、恢复”整段。`screenshot` 的 `execute` 在 `observeDesktop` 之后直接 `copyImageToClipboard`，不拿这把锁。锁是进程级的，不拿锁的写入可以插进另一会话的粘贴窗口。

`screenshot` 里从 `copyImageToClipboard` 开始拿 `withScreenLock(exec.agent?.id, ...)`。观察和写桌面文件可以留在锁外，避免截图文件 I/O 占着鼠标锁。锁的范围只包住剪贴板写入。

`open_in_browser` / `open_in_finder` 如果已经在锁里，不要为了这条再扩大范围。

测试拆成两条，不要试图在一条里让真的 `typeText` 挂住剪贴板：

- `withScreenLock` 已被占用时，第二次调用抛 `SCREEN_BUSY_MESSAGE`。这条用现有的锁单测即可。
- 给 `screenshot` 的 `execute` 注入一个 backend，在 `copyImageToClipboard` 被调用时读锁状态。断言写入剪贴板期间锁是持有的，函数返回后锁已释放。`guiTurn` 的 backend 可以替换，不需要把 `typeText` 的 `run()` 挂住。
- 为此要把 `screenLockState()` 从 `gui-lock.ts` 导出。它现在是模块私有函数（约 29 行），测试 import 不到。加一个 `export` 即可，不要改成读 `globalThis[Symbol.for('dsh-orb.gui-lock')]`——那样测试依赖 Symbol 名，太脆。

## 6. 后台 code agent

### 9. 还在收件箱里的跟进被当成已经开始

根因：`intervalHasStarted` 写成 `code.status === 'running' || !holdsPrompt(...)`。上一轮还在跑时 `status` 已经是 `running`，这次 `requestId` 仍在 `inbox.nextTurn` 里也会返回 true。`runWatch` 接着 `whenIdle()`，等到的是当前回合结束前的空档，`lastAssistantText` 仍是上一轮。

删掉 `status === 'running'` 这个短路。函数只保留：

```ts
function intervalHasStarted(code: Agent, requestId: SessionRequestId): boolean {
  return !holdsPrompt(code, requestId)
}
```

提示还在 `nextTurn` 或 `nextStep` 里就继续等。它被取走之后才进入 `whenIdle()`。注释改成同一句话，避免下一次有人把 `running` 加回来。

测试：agent `status === 'running'` 且 `holdsPrompt` 为 true 时，`waitUntilIntervalStarts` 不返回。把提示从 inbox 拿掉之后才返回。完成通知里的正文来自这次请求结束时的 assistant 文本。

### 27. 同一会话的下一次委托不取消上一个监视器

根因：`recordDelegation` 对已有会话 `watches.push(watch)`。`registry.record` 只调用 `detachRecord` 卸掉书签的事件订阅，不调用上一个 `AbortController.abort()`。旧的 `runWatch` 继续等到后来的空档，用新任务的文本去填旧任务的通知。

改 `recordDelegation`：写入新 watch 之前，把 `existing.watches` 里每个 controller `abort()`，然后把数组换成只含新 watch。`registry.record` 在替换同一 `sessionId` 时，若 `previous.watch` 不是这次传入的同一个 controller，也 `abort()` 它。`code_agent_stop` 仍 abort 全部，行为不变。

测试：同一 `sessionId` 连续两次委托。第一次的 `AbortSignal` 已 aborted，只有第二次的 watch 能发出完成通知。

## 7. 更新与 Electron 运行时

### 3. 退出后安装和用户重新打开抢包

根因：`APPLY_SCRIPT` 只等父进程退出再睡 1.5 秒就 `pnpm add`。`result.json` 在 `pnpm` 结束时才出现。下次启动的 `takeDeferredOutcome` 看不到“正在安装”，宿主会去加载正在被替换的目录。

改 `packages/host/src/deferred-install.ts`：

- `pnpm` 开始前把 `status.json` 写成 `{ phase: 'installing', spec, pid: process.pid }`。`result.json` 仍只在结束时写，写完把 `status.json` 删掉。
- 新增 `deferredInstallInProgress(profileDir)`：存在 `status.json` 且没有 `result.json` 时为 true。用和脚本里 `alive()` 一样的规则看 `status.json` 的 pid；`EPERM` 表示还活着。pid 已死且 status 超过 47 分钟才把残留 status 当成失败结果收掉。47 分钟来自脚本上限：3 次 `pnpm`，每次 `timeout` 15 分钟，失败后再睡 3 秒，合计约 45 分 9 秒，再留一点余量。
- 宿主启动读到“正在安装”时，不要初始化球、不要加载 `koffi`。向日志和设置状态报告更新仍在进行。每 1 秒看一次 `result.json`，最多等 47 分钟。等到结果再按现在的 `takeDeferredOutcome` 路径继续。

设置文案改成：安装完成前不要把这次退出理解成“可以马上再打开”。状态页在 `phase === 'installing'` 时显示进行中，而不是“已安排、请重启”。

测试：写一个 `status.json` 且不写 `result.json`，启动路径不调用原生模块加载。脚本逻辑用抽出的纯函数测“先写 status，再写 result”。

### 4. 延迟安装丢掉 `approvedBuilds`

根因：`DeferredInstall` 没有这个字段。`deferUntilExit` 在探测到已映射镜像时、以及 `EPERM` 之后，都不把 `install()` 收到的 `approvedBuilds` 放进 `job.json`。脚本的 argv 被写死成 `pnpm add <spec> --save-exact --registry=...`。

- `DeferredInstall` 增加 `approvedBuilds: readonly string[]`。两处 `deferUntilExit` 都把本次参数传进去。没有批准时传空数组。
- 脚本在 `pnpm add` 之前，若数组非空，把这些包名合并进 profile 的 `pnpm-workspace.yaml`。pnpm 10/11 的键是文件顶层的 `onlyBuiltDependencies` 数组，不是 `minimumReleaseAgeExclude` 那种缩进在块下面的列表。不要复用 `withReleaseAgeExclusion` 的解析。读写时只动这个顶层键，别的键原样留下。本仓库里没有官方 `installBundle` 对 `approvedBuilds` 的实现；动手前在已安装的 dsh 里再搜一次这个键名。搜到的若不是 `onlyBuiltDependencies`，以安装包里的实现为准，并在 PR 里写明文件位置。脚本不能忽略 `job.approvedBuilds`。
- `koffi` 在名单里时，退出后的安装会执行它的构建脚本。

测试：`deferUntilExit` 的 job 含 `['koffi']`。生成的 workspace 文件在顶层有

```yaml
onlyBuiltDependencies:
  - koffi
```

空数组不新增这个键。文件里已有的 `minimumReleaseAgeExclude` 还在。

### 33. 镜像 404 把网络失败显示成“没有新版本”

根因：`curlText` 对 404 返回 `''`。`fetch` 把所有非 `undefined` 都记成 `answered = true`。后面的 GitHub 请求若传输失败返回 `undefined`，函数因为 `answered` 返回 `null`。`check()` 把 `null` 当成“仓库明确说没有 release”，清掉错误并写入 `checkedAt`，自动检查因此冷却一小时。

`''` 表示这个源没有这份数据，继续下一个源，不要设 `answered`。`answered = true` 只发生在 HTTP 2xx 且正文能解析。所有镜像都是 404、GitHub 又传输失败时，`fetch` 返回 `undefined`，`check()` 走现有的 `error = 'network'`，并且不刷新 `checkedAt`。

GitHub 自己返回 404（正文 `''`）时仍返回 `null`，这是“确实没有 release”。

测试：两个镜像都 404、GitHub `undefined`，结果是 `undefined`。镜像返回合法版本 JSON 时行为不变。

### 34. 下载锁在持有者写完 owner 之前被抢走

根因：`lockExpired` 读不到 `owner` 就进 `catch` 并返回 true。胜者的顺序是 `mkdir` 成功，然后才 `writeFile(owner)`。失败者在这个窗口里认为锁过期，`rm` 掉目录。`process.kill(pid, 0)` 的 `EPERM` 也被当成进程已死，和 `deferred-install.ts` 的 `alive()` 相反。

不要用“目录 mtime 小于 5 秒算还活着”。胜者在 `mkdir` 和 `writeFile(owner)` 之间被挂起超过 5 秒是可能的，第一次运行还要加载 koffi。失败者会删锁，两个进程一起下载，锁要防的事情又发生了。

改获取锁的顺序，让“锁目录存在”和“owner 已写好”同时出现：

- 在锁路径旁边建临时目录，先把 `owner` 写进临时目录。
- 再把临时目录 `rename` 成锁目录。同一分区上这次 rename 是原子的。目标已存在则得到 `EEXIST`，走现在的等待分支，并删掉自己的临时目录。
- 新代码不再出现“锁目录在、owner 还没有”的窗口。

`lockExpired` 仍要处理旧的残留目录：

- `process.kill` 抛 `EPERM`：返回 false，和 `deferred-install.ts` 的 `alive()` 一样，进程还在。`ESRCH` 返回 true。
- `owner` 缺失：只有目录 mtime 已经超过 30 秒才当成残留可删。这只打扫崩在半路的旧格式，不是新协议的判断。
- 其余读失败返回 false，外层继续等到 10 分钟截止。

测试：rename 成功后锁目录里已经有 owner。并发的第二次 `rename` 得到 `EEXIST` 且不删除对方的锁。`kill` 抛 `EPERM` 时不删除锁。owner 里的 pid 不存在时可以接管。

### 39. 已提交的 bundle 设置页没有延迟更新文案

根因：`packages/client-settings/client.js` 的 `updateNotice` 有 `update.deferred` 分支。`packages/bundle/client.js` 是组装前就提交的一份，少了这个分支。`assemble.mjs` 只在 pack 时覆盖它。直接链接仓库里的 bundle 包时，宿主已经广播 `state: 'deferred'`，页面却没有对应横幅。

把 `client-settings/client.js` 里 `update.deferred` 那段和 `updateDeferred` 文案同步到 `packages/bundle/client.js`，放在 `restartRequired` 之前，和源文件顺序一致。

加一个小测试：读两份 `client.js`，断言 bundle 那份含 `update.deferred` 和 `text.updateDeferred`。以后再改设置页时这个测试会先红。

## 8. 设置页与路由

### 16. 焦点触发的 GET 覆盖正在保存的 POST

根因：`load()` 和 `mutate()` 都在响应回来时无条件 `setState`。`focus` 每次都 `load()`。`window.confirm` 会在 `mutate()` 开始前触发 focus，于是 GET 和 POST 并行，后返回的那次把 `snapshot` 和 `busy` 写成自己的结果。同一份文件里还有两个轮询：`refreshSettings()` 在 `helperPhase` 非空时每 2 秒跑一次，`refreshUpdate()` 在 `updating` 时每 2 秒跑一次（约 329–345 行）。它们也无条件写 `snapshot`，不经过 `load()`。保存头像或模型时若轮询的响应后到，旧快照仍会盖住新值。

改 `packages/client-settings/client.js`，并同步到 `packages/bundle/client.js`（否则第 39 条的两份文件又会分叉）：

- `loadGeneration` 从 0 开始。
- 抽一个 `applySnapshot(gen, snapshot)`。`load`、`refreshSettings`、`refreshUpdate` 写 state 都走它。写之前若 `gen !== loadGeneration`，直接返回。
- 这三个函数开头都取 `const gen = ++loadGeneration`。过期的响应不得改 `snapshot`，也不得把 `busy` 设回 false。
- `mutate()` 一进入就 `loadGeneration += 1`，记下这个 gen。这样 confirm 触发的 `load()`，以及进行中的轮询，都会作废。POST 回来时 gen 仍匹配才写入响应。

测试：先发起 `load` 或 `refreshSettings`，再发起 `mutate`，让 GET 的响应后到。最终 snapshot 是 POST 的结果。再加一条和第 39 条一样的文件守卫：`packages/bundle/client.js` 里也要有 `loadGeneration`。

### 37. 非法 JSON 的 POST 没有 HTTP 响应

根因：`readJson` 直接 `JSON.parse`。`handle` 没有包住各路由。解析失败时 Promise 拒绝，`writeHead` 还没执行。

- `readJson` 捕获 `SyntaxError`，抛出带 `status: 400` 的错误，消息用 `invalid-json`。
- `registerOrbRoutes` 的 handler 包一层 `try/catch`。响应头还没写时，用 `sendJson` 返回该 status，body 为 `{ error }`。没有 status 的错误返回 500，body 不要带堆栈。
- 头像上传现有的 413 仍走它自己的拒绝对象，被这层 catch 接住后应按 413 返回，不要变成 500。

测试：`POST /.dsh-orb/update/auto` 正文 `{`，响应 400 且连接结束。超大头像仍是 413。

## 9. 几何

### 38. 吸边复原用了整块屏幕而不是工作区

根因：`insideBallOrigin` 的 x 用 `display.bounds`，y 用 `display.workArea`。左右任务栏在 `bounds` 里、在 `workArea` 外。`dockedTabBounds` 也贴着传入的 `bounds` 边缘。自由拖动的 `clampedBallOrigin` 已经用工作区。

- `insideBallOrigin` 的 x 改为工作区：左侧 `workArea.x + DOCK_IN_PAD`，右侧 `workArea.x + workArea.width - BALL_SIZE - DOCK_IN_PAD`。
- `dockedTabBounds` 改为接收工作区矩形，标签贴工作区的左缘或右缘，y 仍夹在工作区高度内。调用处现在传入的是显示器 bounds 的，改传 `display.workArea`。

底部任务栏的现有行为保持：y 已经在工作区内。

测试：工作区比 bounds 窄、且从左侧缩进 48 像素时，复原后的球 x 是 `workArea.x + DOCK_IN_PAD`，标签不落在 `bounds.x`。

## 10. 划词工具栏

这三条对应的入口仍然关闭。把代码修好，不要在这次改动里恢复菜单、设置项或偏好默认值。恢复入口要单独开任务，并在 macOS 和 Windows 上把双击、拖选、混合 DPI 走一遍。

### Windows 选区没有矩形时锚在 (0, 0)，坐标也不是 DIP

根因：PowerShell 在没有四个矩形数时仍输出 `x = 0; y = 0`。`windows-dispatch.js` 看到数字就把坐标带上。`selection.ts` 用它覆盖鼠标抬起时的锚点。脚本输出的是物理像素，观察框那条路径才做了 `screenToDipRect`。

- 没有有效矩形时，JSON 里不要带 `x` / `y` / `width` / `height`。`0` 不是“缺省”。
- 有矩形时，在 Node 侧用该点所在显示器的 `scaleFactor` 转成 DIP，再交给 `dispatch`。转换函数与鼠标钩子已经在用的那套相同，不要在 PowerShell 里猜 DPI。
- `selection.ts` 仅在 `event.x` 和 `event.y` 都是有限数、且不是缺失字段时才覆盖 `lastAnchor`。

### Windows 选区读取乱序

根因：每次左键抬起都 `void probe.readSelection()`，返回时不核对这次抬起还是不是最新一次。

`dispatchWindowsSelectionMessage` 增加代次。左键按下或抬起时递增。发起读取时记下代次，`.then` 里代次不一致就丢掉结果，不发 `selection`。鼠标按下已经会藏起工具条，过期结果不得再把它显示出来。

### macOS 双击和三击不读选区

根因：`leftMouseUp` 要求 `press != nil && dragged`，`dragged` 要移动至少 8 像素。双击和三击的 `clickState` 大于 1，但位移不够。

`shouldRead` 改为：发生过拖选，或者这次鼠标事件的 click count 大于等于 2。单击且没有拖动仍然不读。Windows 保持“每次左键抬起都读”。

## 待验证，本次不改

### 40. 光标半透明边缘的混合公式

`cursor.ts` 对半透明像素用了直通 alpha：`under * (1 - a) + over * a`。若 `GetDIBits` 给出的颜色已经预乘，边缘会偏暗。这个前提还没有证据。`BI_RGB`、32 位 DIB 的常见口径是 alpha 字节保留为非预乘。

现有 `tests/cursor.spec.ts` 把直通公式编码成了期望：底色 100、光标 `[200, 0, 0, 128]`，结果是 `[150, 50, 50, 255]`。按预乘公式改完，这条会变成约 250，测试变红。用一张“假定已预乘”的像素去断言新公式，只能证明公式算术，不能证明 `GetDIBits` 的输出是预乘的。

本次不要改 `compositeCursor`。验证方法：用一个已知 50% alpha 边缘的系统光标，或自造一个 32bpp `.cur`，截一张图和直通、预乘两种公式对比。确认是预乘之后，再单独改公式并更新 `cursor.spec.ts` 的期望。

## 改完后的核对

每一组合并前：

- `pnpm typecheck` 和 `pnpm test` 通过。
- 对应该组新加的断言失败时，先看是不是把旧的错误行为写进了期望。第 28 条的 `key:91:down:0` 应改成 `key:91:down:1`，不要把扩展标志改回去。
- 第 8 条的 Swift 和重新构建的捕获二进制一起提交。
- 第 2 条和第 35 条在同一个提交里。begin 已经广播之后，abort 和超时都要能补上 end。
- 第 7 条的测试要经过 `wrapDesktopBackend`。只测裸 backend 时，排除列表本来就是空的。
- 第 7 条要动五个文件才能闭环：`ScreenInfo` 加 `appName` 和 `HotkeyInput` 加三个字段（`backend.ts`）、`ObservedScreen` 加 `windowId` / `transientWindowIds` 加 `appName` 并透传（`observe.ts`）、`observationCache` 扩类型并加 `lastObservedWindow`（`coordinate-mode.ts`）、删掉闭包 `observed` 改用入参（`windows.ts`）、`hotkey` 的 `execute` 传参（`plugin.ts`）。漏掉中间那层，插件层拿不到 `windowId`，`rememberObservation` 会无处可取。`appName` 是给 `restoreObservedFocus` 的报错用的；不想动 `ScreenInfo` 就把文案降级成 window id，别打 `undefined`。
- 第 26 条要 `export screenLockState()`，否则测试 import 不到。
- 第 31 条的 epoch 比较写在 `stopTurn` 里，`finishTurn()` 的签名和调用点不要动。
- 第 16、39 条改了 `client-settings/client.js` 的，同步 `packages/bundle/client.js`。pack 出来的 tarball 以组装结果为准，链接安装则以提交的 `bundle/client.js` 为准。
- 第 40 条不在这次的提交里。
