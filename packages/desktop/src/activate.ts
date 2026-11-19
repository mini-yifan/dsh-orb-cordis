/**
 * Bringing an application to the front, or cold-launching it when not running.
 *
 * - macOS uses `open -a` (then `open -b` for bundle identifiers), which both
 *   activates a running app and launches a stopped one.
 * - Windows tries `WScript.Shell.AppActivate` first, then cold-launches via
 *   built-in aliases (`ms-settings:`, `calc.exe`, …), explicit paths/URIs,
 *   `Get-StartApps` (`shell:AppsFolder\<AppID>`, covering Chinese/English Start
 *   Menu & UWP apps like QQ, 微信, Chrome, Edge, Settings), and `Start-Process`.
 * @module @dsh-orb/desktop/src/activate
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long one activation or cold-launch attempt may take. */
const ACTIVATE_TIMEOUT_MS = 10_000

/** Common Windows built-in display names (Chinese & English) mapped to launch targets. */
const WINDOWS_APP_ALIASES: Record<string, string> = {
  'settings': 'ms-settings:',
  'system settings': 'ms-settings:',
  'windows settings': 'ms-settings:',
  '设置': 'ms-settings:',
  '系统设置': 'ms-settings:',
  'calculator': 'calc.exe',
  '计算器': 'calc.exe',
  'notepad': 'notepad.exe',
  '记事本': 'notepad.exe',
  'file explorer': 'explorer.exe',
  'explorer': 'explorer.exe',
  '资源管理器': 'explorer.exe',
  '文件资源管理器': 'explorer.exe',
  'paint': 'mspaint.exe',
  '画图': 'mspaint.exe',
  'terminal': 'wt.exe',
  'windows terminal': 'wt.exe',
  '终端': 'wt.exe',
  'task manager': 'taskmgr.exe',
  '任务管理器': 'taskmgr.exe',
  'control panel': 'control.exe',
  '控制面板': 'control.exe',
  'edge': 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  'chrome': 'chrome.exe',
  'google chrome': 'chrome.exe',
}

/**
 * Resolve a common Windows display name or URI to a direct launch target.
 * @param app - user- or model-supplied app name.
 * @returns direct target (`ms-settings:`, `calc.exe`, URI), or undefined to search `Get-StartApps`.
 */
export function windowsLaunchTarget(app: string): string | undefined {
  const trimmed = app.trim()
  if (trimmed === '') return undefined
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed
  }
  return WINDOWS_APP_ALIASES[trimmed.toLowerCase()]
}

/** Alias groups for matching running Windows processes & titles (e.g. WeChat 4.x uses Weixin.exe with title "微信"). */
const WINDOWS_PROCESS_ALIASES: Record<string, readonly string[]> = {
  'wechat': ['Weixin', 'WeChat', '微信'],
  'weixin': ['Weixin', 'WeChat', '微信'],
  '微信': ['Weixin', 'WeChat', '微信'],
  'qq': ['QQ'],
  'chrome': ['chrome', 'Google Chrome'],
  'google chrome': ['chrome', 'Google Chrome'],
  'edge': ['msedge', 'Microsoft Edge'],
  'microsoft edge': ['msedge', 'Microsoft Edge'],
  'notepad': ['notepad', '记事本'],
  '记事本': ['notepad', '记事本'],
  'calculator': ['CalculatorApp', 'Calculator', '计算器'],
  '计算器': ['CalculatorApp', 'Calculator', '计算器'],
  'settings': ['SystemSettings', '设置'],
  '系统设置': ['SystemSettings', '设置'],
  '设置': ['SystemSettings', '设置'],
  'wps': ['wps', 'WPS Office'],
}

/**
 * Build the PowerShell script that activates a running Windows app (by title,
 * process name, or alias) or launches it cold via alias, path, URI, or
 * `Get-StartApps`.
 *
 * Encoded as UTF-16LE base64 (`-EncodedCommand`) when invoked, so Chinese app
 * names never suffer from PowerShell 5.1 GBK/ANSI script decoding issues.
 */
export function windowsActivateScript(app: string): string {
  const trimmed = app.trim()
  const base = trimmed.replace(/\.exe$/i, '')
  const literal = trimmed.replace(/'/g, "''")
  const mapped = windowsLaunchTarget(trimmed)
  const mappedLiteral = mapped !== undefined ? mapped.replace(/'/g, "''") : ''
  const aliasList = WINDOWS_PROCESS_ALIASES[base.toLowerCase()] ?? [trimmed, base]
  const candidates = [...new Set([trimmed, base, ...aliasList])]
    .filter(item => item !== '')
    .map(item => `'${item.replace(/'/g, "''")}'`)
    .join(', ')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${literal}'`,
    `$mapped = '${mappedLiteral}'`,
    `$candidates = @(${candidates})`,
    '$ws = New-Object -ComObject WScript.Shell',
    'foreach ($c in $candidates) { if ($ws.AppActivate($c)) { exit 0 } }',
    '$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }',
    'foreach ($c in $candidates) {',
    '  $p = $procs | Where-Object { $_.ProcessName -ieq $c -or $_.MainWindowTitle -like ("*" + $c + "*") } | Select-Object -First 1',
    '  if ($p -and $ws.AppActivate($p.Id)) { exit 0 }',
    '}',
    'if ($mapped -ne "") { Start-Process -FilePath $mapped; exit 0 }',
    'if (Test-Path -LiteralPath $name) { Start-Process -FilePath $name; exit 0 }',
    'try {',
    '  $apps = Get-StartApps -ErrorAction SilentlyContinue',
    '  foreach ($c in $candidates) {',
    '    $hit = $apps | Where-Object { $_.Name -ieq $c } | Select-Object -First 1',
    '    if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like ("*" + $c + "*") } | Select-Object -First 1 }',
    '    if ($hit -and $hit.AppID) { Start-Process -FilePath ("shell:AppsFolder\\" + $hit.AppID); exit 0 }',
    '  }',
    '} catch {}',
    'Start-Process -FilePath $name',
  ].join('\n')
}

/**
 * Bring one app to the front, or launch it when not running.
 * @param app - display name, bundle identifier (macOS), URI, path, or exe name (Windows).
 * @throws when the platform is unsupported or the launch failed.
 */
export async function activateApp(app: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await run('open', ['-a', app], { timeout: ACTIVATE_TIMEOUT_MS })
      return
    } catch {
      // A display name that is really a bundle id is the only other shape we can try.
      await run('open', ['-b', app], { timeout: ACTIVATE_TIMEOUT_MS })
      return
    }
  }
  if (process.platform === 'win32') {
    const script = windowsActivateScript(app)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      timeout: ACTIVATE_TIMEOUT_MS,
      windowsHide: true,
    })
    return
  }
  throw new Error(`bringing an app to the front is not supported on ${process.platform}`)
}
