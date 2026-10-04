/**
 * Stand-in for the host control socket, used to smoke-test the helper without
 * starting a whole harness:
 *
 *   node scripts/linux-smoke.mjs packages/helper/lib/main.js /usr/lib/electron40/electron
 *
 * It serves the hello handshake, captures the screen with the ball resting, asks
 * the helper to cloak (the `overlay-capture` interval Computer Use opens around
 * every measurement), captures again, then releases and captures once more. The
 * three PNGs land in .probe/; the middle one must not contain the ball.
 *
 * Needs a running desktop session: run it from a terminal inside KDE, not from
 * a system service.
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const HELPER = process.argv[2]
const ELECTRON = process.argv[3] ?? '/usr/lib/electron40/electron'
const OUT = process.argv[4] ?? '/home/yealqp/Projects/dsh-orb-cordis/.probe'
const token = randomBytes(24).toString('hex')
const seen = []
let socketRef

const server = createServer((socket) => {
  socketRef = socket
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let message
      try { message = JSON.parse(part) } catch { continue }
      seen.push(message.type)
      console.log('  <- helper', JSON.stringify(message).slice(0, 160))
      if (message.type === 'hello') {
        console.log('  -> hello ack, pid', message.pid)
        // Answer the boot-time queries the ball page makes so the panel can render.
        socket.write(`${JSON.stringify({ type: 'chrome', permission: 'danger-full-access', ballEnabled: true, appearance: { dark: true, locale: 'zh' } })}\n`)
        socket.write(`${JSON.stringify({ type: 'history', items: [] })}\n`)
        socket.write(`${JSON.stringify({ type: 'models', foreground: [], background: [] })}\n`)
      }
    }
  })
  socket.on('error', () => {})
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log(`fake host on 127.0.0.1:${port}`)

const userData = `${OUT}/helper-data`
mkdirSync(userData, { recursive: true })

const env = {
  ...process.env,
  DSH_ORB_SOCKET: `127.0.0.1:${port}`,
  DSH_ORB_TOKEN: token,
  DSH_ORB_WEB_PORT: '3080',
  DSH_ORB_APPEARANCE: JSON.stringify({ dark: true, locale: 'zh' }),
  DSH_ORB_ELECTRON_PATH: ELECTRON,
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(ELECTRON, [`--user-data-dir=${userData}`, HELPER], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => process.stdout.write(`  helper: ${chunk}`))
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim()) process.stdout.write(`  helper! ${line}\n`)
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (name) => {
  try {
    execFileSync('spectacle', ['-b', '-n', '-f', '-o', `${OUT}/${name}`], { timeout: 60000 })
    return true
  } catch (error) {
    console.log('  capture failed:', String(error).slice(0, 160))
    return false
  }
}

await sleep(8000)
console.log('\n--- capture with the ball resting ---')
shot('cloak-rest.png')

console.log('--- asking the helper to cloak (overlay-capture begin) ---')
socketRef?.write(`${JSON.stringify({ type: 'overlay-capture', active: true, id: 'cloak-1' })}\n`)
await sleep(1500)
shot('cloak-active.png')

console.log('--- releasing the cloak ---')
socketRef?.write(`${JSON.stringify({ type: 'overlay-capture', active: false, id: 'cloak-2' })}\n`)
await sleep(1500)
shot('cloak-released.png')

console.log('\n--- KWin window list ---')
try {
  const mark = new Date(Date.now() - 30000).toISOString().slice(0, 19).replace('T', ' ')
  execFileSync('bash', ['-c', `qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript ${OUT}/probe-kwin.js >/dev/null; qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null`])
  await sleep(1200)
  const log = execFileSync('bash', ['-c', `journalctl --user _COMM=kwin_wayland --no-pager --since "${mark}" 2>/dev/null | grep -o 'DSHORB_PROBE .*' | tail -1`], { encoding: 'utf8' })
  const data = JSON.parse(log.trim().slice('DSHORB_PROBE '.length))
  for (const w of data.windows) {
    console.log('  ', JSON.stringify(w.resourceClass), w.frame, 'active=' + w.active, 'skipTaskbar=' + w.skipTaskbar, 'normalWindow=' + w.normalWindow, 'pid=' + w.pid)
  }
} catch (error) {
  console.log('  probe failed:', String(error).slice(0, 200))
}

console.log('\n--- final capture ---')
shot('helper-smoke-full.png')

console.log('\nmessages from helper:', seen.join(', ') || '(none)')
console.log('helper exit code:', child.exitCode)
child.kill('SIGTERM')
await sleep(600)
child.kill('SIGKILL')
server.close()
