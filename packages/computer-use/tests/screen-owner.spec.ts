import { afterEach, describe, expect, it } from 'vitest'
import { backgroundPolicyFor, POLICY, policyFor } from '../src/policy.ts'
import {
  BALL_PRESET,
  NOT_SCREEN_OWNER_MESSAGE,
  desktopToolDenial,
  isDesktopTool,
  presetOf,
  screenOwnerState,
  setScreenOwner,
} from '../src/screen-owner.ts'

afterEach(() => {
  // The record is process-global; a test must not decide the next one's owner.
  screenOwnerState().ownerId = ''
  screenOwnerState().ballSessions = undefined
})

describe('desktop tool gate', () => {
  it('leaves every session unrestricted while no owner is published', () => {
    // `dsh web`, the CLI, and a ball that is switched off all run without an owner.
    expect(desktopToolDenial('session-b', 'click', BALL_PRESET)).toBeUndefined()
    expect(desktopToolDenial('session-b', 'bash', BALL_PRESET)).toBeUndefined()
  })

  it('admits the owner and refuses every other ball conversation on the desktop tools', () => {
    setScreenOwner('session-a')
    expect(desktopToolDenial('session-a', 'click', BALL_PRESET)).toBeUndefined()
    expect(desktopToolDenial('session-a', 'bash', BALL_PRESET)).toBeUndefined()
    expect(desktopToolDenial('session-b', 'click', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
    expect(desktopToolDenial('session-b', 'bash', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
  })

  /**
   * The scope of the gate is the whole point of it. An earlier revision gated every session that was
   * not the displayed one, which took the shell away from the main window's own chats and from the
   * Code sessions the ball delegates to — the agent's own conversation could not run a command.
   */
  it('never touches a session that is not a ball conversation', () => {
    setScreenOwner('session-a')
    for (const preset of ['standard', 'chat', 'computer-use-extra', '', undefined]) {
      expect(desktopToolDenial('session-b', 'bash', preset)).toBeUndefined()
      expect(desktopToolDenial('session-b', 'click', preset)).toBeUndefined()
    }
    // A main-window chat is not the owner and still keeps everything.
    expect(desktopToolDenial('main-window-chat', 'bash', 'standard')).toBeUndefined()
    // The delegated Code session the ball itself started keeps its shell — it has work to do.
    expect(desktopToolDenial('delegated-code-session', 'bash', 'standard')).toBeUndefined()
    // Only the ball's own background conversation is gated.
    expect(desktopToolDenial('other-ball-chat', 'bash', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
  })

  it('keeps the coordination tools a background ball conversation still needs', () => {
    setScreenOwner('session-a')
    for (const name of ['web_search', 'web_fetch', 'ask_user_question', 'code_agent', 'code_agent_status', 'code_agent_stop']) {
      expect(desktopToolDenial('session-b', name, BALL_PRESET)).toBeUndefined()
      expect(isDesktopTool(name)).toBe(false)
    }
  })

  it('names every tool that reaches the screen, the clipboard, or the shell', () => {
    for (const name of [
      'click', 'input_text', 'scroll', 'hotkey', 'wait', 'long_wait', 'screenshot',
      'long_press', 'drag', 'open_in_browser', 'open_in_finder', 'list_apps', 'open_app',
      'bash', 'pwsh',
    ]) {
      expect(isDesktopTool(name)).toBe(true)
    }
  })

  it('leaves an agentless internal dispatch alone rather than deadlocking the pipeline', () => {
    setScreenOwner('session-a')
    expect(desktopToolDenial(undefined, 'click', BALL_PRESET)).toBeUndefined()
  })

  it('lifts the restriction when the owner is cleared', () => {
    setScreenOwner('session-a')
    expect(desktopToolDenial('session-b', 'click', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
    setScreenOwner(undefined)
    expect(desktopToolDenial('session-b', 'click', BALL_PRESET)).toBeUndefined()
  })

  /**
   * The preset is a capability declaration, not an identity. A main-window chat may run the
   * computer-use preset on purpose, and it used to lose its shell the moment the ball owned the
   * desktop — the failure that made the shell look model-specific. Membership is what the host
   * knows, so it decides.
   */
  it('gates only sessions the host published as the ball’s own', () => {
    setScreenOwner('session-a')
    screenOwnerState().ballSessions = new Set(['session-a', 'session-b'])

    // A ball conversation that is not the displayed one stays gated.
    expect(desktopToolDenial('session-b', 'click', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
    expect(desktopToolDenial('session-b', 'bash', BALL_PRESET)).toBe(NOT_SCREEN_OWNER_MESSAGE)
    // A main-window chat running the same preset is not the ball's and keeps everything.
    expect(desktopToolDenial('main-window-chat', 'bash', BALL_PRESET)).toBeUndefined()
    expect(desktopToolDenial('main-window-chat', 'click', BALL_PRESET)).toBeUndefined()
  })
})

describe('preset reading', () => {
  it('reads the preset off a live agent shape', () => {
    expect(presetOf({ session: { header: { agentPreset: BALL_PRESET } } })).toBe(BALL_PRESET)
    expect(presetOf({ session: { header: { agentPreset: 'standard' } } })).toBe('standard')
  })

  it('answers undefined instead of throwing, so a read never becomes a denial', () => {
    expect(presetOf(undefined)).toBeUndefined()
    expect(presetOf({})).toBeUndefined()
    expect(presetOf({ session: {} })).toBeUndefined()
    expect(presetOf({ session: { header: {} } })).toBeUndefined()
    expect(presetOf({ session: { header: { agentPreset: '' } } })).toBeUndefined()
    expect(presetOf({ session: { header: { agentPreset: 42 } } })).toBeUndefined()
    expect(presetOf({ get session(): never { throw new Error('disposed') } })).toBeUndefined()
  })
})

describe('background capability policy', () => {
  it('drops the coordinate space and names every refused tool', () => {
    const text = backgroundPolicyFor()
    expect(text).not.toContain('Coordinates: the attached screenshot')
    expect(text).toContain('cannot take or receive screenshots')
    for (const name of ['click', 'input_text', 'bash', 'open_app']) {
      expect(text).toContain(name)
    }
  })

  it('keeps the delegation and coordination rules the background session still needs', () => {
    const text = backgroundPolicyFor()
    expect(text).toContain('code_agent')
    expect(text).toContain('ask_user_question')
    expect(text).toContain('web_search')
    expect(text).toContain('one short sentence of normal reply text')
  })

  it('is the full policy with exactly the coordinate paragraph swapped', () => {
    // A rewrite that drops the target sentence would silently leave the swapped text looking
    // applied while the background prompt still teaches screenshots it will never receive.
    const swapped = backgroundPolicyFor()
    expect(swapped).not.toBe(POLICY)
    expect(swapped.includes('Coordinates: the attached screenshot')).toBe(false)
    expect(POLICY.startsWith(swapped.slice(0, swapped.indexOf('Coordinates:')))).toBe(true)
  })

  it('keeps the foreground policy intact for the owning conversation', () => {
    expect(policyFor('millifraction')).toContain('Coordinates: the attached screenshot uses a 0–1000 space')
    expect(policyFor('pixel')).toContain('Coordinates: the attached screenshot uses pixel columns')
  })
})
