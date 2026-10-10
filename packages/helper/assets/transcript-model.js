// Reasoning summaries, turn-process labels, and tool-card models, matching
// Harness ReasoningRow, message-chrome, TurnProcessNodeView, tool-call-model,
// and the terminal/read/search/web/diff card derivations.

function firstLine(text) {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestCompletedParagraphFirstLine(text) {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatDuration(ms, zh, live) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const secondText = live || (hours === 0 && minutes === 0) ? String(seconds) : pad2(seconds)
  const minuteText = !live && hours === 0 ? String(minutes) : hours > 0 ? pad2(minutes) : String(minutes)
  if (hours > 0) {
    return zh
      ? `${hours}小时${minuteText}分${secondText}秒`
      : `${hours}h ${minuteText}m ${secondText}s`
  }
  if (minutes > 0) return zh ? `${minutes}分${secondText}秒` : `${minutes}m ${secondText}s`
  return zh ? `${secondText}秒` : `${secondText}s`
}

export function reasoningSummary(text, running) {
  if (typeof text !== 'string') return ''
  const summary = running ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  return summary.replaceAll('**', '')
}

/** Turn-process header label, TurnProcessNodeView + message-chrome. */
export function processLabel({ zh, running, elapsedMs, end, title }) {
  const isZh = zh === true
  if (running === true) {
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return isZh ? '深度求索中' : 'Deep diving...'
    const duration = formatDuration(Math.max(1000, elapsedMs), isZh, true)
    return isZh ? `深度求索中，用时${duration}` : `Deep diving for ${duration}`
  }
  const base = end === 'stopped'
    ? isZh ? '已停止' : 'Stopped'
    : end === 'failed'
      ? isZh ? '处理失败' : 'Failed'
      : typeof elapsedMs === 'number' && Number.isFinite(elapsedMs)
        ? isZh ? `用时 ${formatDuration(Math.max(1000, elapsedMs), isZh, false)}` : `Took ${formatDuration(Math.max(1000, elapsedMs), isZh, false)}`
        : isZh ? '已完成工作' : 'Worked'
  if (typeof title === 'string' && title !== '') return isZh ? `${title}，${base}` : `${title}, ${base}`
  return base
}

/* ----- Step-process categories (process-activity.ts + step-process.ts) ----- */

export function activityKind(toolName) {
  if (toolName === 'read') return 'read'
  if (toolName === 'read_image') return 'readImage'
  if (toolName === 'grep' || toolName === 'glob' || toolName.endsWith('_inspect')) return 'search'
  if (toolName === 'write') return 'write'
  if (toolName === 'edit' || toolName === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(toolName) || toolName.startsWith('terminal_')) return 'commands'
  if (toolName === 'run_code') return 'code'
  if (toolName === 'web_search') return 'webSearch'
  if (toolName === 'web_fetch') return 'webFetch'
  if (toolName === 'subagent' || toolName.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(toolName)) return 'plan'
  if (toolName === 'ask_user_question' || toolName === 'request_user_input') return 'questions'
  return 'tools'
}

const DONE_LABELS = {
  zh: {
    read: '已读取文件', readImage: '已读取图片', search: '已搜索代码', write: '已写入文件',
    edit: '修改了文件', commands: '执行了命令', code: '运行了代码', webSearch: '已搜索网页',
    webFetch: '已访问网页', subagents: '已协调子智能体', plan: '更新了计划',
    questions: '向用户提出了问题', tools: '已调用工具',
  },
  en: {
    read: 'Read files', readImage: 'Read images', search: 'Searched code', write: 'Wrote files',
    edit: 'Edited files', commands: 'Ran commands', code: 'Ran code', webSearch: 'Searched the web',
    webFetch: 'Visited web pages', subagents: 'Coordinated subagents', plan: 'Updated the plan',
    questions: 'Asked questions', tools: 'Called tools',
  },
}

/** Closed step-process title: top three tool categories, step-process.ts. */
export function processTitle(toolNames, zh) {
  const counts = new Map()
  for (const name of toolNames) {
    const kind = activityKind(name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const labels = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind]) => DONE_LABELS[zh ? 'zh' : 'en'][kind])
  const first = labels[0]
  if (first === undefined) return undefined
  const continuation = (label) => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    if (zh) return `${first}并${second}`
    return `${first} and ${continuation(second)}`
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(zh ? '，' : ', ')
  return counts.size > 3 ? (zh ? `${title}等` : `${title}, etc.`) : title
}

/* ----- Tool row model (tool-call-model.ts) ----- */

export const TOOL_VARIANTS = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
}

const TOOL_TITLES = {
  zh: {
    search: '搜索', read: '读取', bash: '运行命令', write: '写入', edit: '编辑',
    code: '代码', generic: '工具调用', pwsh: '运行命令', readImage: '读取图片',
    webSearch: '网页搜索', webFetch: '网页获取', todo: '更新任务清单', ask: '提问',
  },
  en: {
    search: 'Search', read: 'Read', bash: 'Bash', write: 'Write', edit: 'Edit',
    code: 'Code', generic: 'Tool call', pwsh: 'Pwsh', readImage: 'Read image',
    webSearch: 'Search', webFetch: 'Fetch', todo: 'Update to-do list', ask: 'Ask question',
  },
}

export function classifyTool(toolName) {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

export function toolTitle(toolName, zh) {
  const dictionary = TOOL_TITLES[zh ? 'zh' : 'en']
  if (toolName === 'pwsh') return dictionary.pwsh
  if (toolName === 'read_image') return dictionary.readImage
  if (toolName === 'web_search') return dictionary.webSearch
  if (toolName === 'web_fetch') return dictionary.webFetch
  if (toolName === 'todo_write') return dictionary.todo
  if (toolName === 'ask_user_question') return dictionary.ask
  return dictionary[classifyTool(toolName)] ?? dictionary.generic
}

const SUMMARY_KEYS = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

function parseArgs(argsRaw) {
  try {
    return JSON.parse(argsRaw)
  } catch {
    return undefined
  }
}

function pickString(args, keys) {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export function deriveSummary(variant, argsRaw) {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query) => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(argsRaw)
}

const FILE_PATH_KEYS = ['path', 'file_path']
const FILE_PATH_VARIANTS = new Set(['read', 'write', 'edit'])

export function deriveFilePath(variant, argsRaw) {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const picked = pickString(parsed, FILE_PATH_KEYS)
  return picked === undefined ? undefined : firstLine(picked)
}

export function formatToolBody(variant, argsRaw) {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = parsed.code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/** Flatten a settled result to display text, tool-call-model.ts resultText. */
export function resultText(content, error) {
  const parts = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else parts.push(JSON.stringify(block, null, 2))
    }
  }
  if (parts.length === 0 && error !== undefined && error !== null) {
    parts.push(`${error.name ?? 'Error'}: ${error.code ?? 'unknown'}`)
  }
  return parts.join('\n')
}

/* ----- Error hints (评论区反馈：原始报错「DeepSeek Messages request failed (404)」等让用户无从下手) ----- */

const ERROR_HINTS = [
  {
    pattern: /Messages request failed \(404\)|model (?:.*)?(?:not found|does not exist)/i,
    zh: '404 多为模型名或 API 地址不对：右键悬浮球打开 Agent 设置确认模型 ID；用中转站时核对其支持的模型列表。',
    en: 'A 404 usually means the model ID or API base URL is wrong: check the agent settings (right-click the ball); with a proxy provider, confirm the models it offers.',
  },
  {
    pattern: /API\s*key(?:\s*is)?\s*(?:invalid|无效|不正确|不合法)|(?:invalid|无效的)\s*API\s*key|密匙无效|密钥无效|unauthorized|\b401\b/i,
    zh: '密钥无效或未生效：检查 API Key 是否复制完整、账户是否有余额、中转站是否支持当前模型。',
    en: 'The API key is invalid or not active: check that the key is complete, the account has balance, and the provider supports this model.',
  },
  {
    pattern: /insufficient(?:\s+\w+)?\s*(?:balance|quota)|quota exceeded|余额不足|额度不足|欠费/i,
    zh: '余额不足：到对应平台充值，或换用其他模型。',
    en: 'Insufficient balance or quota: top up on the provider platform or switch models.',
  },
  {
    pattern: /\b429\b|rate[\s_-]?limit|too many requests|限频|限流/i,
    zh: '触发限流：稍等片刻重试，或降低请求频率。',
    en: 'Rate limited: wait a moment and retry, or slow down the request pace.',
  },
  {
    pattern: /timed?[\s_-]?out|timeout|econnrefused|econnreset|enotfound|fetch failed|certificate/i,
    zh: '网络异常：检查网络与代理设置，确认能访问 API 地址。',
    en: 'Network problem: check your network or proxy and make sure the API endpoint is reachable.',
  },
]

/** One actionable hint for known provider/config failures; unknown text gets none. */
export function errorHint(text, zh) {
  if (typeof text !== 'string' || text === '') return ''
  for (const hint of ERROR_HINTS) {
    if (hint.pattern.test(text)) return zh === true ? hint.zh : hint.en
  }
  return ''
}

/* ----- Terminal card (terminal-card-model.ts) ----- */

function parseExitStatus(text) {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

function shellCall(name, args) {
  if (name !== 'bash' && name !== 'pwsh') return null
  const { command, description, run_in_background: background } = args
  if (typeof command !== 'string' || command.trim() === '') return null
  if (typeof description !== 'string' || description.trim() === '') return null
  if (background === true) return null
  return { command, description }
}

/**
 * Terminal card for a settled root bash/pwsh call; null takes the generic path.
 * Persistent shells (no description) and errors stay generic, as in Harness.
 */
export function terminalCardModel(toolName, argsRaw, resultContent) {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const call = shellCall(toolName, parsed)
  if (call === null) return null
  const content = Array.isArray(resultContent) ? resultContent : []
  if (content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') return null
  const status = parseExitStatus(content[0].text)
  return {
    command: call.command,
    description: call.description,
    output: status.output,
    exitCode: status.exitCode,
    signal: status.signal,
  }
}

/** A settled terminal card reports failure via non-zero exit or a signal. */
export function terminalFailed(card) {
  if (card === null) return false
  return (card.exitCode !== undefined && card.exitCode !== 0) || card.signal !== undefined
}

/* ----- Read card (read-card-model.ts, metadata-driven) ----- */

export function readCardModel(meta, resultContent) {
  if (typeof meta !== 'object' || meta === null) return null
  const { path, offset, lines, totalLines, lang } = meta
  if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return null
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null
  if (lang !== undefined && typeof lang !== 'string') return null
  const narrowed = []
  let previous = offset - 1
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return null
    const { number, text } = line
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number <= previous) return null
    if (number > totalLines || typeof text !== 'string') return null
    previous = number
    narrowed.push({ number, text })
  }
  const content = Array.isArray(resultContent) ? resultContent : []
  if (content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') return null
  const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(content[0].text)?.[1]
  if (body === undefined) return null
  return { label: path, lines: narrowed, totalLines, lang }
}

/** The 1-based line a read call was about, from its arguments. */
export function readCallLine(argsRaw) {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { offset } = parsed
  return typeof offset === 'number' && Number.isInteger(offset) && offset >= 1 ? offset : undefined
}

/* ----- Search card (search-card-model.ts, metadata-driven) ----- */

function searchFiles(value) {
  if (!Array.isArray(value)) return null
  const files = []
  for (const file of value) {
    if (typeof file !== 'object' || file === null) return null
    const { path, matches } = file
    if (typeof path !== 'string' || !Array.isArray(matches)) return null
    const narrowed = []
    for (const match of matches) {
      if (typeof match !== 'object' || match === null) return null
      const { lineNumber, line } = match
      if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return null
      if (typeof line !== 'string') return null
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

export function searchCardModel(meta, resultContent) {
  if (typeof meta !== 'object' || meta === null) return null
  if (typeof meta.truncated !== 'boolean') return null
  if (typeof meta.total !== 'number' || !Number.isInteger(meta.total) || meta.total < 0) return null
  const common = { truncated: meta.truncated, total: meta.total }
  const recovery = meta.truncated && Array.isArray(resultContent)
    ? resultContent.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') || undefined
    : undefined
  if (meta.shape !== 'matches' && meta.shape !== 'paths') return null
  if (meta.shape === 'matches') {
    const files = searchFiles(meta.files)
    return files === null ? null : { recovery, card: { kind: 'matches', files, ...common } }
  }
  if (!Array.isArray(meta.paths) || !meta.paths.every((path) => typeof path === 'string')) return null
  return { recovery, card: { kind: 'paths', paths: [...meta.paths], ...common } }
}

/* ----- Web card (web-card-model.ts, metadata-driven) ----- */

function webSources(value) {
  if (!Array.isArray(value)) return null
  const sources = []
  for (const source of value) {
    if (typeof source !== 'object' || source === null) return null
    const { url, title, snippet, publishedAt } = source
    if (typeof url !== 'string') return null
    if (title !== undefined && typeof title !== 'string') return null
    if (snippet !== undefined && typeof snippet !== 'string') return null
    if (publishedAt !== undefined && typeof publishedAt !== 'string') return null
    sources.push({ url, title, snippet, publishedAt })
  }
  return sources
}

export function webCardModel(meta) {
  if (typeof meta !== 'object' || meta === null) return null
  if (typeof meta.truncated !== 'boolean') return null
  if (meta.sources !== undefined) {
    const sources = webSources(meta.sources)
    if (sources === null) return null
    if (meta.answer !== undefined && typeof meta.answer !== 'string') return null
    return { kind: 'search', answer: meta.answer, sources, truncated: meta.truncated }
  }
  if (typeof meta.url !== 'string') return null
  if (typeof meta.statusCode !== 'number' || !Number.isInteger(meta.statusCode)) return null
  return { kind: 'fetch', url: meta.url, statusCode: meta.statusCode, truncated: meta.truncated }
}

/* ----- Diff card (diff-card-model.ts) ----- */

function narrowDiffs(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

function intendedDiff(toolName, argsRaw) {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const args = parsed
  const { file_path: path } = args
  if (typeof path !== 'string' || path.trim() === '') return null
  if (toolName === 'write') {
    return typeof args.content === 'string'
      ? { tool: 'write', diff: { path, oldText: null, newText: args.content } }
      : null
  }
  if (toolName !== 'edit') return null
  const { old_string: oldText, new_string: newText } = args
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

export function diffCardModel(toolName, argsRaw, isError, meta) {
  const intended = intendedDiff(toolName, argsRaw)
  if (intended === null) return null
  if (isError === true) return null
  const diffs = typeof meta === 'object' && meta !== null && Array.isArray(meta.diffs)
    ? (meta.diffs.length === 0 ? null : narrowDiffs(meta.diffs))
    : undefined
  if (diffs === null || diffs === undefined) {
    return intended.tool === 'write' ? { diffs: [intended.diff] } : null
  }
  return { diffs }
}

/** Added/removed line totals across a card's hunks, primitives diffTotals. */
export function diffTotals(diffs) {
  let added = 0
  let removed = 0
  for (const { oldText, newText } of diffs) {
    const before = oldText === null ? [] : oldText.split('\n')
    const after = newText === null ? [] : newText.split('\n')
    // Longest common subsequence over lines, bounded: hunks in tool meta are
    // small, so the O(n·m) table stays fine.
    const rows = before.length
    const cols = after.length
    const table = new Array((rows + 1) * (cols + 1)).fill(0)
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        table[i * (cols + 1) + j] = before[i] === after[j]
          ? table[(i + 1) * (cols + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1])
      }
    }
    removed += rows - table[0]
    added += cols - table[0]
  }
  return { added, removed }
}

/** Split one hunk into display rows (del/add/context), matching DiffBlock. */
export function diffLines({ oldText, newText }) {
  const before = oldText === null ? [] : oldText.split('\n')
  const after = newText === null ? [] : newText.split('\n')
  const rows = before.length
  const cols = after.length
  const table = new Array((rows + 1) * (cols + 1)).fill(0)
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * (cols + 1) + j] = before[i] === after[j]
        ? table[(i + 1) * (cols + 1) + j + 1] + 1
        : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1])
    }
  }
  const lines = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'context', text: before[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1]) {
      lines.push({ kind: 'del', text: before[i] })
      i += 1
    } else {
      lines.push({ kind: 'add', text: after[j] })
      j += 1
    }
  }
  for (; i < rows; i++) lines.push({ kind: 'del', text: before[i] })
  for (; j < cols; j++) lines.push({ kind: 'add', text: after[j] })
  return lines
}

/* ----- Localized copy for the card chrome ----- */

export function toolLabels(zh) {
  return zh
    ? {
        input: '输入',
        output: '输出',
        copy: '复制',
        copied: '已复制',
        collapse: '收起',
        exitCode: (code) => `退出码 ${code}`,
        signal: (signal) => `信号 ${signal}`,
        noExitCode: '未正常退出',
        noOutput: '无输出',
        readWindow: (shown, total) => `显示 ${shown} / ${total} 行`,
        pathsSummary: (shown, total, truncated) => truncated ? `显示 ${shown} / ${total} 个路径` : `${shown} 个路径`,
        matchesSummary: (shown, total, files, truncated) => truncated ? `显示 ${shown} / ${total} 处匹配 · ${files} 个文件` : `${shown} 处匹配 · ${files} 个文件`,
        noResults: '无结果',
        webNoResults: '未找到结果',
        sourcesTruncated: '来源列表已截断',
        contentTruncated: '内容已截断',
      }
    : {
        input: 'IN',
        output: 'OUT',
        copy: 'Copy',
        copied: 'Copied',
        collapse: 'Collapse',
        exitCode: (code) => `exit code ${code}`,
        signal: (signal) => `signal ${signal}`,
        noExitCode: 'no exit code',
        noOutput: 'No output',
        readWindow: (shown, total) => `Showing ${shown} of ${total} lines`,
        pathsSummary: (shown, total, truncated) => truncated ? `Showing ${shown} of ${total} paths` : `${shown} paths`,
        matchesSummary: (shown, total, files, truncated) => truncated ? `Showing ${shown} of ${total} matches · ${files} files` : `${shown} matches · ${files} files`,
        noResults: 'No results',
        webNoResults: 'No results found',
        sourcesTruncated: 'Source list truncated',
        contentTruncated: 'Content truncated',
      }
}

/* ----- Turn token usage (TurnUsagePanel pill) ----- */

export function usageLabels(zh) {
  return zh
    ? { title: '本轮用量', count: (count) => `${count} tok` }
    : { title: 'Turn usage', count: (count) => `${count} tok` }
}

/**
 * Billed tokens of one settled message: the three disjoint prompt buckets plus
 * output, as the Harness usage pill totals it (provider totals may disagree).
 */
export function tokenUsageTotal(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const count = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const total = count(usage.inputTokens) + count(usage.cacheReadTokens)
    + count(usage.cacheWriteTokens) + count(usage.outputTokens)
  return total > 0 ? total : null
}

/** Compact token figure, mirroring the Harness formatTokens scaling. */
export function formatTokenCount(value) {
  const scaled = (candidate) => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1e3) return String(value)
  if (value < 1e6) return `${scaled(value / 1e3)}K`
  return `${scaled(value / 1e6)}M`
}
