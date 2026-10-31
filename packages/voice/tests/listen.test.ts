import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { holdsDevice, listenMode, needsMicrophone, transcribing, wantsNativeCapture, type ListenInput, type ListenMode } from '../src/listen.ts'

const ready: ListenInput = {
  pinned: false,
  agentBusy: false,
  questionOpen: false,
  bodyBusy: false,
  localBusy: false,
  stopping: false,
  wakeEnabled: true,
  commandEnabled: true,
  interjectEnabled: true,
  echoCancel: true,
  micOpen: true,
}

const mic = {
  wakeEnabled: true,
  wakeWords: ['你好大肥鱼'],
  wakeModel: true,
  commandEnabled: true,
  asrModel: true,
  questionOpen: false,
}

const device = {
  ...mic,
  pinned: false,
  agentBusy: false,
  bodyBusy: false,
  interjectEnabled: true,
  echoCancel: true,
}

function mode(patch: Partial<ListenInput>): ListenMode {
  return listenMode({ ...ready, ...patch })
}

describe('listen mode', () => {
  it('covers the four listening states', () => {
    assert.equal(mode({ pinned: false }), 'wake', 'unpinned and idle listens for the wake word')
    assert.equal(mode({ pinned: true }), 'command', 'pinned and idle listens for a command')
    assert.equal(mode({ pinned: false, agentBusy: true }), 'interject')
    assert.equal(mode({ pinned: true, agentBusy: true }), 'interject', 'a busy agent does not look at the pin')
    assert.equal(mode({ bodyBusy: true }), 'interject', 'a closing line playing or still queued')
    assert.equal(mode({ pinned: true, bodyBusy: true }), 'interject')
    assert.equal(mode({ agentBusy: true, interjectEnabled: false }), 'off', 'an empty interject keyword')
    assert.equal(mode({ agentBusy: true, commandEnabled: false, interjectEnabled: false }), 'off', 'voice input is off')
    assert.equal(mode({ bodyBusy: true, echoCancel: false }), 'off')
    assert.equal(mode({ agentBusy: true, echoCancel: false }), 'interject', 'execution without body audio still listens')
    assert.equal(mode({ agentBusy: true, bodyBusy: true, questionOpen: true, localBusy: true }), 'off')
    assert.equal(holdsDevice({ ...device, questionOpen: true }), false)
    assert.equal(mode({ localBusy: true }), 'off', 'a wake or dismiss reply is playing')
    assert.equal(mode({ agentBusy: true, stopping: true }), 'off')
    assert.equal(holdsDevice(device), true, 'stopping does not release the microphone')
    assert.equal(mode({ micOpen: false }), 'off')
    assert.equal(mode({ pinned: true, micOpen: false }), 'off')
  })

  it('treats command and interject as transcription, and the other two as not', () => {
    assert.equal(transcribing('command'), true)
    assert.equal(transcribing('interject'), true)
    assert.equal(transcribing('wake'), false)
    assert.equal(transcribing('off'), false)
  })

  it('shuts the microphone entirely while a translation streams', () => {
    // The ball is pinned for a translation, which would otherwise read as `command`, and an
    // agent-busy flag would read as `interject`: both keep the microphone open. A translation
    // wants neither, so it must win before either branch is reached.
    assert.equal(mode({ pinned: true, translationBusy: true }), 'off')
    assert.equal(mode({ pinned: false, translationBusy: true }), 'off')
    assert.equal(mode({ agentBusy: true, translationBusy: true }), 'off')
    assert.equal(mode({ pinned: true, bodyBusy: true, translationBusy: true }), 'off')
    // And the device is released, so macOS drops its microphone indicator for the duration.
    assert.equal(holdsDevice({ ...device, pinned: true, translationBusy: true }), false)
    assert.equal(holdsDevice({ ...device, agentBusy: true, translationBusy: true }), false)
    // Once it ends the ordinary rules apply again.
    assert.equal(mode({ pinned: true, translationBusy: false }), 'command')
  })

  it('listens for the wake word only once a translation has settled', () => {
    // The answer stays on a pinned ball, but a translation is not a conversation: the
    // command decoder waits for the user to start one on purpose.
    assert.equal(mode({ pinned: true, translationQuiet: true }), 'wake', 'a pinned ball does not take commands')
    assert.equal(mode({ pinned: false, translationQuiet: true }), 'wake')
    // A command-only setup has no way back in until the ball is unpinned and pinned again.
    assert.equal(mode({ pinned: true, translationQuiet: true, wakeEnabled: false }), 'off')
    // The streaming state still wins: mid-translation there is nothing to listen for.
    assert.equal(mode({ pinned: true, translationBusy: true, translationQuiet: true }), 'off')
    // A real turn takes over from the quiet, because that is the user talking again.
    assert.equal(mode({ pinned: true, translationQuiet: true, agentBusy: true }), 'interject')
  })

  it('holds the device for the wake word alone while a translation is settled', () => {
    // The command column is not listening, so the system microphone indicator must not go
    // on for it: only the wake column may keep the device.
    assert.equal(holdsDevice({ ...device, pinned: true, translationQuiet: true }), true, 'both columns ready: wake still holds it')
    assert.equal(
      holdsDevice({ ...device, pinned: true, translationQuiet: true, commandEnabled: false }),
      true,
      'wake alone still holds it while pinned, unlike the ordinary pinned rule',
    )
    assert.equal(
      holdsDevice({ ...device, translationQuiet: true, wakeEnabled: false }),
      false,
      'voice input alone releases it, because it cannot be reached',
    )
    assert.equal(
      holdsDevice({ ...device, pinned: false, translationQuiet: true }),
      true,
      'collapsed behaves like the ordinary collapsed rule',
    )
  })

  it('drops only the column whose switch is off', () => {
    assert.equal(mode({ pinned: false, wakeEnabled: false }), 'off')
    assert.equal(mode({ pinned: true, wakeEnabled: false }), 'command', 'wake off still allows commands once pinned')
    assert.equal(mode({ pinned: true, commandEnabled: false, interjectEnabled: false }), 'off')
    assert.equal(mode({ pinned: false, commandEnabled: false, interjectEnabled: false }), 'wake', 'command off still allows the wake word')
    assert.equal(mode({ pinned: false, wakeEnabled: false, commandEnabled: false, interjectEnabled: false }), 'off')
    assert.equal(mode({ pinned: true, wakeEnabled: false, commandEnabled: false, interjectEnabled: false }), 'off')
  })

  it('keeps listening when TTS is off, because body audio never becomes busy', () => {
    assert.equal(mode({ pinned: false, bodyBusy: false }), 'wake')
    assert.equal(mode({ pinned: true, bodyBusy: false }), 'command')
  })

  it('holds the microphone only for a listening column that can actually run', () => {
    const base = { wakeEnabled: true, wakeWords: ['你好大肥鱼'], wakeModel: true, commandEnabled: true, asrModel: true }
    assert.equal(needsMicrophone(base), true)
    assert.equal(needsMicrophone({ ...base, wakeEnabled: false }), true, 'voice input still runs')
    assert.equal(needsMicrophone({ ...base, commandEnabled: false }), true, 'wake still runs')
    assert.equal(needsMicrophone({ ...base, wakeEnabled: false, commandEnabled: false }), false)
    assert.equal(needsMicrophone({ ...base, wakeWords: [] }), true, 'command still needs the mic')
    assert.equal(needsMicrophone({ ...base, commandEnabled: false, wakeWords: [] }), false)
    assert.equal(needsMicrophone({ ...base, commandEnabled: false, wakeModel: false }), false)
    assert.equal(needsMicrophone({ ...base, wakeEnabled: false, asrModel: false }), false)
    assert.equal(holdsDevice(device), true, 'both columns on, collapsed')
    assert.equal(holdsDevice({ ...device, pinned: true }), true, 'both columns on, pinned')
    assert.equal(holdsDevice({ ...device, questionOpen: true }), false)
    assert.equal(holdsDevice({ ...device, wakeEnabled: false, commandEnabled: false }), false)
  })

  it('releases the device when the pin state cannot reach the only enabled column', () => {
    assert.equal(holdsDevice({ ...device, wakeEnabled: false }), false, 'voice input alone is released while collapsed')
    assert.equal(holdsDevice({ ...device, wakeEnabled: false, pinned: true }), true, 'voice input alone holds the mic while pinned')
    assert.equal(holdsDevice({ ...device, commandEnabled: false }), true, 'wake alone holds the mic while collapsed')
    assert.equal(holdsDevice({ ...device, commandEnabled: false, pinned: true }), false, 'wake alone is released while pinned')
  })

  it('keeps the device for interjection and drops it when no decoder can run', () => {
    assert.equal(holdsDevice({ ...device, agentBusy: true }), true, 'a busy turn keeps listening for interjection even collapsed')
    assert.equal(holdsDevice({ ...device, agentBusy: true, wakeEnabled: false }), true, 'command alone still holds during a turn')
    assert.equal(holdsDevice({ ...device, bodyBusy: true }), true, 'body audio with echo cancellation keeps listening')
    assert.equal(holdsDevice({ ...device, bodyBusy: true, echoCancel: false }), false, 'no echo cancellation means no body-audio listening')
    assert.equal(holdsDevice({ ...device, agentBusy: true, interjectEnabled: false }), false, 'no interject keyword means no listening')
    assert.equal(holdsDevice({ ...device, agentBusy: true, commandEnabled: false }), false, 'wake cannot interject')
  })

  it('starts the native echo canceller only while transcription is on', () => {
    assert.equal(wantsNativeCapture('wake', false, true), false, 'wake has no ASR and must not duck the system')
    assert.equal(wantsNativeCapture('off', false, true), false)
    assert.equal(wantsNativeCapture('command', false, true), true, 'the pinned panel is the ASR-on state')
    assert.equal(wantsNativeCapture('interject', false, true), true, 'a running turn keeps the panel open')
    assert.equal(wantsNativeCapture('command', true, true), false, 'the fallback stays on plain capture')
    assert.equal(wantsNativeCapture('command', false, false), false, 'no helper means no native capture')
  })
})
