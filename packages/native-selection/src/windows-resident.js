/**
 * Selection reads on Windows, from one long-lived PowerShell process.
 *
 * A read used to spawn `powershell.exe` per left-click release — about 1.5 s of cold start each
 * time, and one process per click on the whole desktop. The process has to be STA for UI
 * Automation, so it cannot simply live on the hook worker's thread; instead it is started once
 * and fed request lines over stdin, answering one JSON line per request.
 */

import { spawn } from 'node:child_process'

/**
 * The resident reader. Reads one request line, writes one answer line.
 *
 * Kept deliberately small: `Add-Type` and the two assemblies load once at startup, which is
 * the whole point — that is where the seconds were going.
 */
export const RESIDENT_SELECTION_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
[Console]::Out.NewLine = "\`n"
$stdout = [Console]::Out

function Read-Selection {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused) { return @{ ok = $false; reason = 'no-focus' } }
  $pattern = $null
  if (-not $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
    return @{ ok = $false; reason = 'no-text-pattern' }
  }
  $ranges = @($pattern.GetSelection())
  if ($ranges.Length -lt 1) { return @{ ok = $false; reason = 'no-range' } }
  $text = $ranges[0].GetText(4000)
  if ([string]::IsNullOrWhiteSpace($text)) { return @{ ok = $false; reason = 'blank' } }
  $out = @{ ok = $true; text = $text; pid = $focused.Current.ProcessId }
  # No usable rectangle means no coordinates at all: 0 is a real screen position, not "missing".
  $rects = @($ranges[0].GetBoundingRectangles())
  if ($rects.Length -ge 4) {
    $out.x = $rects[0]; $out.y = $rects[1]; $out.width = $rects[2]; $out.height = $rects[3]
  }
  return $out
}

# Announce readiness once, so the host knows the assemblies are loaded and the first real
# request will not pay for them.
$stdout.WriteLine((@{ ok = $false; ready = $true } | ConvertTo-Json -Compress))
$stdout.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  try {
    $answer = Read-Selection
  } catch {
    $answer = @{ ok = $false; reason = 'error'; message = $_.Exception.Message }
  }
  $stdout.WriteLine(($answer | ConvertTo-Json -Compress))
  $stdout.Flush()
}
`

/**
 * Arguments that run the reader script and leave stdin free for request lines.
 *
 * Passing the script through stdin (`-Command -`) is what looks natural, but PowerShell parses
 * and executes stdin line by line: once the script reaches its `while` loop, that loop starts
 * consuming the script's own tail as if it were requests. `-EncodedCommand` keeps the two
 * streams separate, and UTF-16LE base64 is also the form PowerShell expects on its command line.
 * @param script - the reader script; tests inject a shorter one.
 * @returns argv for `powershell.exe`, with the encoded script last.
 */
export function residentSelectionArgs(script = RESIDENT_SELECTION_SCRIPT) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
}

/** How long a normal read may wait for one answer line. */
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500
/** How long the child may take to load UI Automation and announce readiness. */
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000

/**
 * @typedef {object} ResidentSelection
 * @property {() => Promise<Record<string, unknown> | undefined>} read
 * @property {() => void} close
 */

/**
 * Start the resident reader.
 *
 * Failures are reported by returning undefined from `read` rather than throwing: a read that
 * cannot answer simply leaves the toolbar hidden, exactly as a platform with no selection does.
 * @param {object} [options] - command, arguments, timeouts, and a spawn override for tests.
 * @returns {ResidentSelection | undefined} the reader handle, or undefined when it could not start.
 */
export function startResidentSelection(options = {}) {
  const command = options.command ?? 'powershell.exe'
  const args = [...(options.args ?? residentSelectionArgs())]
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const spawnImpl = options.spawnImpl ?? spawn

  let child
  try {
    child = spawnImpl(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return undefined
  }

  let buffer = ''
  let closed = false
  let ready = false
  /** Requests waiting for the next answer line, oldest first. */
  const waiting = []
  /** Callers that asked for a read before the assemblies finished loading. */
  const waitingForReady = []
  let startupTimer

  function settle(answer) {
    const next = waiting.shift()
    next?.(answer)
  }

  /** Start every read that arrived while the child was still loading. */
  function startWaiting() {
    for (const start of waitingForReady.splice(0)) start()
  }

  function stop() {
    if (closed) return
    closed = true
    if (startupTimer !== undefined) clearTimeout(startupTimer)
    // A read that was waiting for readiness must resolve, not hang: its `start` sees `closed`.
    startWaiting()
    while (waiting.length > 0) settle(undefined)
  }

  function failStartup() {
    if (closed) return
    stop()
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  startupTimer = setTimeout(failStartup, startupTimeoutMs)
  startupTimer.unref?.()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        // A half-written or noisy line is not an answer; drop it and keep reading.
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const record = parsed
      // The startup announcement is not an answer: it is the green light for reads that arrived
      // while Add-Type was still loading, and consuming it as an answer would hand the first
      // caller a placeholder.
      if (record.ready === true) {
        if (closed || ready) continue
        ready = true
        if (startupTimer !== undefined) clearTimeout(startupTimer)
        startWaiting()
        continue
      }
      settle(record)
    }
  })
  // stderr carries PowerShell's own complaints; nothing there is actionable for a read, and
  // leaving it unread would eventually fill the pipe and stall the child.
  child.stderr.on('data', () => {})

  const onGone = () => {
    if (closed) return
    stop()
  }
  child.on('error', onGone)
  child.on('exit', onGone)
  child.stdin.on('error', onGone)

  return {
    read() {
      if (closed) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        function start() {
          if (closed) {
            resolve(undefined)
            return
          }
          const timer = setTimeout(() => {
            const at = waiting.indexOf(done)
            if (at >= 0) waiting.splice(at, 1)
            resolve(undefined)
          }, timeoutMs)
          function done(answer) {
            clearTimeout(timer)
            resolve(answer)
          }
          waiting.push(done)
          try {
            child.stdin.write('read\n')
          } catch {
            const at = waiting.indexOf(done)
            if (at >= 0) waiting.splice(at, 1)
            clearTimeout(timer)
            resolve(undefined)
          }
        }
        if (ready) start()
        else waitingForReady.push(start)
      })
    },
    close() {
      if (closed) return
      stop()
      try {
        child.stdin.write('quit\n')
        child.stdin.end()
      } catch {
        // Already gone.
      }
      const timer = setTimeout(() => { child.kill() }, 500)
      timer.unref?.()
    },
  }
}
