# FIX-PLAN.md 审核补充

对[FIX-PLAN.md](FIX-PLAN.md)的逐条复核。**本文只读不改**：没有修改 `BUGS.md`、`FIX-PLAN.md`，也没有改任何源码。所有结论都对着代码现况重新核过一遍，行号以本次复核时的工作树为准。

结论先说：**FIX-PLAN.md 的诊断（根因）几乎全部正确，我复核后没有发现一条根因写错；但大约三分之一的实施细节有问题**——有 5 处会改错或改出更严重的回归，有 6 处有边界情况没覆盖，有 4 处需要补测试细节。如果照原文直接动手，会引入新的 bug。

---

## 0. 复核方法

1. **把 FIX-PLAN 里的每一条根因描述，拿回源码里重读一遍**，确认"研发说的现状"是真实的——避免方案基于一个想象中的旧代码。
2. **重点检查"改完之后会怎样"**：改动本身是否正确、是否破坏现有行为、是否引入新错误路径。这类问题根因描述再准也发现不了。
3. **检查方案给的测试是否真的能证伪错误实现**——有几条测试在 fake 下会通过，即使实现是错的。
4. **检查跨条目的隐含依赖**：同一组里改接口（`WindowsDesktopOps`、`WithCapture` 深度规则）会影响同组其他条目。

---

## 1. 评级总览

| 评级 | 条目 | 说明 |
| --- | --- | --- |
| ✅ 照做 | 1、11、12、14、15、18、19、30、32、36、39 | 诊断准、改法对、无回归 |
| ⚠️ 补细节 | 2、8、10、13、17、20、21、22、24、25、26、29、34、37 | 方向对，有边界情况或写法要注意 |
| ❌ 必须返工 | **7**、**6**、**23**、**40**、**16** | 见第 2 节 |
| 🔶 可选加强 | 3、4、28 | 思路对，缺具体数字/写法 |

> 30 原在"必须返工"附近，复核后确认改法（调整 `turnInterrupted` 置位顺序）正确且无副作用，归入 ✅。

---

## 2. 必须返工的 5 条

### 2.1 【严重】第 7 条：改完反而丢失遮罩 id，比原 bug 更糟

方案要求删掉闭包 `observed`，让 `hotkey` 里现场算 `observationOf(host)`。方向是对的（闭包共享状态确实是跨会话污染的来源），但**漏了一个关键机制**。

`windows.ts:312-314`：

```ts
function observationOf(ops: WindowsDesktopOps): WindowsObservationSelection | undefined {
  return selectWindowsObservation(ops.listWindows(), activeCaptureExcludeWindowIds())
}
```

chrome id 是从 `capture-exclude.ts:16-18` 的 `AsyncLocalStorage` 里同步取的：

```ts
export function activeCaptureExcludeWindowIds(): readonly number[] {
  return captureExclude.getStore() ?? []
}
```

**而 `hotkey` 在 computer-use 的包装层只套了 `withInput`，没有 `withCapture`/`runWithCaptureExcludeWindowIds`**（`packages/computer-use/src/overlay-guard.ts:146`）：

```ts
hotkey: (input, signal) => guard.withInput(() => inner.hotkey(input, signal), signal),
```

更糟的是 `withInput` 内部在调 `run()` 之前有 `await transport.send({type:'overlay-input',...})`（同文件 88-93 行），**异步边界会把 AsyncLocalStorage 的上下文清掉**。所以照方案改完，`activeCaptureExcludeWindowIds()` 返回 `[]`，`selectWindowsObservation` 不再排除悬浮球。

**后果**：如果发送热键时球恰好在最前（用户刚点了球、或 input 遮罩把球带到前台），`hotkey` 会把键盘焦点设到球自己身上。**这比原来的 bug（可能激活另一个会话的窗口）更直接、更容易复现。**

而且方案给的验收测试**证明不了这条实现是错的**：测试里 `createWindowsDesktopBackend(host)` 是裸构造，`activeCaptureExcludeWindowIds()` 本来就返回 `[]`，无论实现对不对，`focusWindow` 都拿到 B。

**建议改法（二选一）**：

- (A) 让 `hotkey` 也经过 capture 包装，从而拿到 chrome id：
  ```ts
  hotkey: (input, signal) => guard.withInput(
    () => guard.withCapture(
      session => runWithCaptureExcludeWindowIds(
        session.excludeWindowIds,
        () => inner.hotkey(input, signal),
      ),
      signal,
    ),
    signal,
  )
  ```
  `capture` 嵌在 `input` 里时 `cloaked` 恒为 false（host 侧 `captureDepth===1 && inputDepth===0` 不成立），**不发任何 IPC，只借 AsyncLocalStorage 传 id**，与今天的行为等价。
- (B) 插件层显式传参：`guiTurn` 的每个工具里已有 `listScreens`，把选中的 `ScreenInfo`（含 `windowId`/`transientWindowIds`）作为可选字段传进 `hotkey`，Windows 侧优先用它。代价是 `HotkeyInput` 要加字段，macOS 侧忽略。

我倾向 (A)：改动局部、复用既有机制、且与第 2 条修好后的深度规则兼容。

**测试必须补**：一条走 `wrapDesktopBackend` 的集成断言——chrome 列表里包含球时，`hotkey` 选中的窗口不是球。否则这条永远测不出来。

### 2.2 【严重】第 6 条：漏了新 native 绑定，接口变更没提

两个硬伤：

1. **`WindowFromPoint` 不存在**。`Bindings` 接口（`windows-native.ts:196-235`）和 `bind()` 里都没有它，`GetCursorPos`/`SetCursorPos` 有。整条方案建立在"移动完成后用 `WindowFromPoint` 取 HWND"上，却完全没提要加声明、koffi 签名、mock ops。实施会卡在半路。
2. **`targetBlocksInput(hwnd)` 改了签名，测试 fake 会编译失败**。`tests/windows.spec.ts:73` 是 `targetBlocksInput: () => false`。方案没提要同步改 fake。

**另外，"读 token 失败视为提权"的实现方式建议简化。** 方案要区分 `ERROR_ACCESS_DENIED` 和其他失败，但 `integrityRid`（396-403 行）现在把所有异常吞成 `undefined`，koffi 下读 errno 需要额外机制，投入产出比很差。

**更简单且更安全的等价方案：除"HWND 无效/进程已退出"外，任何拿不到目标完整性级别的情况一律返回 `true`（拦截）**。不需要区分错误码，行为一致，且方向是 fail-closed。

### 2.3 【中】第 23 条：对现有代码的事实描述是错的

方案写：

> 进程基名完全相等（现有逻辑），大小写不敏感。`.exe` 后缀可忽略：`code` 能中 `Code.exe`。

这句写得像"现在做不到、要改成能"。但 `windows-native.ts:390`：

```ts
return base.replace(/\.exe$/u, '')
```

**`.exe` 早就剥掉了**，今天 `open_app("code")` 匹配进程名这一段本来就是好的。方案把一个已正确的事实陈述成待办，实施者会做重复劳动或者以为自己漏看了。

**真正要改的只有标题那一分支**（`title.includes(wanted)` → 精确或前缀+词边界）。

**测试用例也要换**：方案用 `open_app('word')` 不激活标题 "password"。"password" 不匹配是因为它不以 "word" 开头——这条**根本没走到词边界逻辑**，测试通过不代表修好了。建议换成：

- `open_app('code')` 不激活标题 "Codex"（前缀命中但 `e|x` 无边边界 → 必须不命中）；
- `open_app('note')` 不激活 "Notepad"（同上，这是真实风险）；
- `open_app('code')` 激活进程名 `Code.exe` 或标题 "Code - main.rs"（边界命中 → 必须命中）。

### 2.4 【中】第 40 条：前提未经验证，且给的测试是循环论证

方案断言 `GetDIBits` 给出的 32 位光标颜色"已经预乘"。**这个前提没有被证实。**

方案给的测试是"用一张已知的预乘边缘像素，断言混合结果不比非预乘公式更暗"——这个断言只验证了"新公式在输入为预乘时数学正确"，**完全没有验证 `GetDIBits` 的输出真的是预乘的**。这是自我循环：假设了结论，再测试这个假设。

**而且现有测试已经编码了相反的假设**，方案没提它会红。`tests/cursor.spec.ts:107-111`：

```ts
const cursor = Buffer.from([200, 0, 0, 128])
compositeCursor(target, 4, 4, cursor, 1, 1, { x: 0, y: 0 })
expect([...target.subarray(0, 4)]).toEqual([150, 50, 50, 255])
```

底色 100、光标 `[200,0,0,128]`：直通 alpha 下 = `100*0.498 + 200*0.502 = 150`；预乘下（按新公式）= `100*0.498 + 200 = 250`。**照方案改公式，这条现有测试必然失败**，方案却只说"加一个新测试"。

从 Win32 语义看我也倾向原假设：`biCompression: BI_RGB` + `biBitCount: 32` 的 DIB，文档口径下 alpha 字节通常保留为**非预乘**；`.cur` 资源里的 alpha 同理。

**建议：把这一条从"修复"降级为"待验证"，不要和其他 9 条一起提交。** 验证方法：用一个已知 50% alpha 边缘的真实系统光标（或自造一个 32bpp `.cur`）截图对比，先确定前提再决定改不改公式。修不起的 bug 宁可标"需人工验证"，也不要盲改公式造成可见的画质回退。

### 2.5 【中】第 16 条：`loadGeneration` 漏了两个轮询入口

代数机制本身没问题，但**只防住了 `load()` 和 `mutate()`，漏了 `refreshSettings()` 和 `refreshUpdate()`**（`client-settings/client.js:329-345`）。这两个轮询函数在 `helperPhase` / `updating` 期间每 2 秒跑一次，同样无条件 `setState({snapshot})`，**不经过代数**，所以保存头像/模型时如果正好在轮询，旧快照照样覆盖新值。

正确做法：把三处（`load`/`refreshSettings`/`refreshUpdate`）的写入统一走一个带代数的私有函数，`mutate()` 进入时统一 `++generation`。

另外方案说"同步到 `bundle/client.js`"是对的，但**要像第 39 条那样加一条文件一致性守卫**（读两份断言 bundle 那份也含 `loadGeneration`），否则下次改设置页又会分叉。

---

## 3. 需要补充细节的（⚠️）

### 3.1 第 2 条：`captureOpen` 必须在广播后立刻置位，否则 abort 会泄漏遮罩

方案写"发 `active: true`，**成功后** `captureOpen = true`"。这三个字会让实施者写错位置。

`transport.send` 内部的 `waitAck` 在 Promise 执行器里**同步** `broadcast(message)`，所以 `send()` 一返回，消息已经写到 socket。**`captureOpen = true` 必须紧挨 `sentBegin = true` 放在 `await begin` 之前**（即现在的 60-66 行那个位置）。

如果放在 `await begin` 之后：一旦 `await begin` 因 abort 拒绝（`waitAck` 的 abort 分支 reject），`captureOpen` 保持 false，finally 不发 end，而 helper **已经计数 +1**。结果是球永久处于 content-protection 状态——**在后续所有截图里隐身**，比原 bug 更难排查。

**顺带**：第 35 条把超时改成 reject 之后，这种 abort/拒绝路径会比现在更容易触发，所以第 2 条和第 35 条必须一起改、且都必须保证"begin 已广播就一定会补 end"。第 35 条自己写了这点，第 2 条没写，要补上。

### 3.2 第 10 条：释放脚本必须包在 `runHidScript` 内部

方案说"在 `runHidScript` 的**调用侧**包一层"。`runHidScript` 的调用方有 `click`/`typeText`/`scroll`/`hotkey`/`longPress`/`drag`/`openApp`/`pasteText` 等，逐处包必然遗漏。

**应该包在 `runHidScript` 自己里面**（`macos.ts:881-894`），或在它上面的 `hid()`（906-908 行），一处覆盖全部路径。

另外释放脚本**不能走 `runHidScript`**（它会把 signal 交给子进程，等于又把释放脚本也杀了），要直接用 `run(OSASCRIPT, [...], {})` 不传 signal。冷启动 + JXA 初始化在慢机器上能到 1-2 秒，**超时建议 ≥5 秒**，方案里"几秒即可"偏乐观。

### 3.3 第 31 条：epoch 自增漏了两条不走 `onPrompt` 的路径

`turnEpoch += 1` 只加在 `onPrompt` 里，但还有两处置 `turnRunning = true` 的地方不走 `onPrompt`：

- `orb.ts:853-863` 的 `consume('turn/start')`——code_agent 完成通知唤醒的回合；
- `orb.ts:1641-1645` 的 `openSession`——切到正在跑的历史会话。

这两条路径下，`await cancel` 期间新回合开始，`finishTurn()` 照样误标。

**建议**：把 epoch 自增下沉成一个私有方法（如 `beginTurn()`），三处都调；或者 `finishTurn()` 不做 epoch 比较，改成"校验这次 stop 仍持有当前回合"。

### 3.4 第 34 条：mtime 阈值在慢机器上会误杀

`owner` 缺失时用"目录 mtime < 5s 判活"不可靠：胜者进程在 `mkdir` 之后、`writeFile(owner)` 之前被 OS 调度挂起完全可能超过 5 秒（Windows 上低优先级进程、首次运行还要加载 koffi 时尤其）。失败者删锁 → 两个进程同时下载 → 正是这个 bug 要避免的"损坏的 Electron"。

**更可靠的做法：先建临时目录、写 owner、再 `rename` 成锁目录**（同分区 rename 原子，目标已存在则 EEXIST 走竞争分支）。这样"owner 存在"与"锁存在"之间没有窗口。

另外两条小点：`process.kill(pid,0)` 的 `EPERM` 要判为"活着"（与 `deferred-install.ts:97` 的 `alive()` 一致，方案这点写对了）；其余读失败返回 false 让外层继续等，也对。

### 3.5 第 22 条：改法对，但要显式说明 raster 与 bounds 同源

抽出 `roundedRegion` 并在"屏幕信息离开 macOS 后端之前"替换 bounds，思路正确。但**要显式写清楚"attached raster 的像素尺寸就是取整后 bounds 截出来的"**，否则未来有人改 raster 来源又会引入不一致。

特别是 pixel 坐标模式：`mapPixelToGlobal` 用 `attached.width/height` 除，而 bounds 已取整、图像也是取整后截的，两者一致——这个前提要写成注释/断言，否则这条修了也会退。

**精确落点**：`macos.ts:562-575` 的 `screenFromFrontmost` 是唯一的 `ScreenInfo` 出口，在那里取整最干净（`clipToDisplay` 之后）。

### 3.6 第 12 条：中文软换行加空格是产品取舍，要标注

CommonMark 规定软换行渲染成空格，但**中文之间插空格是错的**（"注意\n如下" → "注意 如下"）。这条技术上合规、体验上违和。

建议：仅在拼接处两侧不同时是 CJK 时才插空格；或者至少在方案里标注"已知取舍，验收时预期如此"，否则 QA 会当新 bug 报回来。

### 3.7 第 26 条：测试比方案写的难，要给具体写法

"一个持锁的 typeText 未恢复剪贴板时，另一会话 screenshot 不能调 `copyImageToClipboard`"——`withScreenLock` 是进程级模块状态，要构造"A 持锁不返回"，必须注入一个可控的 `backend` 让 `typeText` 的 `run()` 挂住。`guiTurn(backend, ...)` 的 backend 可注入，所以可行但不简单。

**更现实的组合**：(a) 单测 `withScreenLock` 本身的占用抛错；(b) 一条桩测试断言 `screenshot` 的 execute 在 `copyImageToClipboard` 前后成对调用锁。建议把这两条的具体写法补进方案，否则实施者会在这卡住。

### 3.8 第 13 条：验收用例覆盖不全

方案验收"点复制不会展开或折叠卡片"。但终端卡当前**根本没有折叠逻辑**（`cappedRows` 只管行，不管卡），这条验收目前是空的。建议改成"点复制不会触发卡片 header 的其他行为"，或等将来 header 绑了展开再回来验。

另外建议补一个"空输出时只复制命令"的用例（方案提了，好）和一个"阅读卡不带行号"的用例（方案提了，好）——这两个保留。

### 3.9 第 20 条：注意别把 `tapKey` 也改了

方案说"`tapKey` 的按下和抬起都带调用方传入的 flags，普通键那部分不用改"——对，保留。但要提醒实施者：**只有修饰键的抬起循环要改成"剩余掩码"**，普通键（`tapKey`）两侧都用完整 flags（因为 Cmd 等还没抬）。别把整个循环统一改了。

### 3.10 第 25 条：macOS 侧要保存的是"每个 item 的全部 type"

方案说"清空前用 `pasteboardItems` 记下每个 item 的全部 type 和 `dataForType`"。这是对的，但要强调 **JXA 下要把 `ObjC.unwrap` 后的 NSData 落成可还原的形式**（base64 或临时文件），否则跨脚本边界传不了。验收用例建议直接用"复制一张图 → 触发 input_text → 粘贴到预览里图还在"。

---

## 4. 可选加强（🔶）

### 4.1 第 3 条：把具体数字写死

"上限与脚本超时一致"没给数。脚本是 3 次 × 15 分钟 + 3 次 3 秒间隔 ≈ **47 分钟**，建议直接写进方案，并且"轮询 `result.json`"的间隔也给个值（如 1 秒）。

### 4.2 第 4 条：`onlyBuiltDependencies` 的键名要落实

方案说"若官方 `installBundle({approvedBuilds})` 使用了不同的键，以那份实现为准"。这一句等于没写——研发摸不到官方实现。**这个键名其实可以查证**：`dsh-orb-*.tgz` 和 `packages/bundle/node_modules` 都在仓库里，`grep onlyBuiltDependencies` 能看到宿主实际用的键（本次 grep 只在 client.js 命中，说明这个键名目前**没有任何代码引用**，更要在动手前确认）。

同时提醒：pnpm 的这个键是**顶层数组**，写法和 `withReleaseAgeExclusion` 的 `minimumReleaseAgeExclude`（嵌套在块下的列表）不同，合并逻辑不能直接照抄，要处理成"顶层键"。

### 4.3 第 28 条：别顺手改了 `postedVk`

方案说"`postedVk(0x5B)` 那条若仍被点击修饰键使用，扩展标志要设为 true"。`postedVk` 是**通用**的（`typeText` 里 `postedVk(0x11)` 的 Ctrl+A、Ctrl+V 都走它），**不能整体改**。要在点击修饰键那条单独构造 `{ vk: 0x5B, extended: true }`。

测试期望 `key:91:down:0` 要改成 `key:91:down:1`（末位就是 extended 标志，与 `postedKey` 现有编码一致）。

### 4.4 第 8 条：二进制产物要一起提交

方案在"改完后的核对"里提了要重跑 build 脚本，✅。补一句：**随包的捕获二进制是提交进 git 的，build 产物必须和 Swift 源一起提交**，否则别人拉代码后源码与二进制不一致，且 CI 上表现为"改了没生效"。

---

## 5. 修订后的提交顺序

在 FIX-PLAN 原表基础上做了三处调整（40 移出单独排、7 移到 5/6/17 之后、28 提前）：

| 顺序 | 分组 | 条目 | 调整原因 |
| --- | --- | --- | --- |
| 1 | 悬浮球对话渲染 | 1、11、12、13、14、15 | 不变，纯前端可独立验证 |
| 2 | 宿主回合与遮罩 | 2、29、30、31、32、35、36 | 不变；**2 与 35 必须在同一提交**，否则 abort 泄漏遮罩 |
| 3 | Windows 输入（一） | **28**、**23**、**6** | 28 是常量改动先行；23/6 动接口和绑定，为后面铺路 |
| 4 | Windows 输入（二） | **7**、**5**、**17** | 7 依赖 6 的接口和 2 的深度规则，单独一次提交便于评审 |
| 5 | macOS 输入与截图 | 8、10、18、19、20、21、22 | 不变 |
| 6 | 剪贴板与打开 | 24、25、26 | 不变 |
| 7 | 后台 code agent | 9、27 | 不变 |
| 8 | 更新与运行时 | 3、4、33、34、39 | 不变；**34 建议改成 rename 方案后再排** |
| 9 | 设置页与路由 | 16、37 | 不变；**16 要连两个轮询入口一起改** |
| 10 | 几何 | 38 | 不变 |
| — | 待验证 | **40** | **不进入本次修复序列**，先做真实光标验证再决定 |

---

## 6. 直接可转发的反馈

> FIX-PLAN 的方向和分组是对的，根因没有一条写错，但有 5 处必须返工、多处要补细节，不能直接照做：
>
> 1. **#7**：`activeCaptureExcludeWindowIds()` 走 AsyncLocalStorage，而 `hotkey` 只套了 `withInput`（内部还有 `await send`），改完会拿到空 chrome id，比原 bug 更糟。需要像 `listScreens` 一样把 id 带进去。
> 2. **#6**：`WindowFromPoint` 这个 native 绑定目前不存在，`Bindings`/`bind()`/fake ops 都要一起改；"读 token 失败视为提权"建议简化为除 HWND 无效外一律拦截，别去啃 `GetLastError`。
> 3. **#23**：`processBaseName` 已经剥掉 `.exe`，方案里那句是多余的，真正要改的只有标题匹配；测试用例换成 "Codex" / "Notepad" 这类真正走词边界的。
> 4. **#40**："GetDIBits 输出是预乘"没有证据，给的测试是循环论证，而且现有 `cursor.spec.ts` 的用例编码了相反假设、会红。建议降级为待验证。
> 5. **#16**：漏了 `refreshSettings()` / `refreshUpdate()` 两个轮询入口，它们同样会覆盖正在保存的值。
>
> 另外要补的细节：**#2** 的 `captureOpen` 必须在广播后立刻置位（`await` 前），否则 abort 泄漏遮罩、球永久隐身；**#10** 释放脚本要包在 `runHidScript` 内部且不传 signal；**#31** 的 epoch 要覆盖 `turn/start` 和 `openSession`；**#34** 换成"先建临时目录写 owner 再 rename"；**#12** 标注中文软换行加空格的取舍；**#25** macOS 侧要保存每个 item 的全部 type 并能跨脚本还原。

---

*本文档为审核意见，未改动 `BUGS.md`、`FIX-PLAN.md` 及任何源码。*
