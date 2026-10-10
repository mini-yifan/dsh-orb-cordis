import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processLabel, reasoningSummary, classifyTool, deriveSummary, formatToolBody, terminalCardModel, terminalFailed, terminalCopyText, searchCardModel, searchCopyText, webCardModel, diffCardModel, diffTotals, diffLines, processTitle, toolTitle, readCardModel, readCopyText, usageLabels, tokenUsageTotal, formatTokenCount } from '../assets/transcript-model.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('reasoning summary', () => {
  it('keeps the latest completed paragraph while streaming', () => {
    assert.equal(reasoningSummary('还在想', true), '')
    assert.equal(reasoningSummary('第一段标题\n还在写', true), '第一段标题')
    assert.equal(reasoningSummary('第一行\n第一段剩余\n\n第二行\n还在写', true), '第二行')
    assert.equal(reasoningSummary('第一行\n\n还没写完', true), '第一行')
  })

  it('uses the first line once the block has settled', () => {
    assert.equal(reasoningSummary('全文第一行\n第二行', false), '全文第一行')
    assert.equal(reasoningSummary('\n后面才有字', false), '')
  })

  it('strips bold markers from the collapsed summary', () => {
    assert.equal(reasoningSummary('**加粗**\n未完成', true), '加粗')
    assert.equal(reasoningSummary('**你好**世界\n下一行', false), '你好世界')
    assert.equal(reasoningSummary('  **标题**\n第二行', false), '  标题')
  })
})

describe('turn process label', () => {
  it('formats live seconds and minutes without padded seconds', () => {
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 200 }), '深度求索中，用时1秒')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 5000 }), '深度求索中，用时5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 5000 }), 'Deep diving for 5s')
    assert.equal(processLabel({ zh: true, running: true, elapsedMs: 65000 }), '深度求索中，用时1分5秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 65000 }), 'Deep diving for 1m 5s')
  })

  it('pads settled minutes and keeps a space before the duration', () => {
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 65000 }), '用时 1分05秒')
    assert.equal(processLabel({ zh: false, running: false, elapsedMs: 65000 }), 'Took 1m 05s')
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 3_661_000 }), '用时 1小时01分01秒')
    assert.equal(processLabel({ zh: false, running: true, elapsedMs: 3_661_000 }), 'Deep diving for 1h 01m 1s')
  })

  it('uses the Worked label when the turn has no start time', () => {
    assert.equal(processLabel({ zh: true, running: false }), '已完成工作')
    assert.equal(processLabel({ zh: false, running: false }), 'Worked')
    assert.equal(processLabel({ zh: true, running: true }), '深度求索中')
  })

  it('names stop and fail endings, and prefixes the step title', () => {
    assert.equal(processLabel({ zh: true, running: false, end: 'stopped' }), '已停止')
    assert.equal(processLabel({ zh: false, running: false, end: 'failed' }), 'Failed')
    assert.equal(processLabel({ zh: true, running: false, elapsedMs: 5000, title: '执行了命令' }), '执行了命令，用时 5秒')
    assert.equal(processLabel({ zh: false, running: false, elapsedMs: 5000, title: 'Ran commands' }), 'Ran commands, Took 5s')
  })
})

describe('tool row model', () => {
  it('classifies tools into variants and localized titles', () => {
    assert.equal(classifyTool('bash'), 'bash')
    assert.equal(classifyTool('web_fetch'), 'read')
    assert.equal(classifyTool('grep'), 'search')
    assert.equal(classifyTool('unknown_thing'), 'others')
    assert.equal(toolTitle('bash', true), '运行命令')
    assert.equal(toolTitle('web_search', true), '网页搜索')
    assert.equal(toolTitle('web_search', false), 'Search')
    assert.equal(toolTitle('todo_write', true), '更新任务清单')
  })

  it('derives summaries from arguments, appending the tool name for generic rows', () => {
    assert.equal(deriveSummary('read', JSON.stringify({ file_path: '/tmp/a.txt\nsecond' })), '/tmp/a.txt')
    assert.equal(deriveSummary('bash', JSON.stringify({ description: 'list files', command: 'ls' })), 'list files')
    assert.equal(deriveSummary('search', JSON.stringify({ queries: ['a', 'b'] })), 'a, b')
    assert.equal(deriveSummary('others', JSON.stringify({ task: 'hello' })), 'hello')
  })

  it('formats generic bodies as pretty JSON and unwraps run_code programs', () => {
    assert.equal(formatToolBody('read', '{"file_path":"a"}'), '{\n  "file_path": "a"\n}')
    assert.equal(formatToolBody('code', '{"code":"let x = 1"}'), 'let x = 1')
    assert.equal(formatToolBody('read', 'not json'), 'not json')
  })
})

describe('tool card models', () => {
  it('derives a terminal card from a bash call and exit marker', () => {
    const card = terminalCardModel('bash', JSON.stringify({ command: 'ls -la', description: 'list files' }), [
      { type: 'text', text: 'file-a\nfile-b\n[exit code: 2]' },
    ])
    assert.equal(card?.command, 'ls -la')
    assert.equal(card?.exitCode, 2)
    assert.equal(card?.output, 'file-a\nfile-b')
    assert.equal(terminalFailed(card), true)
  })

  it('treats persistent shells and non-text results as generic', () => {
    assert.equal(terminalCardModel('bash', JSON.stringify({ command: 'x' }), [{ type: 'text', text: '[exit code: 0]' }]), null)
    const noDescription = terminalCardModel('bash', JSON.stringify({ command: 'x' }), undefined)
    assert.equal(noDescription, null)
  })

  it('derives a read card from result metadata and the envelope', () => {
    const card = readCardModel({
      path: '/tmp/a.txt',
      offset: 1,
      totalLines: 2,
      lines: [{ number: 1, text: 'first' }, { number: 2, text: 'second' }],
    }, [{ type: 'text', text: '<path>/tmp/a.txt</path>\n<type>file</type>\n<content>\nfirst\nsecond\n</content>' }])
    assert.equal(card?.label, '/tmp/a.txt')
    assert.equal(card?.lines.length, 2)
    assert.equal(card?.totalLines, 2)
  })

  it('derives search and web cards from metadata', () => {
    const search = searchCardModel({
      truncated: false, total: 2, shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }, { path: 'b.ts', matches: [{ lineNumber: 2, line: 'y' }] }],
    })
    assert.equal(search?.card.kind, 'matches')
    assert.equal(search?.card.files.length, 2)
    const web = webCardModel({ truncated: true, answer: 'an answer', sources: [{ url: 'https://a', title: 'A' }] })
    assert.equal(web?.kind, 'search')
    assert.equal(web?.sources.length, 1)
    const fetch = webCardModel({ truncated: false, url: 'https://b', statusCode: 200 })
    assert.equal(fetch?.kind, 'fetch')
    assert.equal(fetch?.statusCode, 200)
  })

  it('derives diffs from write/edit arguments and result metadata', () => {
    const intended = diffCardModel('write', JSON.stringify({ file_path: 'a.ts', content: 'new' }), false, '')
    assert.equal(intended?.diffs.length, 1)
    const applied = diffCardModel('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nc' }), false, {
      diffs: [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nc' }],
    })
    assert.equal(applied?.diffs.length, 1)
    assert.deepEqual(diffTotals(applied.diffs), { added: 1, removed: 1 })
    const lines = diffLines(applied.diffs[0])
    assert.deepEqual(lines.map((line) => line.kind), ['context', 'del', 'add'])
    assert.equal(diffCardModel('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }), true, ''), null)
  })
})

describe('step process title', () => {
  it('joins the top tool categories with the Harness phrasing', () => {
    assert.equal(processTitle(['bash'], true), '执行了命令')
    assert.equal(processTitle(['bash', 'read'], false), 'Ran commands and read files')
    assert.equal(processTitle(['read', 'read', 'bash', 'grep'], true), '已读取文件，执行了命令，已搜索代码')
  })
})

describe('turn usage pill', () => {
  it('totals billed input plus output, ignoring absent cache buckets', () => {
    assert.equal(tokenUsageTotal({ inputTokens: 100, outputTokens: 40 }), 140)
    assert.equal(tokenUsageTotal({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 900 }), 1040)
    assert.equal(tokenUsageTotal({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 900 }), 900)
    assert.equal(tokenUsageTotal(undefined), null)
    assert.equal(tokenUsageTotal('nope'), null)
    assert.equal(tokenUsageTotal({ inputTokens: -5, outputTokens: 'x' }), null)
  })

  it('scales compact counts like the Harness pill', () => {
    assert.equal(formatTokenCount(999), '999')
    assert.equal(formatTokenCount(1000), '1K')
    assert.equal(formatTokenCount(1234), '1.2K')
    assert.equal(formatTokenCount(12345), '12.3K')
    assert.equal(formatTokenCount(123456), '123K')
    assert.equal(formatTokenCount(1234567), '1.2M')
    const zh = usageLabels(true)
    const en = usageLabels(false)
    assert.equal(zh.count(formatTokenCount(1234)), '1.2K tok')
    assert.equal(zh.title, '本轮用量')
    assert.equal(en.title, 'Turn usage')
  })
})

describe('tool card copy text', () => {
  it('copies only the command when a terminal card has no output', () => {
    assert.equal(terminalCopyText({ command: 'pnpm test', output: '' }), 'pnpm test')
    assert.equal(terminalCopyText({ command: 'ls', output: 'a\nb' }), 'ls\na\nb')
  })

  it('keeps the read body lines but drops the gutter numbers', () => {
    const text = readCopyText({ lines: [{ number: 4, text: 'alpha' }, { number: 5, text: 'beta' }] })
    assert.equal(text, 'alpha\nbeta')
  })

  it('leads the search copy with the summary and every match', () => {
    const card = { kind: 'matches', truncated: false, total: 2, files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'const a = 1' }] }] }
    assert.equal(searchCopyText(card, '2 处匹配'), '2 处匹配\nsrc/a.ts\n7  const a = 1')
    assert.equal(searchCopyText({ kind: 'paths', truncated: false, total: 1, paths: ['src/b.ts'] }, '1 个路径'), '1 个路径\nsrc/b.ts')
  })
})

describe('ball page module', () => {
  it('imports the transcript model from the helper page', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')
    assert.match(shell, /from '\.\/transcript-model\.js'/)
    assert.match(shell, /reasoningSummary\(/)
    assert.match(shell, /processLabel\(/)
    assert.match(html, /type="module" src="shell\.js"/)
  })

  it('wires message copy buttons and the usage pill into both message kinds', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    const chat = readFileSync(join(here, '../assets/chat.css'), 'utf8')
    assert.match(shell, /messageCopyButton\(/)
    assert.match(shell, /className = 'user-actions'/)
    assert.match(shell, /className = 'am-actions'/)
    assert.match(shell, /usagePill\(/)
    assert.match(chat, /\.msg-copy/)
    assert.match(chat, /\.am-usage/)
    // Transcript prose stays selectable; the global sheet keeps chrome unselectable.
    const floating = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    assert.match(floating, /#transcript \{[^}]*user-select: text/s)
  })

  it('pins from an input click and keeps unpinning on the ball only', () => {
    const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    assert.match(shell, /prompt\.addEventListener\('click', \(\) => \{ pinBall\(\) \}\)/)
    // pinBall is set-only; the toggle (and the unpin) stays on the ball's pointerup.
    assert.match(shell, /function pinBall\(\) \{\s*\n\s*if \(pinned\) return\s*\n\s*pinned = true/)
    assert.match(shell, /pinned = !pinned/)
  })
})
