import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VOICE_SETTINGS } from '@dsh-orb/voice/settings'
import { linkProcess, VoiceController, type VoiceLink, type VoicePageMessage } from '../src/voice.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-voice-'))
const script = join(import.meta.dirname, 'fixtures', 'voice-child.mjs')
after(() => { rmSync(root, { recursive: true, force: true }) })

function traceOf(file: string): unknown[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
  } catch {
    return []
  }
}

async function until(check: () => boolean, detail: () => string = () => ''): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for the voice child\n${detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function speaks(file: string): { id: string, text: string }[] {
  return traceOf(file).filter((item) => (item as { type?: string }).type === 'speak') as { id: string, text: string }[]
}

function listenModes(file: string): string[] {
  return listens(file).flatMap((item) => item.mode ? [item.mode] : [])
}

function listens(file: string): { mode?: string, seedMs?: number, device?: boolean }[] {
  return traceOf(file).flatMap((item) => {
    const record = item as { type?: string, mode?: string, seedMs?: number, device?: boolean }
    return record.type === 'listen' ? [record] : []
  })
}

describe('voice controller with a script child', () => {
  it('walks wake, a command, dismiss, idle, a question, and stop', async () => {
    const dir = join(root, 'run')
    const inject = join(dir, 'inject.ndjson')
    const trace = join(dir, 'trace.ndjson')
    mkdirSync(dir, { recursive: true })
    writeFileSync(inject, '')
    writeFileSync(trace, '')
    const page: VoicePageMessage[] = []
    let now = 0
    const settings = {
      ...DEFAULT_VOICE_SETTINGS,
      voiceEnabled: true,
      wakeWords: [...DEFAULT_VOICE_SETTINGS.wakeWords],
      dismissPhrases: [...DEFAULT_VOICE_SETTINGS.dismissPhrases],
    }
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, VOICE_INJECT: inject, VOICE_TRACE: trace },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => now,
      send: (message) => { page.push(message) },
      open: () => linkProcess(child),
    })
    voice.start()
    try {
    const emit = (message: unknown) => { appendFileSync(inject, `${JSON.stringify(message)}\n`) }
    const speakText = async (text: string) => {
      await until(() => speaks(trace).some((item) => item.text === text), () => readFileSync(trace, 'utf8'))
      const spoken = speaks(trace).findLast((item) => item.text === text)
      assert.ok(spoken)
      return spoken
    }

    await until(() => listenModes(trace).includes('wake'), () => readFileSync(trace, 'utf8'))

    emit({ type: 'wake' })
    const greeting = await speakText('我在')
    assert.equal(greeting.text, '我在')
    assert.equal(page.some((message) => message.type === 'pin'), true)
    emit({ type: 'utterance', text: '这句话不该发送' })
    emit({ type: 'playback', id: greeting.id, phase: 'end' })
    await until(() => listenModes(trace).at(-1) === 'command')
    assert.equal(voice.listenMode(), 'command')
    assert.equal(page.some((message) => message.type === 'voice-prompt'), false)

    emit({ type: 'utterance', text: '查一下今天的天气' })
    await until(() => page.some((message) => message.type === 'voice-prompt' && message.text === '查一下今天的天气'))
    voice.beginTurn()
    assert.equal(voice.listenMode(), 'interject')
    voice.endTurn()
    await until(() => voice.listenMode() === 'command')

    emit({ type: 'utterance', text: '好的，你给我退下吧。' })
    await until(() => page.some((message) => message.type === 'unpin'))
    assert.equal(page.filter((message) => message.type === 'voice-prompt').length, 1)
    const goodbye = await speakText('好的，再见')
    assert.equal(goodbye.text, '好的，再见')
    emit({ type: 'playback', id: goodbye.id, phase: 'end' })
    await until(() => voice.listenMode() === 'wake')

    voice.setPinned(true)
    await until(() => voice.listenMode() === 'command')
    const prompts = page.filter((message) => message.type === 'voice-prompt').length
    const unpins = page.filter((message) => message.type === 'unpin').length
    now = 30_000
    voice.poll()
    assert.equal(page.filter((message) => message.type === 'unpin').length, unpins + 1)
    assert.equal(page.filter((message) => message.type === 'voice-prompt').length, prompts)

    voice.setPinned(true)
    voice.beginTurn()
    voice.setPinned(false)
    assert.equal(voice.listenMode(), 'interject')
    voice.endTurn()
    assert.equal(voice.listenMode(), 'wake')

    voice.beginTurn()
    voice.questionOpened()
    assert.equal(voice.listenMode(), 'off')
    assert.equal(voice.snapshot().queued.includes('我有几个问题，你来选一下'), true)
    assert.equal(voice.snapshot().hold, true)
    const prompt = await speakText('我有几个问题，你来选一下')
    assert.equal(prompt.text, '我有几个问题，你来选一下')
    voice.questionClosed()
    await until(() => traceOf(trace).some((item) => (item as { type?: string }).type === 'stop-speak'))
    emit({ type: 'playback', id: prompt.id, phase: 'end', stopped: true })
    await until(() => !voice.snapshot().queued.includes('我有几个问题，你来选一下'))

    voice.noteAssistant('block-1', '今天晴。')
    voice.endTurn()
    assert.equal(voice.snapshot().hold, true)
    voice.haltSpeech()
    assert.equal(voice.snapshot().hold, false)
    assert.deepEqual(voice.snapshot().queued, [])
    } finally {
      voice.close()
      child.kill()
    }
  })

  it('releases the microphone for a question card and restores the column that fits afterwards', async () => {
    const dir = join(root, 'question')
    const inject = join(dir, 'inject.ndjson')
    const trace = join(dir, 'trace.ndjson')
    mkdirSync(dir, { recursive: true })
    writeFileSync(inject, '')
    writeFileSync(trace, '')
    const settings = settingsWith()
    let asr = true
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, VOICE_INJECT: inject, VOICE_TRACE: trace },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr, tts: true }),
      now: () => 0,
      send() {},
      open: () => linkProcess(child),
    })
    const lastAfter = async (before: number, match: (item: { mode?: string, device?: boolean }) => boolean) => {
      await until(() => listens(trace).length > before && match(listens(trace).at(-1) ?? {}), () => readFileSync(trace, 'utf8'))
    }
    voice.start()
    try {
      await until(() => listenModes(trace).includes('wake'), () => readFileSync(trace, 'utf8'))
      voice.beginTurn()
      let mark = listens(trace).length
      voice.questionOpened()
      await lastAfter(mark, (item) => item.mode === 'off' && item.device === false)
      mark = listens(trace).length
      voice.questionClosed()
      await lastAfter(mark, (item) => item.mode === 'interject' && item.device === true)
      voice.endTurn()

      voice.setPinned(true)
      mark = listens(trace).length
      voice.questionOpened()
      await lastAfter(mark, (item) => item.mode === 'off' && item.device === false)
      mark = listens(trace).length
      voice.questionClosed()
      await lastAfter(mark, (item) => item.mode === 'command' && item.device === true)

      voice.setPinned(false)
      mark = listens(trace).length
      voice.questionOpened()
      await lastAfter(mark, (item) => item.mode === 'off' && item.device === false)
      mark = listens(trace).length
      voice.questionClosed()
      await lastAfter(mark, (item) => item.mode === 'wake' && item.device === true)

      settings.commandEnabled = false
      voice.applySettings()
      mark = listens(trace).length
      voice.setPinned(true)
      await lastAfter(mark, (item) => item.mode === 'off' && item.device === false)
      assert.equal(voice.listenMode(), 'off')
      assert.equal(voice.microphone(), null)

      // Nothing to restore after the card: the command column is off and wake cannot
      // run while pinned, so the device stays released.
      voice.questionOpened()
      assert.equal(voice.listenMode(), 'off')
      assert.equal(voice.microphone(), null)
      voice.questionClosed()
      assert.equal(voice.listenMode(), 'off')
      assert.equal(listens(trace).at(-1)?.device, false)

      asr = false
      settings.commandEnabled = true
      voice.setPinned(false)
      voice.applySettings()
      mark = listens(trace).length
      voice.questionOpened()
      await lastAfter(mark, (item) => item.mode === 'off' && item.device === false)
      mark = listens(trace).length
      voice.questionClosed()
      await lastAfter(mark, (item) => item.mode === 'wake' && item.device === true)
    } finally {
      voice.close()
      child.kill()
    }
  })
})

function settingsWith(patch: Partial<typeof DEFAULT_VOICE_SETTINGS> = {}): typeof DEFAULT_VOICE_SETTINGS {
  // Runtime tests start with the master switch on; the column switches exercise their own gates.
  return { ...DEFAULT_VOICE_SETTINGS, voiceEnabled: true, wakeWords: [...DEFAULT_VOICE_SETTINGS.wakeWords], dismissPhrases: [...DEFAULT_VOICE_SETTINGS.dismissPhrases], ...patch }
}

/** A link that never touches a microphone. `emit` is the child speaking; `die` is a crash. */
function fakeChild() {
  const sent: Record<string, unknown>[] = []
  let message: ((value: unknown) => void) | undefined
  const exits = new Set<() => void>()
  const link: VoiceLink = {
    send(value) { sent.push(value as Record<string, unknown>) },
    close() {},
    onMessage(handler) {
      message = handler
    },
    onExit(handler) { exits.add(handler) },
  }
  return {
    sent,
    link,
    emit(value: unknown) { message?.(value) },
    die() { for (const exit of exits) exit() },
  }
}

describe('voice lifecycle', () => {
  it('opens a new child after the ball was switched off and on', () => {
    const settings = settingsWith()
    const children = [fakeChild(), fakeChild()]
    let opened = 0
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => children[opened++]?.link,
    })
    voice.start()
    voice.close()
    voice.start()
    assert.equal(opened, 2)
    children[1]?.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'wake')
  })

  it('ignores the replaced link exiting after a fresh start', () => {
    const settings = settingsWith()
    const children = [fakeChild(), fakeChild()]
    let opened = 0
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => children[opened++]?.link,
    })
    voice.start()
    voice.close()
    voice.start()
    children[0]?.die()
    assert.equal(opened, 2)
    children[1]?.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'wake')
  })

  it('keeps the speech edge until the sentence ends, so the idle clock can run again', () => {
    const settings = settingsWith()
    const child = fakeChild()
    const page: VoicePageMessage[] = []
    let now = 0
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => now,
      send: (message) => { page.push(message) },
      open: () => child.link,
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.setPinned(true)
    assert.equal(voice.listenMode(), 'command')
    child.emit({ type: 'speech', open: true })
    voice.setPinned(false)
    assert.equal(voice.listenMode(), 'command', 'an open sentence stays in transcription')
    child.emit({ type: 'speech', open: false })
    assert.equal(voice.listenMode(), 'wake')
    now = 0
    voice.setPinned(true)
    now = 30_000
    voice.poll()
    assert.equal(page.some((message) => message.type === 'unpin'), true)
  })

  it('forwards the microphone level only while transcription is open', () => {
    const settings = settingsWith()
    const child = fakeChild()
    const page: VoicePageMessage[] = []
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send: (message) => { page.push(message) },
      open: () => child.link,
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.setPinned(true)
    assert.equal(page.some((message) => message.type === 'voice-mode' && message.mode === 'command'), true)
    child.emit({ type: 'level', value: 0.42 })
    assert.equal(page.some((message) => message.type === 'voice-level' && message.value === 0.42), true)
    child.emit({ type: 'level', value: 2 })
    assert.equal(page.some((message) => message.type === 'voice-level' && message.value === 1), true)
    voice.setPinned(false)
    const before = page.length
    child.emit({ type: 'level', value: 0.8 })
    assert.equal(page.slice(before).some((message) => message.type === 'voice-level' && message.value === 0.8), false)
    voice.beginTurn()
    assert.equal(voice.listenMode(), 'interject')
    child.emit({ type: 'level', value: 0.3 })
    assert.equal(page.some((message) => message.type === 'voice-level' && message.value === 0.3), true)
  })

  it('resumes the old turn when the hard interjection could not be started', () => {
    const settings = settingsWith()
    const child = fakeChild()
    const heard: string[] = []
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
      interject: (text) => { heard.push(text) },
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.setPinned(true)
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '旧任务。')
    child.emit({ type: 'utterance', text: '大肥鱼，新任务', mode: 'interject' })
    assert.deepEqual(heard, ['大肥鱼，新任务'])
    assert.equal(voice.listenMode(), 'off', 'the hard interjection waits for the old turn to stop')
    voice.resumeAfterInterjectFailure()
    assert.equal(voice.listenMode(), 'interject')
    voice.noteAssistant('b:1:0:0', '旧任务。继续。')
    assert.equal(child.sent.some((message) => message.type === 'speak' && message.text === '继续。'), true, 'the old turn speaks again after the failure')
    voice.close()
  })

  it('speaks the part of a settled message that rewrites the streamed text', () => {
    const settings = settingsWith()
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    voice.start()
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '今天晴')
    voice.noteAssistant('b:1:0:0', '今天多云。明天有雨。')
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && String(message.text).includes('多云')),
      true,
      'a settled rewrite must not be dropped just because it no longer starts with the stream',
    )
    voice.close()
  })

  it('drops the old queue and restarts after a crash, instead of holding the stop button', () => {
    const settings = settingsWith()
    const children = [fakeChild(), fakeChild()]
    let opened = 0
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => children[opened++]?.link,
    })
    voice.start()
    children[0]?.emit({ type: 'mic', open: true })
    voice.setPinned(true)
    voice.noteAssistant('closing', '今天晴。')
    voice.endTurn()
    assert.equal(voice.snapshot().hold, true)
    children[0]?.die()
    assert.equal(voice.snapshot().hold, false)
    assert.deepEqual(voice.snapshot().queued, [])
    assert.equal(opened, 2)
  })

  it('reports no microphone once both listening columns are off', () => {
    const settings = settingsWith({ wakeEnabled: false, commandEnabled: false, ttsEnabled: true })
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    assert.equal(voice.microphone(), null)
  })

  it('releases the device when voice input alone is enabled and the ball is collapsed', () => {
    const settings = settingsWith({ wakeEnabled: false })
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    const lastListen = () => child.sent.filter((item) => item.type === 'listen').at(-1) as { mode: string, device: boolean }
    voice.start()
    child.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'off', 'voice input only runs while pinned')
    assert.equal(lastListen().mode, 'off')
    assert.equal(lastListen().device, false, 'a collapsed command-only ball must release the microphone')
    assert.equal(voice.microphone(), null, 'an intentionally released device is not a failure')

    voice.setPinned(true)
    assert.equal(voice.listenMode(), 'command')
    assert.equal(lastListen().mode, 'command')
    assert.equal(lastListen().device, true)
    assert.equal(voice.microphone(), true)

    voice.setPinned(false)
    assert.equal(voice.listenMode(), 'off')
    assert.equal(lastListen().mode, 'off')
    assert.equal(lastListen().device, false)
    assert.equal(voice.microphone(), null)

    // A turn still needs the device for interjection, even while collapsed.
    voice.beginTurn()
    assert.equal(voice.listenMode(), 'interject')
    assert.equal(lastListen().mode, 'interject')
    assert.equal(lastListen().device, true)
    voice.endTurn()
    assert.equal(voice.listenMode(), 'off')
    assert.equal(lastListen().device, false)
    voice.close()
  })

  it('releases the device when wake alone is enabled and the ball is pinned', () => {
    const settings = settingsWith({ commandEnabled: false })
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    const lastListen = () => child.sent.filter((item) => item.type === 'listen').at(-1) as { mode: string, device: boolean }
    voice.start()
    child.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'wake')
    assert.equal(lastListen().mode, 'wake')
    assert.equal(lastListen().device, true)
    assert.equal(voice.microphone(), true)

    voice.setPinned(true)
    assert.equal(voice.listenMode(), 'off', 'wake only runs while collapsed')
    assert.equal(lastListen().mode, 'off')
    assert.equal(lastListen().device, false, 'a pinned wake-only ball must release the microphone')
    assert.equal(voice.microphone(), null)

    voice.setPinned(false)
    assert.equal(voice.listenMode(), 'wake')
    assert.equal(lastListen().mode, 'wake')
    assert.equal(lastListen().device, true)
    assert.equal(voice.microphone(), true)
    voice.close()
  })

  it('treats an empty wake list as no wake word', () => {
    const settings = settingsWith({ wakeWords: [] })
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'off')
  })

  it('keeps every voice column off behind the master switch, and restores them together', () => {
    const settings = settingsWith({ voiceEnabled: false })
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    voice.start()
    child.emit({ type: 'mic', open: true })
    assert.equal(voice.listenMode(), 'off')
    assert.equal(voice.microphone(), null, 'no listening column holds the device')
    const configure = child.sent.filter((item) => item.type === 'configure').at(-1) as { settings: typeof settings }
    assert.equal(configure.settings.voiceEnabled, false)
    assert.equal(configure.settings.wakeEnabled, false, 'the child is told the wake column is off')
    assert.equal(configure.settings.commandEnabled, false)
    assert.equal(configure.settings.ttsEnabled, false)
    const listen = child.sent.filter((item) => item.type === 'listen').at(-1) as { mode: string, device: boolean }
    assert.equal(listen.mode, 'off')
    assert.equal(listen.device, false)

    voice.noteAssistant('b:1:0:0', '这句话不应该播报。')
    assert.deepEqual(child.sent.filter((item) => item.type === 'speak'), [])

    settings.voiceEnabled = true
    voice.applySettings()
    assert.equal(voice.listenMode(), 'wake')
    assert.equal(voice.microphone(), true)
    const restored = child.sent.filter((item) => item.type === 'configure').at(-1) as { settings: typeof settings }
    assert.equal(restored.settings.wakeEnabled, true)
    assert.equal(restored.settings.commandEnabled, true)
    assert.equal(restored.settings.ttsEnabled, true, 'the stored column choices come back')
    voice.noteAssistant('b:1:0:1', '现在可以播报了。')
    assert.equal(child.sent.filter((item) => item.type === 'speak').length, 1)

    settings.voiceEnabled = false
    voice.applySettings()
    assert.equal(voice.listenMode(), 'off')
    assert.equal(voice.microphone(), null)
    assert.equal(child.sent.some((item) => item.type === 'stop-speak'), true, 'the playing sentence is stopped')
    assert.deepEqual(voice.snapshot().queued, [])
    voice.close()
  })

  it('keeps the idle unpin clock running with the master switch off', () => {
    const settings = settingsWith({ voiceEnabled: false })
    const child = fakeChild()
    const page: VoicePageMessage[] = []
    let now = 0
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => now,
      send: (message) => { page.push(message) },
      open: () => child.link,
    })
    voice.start()
    voice.setPinned(true)
    now = 30_000
    voice.poll()
    assert.equal(page.some((message) => message.type === 'unpin'), true)
    voice.close()
  })
})

describe('utterance judging', () => {
  it('follows the listen mode from when the sentence started', async () => {
    const dir = join(root, 'judge')
    const inject = join(dir, 'inject.ndjson')
    const trace = join(dir, 'trace.ndjson')
    mkdirSync(dir, { recursive: true })
    writeFileSync(inject, '')
    writeFileSync(trace, '')
    const page: VoicePageMessage[] = []
    const heard: string[] = []
    let stops = 0
    const settings = settingsWith()
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, VOICE_INJECT: inject, VOICE_TRACE: trace },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send: (message) => { page.push(message) },
      open: () => linkProcess(child),
      interject: (text) => { heard.push(text) },
      stopTurn: () => { stops += 1 },
    })
    const emit = (message: unknown) => { appendFileSync(inject, `${JSON.stringify(message)}\n`) }
    const prompts = () => page.filter((message) => message.type === 'voice-prompt')
    const speakText = async (text: string) => {
      await until(() => speaks(trace).some((item) => item.text === text), () => readFileSync(trace, 'utf8'))
      const spoken = speaks(trace).findLast((item) => item.text === text)
      assert.ok(spoken)
      return spoken
    }
    voice.start()
    try {
      await until(() => listenModes(trace).includes('wake'), () => readFileSync(trace, 'utf8'))
      emit({ type: 'wake' })
      const greeting = await speakText('我在')
      emit({ type: 'playback', id: greeting.id, phase: 'end' })
      await until(() => {
        const last = listens(trace).at(-1)
        return last?.mode === 'command' && last.device === true
      }, () => readFileSync(trace, 'utf8'))

      emit({ type: 'utterance', text: '查一下今天的天气', mode: 'command' })
      await until(() => prompts().some((message) => message.text === '查一下今天的天气'))
      voice.beginTurn()
      assert.equal(page.some((message) => message.type === 'voice-mode' && message.mode === 'interject'), true)
      await until(() => {
        const last = listens(trace).at(-1)
        return last?.mode === 'interject' && !(last.seedMs && last.seedMs > 0)
      }, () => readFileSync(trace, 'utf8'))

      voice.noteAssistant('b:1:0:0', '我去查一下今天的天气。')
      await speakText('我去查一下今天的天气。')
      const promptsBeforeAside = prompts().length
      const heardBeforeAside = heard.length
      emit({ type: 'utterance', text: '等一下', mode: 'interject' })
      emit({ type: 'level', value: 0.11 })
      await until(() => page.some((message) => message.type === 'voice-level' && message.value === 0.11))
      assert.equal(prompts().length, promptsBeforeAside)
      assert.equal(heard.length, heardBeforeAside)

      voice.noteAssistant('b:1:0:0', '我去查一下今天的天气。明天')
      emit({ type: 'utterance', text: '大肥鱼，把明天的也查一下', mode: 'interject' })
      await until(() => heard.at(-1) === '大肥鱼，把明天的也查一下')
      await until(() => traceOf(trace).some((item) => (item as { type?: string }).type === 'stop-speak'), () => readFileSync(trace, 'utf8'))
      // The interjection now hard-stops the old turn: the old step is silent and the
      // microphone waits until the orb starts the new task.
      assert.equal(voice.listenMode(), 'off')
      const speaksBeforeSilence = speaks(trace).length
      voice.noteAssistant('b:1:0:0', '我去查一下今天的天气。明天会下雨。后天晴。')
      voice.noteAssistant('b:1:0:2', '我先查一下。')
      assert.equal(speaks(trace).length, speaksBeforeSilence)
      voice.endTurn()
      assert.equal(voice.listenMode(), 'command')
      voice.beginTurn()
      assert.equal(voice.listenMode(), 'interject')
      voice.noteAssistant('b:2:0:0', '明天多云。')
      await speakText('明天多云。')

      voice.questionOpened()
      await until(() => {
        const last = listens(trace).at(-1)
        return last?.mode === 'off' && last.device === false
      }, () => readFileSync(trace, 'utf8'))
      voice.questionClosed()
      await until(() => {
        const last = listens(trace).at(-1)
        return last?.mode === 'interject' && last.device === true && last.seedMs === 0
      }, () => readFileSync(trace, 'utf8'))

      const stopsBefore = stops
      const heardBeforeDismiss = heard.length
      emit({ type: 'utterance', text: '大肥鱼退下吧', mode: 'interject' })
      await until(() => page.some((message) => message.type === 'unpin') && stops === stopsBefore + 1)
      assert.equal(heard.length, heardBeforeDismiss)
      const goodbye = await speakText('好的，再见')
      const lines = traceOf(trace) as { type?: string, text?: string }[]
      const goodbyeAt = lines.findIndex((item) => item.type === 'speak' && item.text === '好的，再见')
      const stopAt = lines.findLastIndex((item, index) => index < goodbyeAt && item.type === 'stop-speak')
      assert.ok(stopAt >= 0 && stopAt < goodbyeAt)
      assert.equal(voice.listenMode(), 'off')
      emit({ type: 'playback', id: goodbye.id, phase: 'end' })
      await until(() => !voice.snapshot().queued.includes('好的，再见'))
      assert.equal(voice.listenMode(), 'off')
      voice.endTurn()
      assert.equal(voice.listenMode(), 'wake')

      voice.beginTurn()
      voice.noteAssistant('b:3:0:0', '今天晴。')
      voice.endTurn()
      await speakText('今天晴。')
      assert.equal(voice.listenMode(), 'interject')
      emit({ type: 'utterance', text: '大肥鱼，再查一次', mode: 'interject' })
      await until(() => heard.at(-1) === '大肥鱼，再查一次')
      await until(() => {
        const again = traceOf(trace) as { type?: string }[]
        return again.filter((item) => item.type === 'stop-speak').length >= 2
      }, () => readFileSync(trace, 'utf8'))

      voice.beginTurn()
      voice.noteAssistant('b:4:0:0', '后天也晴。')
      voice.endTurn()
      await speakText('后天也晴。')
      assert.equal(voice.snapshot().pinned, false)
      assert.equal(voice.listenMode(), 'interject')
      emit({ type: 'speech', open: true })
      emit({ type: 'playback', id: speaks(trace).findLast((item) => item.text === '后天也晴。')?.id, phase: 'end' })
      await until(() => page.some((message) => message.type === 'voice-hold' && message.hold === false))
      assert.equal(voice.listenMode(), 'interject')
      assert.equal(listens(trace).at(-1)?.mode, 'interject')
      emit({ type: 'speech', open: false })
      await until(() => listens(trace).at(-1)?.mode === 'wake', () => readFileSync(trace, 'utf8'))
      emit({ type: 'utterance', text: '大肥鱼，再查一次', mode: 'interject' })
      await until(() => heard.filter((text) => text === '大肥鱼，再查一次').length >= 2)

      voice.setPinned(true)
      voice.beginTurn()
      voice.noteAssistant('b:5:0:0', '大后天晴。')
      voice.endTurn()
      const pinnedClosing = await speakText('大后天晴。')
      assert.equal(voice.listenMode(), 'interject')
      const promptsBeforeDrop = prompts().length
      const heardBeforeDrop = heard.length
      emit({ type: 'speech', open: true })
      emit({ type: 'playback', id: pinnedClosing.id, phase: 'end' })
      await until(() => !voice.snapshot().queued.includes('大后天晴。'))
      assert.equal(voice.listenMode(), 'command')
      emit({ type: 'speech', open: false })
      await until(() => voice.listenMode() === 'command')
      emit({ type: 'utterance', text: '等一下', mode: 'interject' })
      emit({ type: 'level', value: 0.12 })
      await until(() => page.some((message) => message.type === 'voice-level' && message.value === 0.12))
      assert.equal(prompts().length, promptsBeforeDrop)
      assert.equal(heard.length, heardBeforeDrop)

      settings.interjectKeyword = ''
      voice.applySettings()
      voice.beginTurn()
      assert.equal(voice.listenMode(), 'off')
      settings.interjectKeyword = '，。'
      voice.applySettings()
      assert.equal(voice.listenMode(), 'off')
    } finally {
      voice.close()
      child.kill()
    }

    const quietDir = join(root, 'no-aec')
    const quietInject = join(quietDir, 'inject.ndjson')
    const quietTrace = join(quietDir, 'trace.ndjson')
    mkdirSync(quietDir, { recursive: true })
    writeFileSync(quietInject, '')
    writeFileSync(quietTrace, '')
    const quietChild = spawn(process.execPath, [script], {
      env: { ...process.env, VOICE_INJECT: quietInject, VOICE_TRACE: quietTrace, VOICE_AEC: '0' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const quiet = new VoiceController({
      settings: () => settingsWith(),
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => linkProcess(quietChild),
    })
    quiet.start()
    try {
      await until(() => listenModes(quietTrace).includes('wake'), () => readFileSync(quietTrace, 'utf8'))
      quiet.beginTurn()
      assert.equal(quiet.listenMode(), 'interject')
      quiet.noteAssistant('b:5:0:0', '今天晴。')
      quiet.endTurn()
      await until(() => speaks(quietTrace).some((item) => item.text === '今天晴。'), () => readFileSync(quietTrace, 'utf8'))
      assert.equal(quiet.listenMode(), 'interject', 'body audio keeps listening without VPIO; echo.ts filters our own voice')
    } finally {
      quiet.close()
      quietChild.kill()
    }

    const children = [fakeChild(), fakeChild()]
    let opened = 0
    let halted: VoiceController
    halted = new VoiceController({
      settings: () => settingsWith(),
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => {
        const next = children[opened++]
        if (opened === 2) halted.haltSpeech()
        return next?.link
      },
    })
    halted.start()
    children[0]?.emit({ type: 'mic', open: true })
    halted.setPinned(true)
    halted.beginTurn()
    halted.haltSpeech()
    assert.equal(halted.listenMode(), 'off')
    const speaksBefore = children[0]?.sent.filter((item) => item.type === 'speak').length ?? 0
    halted.noteAssistant('b:9:0:0', '今天晴。')
    assert.equal(children[0]?.sent.filter((item) => item.type === 'speak').length, speaksBefore)
    halted.endTurn()
    assert.equal(children[0]?.sent.filter((item) => item.type === 'speak').length, speaksBefore)
    assert.equal(halted.listenMode(), 'command')
    halted.beginTurn()
    halted.noteAssistant('b:9:1:0', '明天多云。')
    assert.equal(children[0]?.sent.some((item) => item.type === 'speak' && item.text === '明天多云。'), true)
    children[0]?.die()
    assert.equal(opened, 2)
    children[1]?.emit({ type: 'mic', open: true })
    halted.noteAssistant('b:9:2:0', '后天晴。')
    assert.equal(children[1]?.sent.some((item) => item.type === 'speak'), false)
  })
})

describe('new turn speech reset', () => {
  function controller(child: ReturnType<typeof fakeChild>): VoiceController {
    const settings = settingsWith()
    return new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
    })
  }

  it('stops the speaker on a barge and interjects the flagged command without the keyword', () => {
    const settings = settingsWith()
    const child = fakeChild()
    const heard: string[] = []
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => ({ wake: true, asr: true, tts: true }),
      now: () => 0,
      send() {},
      open: () => child.link,
      interject: (text) => { heard.push(text) },
    })
    voice.start()
    child.emit({ type: 'mic', open: true, aec: true })
    child.emit({ type: 'speech', open: true })
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '正在播报。')
    voice.endTurn()
    assert.equal(child.sent.some((message) => message.type === 'speak' && message.text === '正在播报。'), true)

    child.emit({ type: 'barge', keyword: '大肥鱼' })
    assert.equal(child.sent.some((message) => message.type === 'stop-speak'), true, 'the speaker stops on the barge edge')
    voice.noteAssistant('b:1:0:1', '这段不能在命令前重新播出来。')
    assert.equal(child.sent.some((message) => message.type === 'speak' && message.text.includes('命令前')), false, 'barge mutes the rest of the turn until the command arrives')

    child.emit({ type: 'utterance', text: '打开插画', mode: 'interject', interject: true })
    assert.deepEqual(heard, ['打开插画'])
    voice.close()
  })

  it('stops the previous closing and speaks the new turn first sentence', () => {
    const child = fakeChild()
    const voice = controller(child)
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '旧结果。')
    voice.endTurn()
    const old = child.sent.find((message) => message.type === 'speak')
    assert.ok(old)

    voice.beginTurn()
    assert.deepEqual(voice.snapshot().queued, [])
    assert.equal(child.sent.some((message) => message.type === 'stop-speak' && message.id === old.id), true)

    voice.noteAssistant('b:2:0:0', '新任务第一句。')
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '新任务第一句。'),
      true,
    )
    voice.close()
  })

  it('drops the previous block held during playback and plays the next block', () => {
    const child = fakeChild()
    const voice = controller(child)
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '第一句。')
    const first = child.sent.find((message) => message.type === 'speak')
    assert.ok(first)
    voice.noteAssistant('b:1:1:0', '播报期间的途中句。')
    child.emit({ type: 'playback', id: first.id, phase: 'end' })

    voice.noteAssistant('b:1:2:0', '网页能访问。')
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '网页能访问。'),
      true,
    )
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '播报期间的途中句。'),
      false,
    )
    voice.close()
  })

  it('keeps the final block tail when an older block settles late', () => {
    const child = fakeChild()
    const voice = controller(child)
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.beginTurn()
    voice.noteAssistant('b:2:3:1', '第一句。')
    const first = child.sent.find((message) => message.type === 'speak')
    assert.ok(first)

    // Settled blocks can arrive out of order at turn end. The older block must not clear
    // the newest block's held tail.
    voice.noteAssistant('b:2:3:1', '第一句。剩余的收尾。')
    voice.noteAssistant('b:2:2:1', '旧块。')
    voice.noteAssistant('b:2:3:1', '第一句。剩余的收尾。')
    voice.endTurn()
    child.emit({ type: 'playback', id: first.id, phase: 'end' })

    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '剩余的收尾。'),
      true,
    )
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '旧块。'),
      false,
    )
    voice.close()
  })

  it('mutes the old turn and ignores its late key after the new turn starts', () => {
    const child = fakeChild()
    const voice = controller(child)
    voice.start()
    child.emit({ type: 'mic', open: true })
    voice.beginTurn()
    voice.noteAssistant('b:1:0:0', '旧结果。')
    voice.endTurn()

    voice.prepareNewTurn()
    const speaksBefore = child.sent.filter((message) => message.type === 'speak').length
    voice.noteAssistant('b:1:0:0', '旧结果。晚到。')
    assert.equal(child.sent.filter((message) => message.type === 'speak').length, speaksBefore)

    voice.beginTurn()
    voice.noteAssistant('b:2:0:0', '新第一句。')
    voice.noteAssistant('b:1:0:0', '旧结果。更晚到。')
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && message.text === '新第一句。'),
      true,
    )
    assert.equal(
      child.sent.some((message) => message.type === 'speak' && String(message.text).includes('更晚到')),
      false,
    )
    voice.close()
  })
})

describe('qwen speech readiness', () => {
  const ttsSpeaks = (child: ReturnType<typeof fakeChild>) =>
    child.sent.filter((item) => item.type === 'speak')

  function controller(
    settings: typeof DEFAULT_VOICE_SETTINGS,
    presence: { wake: boolean, asr: boolean, tts: boolean },
  ) {
    const child = fakeChild()
    const voice = new VoiceController({
      settings: () => settings,
      presence: () => presence,
      now: () => 0,
      send() {},
      open: () => child.link,
    })
    voice.start()
    return { child, voice }
  }

  it('speaks through qwen without the local files', () => {
    const settings = settingsWith({ ttsBackend: 'qwen', qwenApiKey: 'sk-test' })
    const { child, voice } = controller(settings, { wake: false, asr: false, tts: false })
    voice.noteAssistant('b:1:0:0', '今天晴。')
    const spoken = ttsSpeaks(child)
    assert.equal(spoken.length, 1)
    assert.equal(spoken[0]?.text, '今天晴。')
    voice.close()
  })

  it('treats a blank qwen key as speech off', () => {
    const settings = settingsWith({ ttsBackend: 'qwen', qwenApiKey: '   ' })
    const { child, voice } = controller(settings, { wake: false, asr: false, tts: true })
    voice.noteAssistant('b:1:0:0', '今天晴。')
    voice.endTurn()
    assert.deepEqual(ttsSpeaks(child), [])
    voice.close()
  })

  it('keeps the local column on the downloaded files', () => {
    const settings = settingsWith({ ttsBackend: 'local', qwenApiKey: 'sk-test' })
    const { child, voice } = controller(settings, { wake: false, asr: false, tts: false })
    voice.noteAssistant('b:1:0:0', '今天晴。')
    assert.deepEqual(ttsSpeaks(child), [])
    voice.close()
  })

  it('starts using qwen as soon as the key is filled', () => {
    const settings = settingsWith({ ttsBackend: 'qwen', qwenApiKey: '' })
    const { child, voice } = controller(settings, { wake: false, asr: false, tts: false })
    voice.noteAssistant('b:1:0:0', '今天晴。')
    assert.deepEqual(ttsSpeaks(child), [])
    settings.qwenApiKey = 'sk-test'
    voice.applySettings()
    voice.noteAssistant('b:1:0:1', '明天多云。')
    assert.equal(ttsSpeaks(child).some((item) => item.text === '明天多云。'), true)
    voice.close()
  })

  it('uses qwen for the wake reply and the question prompt', () => {
    const settings = settingsWith({ ttsBackend: 'qwen', qwenApiKey: 'sk-test' })
    const { child, voice } = controller(settings, { wake: true, asr: true, tts: false })
    child.emit({ type: 'mic', open: true })
    child.emit({ type: 'wake' })
    const reply = ttsSpeaks(child).find((item) => item.text === '我在')
    assert.ok(reply)
    child.emit({ type: 'playback', id: reply.id, phase: 'end' })
    voice.questionOpened()
    assert.equal(ttsSpeaks(child).some((item) => item.text === '我有几个问题，你来选一下'), true)
    voice.close()
  })

  it('stops the sentence when the key stops being ready', () => {
    const settings = settingsWith({ ttsBackend: 'qwen', qwenApiKey: 'sk-test' })
    const { child, voice } = controller(settings, { wake: false, asr: false, tts: false })
    voice.noteAssistant('b:1:0:0', '今天晴。')
    assert.equal(ttsSpeaks(child).length, 1)
    settings.qwenApiKey = '  '
    voice.applySettings()
    assert.equal(child.sent.some((item) => item.type === 'stop-speak'), true)
    voice.close()
  })
})

