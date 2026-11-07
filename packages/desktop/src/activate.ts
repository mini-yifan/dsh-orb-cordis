/**
 * Borrowing the foreground, and giving it back.
 *
 * Only two platform commands are used, both shipped by the OS: `open -a` on
 * macOS and a one-line PowerShell script on Windows. There is deliberately no
 * fallback to thread attachment or window-message tricks — when the system
 * refuses to raise a window, the agent is told so and stops.
 * @module @dsh-orb/desktop/src/activate
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** How long one activation attempt may take. */
const ACTIVATE_TIMEOUT_MS = 8000

/**
 * Bring one app to the front.
 * @param app - display name (macOS) or process/window name (Windows).
 * @throws when the platform is unsupported or the system refused.
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
    const literal = app.replace(/'/g, "''")
    const script = '$ErrorActionPreference="Stop";'
      + '$w=New-Object -ComObject WScript.Shell;'
      + `if(-not $w.AppActivate('${literal}')){exit 1}`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      timeout: ACTIVATE_TIMEOUT_MS,
      windowsHide: true,
    })
    return
  }
  throw new Error(`bringing an app to the front is not supported on ${process.platform}`)
}