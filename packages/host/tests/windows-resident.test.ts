import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { RESIDENT_SELECTION_ARGS, startResidentSelection } from '../../native-selection/src/windows-resident.js'

/**
 * A stand-in for `powershell.exe` that speaks the reader protocol.
 *
 * It answers one line per request, so the tests can drive ordering, concurrency, a silent
 * child, and a child that dies mid-request without needing Windows.
 */
function fakeProcess(behaviour: {
  /** Answer text for the n-th request (0-based). Returning undefined means "say nothing". */
  answer?: (index: number) => string | undefined
  /** Emit the readiness line on startup. */
  announce?: boolean
  /** Never exit on `quit`, so `close()` has to kill. */
  stubborn?: boolean
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    kill: () => void
    requests: string[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.requests = []
  let index = 0
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      child.requests.push(line)
      if (line.trim() === 'quit') {
        if (!behaviour.stubborn) child.emit('exit', 0)
        return
      }
      const answer = behaviour.answer === undefined ? '{"ok":true,"text":"picked"}' : behaviour.answer(index++)
      if (answer !== undefined) child.stdout.write(`${answer}\n`)
    }
  })
  child.kill = () => { child.emit('exit', 1) }
  if (behaviour.announce !== false) {
    // Readiness arrives asynchronously, as a real child's first line would.
    setTimeout(() => child.stdout.write('{"ok":false,"ready":true}\n'), 0)
  }
  return child
}

function start(behaviour: Parameters<typeof fakeProcess>[0], options: { requestTimeoutMs?: number } = {}) {
  const children: ReturnType<typeof fakeProcess>[] = []
  const reader = startResidentSelection({
    command: 'fake-powershell',
    args: ['-NoProfile'],
    requestTimeoutMs: options.requestTimeoutMs,
    spawnImpl: ((command: string, args: readonly string[]) => {
      assert.equal(command, 'fake-powershell')
      assert.deepEqual([...args], ['-NoProfile'])
      const child = fakeProcess(behaviour)
      children.push(child)
      return child
    }) as never,
  })
  assert.ok(reader !== undefined)
  return { reader, children }
}

describe('resident selection reader', () => {
  it('answers each request from one long-lived process', async () => {
    const { reader, children } = start({ answer: (n) => `{"ok":true,"text":"word-${String(n)}"}` })
    // Several reads, one process: this is the whole point of the change, since the old path
    // started a PowerShell per left-click release.
    assert.equal((await reader.read())?.text, 'word-0')
    assert.equal((await reader.read())?.text, 'word-1')
    assert.equal((await reader.read())?.text, 'word-2')
    assert.equal(children.length, 1, 'one process serves every read')
    assert.deepEqual(children[0]?.requests, ['read', 'read', 'read'])
    reader.close()
  })

  it('pairs concurrent reads with their own answers in order', async () => {
    const { reader } = start({ answer: (n) => `{"ok":true,"text":"r${String(n)}"}` })
    const [a, b, c] = await Promise.all([reader.read(), reader.read(), reader.read()])
    assert.deepEqual([a?.text, b?.text, c?.text], ['r0', 'r1', 'r2'])
    reader.close()
  })

  it('drops the startup announcement instead of using it as an answer', async () => {
    // The readiness line is not a read result: consuming it would hand the first caller a
    // placeholder and leave every later read one answer behind.
    const { reader } = start({ answer: () => '{"ok":true,"text":"real"}' })
    assert.equal((await reader.read())?.text, 'real')
    reader.close()
  })

  it('ignores a malformed line and keeps waiting for a real answer', async () => {
    // A child that writes noise instead of an answer must not resolve the request with it.
    const { reader, children } = start({ answer: () => undefined })
    const pending = reader.read()
    await new Promise((resolve) => setTimeout(resolve, 10))
    children[0]?.stdout.write('not json\n')
    await new Promise((resolve) => setTimeout(resolve, 10))
    children[0]?.stdout.write('{"ok":true,"text":"after-noise"}\n')
    assert.equal((await pending)?.text, 'after-noise')
    reader.close()
  })

  it('answers nothing when the child says nothing in time', async () => {
    const { reader } = start({ answer: () => undefined }, { requestTimeoutMs: 40 })
    // A read that cannot answer must resolve, not hang: the toolbar stays hidden either way.
    assert.equal(await reader.read(), undefined)
    reader.close()
  })

  it('fails in-flight reads at once when the child dies', async () => {
    const { reader, children } = start({ answer: () => undefined })
    const pending = reader.read()
    children[0]?.emit('exit', 1)
    // The death answers every waiter immediately rather than making each wait out its timeout.
    assert.equal(await pending, undefined)
    // And a read after death is answered without another write.
    assert.equal(await reader.read(), undefined)
    reader.close()
  })

  it('kills a child that does not exit on quit', async () => {
    const { reader, children } = start({ stubborn: true })
    reader.close()
    await new Promise((resolve) => setTimeout(resolve, 620))
    // The kill timer is the only thing that ends a child ignoring the quit line.
    assert.equal(children[0]?.requests.includes('quit'), true)
  })

  it('starts the reader with the arguments PowerShell needs to read stdin', () => {
    // `-Command -` is what makes PowerShell read its script from stdin; `-STA` is required by
    // UI Automation, and `-NonInteractive` keeps a prompt from blocking the pipe.
    assert.deepEqual([...RESIDENT_SELECTION_ARGS], ['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'])
  })
})
