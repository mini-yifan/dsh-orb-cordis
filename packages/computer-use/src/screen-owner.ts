/**
 * Which Computer Use session currently owns the desktop.
 *
 * The ball panel shows exactly one conversation at a time, but every ball conversation stays a live
 * agent: a `code_agent` completion notice wakes its caller even while the user watches another chat.
 * Only the conversation the panel currently shows may touch the screen — the rest stay on the
 * non-GUI tools (search, questions, further background work) so a session nobody is looking at can
 * never move the mouse.
 *
 * The owner is published by the orb host, which is the only component that knows which session the
 * panel displays. State lives on `globalThis` under a `Symbol.for` key, so the host plugin and the
 * preset's tool layer — separate packages composed into one process — share one record, mirroring
 * the process-global screen mutex in `gui-lock.ts`.
 *
 * An absent owner means unrestricted: `dsh web`, the CLI, and a ball that is switched off keep the
 * full tool surface.
 * @module @dsh-orb/computer-use/src/screen-owner
 */

const SCREEN_OWNER = Symbol.for('dsh-orb.screen-owner')

/**
 * Agent preset of a floating ball conversation. The overlay in `cordis.patch.yml` registers it and
 * the orb host creates every ball session with it, so it is what separates a ball conversation from
 * the main window's chats and from the standard-preset Code sessions the ball delegates to.
 */
export const BALL_PRESET = 'computer-use'

interface ScreenOwnerState {
  /** Session id of the conversation the ball currently shows, or empty when unrestricted. */
  ownerId: string
  /**
   * Sessions the ball has adopted, i.e. the conversations that are actually the ball's own.
   *
   * The preset alone cannot answer that question: a main-window chat may deliberately run the
   * computer-use preset to drive the GUI, and gating it because the ball owns the desktop locks the
   * shell out of a window the user is watching. The host records membership here when it adopts a
   * conversation; absent (an older host) keeps the preset-only rule.
   */
  ballSessions?: Set<string>
}

/**
 * Tools that operate the shared desktop: GUI input, screen capture, app activation, the clipboard,
 * and the shell. Read-only environment inspection is deliberately absent — listing a directory or
 * reading a file changes nothing another session could collide with.
 */
const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // Preset GUI tools (see applyComputerUse).
  'click',
  'input_text',
  'scroll',
  'hotkey',
  'wait',
  'long_wait',
  'screenshot',
  'long_press',
  'drag',
  'open_in_browser',
  'open_in_finder',
  'list_apps',
  'open_app',
  // Shell: registered by the preset as bash (or pwsh on Windows).
  'bash',
  'pwsh',
])

/**
 * Tool-visible failure text. The model reads this as an isError result, so it carries the rule and
 * the way out instead of a bare denial.
 */
export const NOT_SCREEN_OWNER_MESSAGE =
  'Only the conversation the floating ball currently shows may operate the desktop or run commands. '
  + 'This session is in the background, so this tool is unavailable. Do not retry it: report what you '
  + 'have as text, and continue with web_search, web_fetch, ask_user_question, or code_agent if you '
  + 'need them.'

/** The shared record; exported so tests can observe and reset it. */
export function screenOwnerState(): ScreenOwnerState {
  const holder = globalThis as { [SCREEN_OWNER]?: ScreenOwnerState }
  holder[SCREEN_OWNER] ??= { ownerId: '' }
  return holder[SCREEN_OWNER]!
}

/** Publish the session the ball panel shows; an empty string leaves every session unrestricted. */
export function setScreenOwner(sessionId: string | undefined): void {
  screenOwnerState().ownerId = typeof sessionId === 'string' ? sessionId : ''
}

/** The session that currently owns the desktop, or `undefined` when nothing is restricted. */
export function screenOwnerId(): string | undefined {
  const { ownerId } = screenOwnerState()
  return ownerId === '' ? undefined : ownerId
}

/** Whether this tool name reaches the shared desktop or the shell. */
export function isDesktopTool(name: string): boolean {
  return DESKTOP_TOOLS.has(name)
}

/**
 * Denial reason for one pending call, or `undefined` when it may run.
 *
 * The rule is narrow on purpose: **only the floating ball's own conversations are gated, and only
 * the background ones.** A ball conversation the panel currently shows owns the desktop; every other
 * ball conversation may only talk. Nothing else in the process is affected — the main window's own
 * chats keep their tools, and so do the standard-preset Code sessions a ball conversation delegates
 * to, which need the shell to do the work they were handed.
 *
 * Four states are deliberately permissive, and each one is a door that must not lock:
 * - no owner at all (a host without a ball),
 * - a call with no agent (internal dispatch),
 * - a session that is not a ball conversation (the main window, a delegated Code session),
 * - the owner's own calls.
 *
 * "Is a ball conversation" is read from the host-published membership set, not from the preset: a
 * main-window chat running the computer-use preset is not the ball's, and must keep its shell.
 * @param agentId - calling agent id, or undefined when the call carries no agent.
 * @param toolName - tool name as registered.
 * @param preset - the calling session's agent preset, or undefined when it cannot be read.
 * @returns the model-facing denial, or undefined to leave the call allowed.
 */
export function desktopToolDenial(
  agentId: string | undefined,
  toolName: string,
  preset: string | undefined,
): string | undefined {
  const owner = screenOwnerId()
  if (owner === undefined) return undefined
  if (agentId === undefined || agentId === owner) return undefined
  // Membership is the identity test; when the host publishes none, fall back to the preset.
  const ballSessions = screenOwnerState().ballSessions
  if (ballSessions !== undefined && !ballSessions.has(agentId)) return undefined
  if (preset !== BALL_PRESET) return undefined
  if (!DESKTOP_TOOLS.has(toolName)) return undefined
  return NOT_SCREEN_OWNER_MESSAGE
}

/**
 * Agent preset of a live agent, or undefined when it cannot be read.
 *
 * Undefined reads as "not a ball conversation" everywhere it is consumed, so an unreadable header
 * widens access instead of closing it. Locking the wrong session out of the shell is far worse than
 * leaving one ball conversation ungated.
 * @param agent - calling agent from the execution, if the call carried one.
 * @returns the preset name, or undefined.
 */
export function presetOf(agent: unknown): string | undefined {
  try {
    const header = (agent as { session?: { header?: { agentPreset?: unknown } } } | undefined)?.session?.header
    const preset = header?.agentPreset
    return typeof preset === 'string' && preset !== '' ? preset : undefined
  } catch {
    // A disposed or fake session must not turn a read into a denial.
    return undefined
  }
}
