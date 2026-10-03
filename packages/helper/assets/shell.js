import { renderMarkdown } from './markdown.js'
import {
  processLabel, reasoningSummary, processTitle, toolTitle, toolLabels, classifyTool, deriveSummary,
  formatToolBody, terminalCardModel, terminalFailed, readCardModel,
  searchCardModel, webCardModel, diffCardModel, diffTotals, diffLines,
  usageLabels, tokenUsageTotal, formatTokenCount,
} from './transcript-model.js'
import { upgradeCodeBlocks } from './highlight.js'
import {
  icon, THINK, CHEVRON_DOWN, CHEVRON_UP, SEARCH, GLOBE, BROWSE, EDIT, CODE, API, SPARKLE, COPY, CHECK, stateSpinner,
} from './icons.js'

const api = window.dshOrb
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
const DOCK_HOVER_DELAY_MS = 800
const DOCK_DRAG_OFF_PX = 24
const COMPOSER_MIN_PX = 72
const COMPOSER_LINE_PX = 20
const COMPOSER_MAX_PX = COMPOSER_MIN_PX + COMPOSER_LINE_PX * 3
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

const zh = {
  title: '桌面 agent',
  stop: '停止',
  fresh: '新建',
  history: '历史',
  historyEmpty: '还没有 Computer Use 对话。',
  untitled: '未命名对话',
  placeholder: '向桌面 agent 发送消息…',
  accessReadOnly: '仅可查看',
  accessWrite: '工作区内修改',
  accessFull: '完全权限',
  cancel: '放弃',
  skip: '跳过',
  next: '下一题',
  submit: '提交',
  prev: '上一题',
  recommended: '推荐',
  custom: '输入你的答案',
  incomplete: '请先完成这道问题。',
  unanswered: '请选择一个选项或填写自定义答案。',
  think: '思考',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  tooLong: '最多 8000 个字符，已保留输入。',
  truncated: '已截断',
  chipDismiss: '移除',
  tccTitle: '使用桌面 agent 需要两项 Mac 权限',
  tccAppHint: '在列表里打开 {name}。',
  tccScreenName: '屏幕录制',
  tccScreenReason: '让 agent 看见当前窗口。',
  tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
  tccScreenOpen: '打开「屏幕录制」设置',
  tccAccessibilityName: '辅助功能',
  tccAccessibilityReason: '让 agent 点击和输入。',
  tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
  tccAccessibilityOpen: '打开「辅助功能」设置',
  tccStatusMissing: '未开启',
  tccStatusGranted: '已开启',
  tccStatusNeedsRelaunch: '已开启，请退出后重开',
  tccFooter: '打开开关后，请完全退出 {name} 再打开。只关主窗口无效。插件不能替你重启官方应用。',
  tccLater: '稍后',
  tccDismiss: '关闭',
}
const en = {
  title: 'Desktop agent',
  stop: 'Stop',
  fresh: 'New',
  history: 'History',
  historyEmpty: 'No Computer Use chats yet.',
  untitled: 'Untitled',
  placeholder: 'Ask the desktop agent…',
  accessReadOnly: 'Read Only',
  accessWrite: 'Workspace Write',
  accessFull: 'Full access',
  cancel: 'Dismiss',
  skip: 'Skip',
  next: 'Next',
  submit: 'Submit',
  prev: 'Previous question',
  recommended: 'Recommended',
  custom: 'Type your answer',
  incomplete: 'Please complete this question first.',
  unanswered: 'Please select an option or enter a custom answer.',
  think: 'Think',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  tooLong: 'Limit is 8000 characters. The text was kept.',
  truncated: 'truncated',
  chipDismiss: 'Remove',
  tccTitle: 'Desktop agent needs two Mac permissions',
  tccAppHint: 'In the list, turn on {name}.',
  tccScreenName: 'Screen Recording',
  tccScreenReason: 'Lets the agent see the current window.',
  tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
  tccScreenOpen: 'Open Screen Recording settings',
  tccAccessibilityName: 'Accessibility',
  tccAccessibilityReason: 'Lets the agent click and type.',
  tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
  tccAccessibilityOpen: 'Open Accessibility settings',
  tccStatusMissing: 'Off',
  tccStatusGranted: 'On',
  tccStatusNeedsRelaunch: 'On — quit and reopen',
  tccFooter: 'After the switches are on, quit {name} completely and open it again. Closing the main window does not quit. This plugin cannot restart the official app.',
  tccLater: 'Later',
  tccDismiss: 'Dismiss',
}

const PROMPT_LIMIT = 8000
// The UI language mirrors the main window's, delivered on the appearance
// message; until it arrives the page follows the system like the web client.
let messages = (navigator.language || '').toLowerCase().startsWith('zh') ? zh : en
let chatLabels = toolLabels(messages === zh)
let usageText = usageLabels(messages === zh)

/** Switch the page dictionary; refreshers re-render from the new one. */
function applyLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') return
  const next = locale === 'zh' ? zh : en
  if (next === messages) return
  messages = next
  chatLabels = toolLabels(messages === zh)
  usageText = usageLabels(messages === zh)
  document.documentElement.lang = locale
}

function applyColorScheme(dark) {
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  // Theme sheets key dark overrides on body[data-ds-dark-theme], as in Harness.
  document.body.toggleAttribute('data-ds-dark-theme', dark)
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
applyColorScheme(colorScheme.matches)
colorScheme.addEventListener('change', () => applyColorScheme(colorScheme.matches))

function promptText(prompt) {
  return (prompt.innerText ?? prompt.textContent ?? '').replaceAll('\u00a0', ' ')
}

function composeSend(instruction, selection) {
  if (selection === '') return instruction
  const joiner = '\n\n'
  const room = PROMPT_LIMIT - instruction.length - joiner.length
  if (room <= 0) return instruction
  const mark = `\n${messages.truncated}`
  let body = selection
  if (body.length > room) {
    const kept = Math.max(0, room - mark.length)
    body = kept === 0 ? mark.slice(0, room) : `${selection.slice(0, kept)}${mark}`
  }
  return `${instruction}${joiner}${body}`
}

function insertPlainText(prompt, text) {
  if (text === '') return
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  prompt.append(text)
}

function editableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  if (element == null || typeof element.closest !== 'function') return false
  return element.closest('input, textarea, [contenteditable="true"]') !== null
}

function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229
}

function parseRecommendedLabel(label) {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped
}

function buildAnswer(questions, drafts) {
  return {
    answers: questions.map((item, index) => {
      const value = drafts[index]
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

function permissionText(preset) {
  if (preset === 'read-only') return messages.accessReadOnly
  if (preset === 'workspace-write') return messages.accessWrite
  return messages.accessFull
}

function main() {
  document.documentElement.lang = messages === zh ? 'zh' : 'en'
  const stop = document.querySelector('#stop')
  const newConversation = document.querySelector('#new-conversation')
  const historyButton = document.querySelector('#history')
  const permissionRoot = document.querySelector('#permission')
  const permissionButton = document.querySelector('#permission-button')
  const permissionLabel = document.querySelector('#permission-label')
  const permissionMenu = document.querySelector('#permission-menu')
  const ball = document.querySelector('#ball')
  const dockTab = document.querySelector('#dock-tab')
  const panel = document.querySelector('#panel')
  const transcript = document.querySelector('#transcript')
  const questionRoot = document.querySelector('#question')
  const questionEyebrow = document.querySelector('#question-eyebrow')
  const questionTitle = document.querySelector('#question-title')
  const questionDetail = document.querySelector('#question-detail')
  const questionOptions = document.querySelector('#question-options')
  const questionCustom = document.querySelector('#question-custom')
  const questionError = document.querySelector('#question-error')
  const questionPager = document.querySelector('#question-pager')
  const questionProgress = document.querySelector('#question-progress')
  const questionPrev = document.querySelector('#question-prev')
  const questionNextNav = document.querySelector('#question-next-nav')
  const questionSkip = document.querySelector('#question-skip')
  const questionContinue = document.querySelector('#question-continue')
  const questionCancel = document.querySelector('#question-cancel')
  const historyList = document.querySelector('#history-list')
  const status = document.querySelector('#status')
  const prompt = document.querySelector('#prompt')
  const composer = document.querySelector('#composer')
  applyStaticText()

  let expanded = false
  let pinned = false
  let running = false
  let attachedSelection = ''
  let tccGateVisible = false
  let processGroup
  let processClock
  let dragging = false
  let collapsing = false
  let skipClick = false
  let skipDockCommit = false
  let suppressExpand = false
  let docked
  let dockHoverArmed = true
  let dockPointerInside = false
  let dockHoverTimer
  let collapseTimer
  let collapseFrame
  let pointer
  let lastOrigin
  let permission = 'danger-full-access'
  let permissionOpen = false
  let historyOpen = false
  let pending
  let sessionId = ''
  let avatarSrc = 'deepseek-avatar-square.gif'
  let historyItems = []
  const blocks = new Map()
  // Last message per block key: the locale refresh re-renders from it.
  const blockData = new Map()
  let lastTccStatus

  /**
   * Re-apply every static label. Called at startup and on locale changes;
   * dynamic regions (permission, history, question, TCC gate, transcript) are
   * refreshed separately from their stored state.
   */
  function applyStaticText() {
    document.querySelector('#page-title').textContent = messages.title
    const stopButton = document.querySelector('#stop')
    stopButton.setAttribute('aria-label', messages.stop)
    stopButton.title = messages.stop
    const newConversationButton = document.querySelector('#new-conversation')
    newConversationButton.setAttribute('aria-label', messages.fresh)
    newConversationButton.title = messages.fresh
    const historyToggle = document.querySelector('#history')
    historyToggle.setAttribute('aria-label', messages.history)
    historyToggle.title = messages.history
    document.querySelector('#input-label').textContent = messages.placeholder
    prompt.dataset.placeholder = messages.placeholder
    questionCancel.textContent = messages.cancel
    questionSkip.textContent = messages.skip
    questionPrev.setAttribute('aria-label', messages.prev)
    questionNextNav.setAttribute('aria-label', messages.next)
    questionPrev.textContent = '‹'
    questionNextNav.textContent = '›'
    const chipDismiss = document.querySelector('#selection-chip-dismiss')
    chipDismiss.setAttribute('aria-label', messages.chipDismiss)
    chipDismiss.title = messages.chipDismiss
    document.querySelector('#tcc-screen-name').textContent = messages.tccScreenName
    document.querySelector('#tcc-screen-reason').textContent = messages.tccScreenReason
    document.querySelector('#tcc-screen-path').textContent = messages.tccScreenPath
    document.querySelector('#tcc-screen-open').textContent = messages.tccScreenOpen
    document.querySelector('#tcc-accessibility-name').textContent = messages.tccAccessibilityName
    document.querySelector('#tcc-accessibility-reason').textContent = messages.tccAccessibilityReason
    document.querySelector('#tcc-accessibility-path').textContent = messages.tccAccessibilityPath
    document.querySelector('#tcc-accessibility-open').textContent = messages.tccAccessibilityOpen
    document.querySelector('#tcc-title').textContent = messages.tccTitle
    document.querySelector('#tcc-later').textContent = messages.tccLater
    const tccClose = document.querySelector('#tcc-dismiss')
    tccClose.setAttribute('aria-label', messages.tccDismiss)
    tccClose.title = messages.tccDismiss
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.textContent = permissionText(option.dataset.preset)
    }
  }

  /** Re-render every text surface after the dictionary switched. */
  function refreshAllText() {
    applyStaticText()
    renderPermission()
    renderHistory()
    if (pending !== undefined) renderQuestion()
    if (tccGateVisible && lastTccStatus) showTccGate(lastTccStatus)
    refreshProcessLabel(processGroup)
    refreshTranscriptLocale()
  }

  /** Locale-dependent labels inside the transcript, from the stored messages. */
  function refreshTranscriptLocale() {
    for (const [key, node] of blocks) {
      const block = blockData.get(key)
      if (block === undefined) continue
      if (block.kind === 'user') continue
      if (block.kind === 'reasoning') {
        node.querySelector('.think-title').textContent = messages.think
        node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      } else if (block.kind === 'tool') {
        updateToolNode(node, block)
      } else {
        updateAssistantNode(node, block)
      }
    }
    refreshProcessLabel(processGroup)
  }

  function pageClosed() {
    return globalThis.document?.body == null
  }

  function freezeGif(gif) {
    const still = () => {
      if (gif.dataset.mode !== 'still' || gif.naturalWidth === 0) return
      const canvas = document.createElement('canvas')
      canvas.width = gif.naturalWidth
      canvas.height = gif.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(gif, 0, 0)
      try {
        gif.src = canvas.toDataURL()
      } catch {
        // The GIF already reset to its first frame.
      }
    }
    if (gif.complete && gif.naturalWidth > 0) still()
    else gif.addEventListener('load', still, { once: true })
  }

  function asking() {
    return pending !== undefined
  }

  function syncGif() {
    if (pageClosed()) return
    const gif = document.querySelector('#ball-gif')
    const play = expanded || running || asking() || tccGateVisible || attachedSelection !== ''
    if (play) {
      if (gif.dataset.mode !== 'play') {
        gif.dataset.mode = 'play'
        gif.src = avatarSrc
      }
      return
    }
    if (gif.dataset.mode === 'still') return
    gif.dataset.mode = 'still'
    gif.src = avatarSrc
    freezeGif(gif)
  }

  function setRunning(next, interrupted = false) {
    running = next
    if (pageClosed()) return
    document.body.classList.toggle('running', running)
    stop.hidden = !expanded || !running
    syncGif()
    if (next) {
      const group = ensureProcess()
      if (!group.live) {
        group.live = true
        group.startedAt = Date.now()
        group.elapsedMs = undefined
        setProcessOpen(group, true)
        refreshProcessLabel(group)
        startProcessClock()
      }
      return
    }
    if (interrupted) {
      for (const node of blocks.values()) {
        if (node.dataset.kind === 'tool' && node.dataset.state === 'running') {
          node.dataset.state = 'stopped'
          const summary = node.querySelector('.tool-summary')
          summary?.classList.add('tool-stopped-summary')
        }
      }
    }
    if (processGroup) {
      stopProcessClock()
      freezeProcess(processGroup)
      setProcessOpen(processGroup, false)
      refreshProcessLabel(processGroup)
    }
  }

  function applyDirection(state) {
    document.body.classList.toggle('expand-left', state.horizontal === 'left')
    document.body.classList.toggle('expand-right', state.horizontal === 'right')
    document.body.classList.toggle('expand-up', state.vertical === 'up')
    document.body.classList.toggle('expand-down', state.vertical === 'down')
  }

  function clearDockHoverTimer() {
    if (dockHoverTimer === undefined) return
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    clearDockHoverTimer()
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      return
    }
    if (becameDocked) {
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
    dockTab.hidden = false
  }

  function applyDockedFrom(result) {
    if (result == null) return
    applyDocked(result.docked)
    if (result.horizontal && result.vertical) applyDirection(result)
  }

  async function moveBall(x, y) {
    applyDockedFrom(await api.move(x, y, !(running || asking())))
  }

  async function clampBall() {
    applyDockedFrom(await api.clamp(!(running || asking())))
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnap())
  }

  async function setExpanded(next, force = false) {
    if (pageClosed()) return
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      const state = await api.setExpanded(true)
      applyDocked(undefined)
      applyDirection(state)
      panel.hidden = false
      expanded = true
      document.body.classList.add('expanded')
      stop.hidden = !running
      syncGif()
      return
    }
    if (!force && (pinned || running || asking())) return
    expanded = false
    document.body.classList.remove('expanded')
    if (docked !== undefined) dockTab.hidden = false
    stop.hidden = true
    syncGif()
    if (force) {
      panel.hidden = true
      await api.setExpanded(false)
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      panel.hidden = true
      void api.setExpanded(false)
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (pinned || running || asking() || dragging) return
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  function draftOverflows() {
    return prompt.scrollHeight > prompt.clientHeight + 1
  }

  function syncComposerHeight() {
    const empty = promptText(prompt).trim() === ''
    prompt.classList.toggle('prompt-empty', empty)
    if (empty) {
      document.body.classList.remove('composer-capped')
      document.body.style.setProperty('--composer-height', 'var(--ball)')
      return
    }
    document.body.classList.remove('composer-capped')
    let height = COMPOSER_MIN_PX
    for (;;) {
      document.body.style.setProperty('--composer-height', `${height}px`)
      if (!draftOverflows() || height >= COMPOSER_MAX_PX) break
      height = Math.min(COMPOSER_MAX_PX, height + COMPOSER_LINE_PX)
    }
    document.body.classList.toggle('composer-capped', draftOverflows())
  }

  function clearPrompt() {
    prompt.textContent = ''
    prompt.classList.add('prompt-empty')
    document.body.classList.remove('composer-capped')
    document.body.style.setProperty('--composer-height', 'var(--ball)')
  }

  function refreshProcessLabel(group) {
    if (!group) return
    const elapsedMs = group.live
      ? group.startedAt === undefined ? undefined : Date.now() - group.startedAt
      : group.elapsedMs
    const title = !group.live && group.tools.size > 0
      ? processTitle([...group.tools], messages === zh)
      : undefined
    group.label.textContent = processLabel({
      zh: messages === zh,
      running: group.live,
      elapsedMs,
      title,
    })
  }

  function setProcessOpen(group, open) {
    if (!group) return
    group.preferredOpen = open
    const foldable = group.bodies.some((body) => body.childElementCount > 0)
    const shown = open && foldable
    group.section.toggleAttribute('data-open', shown)
    group.header.toggleAttribute('data-open', shown)
    group.header.disabled = !foldable
    group.chevron.hidden = !foldable
    if (foldable) group.header.setAttribute('aria-expanded', String(shown))
    else group.header.removeAttribute('aria-expanded')
  }

  function freezeProcess(group) {
    if (!group?.live) return
    group.elapsedMs = group.startedAt === undefined ? undefined : Date.now() - group.startedAt
    group.live = false
  }

  function stopProcessClock() {
    if (processClock === undefined) return
    clearInterval(processClock)
    processClock = undefined
  }

  function startProcessClock() {
    stopProcessClock()
    processClock = setInterval(() => {
      if (processGroup?.live) refreshProcessLabel(processGroup)
    }, 1000)
  }

  function closeProcess() {
    const group = processGroup
    if (!group) return
    stopProcessClock()
    freezeProcess(group)
    refreshProcessLabel(group)
    setProcessOpen(group, false)
    processGroup = undefined
  }

  function ensureProcess() {
    if (processGroup) return processGroup
    const section = document.createElement('section')
    section.className = 'turn'
    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'process'
    const label = document.createElement('span')
    label.className = 'process-label'
    const chevron = icon(CHEVRON_DOWN)
    chevron.classList.add('process-chevron')
    header.append(label, chevron)
    section.append(header)
    const loose = []
    let anchor = null
    for (const child of transcript.children) {
      if (child.dataset?.kind === 'user') {
        loose.length = 0
        anchor = null
        continue
      }
      if (child.dataset?.kind === 'assistant') {
        if (anchor === null) anchor = child
        loose.push(child)
      }
    }
    if (anchor) transcript.insertBefore(section, anchor)
    else transcript.append(section)
    for (const node of loose) section.append(node)
    const live = running
    const group = {
      section, header, label, chevron, bodies: [], current: undefined, live,
      startedAt: live ? Date.now() : undefined,
      elapsedMs: undefined,
      preferredOpen: live,
      tools: new Set(),
    }
    processGroup = group
    header.addEventListener('click', () => {
      if (header.disabled) return
      setProcessOpen(group, !section.hasAttribute('data-open'))
    })
    setProcessOpen(group, live)
    refreshProcessLabel(group)
    if (live) startProcessClock()
    return group
  }

  function syncThinkPreview(node) {
    const summary = node.querySelector('.think-summary-text')?.textContent ?? ''
    node.toggleAttribute('data-preview', !node.hasAttribute('data-expanded') && summary !== '')
  }

  function createThink(node) {
    node.dataset.variant = 'think'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const disclosure = document.createElement('div')
    disclosure.className = 'think-disclosure'
    const row = document.createElement('div')
    row.className = 'think-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'think-leading'
    const idle = document.createElement('span')
    idle.className = 'think-icon-idle'
    idle.append(icon(THINK))
    const hover = document.createElement('span')
    hover.className = 'think-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const openChevron = document.createElement('span')
    openChevron.className = 'think-chevron-open'
    openChevron.append(icon(CHEVRON_UP))
    leading.append(idle, hover, openChevron)
    const title = document.createElement('span')
    title.className = 'think-title'
    title.textContent = messages.think
    const separator = document.createElement('span')
    separator.className = 'think-separator'
    separator.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'think-summary'
    const summaryText = document.createElement('span')
    summaryText.className = 'think-summary-text'
    summary.append(summaryText)
    row.append(leading, title, separator, summary)
    const body = document.createElement('div')
    body.className = 'think-body'
    disclosure.append(row, body)
    node.append(status, disclosure)
    const toggle = () => {
      const open = !node.hasAttribute('data-expanded')
      node.toggleAttribute('data-expanded', open)
      disclosure.toggleAttribute('data-open', open)
      row.setAttribute('aria-expanded', String(open))
      syncThinkPreview(node)
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }

  /**
   * Chronological placement, as in Harness: replies sit between the process
   * runs that produced them. Thinking and tool blocks join the trailing
   * process body; a reply closes that run, so later tools open a new one.
   */
  function placeBlock(node, kind) {
    if (kind === 'user') {
      closeProcess()
      transcript.append(node)
      return
    }
    // With no turn section at all a reply stays loose; the next thinking/tool block scoops it in.
    if (kind === 'assistant' && processGroup === undefined) {
      transcript.append(node)
      return
    }
    const group = ensureProcess()
    if (kind === 'assistant') {
      group.current = undefined
      group.section.append(node)
      return
    }
    let body = group.current
    if (body === undefined) {
      body = document.createElement('div')
      body.className = 'process-body'
      group.section.append(body)
      group.bodies.push(body)
      group.current = body
    }
    body.append(node)
    setProcessOpen(group, group.preferredOpen === true)
  }

  const CHAT_READ_MAX_LINES = 8
  const CHAT_SEARCH_MAX_LINES = 8
  const CHAT_DIFF_MAX_LINES = 9

  function toolIcon(name) {
    if (name === 'web_search') return icon(GLOBE)
    if (name === 'web_fetch' || name === 'read' || name === 'read_image') return icon(BROWSE)
    switch (classifyTool(name)) {
      case 'bash': return icon(API)
      case 'search': return icon(SEARCH)
      case 'write':
      case 'edit': return icon(EDIT)
      case 'code': return icon(CODE)
      default: return icon(SPARKLE)
    }
  }

  async function writeClipboard(text) {
    // Main-process write: renderer clipboard APIs reject while the ball window
    // rests unfocused ("Document is not focused").
    if (typeof api?.copy === 'function') {
      api.copy(text)
      return true
    }
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }

  function copyToClipboard(text, button) {
    const restore = () => {
      button.textContent = chatLabels.copy
      delete button.dataset.copied
    }
    const done = () => {
      button.textContent = chatLabels.copied
      button.dataset.copied = 'true'
      setTimeout(restore, 1600)
    }
    void writeClipboard(text).then((ok) => {
      if (ok) done()
      else restore()
    })
  }

  /**
   * Icon copy button for message chrome (MessageIconActions): copy glyph,
   * brief check mark once the clipboard write resolves.
   */
  function messageCopyButton(getText) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'msg-copy'
    button.title = chatLabels.copy
    button.append(icon(COPY))
    let revertTimer
    const reset = () => {
      delete button.dataset.copied
      button.title = chatLabels.copy
      button.replaceChildren(icon(COPY))
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (button.dataset.copied === 'true') return
      void writeClipboard(getText()).then((ok) => {
        if (!ok) return
        clearTimeout(revertTimer)
        button.dataset.copied = 'true'
        button.title = chatLabels.copied
        button.replaceChildren(icon(CHECK))
        revertTimer = setTimeout(reset, 1200)
      })
    })
    return button
  }

  /** Usage pill text: "12.3K tok", hidden entirely when no usage arrived. */
  function usagePill(node, block) {
    const pill = node.querySelector('.am-usage')
    const total = block.running ? null : tokenUsageTotal(block.usage)
    pill.hidden = total === null
    if (total !== null) {
      pill.textContent = usageText.count(formatTokenCount(total))
      pill.title = usageText.title
    }
  }

  function wireCopyButtons(root) {
    for (const button of root.querySelectorAll('.cb-copy, .term-copy, .search-copy')) {
      if (button.dataset.wired === 'true') continue
      button.dataset.wired = 'true'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const block = button.closest('.cb, .term, .search')
        const code = block?.querySelector('pre')?.textContent ?? ''
        copyToClipboard(code, button)
      })
    }
  }

  function renderMarkdownBody(element, text, { compact = false, live = false } = {}) {
    element.innerHTML = renderMarkdown(text, { compact, copyLabel: chatLabels.copy })
    wireCopyButtons(element)
    // Shiki runs on settled content only; re-highlighting every delta is too costly while streaming.
    if (!live) void upgradeCodeBlocks(element)
  }

  function shimmer(element, active) {
    if (active) element.setAttribute('data-text-shimmer', '')
    else element.removeAttribute('data-text-shimmer')
  }

  /** Bounded row list with the primitives' ghost "… N more" expander. */
  function cappedRows(target, rows, cap) {
    target.replaceChildren()
    const show = rows.slice(0, cap)
    for (const row of show) target.append(row)
    if (rows.length <= cap) return
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'card-expand'
    expand.textContent = `… ${rows.length - show.length}`
    let open = false
    expand.addEventListener('click', (event) => {
      event.stopPropagation()
      open = !open
      for (const row of rows.slice(show.length)) {
        if (open) target.append(row)
        else row.remove()
      }
      expand.remove()
      if (!open) {
        for (const row of rows.slice(cap)) row.remove()
        target.append(expand)
      }
      expand.textContent = open ? chatLabels.collapse : `… ${rows.length - show.length}`
      if (!open) return
    })
    target.append(expand)
  }

  function buildTerminalCard(model) {
    const card = document.createElement('div')
    card.className = 'term'
    card.setAttribute('data-body', 'true')
    const header = document.createElement('div')
    header.className = 'term-header'
    const prompt = document.createElement('div')
    prompt.className = 'term-prompt'
    const line = document.createElement('div')
    line.className = 'term-prompt-line'
    const command = document.createElement('span')
    command.className = 'term-command'
    command.textContent = model.command
    line.append(command)
    const failed = terminalFailed(model)
    const status = document.createElement('span')
    status.className = 'term-status'
    if (model.signal !== undefined) status.textContent = chatLabels.signal(model.signal)
    else if (model.exitCode === undefined || model.exitCode === null) status.textContent = chatLabels.noExitCode
    else {
      status.textContent = chatLabels.exitCode(model.exitCode)
      if (model.exitCode === 0 && !failed) status.setAttribute('data-ok', 'true')
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'term-copy'
    copy.textContent = chatLabels.copy
    prompt.append(line)
    header.append(prompt, status, copy)
    card.append(header)
    const output = document.createElement('div')
    output.className = 'term-output'
    const text = model.output ?? ''
    if (text === '') {
      const empty = document.createElement('div')
      empty.className = 'term-empty'
      empty.textContent = chatLabels.noOutput
      card.append(empty)
    } else {
      for (const row of text.split('\n')) {
        const lineEl = document.createElement('div')
        lineEl.className = 'term-line'
        lineEl.textContent = row
        output.append(lineEl)
      }
      card.append(output)
    }
    return card
  }

  function buildDiffCard(model) {
    const card = document.createElement('div')
    card.className = 'diff'
    const body = document.createElement('div')
    body.className = 'diff-body'
    const rows = []
    for (const hunk of model.diffs) {
      const path = document.createElement('div')
      path.className = 'diff-line diff-path'
      path.textContent = hunk.path
      rows.push(path)
      for (const line of diffLines(hunk)) {
        const row = document.createElement('div')
        row.className = `diff-line diff-${line.kind}`
        row.textContent = line.text
        rows.push(row)
      }
    }
    cappedRows(body, rows, CHAT_DIFF_MAX_LINES)
    card.append(body)
    return card
  }

  function buildReadCard(model) {
    const card = document.createElement('div')
    card.className = 'cb'
    card.setAttribute('data-code-lang', model.lang ?? '')
    const bannerWrap = document.createElement('div')
    bannerWrap.className = 'cb-banner-wrap'
    const banner = document.createElement('div')
    banner.className = 'cb-banner'
    banner.setAttribute('data-code-block-banner', '')
    const info = document.createElement('div')
    info.className = 'cb-infostring'
    info.textContent = `${model.label} · ${chatLabels.readWindow(Math.min(model.lines.length, CHAT_READ_MAX_LINES), model.totalLines)}`
    const action = document.createElement('div')
    action.className = 'cb-action'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cb-copy'
    copy.textContent = chatLabels.copy
    action.append(copy)
    banner.append(info, action)
    bannerWrap.append(banner)
    card.append(bannerWrap)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    const rows = model.lines.map((line) => {
      const row = document.createElement('div')
      row.className = 'read-line'
      const gutter = document.createElement('span')
      gutter.className = 'read-gutter'
      gutter.textContent = String(line.number)
      const content = document.createElement('span')
      content.className = 'read-content'
      content.textContent = line.text
      row.append(gutter, content)
      return row
    })
    const gutterWidth = `${String(model.totalLines).length + 1}ch`
    card.style.setProperty('--dsl-read-gutter', gutterWidth)
    cappedRows(code, rows, CHAT_READ_MAX_LINES)
    pre.append(code)
    card.append(pre)
    return card
  }

  function buildSearchCard(cardModel) {
    const card = document.createElement('div')
    card.className = 'search'
    const header = document.createElement('div')
    header.className = 'search-header'
    const summary = document.createElement('div')
    summary.className = 'search-summary'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'search-copy'
    copy.textContent = chatLabels.copy
    header.append(summary, copy)
    card.append(header)
    const body = document.createElement('div')
    body.className = 'search-body'
    const rows = []
    if (cardModel.kind === 'matches') {
      const shown = cardModel.files.reduce((total, file) => total + file.matches.length, 0)
      summary.textContent = chatLabels.matchesSummary(shown, cardModel.total, cardModel.files.length, cardModel.truncated)
      for (const file of cardModel.files) {
        const group = document.createElement('div')
        group.className = 'search-file-header'
        const path = document.createElement('span')
        path.className = 'search-file-path'
        path.textContent = file.path
        const count = document.createElement('span')
        count.className = 'search-file-count'
        count.textContent = String(file.matches.length)
        group.append(path, count)
        rows.push(group)
        for (const match of file.matches) {
          const line = document.createElement('div')
          line.className = 'search-line'
          const number = document.createElement('span')
          number.className = 'search-line-number'
          number.textContent = `${match.lineNumber}  `
          line.append(number)
          line.append(document.createTextNode(match.line))
          rows.push(line)
        }
      }
    } else {
      summary.textContent = chatLabels.pathsSummary(cardModel.paths.length, cardModel.total, cardModel.truncated)
      for (const path of cardModel.paths) {
        const line = document.createElement('div')
        line.className = 'search-line'
        line.textContent = path
        rows.push(line)
      }
    }
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      empty.textContent = chatLabels.noResults
      card.append(empty)
      return card
    }
    cappedRows(body, rows, CHAT_SEARCH_MAX_LINES)
    card.append(body)
    return card
  }

  function linkOrText(className, url, label) {
    if (!/^https?:\/\//i.test(url)) return document.createTextNode(label)
    const link = document.createElement('a')
    link.className = className
    link.href = url
    link.textContent = label
    return link
  }

  function buildWebCard(model) {
    const card = document.createElement('div')
    card.className = 'web'
    if (model.kind === 'fetch') {
      const fetch = document.createElement('div')
      fetch.className = 'web-fetch'
      fetch.append(linkOrText('web-fetch-url', model.url, model.url))
      const meta = document.createElement('div')
      meta.className = 'web-fetch-meta'
      const status = document.createElement('span')
      status.className = 'web-status'
      status.textContent = `HTTP ${model.statusCode}`
      meta.append(status)
      if (model.truncated) {
        const truncated = document.createElement('span')
        truncated.className = 'web-truncated'
        truncated.textContent = chatLabels.contentTruncated
        meta.append(truncated)
      }
      fetch.append(url, meta)
      card.append(fetch)
      return card
    }
    if (model.answer) {
      const answer = document.createElement('div')
      answer.className = 'web-answer'
      renderMarkdownBody(answer, model.answer)
      card.append(answer)
    }
    if (model.sources.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'web-empty'
      empty.textContent = chatLabels.webNoResults
      card.append(empty)
      return card
    }
    const sources = document.createElement('ol')
    sources.className = 'web-sources'
    for (const source of model.sources) {
      const item = document.createElement('li')
      item.className = 'web-source'
      item.append(linkOrText('web-source-link', source.url, source.title !== undefined && source.title !== '' ? source.title : source.url))
      if (source.snippet !== undefined && source.snippet !== '') {
        const snippet = document.createElement('div')
        snippet.className = 'web-snippet'
        snippet.textContent = source.snippet
        item.append(snippet)
      }
      if (source.publishedAt !== undefined && source.publishedAt !== '') {
        const published = document.createElement('div')
        published.className = 'web-published'
        published.textContent = source.publishedAt
        item.append(published)
      }
      sources.append(item)
    }
    card.append(sources)
    if (model.truncated) {
      const truncated = document.createElement('div')
      truncated.className = 'web-truncated'
      truncated.textContent = chatLabels.sourcesTruncated
      card.append(truncated)
    }
    return card
  }

  function buildIoCard(inputText, outputText, isError) {
    const card = document.createElement('div')
    card.className = 'tool-io-card'
    if (inputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.input
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = inputText
      section.append(label, text)
      card.append(section)
    }
    if (inputText !== null && outputText !== null) {
      const divider = document.createElement('span')
      divider.className = 'tool-io-divider'
      card.append(divider)
    }
    if (outputText !== null) {
      const section = document.createElement('div')
      section.className = 'tool-io-section'
      const label = document.createElement('span')
      label.className = 'tool-io-label'
      label.textContent = chatLabels.output
      const text = document.createElement('span')
      text.className = 'tool-io-text'
      text.textContent = outputText
      if (isError) text.setAttribute('data-error', 'true')
      section.append(label, text)
      card.append(section)
    }
    return card
  }

  function updateToolNode(node, block) {
    const detail = block.detail
    const name = block.text
    const root = node.querySelector('.tool')
    const variant = classifyTool(name)
    const state = block.running === true
      ? detail?.args ? 'running' : 'preparing'
      : detail?.isError === true ? 'error' : node.dataset.state === 'stopped' ? 'stopped' : 'ok'
    root.dataset.tool = name
    root.dataset.variant = variant
    root.dataset.state = state
    node.dataset.state = state

    node.querySelector('.visually-hidden').textContent = state === 'error' ? messages.failed
      : state === 'stopped' ? messages.stopped
        : state === 'running' || state === 'preparing' ? messages.running
          : ''

    const title = node.querySelector('.tool-title')
    title.textContent = toolTitle(name, messages === zh)
    shimmer(title, state === 'running' || state === 'preparing')

    const meta = parseMeta(detail?.meta)
    const terminal = terminalCardModel(name, detail?.args ?? '', detail?.result ? [{ type: 'text', text: detail.result }] : [])
    const read = terminal === null ? readCardModel(meta, detail?.result ? [{ type: 'text', text: detail.result }] : []) : null
    const search = read === null && terminal === null ? searchCardModel(meta) : null
    const web = search === null && read === null && terminal === null ? webCardModel(meta) : null
    const diff = terminal === null && read === null && search === null && web === null
      ? diffCardModel(name, detail?.args ?? '', detail?.isError === true, meta)
      : null

    const expandable = state !== 'preparing'
      && (Boolean(detail?.args) || Boolean(detail?.result) || terminal !== null || read !== null || search !== null || web !== null || diff !== null)
    const row = node.querySelector('.tool-row')
    root.toggleAttribute('data-expandable', expandable)
    row.toggleAttribute('data-expandable', expandable)
    if (!expandable) {
      root.removeAttribute('data-open')
      row.setAttribute('aria-expanded', 'false')
    }

    let summaryText
    if (state === 'error') {
      const first = firstLineOf(detail?.result ?? '')
      summaryText = first !== '' ? first : summaryFor(name, detail?.args ?? '')
    } else if (state === 'stopped') {
      summaryText = summaryFor(name, detail?.args ?? '')
    } else {
      summaryText = summaryFor(name, detail?.args ?? '')
    }
    const sep = node.querySelector('.tool-sep')
    const summary = node.querySelector('.tool-summary')
    const fileLink = node.querySelector('.tool-file-link')
    const suffix = node.querySelector('.tool-summary-suffix')
    const showCollapsed = summaryText !== '' && state !== 'preparing'
    sep.hidden = !showCollapsed
    summary.hidden = !showCollapsed
    summary.textContent = summaryText
    fileLink.hidden = true
    shimmer(summary, state === 'running')

    if (diff !== null && state !== 'error' && state !== 'stopped') {
      const totals = diffTotals(diff.diffs)
      suffix.hidden = false
      suffix.textContent = `+${totals.added} -${totals.removed}`
      suffix.className = 'tool-summary-suffix tool-diff-stat'
    } else {
      suffix.hidden = true
      suffix.textContent = ''
      suffix.className = 'tool-summary-suffix'
    }

    const bodyWrap = node.querySelector('.tool-body')
    bodyWrap.replaceChildren()
    if (terminal !== null) {
      bodyWrap.className = 'tool-body tool-terminal-body'
      bodyWrap.append(buildTerminalCard(terminal))
    } else if (diff !== null) {
      bodyWrap.className = 'tool-body tool-diff-body'
      bodyWrap.append(buildDiffCard(diff))
    } else if (read !== null) {
      bodyWrap.className = 'tool-body tool-read-body'
      bodyWrap.append(buildReadCard(read))
    } else if (search !== null) {
      bodyWrap.className = 'tool-body tool-search-body'
      bodyWrap.append(buildSearchCard(search.card))
      if (search.recovery !== undefined) {
        const recovery = document.createElement('div')
        recovery.className = 'tool-search-recovery'
        recovery.textContent = search.recovery
        bodyWrap.append(recovery)
      }
    } else if (web !== null) {
      bodyWrap.className = 'tool-body tool-web-body'
      bodyWrap.append(buildWebCard(web))
    } else {
      bodyWrap.className = 'tool-body'
      const input = formatToolBody(variant, detail?.args ?? '')
      const output = detail?.result ? detail.result : null
      if (input !== null || output !== null) {
        bodyWrap.append(buildIoCard(input, output, detail?.isError === true))
      }
    }
    if (processGroup !== undefined) processGroup.tools.add(name)
    refreshProcessLabel(processGroup)
  }

  function parseMeta(text) {
    if (typeof text !== 'string' || text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function firstLineOf(text) {
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  }

  function summaryFor(name, argsRaw) {
    const variant = classifyTool(name)
    const base = deriveSummary(variant, argsRaw)
    if (variant !== 'others') return base
    return base === '' ? name : `${name} · ${base}`
  }

  function createToolNode(block) {
    const node = document.createElement('article')
    node.className = 'block'
    node.dataset.kind = 'tool'
    const root = document.createElement('div')
    root.className = 'tool'
    const status = document.createElement('span')
    status.className = 'visually-hidden'
    const row = document.createElement('div')
    row.className = 'tool-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')
    const leading = document.createElement('span')
    leading.className = 'tool-leading'
    const idle = document.createElement('span')
    idle.className = 'tool-icon-idle'
    idle.append(toolIcon(block.text))
    const hover = document.createElement('span')
    hover.className = 'tool-chevron-hover'
    hover.append(icon(CHEVRON_DOWN))
    const open = document.createElement('span')
    open.className = 'tool-chevron-open'
    open.append(icon(CHEVRON_UP))
    leading.append(idle, hover, open)
    const title = document.createElement('span')
    title.className = 'tool-title'
    const sep = document.createElement('span')
    sep.className = 'tool-sep'
    sep.setAttribute('aria-hidden', 'true')
    const summary = document.createElement('span')
    summary.className = 'tool-summary'
    const suffix = document.createElement('span')
    suffix.className = 'tool-summary-suffix'
    suffix.hidden = true
    const fileLink = document.createElement('span')
    fileLink.className = 'tool-file-link'
    fileLink.hidden = true
    row.append(leading, title, sep, summary, suffix, fileLink)
    const body = document.createElement('div')
    body.className = 'tool-body'
    root.append(status, row, body)
    node.append(root)
    const toggle = () => {
      if (root.hasAttribute('data-expandable') === false) return
      const isOpen = !root.hasAttribute('data-open')
      root.toggleAttribute('data-open', isOpen)
      row.setAttribute('aria-expanded', String(isOpen))
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
    return node
  }

  /** Per-node raw text the message copy button writes (raw markdown, as Harness). */
  const messageCopyText = new WeakMap()

  function updateAssistantNode(node, block) {
    const body = node.querySelector('.am-body')
    renderMarkdownBody(body, block.text, { live: block.running === true })
    const record = messageCopyText.get(node)
    if (record) record.text = block.text
    const actions = node.querySelector('.am-actions')
    if (actions) actions.hidden = block.running === true
    usagePill(node, block)
    const existing = node.querySelector('.am-stopped')
    if (block.interrupted === true) {
      const chip = existing ?? document.createElement('span')
      chip.className = 'am-stopped'
      chip.textContent = messages.stopped
      if (existing === null) body.append(chip)
    } else {
      existing?.remove()
    }
  }

  function upsertBlock(block) {
    if (typeof block?.key !== 'string' || typeof block.text !== 'string') return
    blockData.set(block.key, block)
    let node = blocks.get(block.key)
    if (node === undefined) {
      if (block.kind === 'user') {
        node = document.createElement('div')
        node.className = 'user-row'
        node.dataset.kind = 'user'
        const bubble = document.createElement('div')
        bubble.className = 'user-bubble'
        const actions = document.createElement('div')
        actions.className = 'user-actions'
        actions.append(messageCopyButton(() => bubble.textContent ?? ''))
        node.append(bubble, actions)
      } else if (block.kind === 'assistant') {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'assistant'
        const root = document.createElement('div')
        root.className = 'am'
        const body = document.createElement('div')
        body.className = 'am-body'
        const actions = document.createElement('div')
        actions.className = 'am-actions'
        actions.hidden = true
        const copyText = { text: '' }
        messageCopyText.set(node, copyText)
        actions.append(messageCopyButton(() => copyText.text))
        const usage = document.createElement('span')
        usage.className = 'am-usage'
        usage.hidden = true
        actions.append(usage)
        root.append(body, actions)
        node.append(root)
      } else if (block.kind === 'tool') {
        node = createToolNode(block)
      } else {
        node = document.createElement('article')
        node.className = 'block'
        node.dataset.kind = 'reasoning'
        createThink(node)
      }
      blocks.set(block.key, node)
      placeBlock(node, block.kind)
    }
    if (block.kind !== 'tool') node.dataset.state = block.running ? 'running' : 'ok'
    // A folded turn keeps only the final answer visible (Harness turn-process fold).
    node.toggleAttribute('data-response', block.response === true)
    if (block.kind === 'user') {
      node.querySelector('.user-bubble').textContent = block.text
    } else if (block.kind === 'reasoning') {
      const summary = reasoningSummary(block.text, block.running === true)
      node.querySelector('.think-summary-text').textContent = summary
      const preview = node.querySelector('.think-summary')
      if (block.running) preview.setAttribute('data-streaming', 'true')
      else preview.removeAttribute('data-streaming')
      node.querySelector('.visually-hidden').textContent = block.running ? messages.running : ''
      renderMarkdownBody(node.querySelector('.think-body'), block.text, { compact: true, live: block.running === true })
      syncThinkPreview(node)
    } else if (block.kind === 'tool') {
      updateToolNode(node, block)
    } else {
      updateAssistantNode(node, block)
    }
  }

  /**
   * Transcript events apply in arrival order on one animation frame, so a turn
   * marker never lands before the blocks queued ahead of it, and the view only
   * scrolls when the reader is already at the bottom.
   */
  const staged = []
  let stagedFrame
  function stage(message) {
    staged.push(message)
    stagedFrame ??= requestAnimationFrame(() => {
      stagedFrame = undefined
      const list = staged.splice(0)
      const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120
      for (const item of list) {
        if (item.type === 'block') upsertBlock(item)
        else if (item.type === 'block-drop') removeBlock(item.key)
        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true)
        else if (item.type === 'reset') clearTranscript()
      }
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight
    })
  }

  function removeBlock(key) {
    const node = blocks.get(key)
    if (node === undefined) return
    blocks.delete(key)
    blockData.delete(key)
    node.remove()
  }

  function renderHistory() {
    historyList.replaceChildren()
    if (historyItems.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = messages.historyEmpty
      historyList.append(empty)
      return
    }
    for (const item of historyItems) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.sessionId === sessionId ? 'history-row current' : 'history-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(item.sessionId === sessionId))
      button.textContent = typeof item.title === 'string' && item.title !== '' ? item.title : messages.untitled
      button.addEventListener('click', () => {
        setHistoryOpen(false)
        if (item.sessionId !== sessionId) api.openSession(item.sessionId)
      })
      historyList.append(button)
    }
  }

  function clearTranscript() {
    stopProcessClock()
    processGroup = undefined
    blocks.clear()
    blockData.clear()
    transcript.replaceChildren()
    pending = undefined
    syncQuestion()
  }

  function setHistoryOpen(next) {
    historyOpen = next
    historyList.hidden = !historyOpen
    historyButton.setAttribute('aria-pressed', String(historyOpen))
    if (historyOpen) {
      renderHistory()
      api.requestHistory()
      setPermissionOpen(false)
    }
    syncQuestion()
  }

  function setPermissionOpen(next) {
    permissionOpen = next
    permissionMenu.hidden = !permissionOpen
    permissionButton.setAttribute('aria-expanded', String(permissionOpen))
  }

  function renderPermission() {
    permissionLabel.textContent = permissionText(permission)
    for (const option of permissionMenu.querySelectorAll('button')) {
      option.setAttribute('aria-selected', String(option.dataset.preset === permission))
    }
  }

  function syncContinue() {
    const draft = pending.drafts[pending.index]
    questionContinue.textContent = pending.index === pending.questions.length - 1
      ? messages.submit
      : messages.next
    questionContinue.disabled = pending.busy || !draftAnswered(draft)
    questionSkip.disabled = pending.busy
    questionCancel.disabled = pending.busy
    questionPrev.disabled = pending.busy || pending.index === 0
    questionNextNav.disabled = pending.busy || pending.index === pending.questions.length - 1
    questionCustom.disabled = pending.busy
    questionCustom.hidden = false
    questionCustom.placeholder = messages.custom
    if (document.activeElement !== questionCustom) questionCustom.value = draft.custom
  }

  function renderQuestion() {
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    const hasHeader = typeof item.header === 'string' && item.header !== ''
    questionEyebrow.hidden = !hasHeader
    questionEyebrow.textContent = hasHeader ? item.header : ''
    questionTitle.textContent = item.question
    const hasDetail = typeof item.detail === 'string' && item.detail !== ''
    questionDetail.hidden = !hasDetail
    questionDetail.textContent = hasDetail ? item.detail : ''
    questionOptions.replaceChildren()
    const options = item.options ?? []
    questionOptions.setAttribute('role', item.multiSelect === true ? 'group' : 'radiogroup')
    for (const [optionIndex, option] of options.entries()) {
      const selected = draft.selected.includes(option.label)
      const display = parseRecommendedLabel(option.label)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = selected ? 'question-option selected' : 'question-option'
      button.setAttribute('role', item.multiSelect === true ? 'checkbox' : 'radio')
      button.setAttribute('aria-checked', String(selected))
      button.disabled = pending.busy
      const mark = document.createElement('span')
      mark.className = 'question-option-mark'
      mark.textContent = item.multiSelect === true ? (selected ? '\u2713' : '') : String(optionIndex + 1)
      const copy = document.createElement('span')
      copy.className = 'question-option-copy'
      const label = document.createElement('span')
      label.className = 'question-option-label'
      label.textContent = display.label
      copy.append(label)
      if (display.recommended) {
        const badge = document.createElement('span')
        badge.className = 'question-recommended'
        badge.textContent = messages.recommended
        copy.append(badge)
      }
      if (typeof option.description === 'string' && option.description !== '') {
        const description = document.createElement('span')
        description.className = 'question-option-description'
        description.textContent = option.description
        copy.append(description)
      }
      button.append(mark, copy)
      button.addEventListener('click', () => { chooseOption(option.label) })
      questionOptions.append(button)
    }
    questionPager.hidden = pending.questions.length <= 1
    questionProgress.textContent = `${String(pending.index + 1)} / ${String(pending.questions.length)}`
    const hasError = typeof pending.error === 'string' && pending.error !== ''
    questionError.hidden = !hasError
    questionError.textContent = hasError ? pending.error : ''
    syncContinue()
  }

  function syncQuestion() {
    const showCard = pending !== undefined && !historyOpen
    document.body.classList.toggle('asking', pending !== undefined)
    questionRoot.hidden = !showCard
    transcript.hidden = historyOpen
    if (showCard) renderQuestion()
    syncGif()
  }

  function chooseOption(label) {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    if (item.multiSelect === true) {
      draft.selected = draft.selected.includes(label)
        ? draft.selected.filter((entry) => entry !== label)
        : [...draft.selected, label]
    } else {
      draft.selected = [label]
      draft.custom = ''
      if (pending.index < pending.questions.length - 1) pending.index += 1
    }
    draft.skipped = false
    pending.error = undefined
    renderQuestion()
  }

  function submitPending() {
    const missing = pending.drafts.findIndex((draft) => !draftCompleted(draft))
    if (missing >= 0) {
      pending.index = missing
      pending.error = messages.incomplete
      renderQuestion()
      return
    }
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.answerQuestion(pending.id, buildAnswer(pending.questions, pending.drafts).answers)
  }

  function continueFlow() {
    if (pending === undefined || pending.busy) return
    const draft = pending.drafts[pending.index]
    if (!draftAnswered(draft)) {
      pending.error = messages.unanswered
      renderQuestion()
      return
    }
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      pending.error = undefined
      renderQuestion()
      return
    }
    submitPending()
  }

  function skipQuestion() {
    if (pending === undefined || pending.busy) return
    pending.drafts[pending.index] = { selected: [], custom: '', skipped: true }
    pending.error = undefined
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      renderQuestion()
      return
    }
    submitPending()
  }

  function cancelQuestion() {
    if (pending === undefined || pending.busy) return
    pending.busy = true
    pending.error = undefined
    renderQuestion()
    api.cancelQuestion(pending.id)
  }

  function showQuestion(payload) {
    if (!payload || typeof payload.id !== 'string' || !Array.isArray(payload.questions) || payload.questions.length === 0) return
    if (pending?.id === payload.id) {
      syncQuestion()
      return
    }
    pending = { id: payload.id, questions: payload.questions, drafts: emptyDrafts(payload.questions), index: 0, busy: false }
    setHistoryOpen(false)
    syncQuestion()
    void setExpanded(true)
  }

  function clearQuestion(id) {
    if (pending === undefined || pending.id !== id) return
    pending = undefined
    syncQuestion()
  }

  function isPrimaryButton(event) {
    return event.button === 0
  }

  function primaryButtonHeld(event) {
    return (event.buttons & 1) === 1
  }

  document.body.addEventListener('pointerenter', () => {
    dockPointerInside = true
    if (dragging || collapsing) return
    if (docked !== undefined) {
      if (dockHoverArmed) void unsnapDocked()
      return
    }
    if (suppressExpand) return
    void setExpanded(true)
  })
  document.body.addEventListener('pointerleave', () => {
    dockPointerInside = false
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  })

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = false
    lastOrigin = undefined
    pointer = { ...ballGrabOffset(event), startX: event.screenX, startY: event.screenY }
    ball.setPointerCapture(event.pointerId)
  })
  ball.addEventListener('pointermove', (event) => {
    if (pointer === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
    if (!dragging) {
      if (Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) <= 4) return
      dragging = true
      if (running || asking()) {
        void moveBall(lastOrigin.x, lastOrigin.y)
        return
      }
      collapsing = true
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true).then(() => {
        collapsing = false
        if (dragging && lastOrigin !== undefined) void moveBall(lastOrigin.x, lastOrigin.y)
      })
      return
    }
    if (!collapsing) void moveBall(lastOrigin.x, lastOrigin.y)
  })
  async function finishPointer(event) {
    if (dragging) {
      skipClick = true
      dragging = false
      collapsing = false
      const origin = pointer === undefined
        ? lastOrigin
        : { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
      pointer = undefined
      lastOrigin = undefined
      const skipDock = skipDockCommit
      skipDockCommit = false
      if (!skipDock) {
        if (origin !== undefined) await moveBall(origin.x, origin.y)
        await clampBall()
      }
      return true
    }
    pointer = undefined
    lastOrigin = undefined
    return false
  }
  ball.addEventListener('pointerup', async (event) => {
    if (!isPrimaryButton(event)) {
      void finishPointer(event)
      return
    }
    const dragged = await finishPointer(event)
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    pinned = !pinned
    document.body.classList.toggle('pinned', pinned)
    if (pinned) await setExpanded(true)
  })
  ball.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  ball.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  dockTab.addEventListener('pointerdown', (event) => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
  })
  dockTab.addEventListener('pointermove', (event) => {
    if (pointer === undefined || docked === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX, y: event.screenY }
    const inward = docked === 'right' ? pointer.startX - event.screenX : event.screenX - pointer.startX
    if (inward <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', (event) => { void finishPointer(event) })
  dockTab.addEventListener('pointercancel', (event) => { void finishPointer(event) })
  dockTab.addEventListener('lostpointercapture', (event) => { void finishPointer(event) })

  const selectionChip = document.querySelector('#selection-chip')
  const selectionChipText = document.querySelector('#selection-chip-text')
  const selectionChipDismiss = document.querySelector('#selection-chip-dismiss')
  selectionChipDismiss.textContent = '\u00d7'
  const tccGate = document.querySelector('#tcc-gate')
  const tccDismiss = document.querySelector('#tcc-dismiss')
  const tccTitle = document.querySelector('#tcc-title')
  const tccApp = document.querySelector('#tcc-app')
  const tccScreenStatus = document.querySelector('#tcc-screen-status')
  const tccScreenOpen = document.querySelector('#tcc-screen-open')
  const tccAccessibilityStatus = document.querySelector('#tcc-accessibility-status')
  const tccAccessibilityOpen = document.querySelector('#tcc-accessibility-open')
  const tccFooter = document.querySelector('#tcc-footer')
  const tccLater = document.querySelector('#tcc-later')
  tccDismiss.textContent = '\u00d7'
  document.querySelector('#tcc-relaunch').hidden = true

  function setAttachedSelection(text) {
    attachedSelection = text
    const show = text !== ''
    selectionChip.hidden = !show
    document.body.classList.toggle('has-selection-chip', show)
    selectionChipText.textContent = text
    syncGif()
  }

  function tccReady(tccStatus) {
    return tccStatus == null || tccStatus.applicable === false
      || (tccStatus.screen === 'granted' && tccStatus.accessibility === 'granted')
  }

  function tccStatusLabel(state) {
    if (state === 'granted') return messages.tccStatusGranted
    if (state === 'needsRelaunch') return messages.tccStatusNeedsRelaunch
    return messages.tccStatusMissing
  }

  function hideTccGate() {
    tccGateVisible = false
    tccGate.hidden = true
    document.body.classList.remove('tcc-gating')
    syncGif()
  }

  function showTccGate(tccStatus) {
    tccGateVisible = true
    lastTccStatus = tccStatus
    const name = typeof tccStatus.appName === 'string' ? tccStatus.appName : ''
    tccApp.textContent = messages.tccAppHint.replaceAll('{name}', name)
    tccFooter.textContent = messages.tccFooter.replaceAll('{name}', name)
    tccScreenStatus.textContent = tccStatusLabel(tccStatus.screen)
    tccAccessibilityStatus.textContent = tccStatusLabel(tccStatus.accessibility)
    tccScreenOpen.hidden = tccStatus.screen === 'granted'
    tccAccessibilityOpen.hidden = tccStatus.accessibility === 'granted'
    tccGate.hidden = false
    document.body.classList.add('tcc-gating')
    syncGif()
  }

  async function refreshTccGate(options = {}) {
    if (typeof api.tccStatus !== 'function') return true
    let tccStatus
    try {
      tccStatus = await api.tccStatus()
    } catch {
      return true
    }
    if (tccReady(tccStatus)) {
      hideTccGate()
      return true
    }
    if (options.forceShow || tccGateVisible) showTccGate(tccStatus)
    return false
  }

  async function openTccRight(right) {
    if (typeof api.openTcc !== 'function') return
    let tccStatus
    try {
      tccStatus = await api.openTcc(right)
    } catch {
      return
    }
    if (tccReady(tccStatus)) hideTccGate()
    else showTccGate(tccStatus)
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitComposer()
  })
  async function submitComposer() {
    const text = promptText(prompt).trim()
    if (text === '') return
    if (text.length > PROMPT_LIMIT) {
      status.textContent = messages.tooLong
      return
    }
    const ready = await refreshTccGate({ forceShow: true })
    if (!ready) {
      await setExpanded(true)
      return
    }
    const payload = composeSend(text, attachedSelection)
    clearPrompt()
    setAttachedSelection('')
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.send(payload)
  }
  prompt.addEventListener('input', syncComposerHeight)
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  prompt.addEventListener('paste', (event) => {
    event.preventDefault()
    insertPlainText(prompt, event.clipboardData?.getData('text/plain') ?? '')
    syncComposerHeight()
  })
  composer.addEventListener('click', (event) => {
    if (event.target === composer) prompt.focus()
  })

  for (const preset of PERMISSION_PRESETS) {
    const item = document.createElement('li')
    const option = document.createElement('button')
    option.type = 'button'
    option.dataset.preset = preset
    option.setAttribute('role', 'option')
    option.textContent = permissionText(preset)
    option.addEventListener('click', () => {
      permission = preset
      setPermissionOpen(false)
      renderPermission()
      api.setPermission(preset)
    })
    item.append(option)
    permissionMenu.append(item)
  }
  renderPermission()
  permissionButton.addEventListener('click', (event) => {
    event.stopPropagation()
    setHistoryOpen(false)
    setPermissionOpen(!permissionOpen)
  })
  document.addEventListener('pointerdown', (event) => {
    if (permissionRoot.contains(event.target)) return
    setPermissionOpen(false)
  })
  historyButton.addEventListener('click', () => { setHistoryOpen(!historyOpen) })
  newConversation.addEventListener('click', () => {
    setHistoryOpen(false)
    setPermissionOpen(false)
    api.newSession()
    prompt.focus()
  })
  stop.addEventListener('click', () => { api.stop() })
  questionCancel.addEventListener('click', cancelQuestion)
  questionSkip.addEventListener('click', skipQuestion)
  questionContinue.addEventListener('click', continueFlow)
  questionPrev.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === 0) return
    pending.index -= 1
    pending.error = undefined
    renderQuestion()
  })
  questionNextNav.addEventListener('click', () => {
    if (pending === undefined || pending.busy || pending.index === pending.questions.length - 1) return
    pending.index += 1
    pending.error = undefined
    renderQuestion()
  })
  questionCustom.addEventListener('input', () => {
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    draft.custom = questionCustom.value
    draft.skipped = false
    if (item.multiSelect !== true) draft.selected = []
    pending.error = undefined
    questionError.hidden = true
    syncContinue()
  })
  questionCustom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  })

  api.onBlock((block) => { stage(block) })
  api.onBlockDrop((key) => { stage({ type: 'block-drop', key }) })
  api.onTurn((turn) => { stage({ type: 'turn', ...(turn ?? {}) }) })
  api.onSession((id) => { sessionId = typeof id === 'string' ? id : '' })
  api.onHistory((items) => {
    historyItems = Array.isArray(items) ? items : []
    if (historyOpen) renderHistory()
  })
  api.onPermission((preset) => {
    if (typeof preset !== 'string') return
    permission = preset
    renderPermission()
  })
  api.onReset(() => { stage({ type: 'reset' }) })
  api.onAttach((text) => {
    if (typeof text !== 'string' || text === '') return
    void setExpanded(true).then(() => {
      setAttachedSelection(text)
      prompt.focus()
    })
  })
  selectionChipDismiss.addEventListener('click', () => { setAttachedSelection('') })
  tccDismiss.addEventListener('click', () => { hideTccGate() })
  tccLater.addEventListener('click', () => { hideTccGate() })
  tccScreenOpen.addEventListener('click', () => { void openTccRight('screen') })
  tccAccessibilityOpen.addEventListener('click', () => { void openTccRight('accessibility') })
  api.onAvatar((src) => {
    avatarSrc = typeof src === 'string' && src !== '' ? src : 'deepseek-avatar-square.gif'
    const gif = document.querySelector('#ball-gif')
    if (!gif) return
    delete gif.dataset.mode
    syncGif()
  })
  api.onStatus((text) => { status.textContent = typeof text === 'string' ? text : '' })
  // The theme arrives as the helper's nativeTheme (the prefers-color-scheme
  // query above follows it); the locale switches the whole page dictionary.
  if (typeof api.onAppearance === 'function') {
    api.onAppearance((appearance) => {
      if (appearance !== null && typeof appearance === 'object') {
        applyLocale(appearance.locale)
        refreshAllText()
      }
    })
  }
  transcript.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) return
    event.preventDefault()
    api.openExternal(href)
  })
  api.onQuestion((payload) => { showQuestion(payload) })
  api.onQuestionClear((id) => { clearQuestion(id) })
  api.onQuestionError((payload) => {
    if (pending === undefined || pending.id !== payload?.id) return
    pending.busy = false
    pending.error = typeof payload.text === 'string' ? payload.text : messages.incomplete
    renderQuestion()
  })
  syncGif()
}

main()
