# 悬浮球语音实现方案

> 对照 [05-voice.md](05-voice.md)。交互以那份需求为准。本文只写落在哪、按什么顺序做、每一步怎么验收。
> 引擎怎么初始化、唤醒词怎么转音素、正文怎么清洗切句、语速怎么拆成模型速度和 SOLA，按文末三份落地文档写。出厂参数以本文钉死的值为准。
> 做完一节再做下一节。每一节的验收没过，不要开始下一节。
>
> 2026-10-23 修订：设备是否占用不再只看“至少一列可用”，而是看当前固定状态下有没有可达的听法；只开唤醒固定、只开语音输入收起时释放。第 0 节第 3 条与第 8.2 节的旧表述按此执行，见 [04-addenda.md](04-addenda.md) 第 27 节。

## 0. 已经定下来的做法

这些决定直接写进代码，不用再选型。

1. **语音引擎放在 Host 拉起的一个 Node 子进程里。** Host 本身是 `ELECTRON_RUN_AS_NODE=1` 的 Node 进程，`sherpa-onnx-node` 和 `node-cpal` 能在这里加载。helper 是另下一份 Electron，不要把这两个原生模块装进 helper，也不要为它们做 Electron 重编译。SenseVoice 常驻约 0.9GB，TTS 两个引擎约 0.5GB，`generate()` 和一次识别都是同步 CPU 工作，不能跑在 Host 主线程上，否则悬浮球 Agent 和 Computer Use 会被拖住。
2. **产品状态在 Host。** 听唤醒、听指令，还是两边都关，由 Host 根据固定、任务、提问卡、播报和设置算出来，再通知子进程。子进程只负责采集、识别、合成和播放。helper 页面继续拥有固定这个手势，并把每次变化报给 Host。
3. **一路麦克风，按需开。** Host 按当前固定状态判断有没有可达的听法：只开唤醒且收起、只开语音输入且固定时才需要设备；两列都关、对应模型不齐，或只开的那列在当前固定状态下不可达时，关闭输入流，macOS 的麦克风指示随之消失。两列都可用的状态下，切换只改「这份 PCM 喂给谁」，不关闭、不重开设备，需求里「固定之后立刻说的那句开头要留给语音输入」靠这个做到。
4. **播放也在子进程里。** 用 `node-cpal` 的输出流播 22050Hz PCM。Host 只收到开始和结束。不要把音频送进 helper 页面。
5. **ASR 模型只走 DeepSeek Harness 官方下载。** 调用 Host 上的 `ctx.speechToText`，提供者 id 是 `sensevoice-local`。文件留在官方目录 `dshHomePath('speech-to-text', 'sensevoice')`。插件不另存一份，也不调用官方的 `transcribe()`。官方那条是「整段 WAV 进、文本出」，球要的是常驻 VAD。子进程自己用 sherpa 读同一批已经校验过的文件。
6. **唤醒模型和 TTS 模型由插件下载**，放在 `dshHomePath('dsh-orb', 'voice', 'kws')` 和 `dshHomePath('dsh-orb', 'voice', 'tts')`。版本就是仓库里钉死的 URL 和哈希。不做「到 GitHub 上找一个更新的模型名」的爬虫。
7. **官方仓库一行不改。** 全部代码在本仓库。设置页改 `packages/client-settings/client.js`，由现有装配抄进 bundle。

出厂值：

| 项 | 值 |
|---|---|
| 唤醒词 | `你好大肥鱼`（一条） |
| 灵敏度 `keywordsThreshold` | 0.25 |
| 增强分 `keywordsScore` | 1 |
| 判定粒度 | chunk-8，160ms |
| 连触发冷却 | 1.5 秒 |
| 唤醒回复语 | 我在 |
| 退下口令 | 你退下吧、退下吧 |
| 退下回复语 | 好的，再见 |
| 提问提示语 | 我有几个问题，你来选一下 |
| 空闲时长 | 30 秒，允许 5–600 的整数 |
| 语速 | 1.5，设置范围 1.0–3.0，步进 0.1 |
| VAD / ASR | 与 DeepSeek Harness 默认定值相同，设置里不出现：阈值 0.5、最短静音 0.5 秒、最短语音 0.25 秒、最长 30 秒、窗 512、VAD 线程 1、识别线程 2、语言 auto、ITN 开、段首回补 0.3 秒 |

依赖版本锁死：`sherpa-onnx-node@1.13.8`。`node-cpal` 用 1.x 的 API（`defaultHost().defaultInputDevice()`、建流之后要 `play()`）。`pinyin-pro` 只给唤醒词生成器使用。

## 1. 进程和文件

```mermaid
flowchart LR
  page["helper 页面 shell.js<br>固定、空闲手势、停止按钮"]
  host["Host 语音控制器<br>听的状态、播报队列、设置"]
  child["语音子进程<br>一路麦克风、KWS、VAD、ASR、TTS、喇叭"]
  page <-->|"现有 NDJSON"| host
  host <-->|"子进程 stdin/stdout NDJSON"| child
```

新建私有包 `packages/voice`，随 `dsh-orb` 装配进 `dist/voice`，不单独发布。Host 用相对路径找到它，和现有 helper 的找法一样。

| 路径 | 职责 |
|---|---|
| `packages/voice/src/listen.ts` | 听的状态。纯函数 |
| `packages/voice/src/queue.ts` | 途中句、收尾、提问提示语的队列。纯函数 |
| `packages/voice/src/dismiss.ts` | 退下包含匹配。纯函数 |
| `packages/voice/src/idle.ts` | 空闲计时。纯函数 |
| `packages/voice/src/keywords.ts` | 从 wake-lab 的 `lib/keywords.mjs` 搬来的词表生成 |
| `packages/voice/src/speak-text.ts` | 从 `tts-lab/reference/matcha-tts.mjs` 搬来的清洗、切句、语速规划 |
| `packages/voice/src/child.ts` | 子进程入口 |
| `packages/voice/src/manifest.ts` | 唤醒和 TTS 的官方 URL、字节数、sha256 |
| `packages/host/src/voice.ts` | 控制器：状态、队列、子进程、和 `onPrompt` 的衔接 |
| `packages/host/src/voice-models.ts` | 唤醒 / TTS 下载，以及官方 ASR 的准备状态 |
| `packages/host/src/preferences.ts` | 增加 `orb-voice.json` |
| `packages/host/src/routes.ts` | 设置读写、下载、进度 |
| `packages/host/src/orb.ts` | 接固定、停止、正文、提问卡 |
| `packages/helper/assets/shell.js` | 固定上报、空闲的指针规则、停止按钮多留一会儿 |
| `packages/helper/src/main.ts` | 转发新的 socket 消息 |
| `packages/client-settings/client.js` | 「设置 → 悬浮球」里的「语音」一组 |

子进程用 `fork()` 拉起，这样会继承 `ELECTRON_RUN_AS_NODE`，跑的是 Node 而不是另一份 Electron。协议走 stdin/stdout 的 NDJSON，不另开端口。Host 退出时子进程一起退出。子进程崩溃后 Host 最多再拉起 3 次，仍失败就关掉语音，球的打字和 Computer Use 继续可用，设置页给出和 helper 起不来时同一风格的说明。

Linux 上现有逻辑不建球。语音子进程同样不启动，设置页沿用现在的 Linux 提示。

Host 和页面之间仍走现有的 NDJSON。这一次新增加的消息：

| 方向 | 消息 | 作用 |
|---|---|---|
| 页面 → Host | `{ type: 'pinned', pinned }` | 固定变化 |
| 页面 → Host | `{ type: 'activity' }` | 输入框有按键，空闲计时重算 |
| Host → 页面 | `{ type: 'pin' }` | 调用 `pinBall()` 并展开 |
| Host → 页面 | `{ type: 'unpin' }` | 只取消固定 |
| Host → 页面 | `{ type: 'voice-hold', hold }` | 停止按钮和展开要不要为播报多留 |
| Host → 页面 | `{ type: 'voice-mode', mode }` | 听的状态变化，页面据此显示或隐藏输入框上沿的语音指示条 |
| Host → 页面 | `{ type: 'voice-level', value }` | 0–1 的平滑麦克风电平，驱动指示条的浅蓝色长条 |
| Host → 页面 | `{ type: 'voice-speech', open }` | VAD 开口/闭口，驱动指示条末端那颗 ASR 圆点 |
| Host → 页面 | `{ type: 'voice-prompt', text }` | 一句要发送的语音指令 |
| Host → 子进程 | `configure` / `listen` / `speak` / `stop-speak` | 设置、听的模式、播一段、停掉当前声音 |
| 子进程 → Host | `wake` / `speech` / `utterance` / `playback` / `mic` / `level` | 唤醒、开口、整段文本、播放开始或结束、麦克风是否可用、语音电平 |

`listen` 带 `mode: 'off' | 'wake' | 'command'`，以及 `seedMs`。切到 `command` 且没有回复语要播时 `seedMs` 为 300，其余为 0。

## 2. 听的状态

先写 `listen.ts` 和单测，不接麦克风。

输入：

- `pinned`：页面报上来的固定
- `agentBusy`：现有的 `turnRunning`
- `questionOpen`：提问卡还在等点选
- `playbackBusy`：喇叭上有声音，或队列里还有收尾、提问提示语、唤醒回复语、退下回复语
- `wakeEnabled`：开关开着，并且唤醒模型文件齐全
- `commandEnabled`：开关开着，并且官方 ASR 模型文件齐全
- `micOpen`：子进程已经拿到麦克风

输出只有三种：`off`、`wake`、`command`。

```
agentBusy 或 questionOpen 或 playbackBusy  → off
没固定，wakeEnabled，micOpen               → wake
已固定，commandEnabled，micOpen            → command
其余                                       → off
```

对应需求第 1 节。模型没准备好或开关关掉，就等于那一列没有。麦克风权限没给，两列都不发生，球的其他功能照常。两列都没有时，子进程不打开输入流，Host 的设置页也不报麦克风故障。

测试把这张表的每一行都覆盖到，再加：只关唤醒、只关语音输入、只关 TTS（TTS 关掉时 `playbackBusy` 不会因为播报变成真）、提问卡开着、收尾还在播。

## 3. 播报队列

先写 `queue.ts` 和单测。TTS 开关关掉，或 TTS 模型不在时，这个队列不接收任何文本，调用方直接看到「没有要播的」。

队列认四种东西：

| 种类 | 什么时候产生 | 喇叭忙时 |
|---|---|---|
| 途中正文 | 任务还没结束，这句后面又出现了工具调用 | 丢掉，以后不补 |
| 收尾 | 任务结束时还没播过的那段正文 | 放进收尾槽，槽里始终只有一段 |
| 提问提示语 | 提问卡弹出 | 单独占一个槽，收尾换掉时它还在 |
| 本地短句 | 唤醒回复语、退下回复语 | 立刻占用喇叭；这两句很短，而且只在 Agent 空闲时出现 |

正文只来自推到球上的 `kind === 'assistant'`。Host 里 `applyContent` 已经把模型的 `text` 收成这种块，`reasoning` / `thinking` 收成 `reasoning`，工具是 `tool`。思考、工具、面板状态不进队列。显示中的会话一切换，清空暂停区和队列并停掉当前声音。

一句正文刚到时，还不能断定它是途中还是收尾。模型先把字吐完，过一会儿才调用工具，或者就此结束。按下面的规则分类，单测就按这几步写：

1. 用 TTS 文档里的 `takeReadyPrefix` 把流式正文切成句子。任务结束时把没切完的尾巴强制切出来。
2. 句子就绪时，喇叭空着、队列也是空的：马上播。这句先记成「还没归类」。
3. 句子就绪时喇叭不空：放进暂停区，不进播放队列。
4. 工具调用开始：暂停区全部丢掉。缓冲区里还没切成句的开场那句，喇叭空着、后面也没排提问或收尾，就立刻当途中播；喇叭忙，或后面已经排了提问/收尾，就丢掉，不留到收尾再补。正在播的那句如果还没归类，记成途中，让它播完，不补后面丢掉的字。
5. 喇叭在任务中途空出来：只播队列里已经确定的收尾和提问提示语。不要把暂停区补播出去。
6. 任务结束：暂停区里剩下的字拼成一段收尾。喇叭空着就播；忙着就放进收尾槽，替换槽里旧的收尾，不替换提问提示语。已经在播的「还没归类」改记为收尾，不要再排一次。
7. 提问提示语进入自己的槽。一张卡一句。它和收尾按入队顺序播。后来的收尾只替换收尾槽里的文字，不把提示语挤掉，也不插到提示语前面。
8. 用户点选或取消这张卡：正在播的如果是这句提示语，立刻停；它还排在队列里，就从队列删掉。正在播的正文继续。
9. 点击停止，或显示中的会话换了：暂停区、队列、当前声音全部清掉。

本地短句不进收尾槽。它们占用喇叭时，`playbackBusy` 为真，所以这两句说完之前不会把麦克风里的声音当成指令。回复语或提问提示语是空字符串时，不往喇叭送，队列里也不占位。

测试至少包含需求第 8 节那一轮里的播报分支：途中句赶上了就播、没赶上就在工具开始后丢掉、提问提示语排队、收尾排队、点选后提示语停下、停止后队列为空。再加一条：收尾是连续两句，拼成同一段，只占一个槽。

## 4. 退下和空闲

### 4.1 包含匹配

`dismiss.ts`：把识别结果和口令都去掉空白、标点和符号，再做 NFKC 与拉丁字母小写归一，然后检查识别结果是否完整包含某条口令。整句就是口令、或长句里完整带出口令，都算命中；只说出口令的一部分不算。一条口令都没有时，没有退下。

「你退下吧。」命中出厂口令。「请你退下吧」「好的，你给我退下吧」命中。「退下吧，去查天气」命中。「你退下」不命中。

### 4.2 空闲计时

`idle.ts` 只回答「现在要不要取消固定」。计时在 Host，用可注入的时钟，单测不要真等 30 秒。

开始计时的条件：已经固定，Agent 不忙，没有提问卡，没有播报（含本地短句），当前也没有一段还没送出的语音。条件一满足就从 0 计满设置里的时长。

这些情况把表停住，时间不往前走。停住的条件消失、并且仍然固定时，重新从 0 开始：

- 一段语音已经开口、还没送出
- Agent 正在执行
- 提问卡在等
- 收尾、提问提示语、唤醒回复语或退下回复语还在播，或队列里还有

这些情况立刻从 0 重算：输入框有按键、发出一条文字指令、一段语音已经作为指令送出。

鼠标在不在球上，不传入这个函数。到时只产生「取消固定」，不产生「收回显示框」。

## 5. 设置

存在 profile 的 `orb-voice.json`，走现有的 `ProfileStore`：读坏了用出厂值，写的时候原子替换。空闲时长和三个模型无关，模型不在时也能改。

```ts
interface VoiceSettings {
  wakeEnabled: boolean
  wakeWords: string[]          // 出厂 ['你好大肥鱼']
  wakeThreshold: number        // 0.25，允许 0.05–0.9
  wakeScore: number            // 1，允许 0.5–4
  wakeChunk: 8 | 16            // 出厂 8
  wakeCooldownMs: number       // 1500，允许 500–5000
  wakeReply: string            // 我在
  commandEnabled: boolean
  dismissPhrases: string[]     // ['你退下吧', '退下吧']
  dismissReply: string         // 好的，再见
  ttsEnabled: boolean
  questionPrompt: string       // 我有几个问题，你来选一下
  ttsSpeed: number             // 1.5，允许 1–3，步进 0.1
  idleMs: number               // 30000，允许 5000–600000
}
```

三个开关出厂都是开。模型不在时开关的值仍保存，只是第 2 节里对应的能力不生效。

### 5.1 页面

在 `packages/client-settings/client.js` 的悬浮球页增加一组「语音」，放在现有卡片下面。球菜单里的「打开悬浮球设置」已经会打开这一页，不用新做入口。中英文案都补上，跟随现在的 `text` 表。

三组各自放自己的控件和自己的下载按钮：

- 语音唤醒：开关、灵敏度、增强分、判定粒度、冷却、唤醒词、回复语、下载按钮。
- 语音输入：开关、退下口令（多条）、退下回复语、启动 ASR 的按钮。
- TTS：开关、提问提示语、语速、下载按钮。
- 空闲时长单独一项，始终可改。

模型不在时，被锁住的控件看起来不可用，但点击要弹窗，不能做成原生 `disabled` 把点击吞掉。弹窗说明缺哪一个模型。同一处被两个模型挡住时，把缺的都写上。

| 缺的模型 | 不能改 | 弹窗 |
|---|---|---|
| 唤醒 | 这一组里除下载按钮以外的全部 | 要下载语音唤醒模型 |
| TTS | TTS 的开关、提问提示语、语速；还有唤醒回复语、退下回复语 | 要下载 TTS 模型 |
| 官方 ASR | 语音输入的开关、退下口令 | 要启动 ASR 语音模型 |

退下回复语只看 TTS 模型在不在。

下载按钮的行为见第 9 节。这一节先用假的「模型在 / 不在 / 下载中百分之多少」把页面和锁做完。

设置路由沿用 `/.dsh-orb` 那一组：`GET /settings` 的 snapshot 里增加 `voice`，以及每个模型的 `present`、`downloading`、`progress`。保存用一条新的 `POST`。下载用单独的 `POST`，进行中的重复点击直接返回当前进度，不另起一次下载。

验收：三项开关、空闲时长、文案能保存并在重启 Host 后还在。模型不在时点击被锁控件会弹出对应说明。ASR 按钮在 `present: true` 时不渲染。

## 6. 接到现有的球

这一节用一个脚本子进程代替真麦克风：测试可以让它发出 `wake`、`utterance`、`playback`。球上的交互先全部走通。

### 6.1 固定要让 Host 知道

`pinned` 今天只活在 `shell.js` 里。下面每次变化都经 helper 主进程上报 `{ type: 'pinned', pinned }`：

- 单击球的翻转（`shell.js` 里球的 `pointerup`）
- 拖动开始时的取消固定（`startBallDrag`）
- Host 要求固定或取消固定

Host 发 `{ type: 'pin' }` 时，页面调用现有的 `pinBall()` 再 `setExpanded(true)`，效果与单击钉住相同。Host 发 `{ type: 'unpin' }` 时，只把 `pinned` 设为 false。接着走现有收回规则：当时指针不在悬浮球窗口上，就 `scheduleCollapse()`；指针还在上面，显示框留着，等现有的 `pointerleave` 再收。取消固定不播退下回复语，不发消息，输入框里的草稿保留。

Agent 空闲时的拖动保持现在的样子：取消固定，并且 `setExpanded(false, true)` 把显示框收起。

为了知道「指针还在不在」，给窗口加一个 `pointerInside`。`pointerenter` 置真，`pointerleave` 置假。空闲计时不读它。

### 6.2 任务、提问卡、停止

这些 Host 里已经有了，语音控制器只订阅：

- `beginTurn` / `finishTurn` → `agentBusy`
- 提问消息出现 → `questionOpen`，并往队列放一句提示语
- `onQuestionAnswer`、`onQuestionCancel`、helper 断开后的 `handQuestionBack` → 提问结束，按第 3 节停掉这句提示语
- 现有 `{ type: 'stop' }`：Agent 还在就走现有的 `stopTurn`；同时清掉暂停区和队列，并让子进程停掉当前 PCM

`shell.js` 的 `setRunning` 在任务开始时已经会 `showWorkPanel()`，也就是展开并固定。保持这个行为。任务进行中单击球仍只取消固定，显示框因为 `running` 或 `asking()` 收不回去。

停止按钮今天是 `stop.hidden = !expanded || !running`。增加 `voiceHold`：收尾或提问提示语正在播，或队列里还有它们。`voiceHold` 为真时按钮留着，显示框保持展开。本地的「我在」「好的，再见」不把 `voiceHold` 置真。两边都结束，Host 发 `voiceHold: false`。若此时已经取消固定，按 6.1 的指针规则收回。

`voiceHold` 不锁历史和新会话。那把锁仍然只跟 `running` 走。

### 6.3 一句语音变成一条消息

子进程报 `utterance` 后，Host 先做退下匹配。

命中：不产生用户气泡。Host 发 `unpin`，再让子进程播退下回复语。回复语是空的，或 TTS 关着、模型不在，就只取消固定。

未命中：Host 把原文发给页面（`voice-prompt`）。页面接着做两件事：

1. 走现有的 `refreshTccGate({ forceShow: true })`。屏幕录制或辅助功能还没给，就展开引导层，这句话结束，不上屏。
2. 权限齐了，用现有的 `composeSend` 把划词 chip 拼进正文并清掉 chip，再 `api.send`。这会进现有的 `onPrompt`，用户气泡和轮次都从那里来。输入框里的草稿留着。页面上不再另画一条用户消息。

输入框按键上报 `{ type: 'activity' }`，让空闲计时重算。语音开口由子进程的 `speech` 消息把计时停住，送出后再重算。

### 6.4 这一节的验收

用脚本子进程，不打开麦克风：

1. 发 `wake`：显示框展开并固定。接着发一段播报开始和结束。结束之后状态变成 `command`。
2. 发一句普通识别结果：显示框里出现用户消息，并进入现有的执行。执行期间状态是 `off`。
3. 发「好的，你给我退下吧。」：命中包含匹配，不上屏。固定取消。指针不在窗口上时显示框收回。
4. 固定着且空闲，把时钟拨过 30 秒：只取消固定。
5. 执行中把固定取消：显示框还在，状态保持 `off`。执行结束且没有播报后，状态变成 `wake`。
6. 提问卡出现：状态 `off`，队列里有一句提示语。点选后，若这句还在播，播放结束事件带着「被停掉」。
7. 执行结束后仍有收尾：停止按钮还在。点击后队列空，按钮消失。

## 7. 语音子进程：一路麦克风，按需开

把 wake-lab 的采集和 `KeywordSpotter` 循环、voice-lab 的 `VoiceInputStream` 搬进 `child.ts`。采集回调里只做重采样、混成单声道、推进环形缓冲和 VAD。SenseVoice 的解码放在 worker 线程，沿用 voice-lab 的做法。回调里跑识别会让 CoreAudio 报 overrun。

子进程启动后：

1. 按 Host 发来的配置加载已经存在的模型。唤醒开关关着或文件不齐，就不加载 KWS。语音输入同理不加载 ASR；语音输入关掉时把已加载的 ASR worker 一起停掉，回收内存。TTS 同理。
2. 只有 Host 发来的 `device` 为 true，且唤醒或语音输入至少一列可用（开关开着、模型齐、唤醒词不空）时才打开默认输入设备；`device` 为 false 或两列都不可用时关闭输入流，系统麦克风指示消失。优先原生 16kHz、Float32、单声道。否则采集后再用 `LinearResampler` 转到 16k，多声道逐帧平均。
3. 输入流开着时，始终保留最近 0.5 秒 PCM。

每一块 PCM：

- 模式 `wake`：喂给 KWS。命中后 `reset`，进入冷却，向 Host 发 `wake`。不关闭输入流。
- 模式 `command`：喂给 VAD。静音判定结束后得到整段文本，向 Host 发 `utterance`。说话过程中发 `speech: true`，段结束发 `speech: false`。每 50ms 把平滑后的 0–1 电平作为 `level` 发给 Host，只用于输入框上沿的语音指示条。没有逐字结果。
- 模式 `off`：这块 PCM 不喂给任何一个解码器。只要还有一列可用，输入流就开着；两列都不可用时按上面的规则关闭。

从 `wake` 切到 `command` 时：

- 没有本地回复语要播：把切换前 300ms 作为 VAD 的段首回补历史，让固定之后立刻说的那句字头还在。不要把这 300ms 单独识别成一句。
- 有「我在」要播：播放期间保持 `off`。播放结束再进入 `command`，回补只用播放结束之后的新样本，避免把「我在」的回声识别进去。回复语播放期间说的话不收下。

识别文本如果以当前某条唤醒词开头，去掉这个前缀。去掉之后是空的，就丢掉，不当成指令。

KWS 的引擎在词表、灵敏度、增强分、chunk 变化时重建，约 220–290ms。重建期间不关闭麦克风。`keywords.txt` 只能由生成器写出纯 token 行，不能有注释和空行，否则 sherpa 会直接把进程打崩。冷却时间改变不用重建引擎。

出厂唤醒词写成 `你好大肥鱼`，只放这一条。实现这一节时用 wake-lab 的生成器产出 token，再用系统语音合成 16kHz wav 做文件回放。这份词已经在唤醒文档里用真人麦克风验收过。文件回放命中不了，先查词表和参数，出厂词保持 `你好大肥鱼`。

麦克风权限：采集发生在 Host 这条进程里，macOS 弹窗上的名字是 DeepSeek Harness（桌面版）或当前终端（`dsh web`），和现有的屏幕录制一致。拒绝或设备打开失败时，子进程报 `mic: false`，听的状态保持 `off`。设置页的语音组顶部加一行说明，并给出打开系统麦克风设置的按钮，写法对齐现在的 TCC 行。球本身继续能用。

验收：

- 对着麦克风说「你好大肥鱼」，显示框固定。说的这句唤醒词不上屏。
- 固定后说「查一下今天的天气」，约 0.6 秒内整句上屏并发送。说的过程中显示框里没有逐字稿。
- 唤醒之后立刻把指令接在后面说，指令的第一个字还在。
- 回复语「我在」播放时再说一句，这句话不发送。播完之后的下一句会发送。
- 执行期间说话，没有新的用户消息。

## 8. TTS

把 Matcha 参考实现里的文本层和两个 `OfflineTts` 引擎放进子进程。中文引擎用 lexicon 和 `date.fst,number.fst,phone.fst`。英文引擎用 `espeak-ng-data`。`numThreads` 写在 `model` 里面，用 4。`lang` 留空。`sid` 固定 0。两个引擎第一次用到时再加载，加载后各跑一次「预热」。合成放进队列，同一个实例不要并发 `generate()`。

语速按 TTS 文档第 5 节：设置值记为 T。中文模型速度用 `min(T, 1.5)`，剩下的倍率用 SOLA。英文按同一套规划做反向补偿，让听感落在 T。T 的上限是 3.0。不要把大于 1.5 的值直接传给中文模型的 `speed`。

Host 上的队列（第 3 节）决定「播哪一段」。子进程只接收已经定稿的一段文字，自己再清洗、切句、合成、播放。一段收尾在子进程里按句合成，句和句之间用文档里的 gap，对 Host 来说仍是同一段：整段开始报一次，整段结束报一次。

Agent 的工具调用不等待播放。Host 把「播这段」写进子进程 stdin 之后立刻返回。`onAssistantStream` 里只把正文交给队列，不在那里 `await` 播放结束。

本地回复语是空字符串时，Host 不发播放，直接按第 2 节恢复麦克风。

验收：

- 任务途中吐出「我去查一下今天的天气」，喇叭空着时能听到。人为让喇叭先占着，这句不播，后面的工具调用仍继续。
- 提问卡只听到提示语，听不到题目和选项。点选后提示语中断。
- 收尾在上一句没播完时会排队，上一句结束后马上开始。停止按钮在收尾期间还在，点击后声音立刻停。
- 把显示框换到另一场对话，上一场的声音停，新一场才可能再播。
- 语速 1.5 和 3.0 都能出声。1.5 下用文档第 7.2 节的办法抽查一句，重合度达到那份文档的合格线。

## 9. 模型下载

进度条放在对应按钮下面，显示已下载字节除以总字节。下载进行中，这个按钮不再发起另一次。结束或失败后进度条消失。失败时在按钮下说明原因，已下的完整文件保留，残缺文件删掉，用户可以再点。

### 9.1 唤醒模型和 TTS 模型

> 2026-10-25 起唤醒模型改由 npm 数据包 `dsh-orb-kws` 分发（先 npmmirror、再 npmjs），弹窗写镜像地址和约 9 MB；下面这条 GitHub 地址降为最后的兜底。见 [04-addenda.md](04-addenda.md) 第 34 节。

弹窗里的来源和体积就用下面这组，和两份落地文档里的官方发布物一致。

唤醒，解压后约 38MB：

`https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`

解压后必须同时有 chunk-8 和 chunk-16 的 int8 encoder、fp32 decoder、int8 joiner，以及 `tokens.txt`、`en.phone`。少一个文件就视为模型不存在。fp32 encoder 不用加载。

TTS，磁盘约 214MB，三份都要：

| 文件 | 官方来源 | sha256 |
|---|---|---|
| 中文 Matcha | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2` | 包内 `model-steps-3.onnx` 为 `ff1cc7f7abdedc4eeec668a4a0dc2e72a0c314c5637d5fce885345b490bd08de` |
| 英文 Matcha | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-en_US-ljspeech.tar.bz2` | 包内 `model-steps-3.onnx` 为 `4d7771c0ec063ca74f2fa92ba0ecfe14f73fa3f61c236d9469b92e102d8e9574` |
| vocoder | `https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx` | `0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081` |

中文包还要有 `tokens.txt`、`lexicon.txt`、`date.fst`、`number.fst`、`phone.fst`。英文包还要有 `tokens.txt` 和整个 `espeak-ng-data/`。`dict/` 那套 jieba 词典不用。vocoder 在磁盘上存一份，两个模型目录里用软链指过去。

按钮行为：

- 文件不齐：按钮是这一组的主按钮。点击先弹窗，写上来源和体积。用户确认后才下载。
- 文件齐全而且哈希和清单一致：按钮留着，样式改成次按钮。再点击时弹窗「模型已经存在，不需要重新下载」，不开始下载。
- 文件在，但哈希和当前插件清单不一致：视为要更新，不再弹首次确认，直接下载，进度条同样在按钮下方。

下载写到临时文件，校验通过再替换正式文件。国内访问 GitHub 失败时，沿用落地文档里的镜像顺序重试，弹窗里仍写官方来源。

### 9.2 官方 ASR

按钮文案是「启动 ASR 语音模型」。只在官方模型不存在时渲染。

Host 读 `ctx.speechToText`。服务不存在，或没有 id 为 `sensevoice-local` 的提供者：弹窗说明当前 DeepSeek Harness 没有官方语音识别服务，插件不会自己另下一份。按钮可以留着，点击只出现这句说明。

服务存在：弹窗写明官方来源和体积，用户确认后调用 `prepare('sensevoice-local')`。来源用该提供者的 `downloadSources`（官方默认是 `https://huggingface.co` 和 `https://hf-mirror.com`）。体积按官方 `assets.json` 的 int8 三件套：

| 文件 | 字节 |
|---|---|
| `model.int8.onnx` | 239233841 |
| `tokens.txt` | 315894 |
| `silero_vad.onnx` | 1807522 |

合计 241357257 字节，弹窗写约 230MB。进度用 snapshot 里 `downloading` 的 `completedBytes / totalBytes`。`phase === 'ready'` 之后按钮不再显示。以后的更新由用户在 DeepSeek Harness 自己的语音页面处理。

子进程使用的路径：

```
dshHomePath('speech-to-text', 'sensevoice')/models/sensevoice-onnx/model.int8.onnx
dshHomePath('speech-to-text', 'sensevoice')/models/sensevoice-onnx/tokens.txt
dshHomePath('speech-to-text', 'sensevoice')/models/silero/silero_vad.onnx
```

三个文件都在、并且字节数和上面一致，才算 ASR 已存在。下载进行中算不存在，被锁的控件继续不能改。

验收：删掉本机对应目录后，三个按钮各自能弹窗、能出进度、完成后第 2 节的对应列开始生效。ASR 完成后按钮消失，官方目录里有文件，`dsh-orb/voice` 下面没有第二份 SenseVoice。唤醒和 TTS 在文件已齐时再点，出现「模型已经存在，不需要重新下载」。

## 10. 打包

`packages/bundle/scripts/pack.mjs` 今天会把 `koffi` 和 `zod` 收进 tarball。语音这条同样要把运行时依赖收进去，否则用户装上的包加载不了原生模块：

- `sherpa-onnx-node@1.13.8` 和当前平台的预编译包
- `node-cpal` 和它的平台包
- `pinyin-pro`

只打 macOS arm64、macOS x64、Windows x64，和球本身的平台一致。装好后在官方桌面版和 `dsh web` 各启动一次，确认子进程能 `require` 到这些模块。

## 11. 按需求走完整一轮

三个模型都已就绪、三个开关都开着，在真机上按这个顺序操作。每一步的听和播都要符合。

1. 球没有固定。说「你好大肥鱼」。显示框展开并固定，听到「我在」，然后可以下指令。
2. 说「查一下今天的天气」。说完后整句上屏并发送。没有逐字稿。
3. Agent 开始干活。唤醒和语音输入都没有反应。途中若说出短句，喇叭空着就听到；用上一句本地音频把喇叭占住时，这句途中的话不再出现。思考和工具调用不播，也不等喇叭。
4. 若弹出提问卡，只听到「我有几个问题，你来选一下」。卡片还在时说话没有反应。点选或取消后，这句如果还在播，立刻停。
5. 任务结束。收尾能听到。喇叭若被占着，上一句结束后马上听到收尾。这段时间停止按钮还在，显示框还展开。
6. 收尾结束，停止按钮消失。固定还在，就可以直接说下一句。30 秒没有新的指令，只取消固定；指针不在悬浮球窗口上时显示框收回。
7. 再次固定后说「退下吧」。这句话不上屏、不发给 Agent。固定取消，听到「好的，再见」。
8. 再跑一次任务，在执行中到收尾播完之前点停止。执行停、声音停、没有补播，按钮消失。之后按当时的固定状态恢复麦克风。

另外抽查：三个开关各自关掉时，只有那一列停止，另外两列仍按第 1 节工作。模型文件删掉一个，对应列停止，开关的勾选状态还在。

## 12. 不要做

需求第 10 节里的项都不要做：单独的语音按钮、说话打断 TTS、把提问卡内容念出来、用语音回答提问卡、补播没赶上的途中正文、在设置里再暴露一套 VAD / ASR 参数。

另外两件不要做：不要把 PCM 或模型再复制进 helper；不要在 Host 主线程里调用 `KeywordSpotter`、`OfflineRecognizer` 或 `OfflineTts`。

## 13. 材料

- 交互：[05-voice.md](05-voice.md)
- 唤醒：`~/Projects/tts_native/docs/KWS-语音唤醒-落地实现文档.md`，代码在 `tts_native/wake-lab`
- 语音输入：`~/Projects/tts_native/docs/VAD-ASR-语音输入-落地实现文档.md`，代码在 `tts_native/voice-lab`
- TTS：`~/Projects/tts_native/docs/Matcha-TTS-落地实现文档.md`，参考实现 `tts_native/tts-lab/reference/matcha-tts.mjs`
- 官方 ASR 下载：DeepSeek Harness 的 `speechToText.prepare('sensevoice-local')`，资产清单在官方包 `speech-to-text-sensevoice/runtime/assets.json`
