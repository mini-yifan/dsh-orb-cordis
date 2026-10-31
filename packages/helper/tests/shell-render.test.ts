import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The ball page is a browser-only module (window/document at import time), so
 * these rendering fixes are pinned at the source level, the way drag-input and
 * transcript-model guard shell.js. Comments are stripped: only live code counts.
 */
const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * An asset as the pins below read it, with its line endings normalized. The patterns anchor on
 * `\n`, and a Windows checkout (`core.autocrlf=true`) has CRLF on disk, which is not what any of
 * them are pinning.
 * @param relative - asset path relative to this test file.
 * @returns the asset text with `\r\n` folded to `\n`.
 */
function source(relative: string): string {
  return readFileSync(join(here, relative), 'utf8').replaceAll('\r\n', '\n')
}

const shell = source('../assets/shell.js')
const code = shell.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '')
const highlight = source('../assets/highlight.js')

describe('ball page render guards', () => {
  it('appends the web-fetch meta without the undefined url reference', () => {
    assert.match(code, /fetch\.append\(meta\)/)
    assert.equal(code.includes('fetch.append(url'), false)
  })

  it('keeps drawing the rest of a frame when one item fails', () => {
    assert.match(code, /for \(const item of list\) \{\s*try \{/)
    assert.match(code, /catch \(error\) \{\s*console\.error\(/)
  })

  it('builds chip icons as nodes instead of innerHTML strings', () => {
    assert.match(code, /status\.replaceChildren\(icon\(/)
    assert.equal(code.includes('status.innerHTML = icon('), false)
  })

  it('keeps the card expander mounted while it toggles the hidden rows', () => {
    assert.equal(code.includes('expand.remove()'), false)
    assert.match(code, /target\.insertBefore\(row, expand\)/)
    assert.match(code, /expand\.textContent = open \? chatLabels\.collapse/)
  })

  it('copies the rows the tool cards show, read at click time', () => {
    // The reader runs on click, so the clipboard follows the cap and the expander.
    assert.match(code, /copyText\(copy, \(\) => terminalCopyText\(/)
    assert.match(code, /querySelectorAll\('\.term-line'\)/)
    assert.match(code, /copyText\(copy, \(\) => readCopyText\(/)
    assert.match(code, /querySelectorAll\('\.read-content'\)/)
    assert.match(code, /copyText\(copy, \(\) => searchCopyText\(/)
    assert.match(code, /querySelectorAll\('\.search-file-path, \.search-line'\)/)
  })

  it('re-upgrades tracked roots once a lazy grammar lands', () => {
    assert.match(highlight, /const root = ref\.deref\(\)/)
    assert.match(highlight, /upgradeCodeBlocks\(root, \{ track: false \}\)/)
  })

  it('tracks a re-rendered root once instead of once per render', () => {
    assert.match(highlight, /known = new WeakSet\(\)/)
    assert.match(highlight, /if \(track && !known\.has\(root\)\)/)
    assert.equal(highlight.includes('if (track) tracked.add(new WeakRef(root))'), false)
  })

  it('keeps the ball wrapped: only the panel far edge moves for the strip', () => {
    const css = source('../assets/floating.css')
    // The panel is the window minus its chrome, so the ball at the near edge always sits
    // inside it: a stale strip state must never leave the ball outside the panel.
    assert.equal(/--panel-w|width:\s*var\(--panel-w\)/.test(css), false)
    assert.match(css, /#panel \{\s*position: absolute;\s*inset: var\(--chrome\);/)
    // The panel and the strip are placed from the same offset, so they cannot drift apart.
    assert.match(css, /--panel-left:\s*calc\(var\(--chrome\) \+ var\(--strip-w\)\)/)
    assert.match(css, /body\.has-strip\.strip-left #panel \{\s*left:\s*var\(--panel-left\);\s*right: var\(--chrome\);/)
    assert.match(css, /body\.has-strip\.strip-right #panel \{\s*right: var\(--panel-left\);\s*left: var\(--chrome\);/)
    assert.match(css, /body\.has-strip\.strip-left #agent-strip \{\s*left:\s*0;\s*width:\s*calc\(var\(--panel-left\) \+ var\(--strip-tuck\)\)/)
    // The old rules sized the strip from a hard-coded panel width instead of the panel's own.
    assert.equal(css.includes('right: calc(320px'), false)
    // `--panel-left` is declared on the root and computes with `--strip-w`, so the page must
    // set that one on the root too: a body-scoped value would leave the offset at 12px.
    assert.match(code, /document\.documentElement\.style\.setProperty\('--strip-w'/)
    assert.equal(code.includes("document.body.style.setProperty('--strip-w'"), false)
  })

  it('re-syncs the host geometry whenever the reservation and the chips disagree', () => {
    // Both directions, and even while the strip is hidden: the reservation follows the chip
    // list, so a missed message would either cover the chips or leave a gap beside them.
    assert.match(code, /if \(document\.body\.classList\.contains\('has-strip'\) !== \(agentItems\.length > 0\)\) void syncStrip\(\)/)
    assert.match(code, /async function syncStrip\(\)/)
    assert.match(code, /await api\.syncStrip\?\.\(\)/)
    // Once on startup, so a state message lost across a page load heals before the first hover.
    assert.match(code, /syncGif\(\)\n(?:\s*(?:\/\/[^\n]*|reportPinned\(\))\n)*\s+void syncStrip\(\)\n\}/)
  })

  it('dismisses a finished chip from its own control instead of the chip body', () => {
    const css = source('../assets/floating.css')
    const preload = source('../preload.cjs')
    const main = source('../src/main.ts')
    // A button inside a button is invalid markup and swallows the inner click, so the row is a
    // container and each control is a button of its own.
    assert.match(code, /const chip = document\.createElement\('div'\)/)
    assert.equal(code.includes("const chip = document.createElement('button')"), false)
    assert.match(code, /open\.className = 'agent-chip-open'/)
    assert.match(code, /dismiss\.className = 'agent-chip-dismiss'/)
    assert.match(code, /api\.dismissAgent\?\.\(item\.sessionId\)/)
    // Only a finished stretch has anything to dismiss: while it runs, that chip is the only trace
    // of the task. The × sits exactly where the unread dot used to.
    assert.match(code, /if \(item\.unread === true\) \{\n\s+chip\.dataset\.dismiss = 'true'\n\s+const dismiss = document\.createElement\('button'\)/)
    assert.equal(code.includes('agent-chip-unread'), false)
    assert.equal(css.includes('agent-chip-unread'), false)
    assert.match(css, /\.agent-chip-dismiss \{/)
    // The collapsed row cannot hold status + elapsed + ×, so the elapsed time steps aside instead of
    // being cut into a half glyph beside the ×.
    assert.match(css, /\.agent-chip\[data-dismiss="true"\]:not\(:hover\):not\(:focus-within\) \.agent-chip-time \{\n\s+display: none;/)
    // Hovering — or tabbing into either control — expands the row, which is what reveals both the
    // task name and the ×.
    assert.match(css, /\.agent-chip:hover,\n\.agent-chip:focus-within \{\n\s+width: 100%;/)
    // The click has a bridge: page → preload → helper → host.
    assert.match(preload, /ipcRenderer\.send\('orb:agent-dismiss', id\)/)
    assert.match(main, /ipcMain\.on\('orb:agent-dismiss',[\s\S]{0,160}?type: 'agent-dismiss'/)
  })
})

/**
 * A turn in the conversation on screen must be visible: the ball comes back from the screen edge,
 * the panel opens and stays pinned. The page only ever sees the displayed conversation's turns —
 * the host streams that one session — so this cannot fire for a background conversation's agent.
 */
describe('agent work keeps the panel on screen', () => {
  it('promotes the panel from the collapsed and docked states when a turn starts', () => {
    assert.match(code, /if \(next\) \{\n(?:\s*\/\/[^\n]*\n)*\s+void showWorkPanel\(\)/)
    assert.match(code, /async function showWorkPanel\(\) \{\n\s+if \(pageClosed\(\)\) return\n(?:\s*\/\/[^\n]*\n)*\s+if \(docked !== undefined\) await unsnapDocked\(\)\n\s+await setExpanded\(true\)\n\s+pinBall\(\)/)
  })

  it('pins the panel when the selection toolbar sends text to the agent', () => {
    // "Send to Agent" is the user asking to talk, so it has to land where a turn does. A bare
    // setExpanded would leave the ball unpinned: voice input stays shut (it only opens for a
    // pinned ball), so the user would have to click the ball again before speaking, and the
    // panel would collapse 180ms after the pointer left. showWorkPanel also lifts a docked
    // ball off the screen edge, which setExpanded alone skips.
    assert.match(code, /api\.onAttach\(\(text\) => \{\n\s+if \(typeof text !== 'string' \|\| text === ''\) return\n(?:\s*\/\/[^\n]*\n)*\s+void showWorkPanel\(\)\.then\(\(\) => \{/)
    assert.match(code, /void showWorkPanel\(\)\.then\(\(\) => \{\n\s+setAttachedSelection\(text\)\n\s+prompt\.focus\(\)/)
    // And it must not go back to the expand-only call.
    assert.doesNotMatch(code, /api\.onAttach[\s\S]{0,400}?void setExpanded\(true\)/)
  })

  it('never collapses or docks while the turn is running', () => {
    // Every collapse path already consults `running`; the dock paths carry it to the main process
    // as `canDock`, which is what stops a release on a screen edge from docking.
    assert.match(code, /function scheduleCollapse\(\) \{\n\s+if \(pinned \|\| running \|\| asking\(\) \|\| dragging \|\| voiceHold\) return/)
    assert.match(code, /if \(!force && \(pinned \|\| running \|\| asking\(\) \|\| voiceHold\)\) return/)
    assert.match(code, /api\.dragEnd\(!\(running \|\| asking\(\)\)\)/)
    assert.match(code, /api\.dragMove\(!\(running \|\| asking\(\)\)\)/)
  })

  it('keeps the panel up for speech, and collapses only when the pointer has left', () => {
    const css = source('../assets/floating.css')
    assert.match(code, /function stopShown\(\) \{\n\s+return expanded && \(running \|\| voiceHold\)/)
    assert.match(code, /function unpinFromHost\(\) \{\n\s+assignPinned\(false\)\n\s+if \(!pointerInside\) scheduleCollapse\(\)/)
    assert.match(code, /if \(!pinned && !running && !asking\(\) && !pointerInside\) scheduleCollapse\(\)/)
    assert.match(code, /document\.body\.classList\.toggle\('voice-hold', voiceHold\)/)
    assert.match(code, /prompt\.addEventListener\('keydown', \(event\) => \{\n\s+if \(typeof api\.reportActivity === 'function'\) api\.reportActivity\(\)/)
    assert.match(css, /body:not\(\.expanded\) #stop,\nbody:not\(\.running\):not\(\.voice-hold\) #stop \{\n\s+display: none;/)
  })

  it('locks only the two conversation-switch controls, and only while running', () => {
    assert.match(code, /function setWorkLocked\(locked\) \{[\s\S]{0,220}document\.body\.classList\.toggle\('work-locked', locked\)/)
    // The lock follows the turn, and a transcript reset (a conversation switch) clears it.
    assert.match(code, /setWorkLocked\(running\)/)
    assert.match(code, /function clearTranscript\(\) \{[\s\S]{0,600}setRunning\(false\)/)
    // Both controls answer a click while locked with the inline notice instead of switching.
    assert.match(code, /historyButton\.addEventListener\('click', \(\) => \{\n\s+if \(workLocked\) \{\n\s+showHint\(messages\.workLocked\)/)
    assert.match(code, /newConversation\.addEventListener\('click', \(\) => \{\n\s+if \(workLocked\) \{\n\s+showHint\(messages\.workLocked\)/)
    // A notice, never a dialog, and it clears itself.
    assert.match(code, /hintTimer = setTimeout\(\(\) => \{\n\s+hintTimer = undefined\n\s+hint\.hidden = true\n\s+\}, HINT_MS\)/)
    assert.equal(code.includes('confirm('), false)
    assert.equal(code.includes('alert('), false)
  })

  it('gives both locked controls a tooltip that explains the refusal', () => {
    assert.match(code, /historyButton\.title = workLocked \? messages\.historyLocked : messages\.history/)
    assert.match(code, /newConversation\.title = workLocked \? messages\.newLocked : messages\.fresh/)
    assert.match(code, /function refreshAllText\(\) \{\n\s+applyStaticText\(\)\n\s+applyLockedLabels\(\)/)
  })

  it('ships the notice element and its styles', () => {
    const html = source('../assets/floating.html')
    const css = source('../assets/floating.css')
    assert.match(html, /<p id="hint" role="status" hidden><\/p>/)
    assert.match(css, /body\.work-locked #history,\nbody\.work-locked #new-conversation \{\n\s+opacity: 0\.45;/)
  })

  it('puts a microphone meter on the composer edge while a command is heard', () => {
    const html = source('../assets/floating.html')
    const css = source('../assets/floating.css')
    const preload = source('../preload.cjs')
    const main = source('../src/main.ts')
    assert.match(html, /<div id="voice-meter" aria-hidden="true"><span id="voice-meter-bar"><\/span><span id="voice-meter-dot"><\/span><\/div>\n\s+<div id="prompt"/)
    assert.match(css, /#voice-meter \{\n\s+position: absolute;\n\s+z-index: 3;\n\s+top: 1px;/)
    assert.match(css, /#voice-meter\.active \{\n\s+opacity: 1;/)
    assert.match(css, /#voice-meter-bar \{\n\s+display: block;\n\s+width: 100%;/)
    assert.match(css, /background: #8ec5ff;/)
    // The composer is hidden while the agent works, but the meter inside it must stay
    // visible: transcription is still open during the turn.
    assert.match(css, /body\.running #voice-meter \{\n\s+visibility: visible;/)
    assert.match(code, /const listening = voiceMode === 'command' \|\| voiceMode === 'interject'/)
    assert.match(code, /const active = listening && expanded && !asking\(\)/)
    assert.match(code, /const next = mode === 'command' \|\| mode === 'interject' \? mode : 'off'/)
    assert.match(code, /if \(!pinned && !pointerInside\) scheduleCollapse\(\)/)
    assert.match(code, /api\.onVoiceMode\?\.\(\(mode\) => \{/)
    assert.match(code, /api\.onVoiceLevel\?\.\(\(level\) => \{/)
    assert.match(preload, /onVoiceMode\(callback\)/)
    assert.match(preload, /onVoiceLevel\(callback\)/)
    assert.match(main, /orb:voice-mode/)
    assert.match(main, /mode === 'interject'/)
    assert.match(main, /orb:voice-level/)
  })

  it('lights the ASR dot only while a speech segment is going to the recognizer', () => {
    const html = source('../assets/floating.html')
    const css = source('../assets/floating.css')
    const preload = source('../preload.cjs')
    const main = source('../src/main.ts')
    assert.match(html, /<div id="voice-meter" aria-hidden="true"><span id="voice-meter-bar"><\/span><span id="voice-meter-dot"><\/span><\/div>/)
    // Dim while the input is merely armed; lit only under `.speech`, which the renderer toggles.
    assert.match(css, /#voice-meter\.speech #voice-meter-dot \{\n\s+background: #8ec5ff;/)
    // The dot sits at the track's far end, opposite the ball on either side.
    assert.match(css, /body\.expand-left #voice-meter-dot \{\n\s+left: -7px;/)
    assert.match(css, /body\.expand-right #voice-meter-dot \{\n\s+right: -7px;/)
    assert.match(code, /voiceMeter\.classList\.toggle\('speech', active && voiceSpeech\)/)
    assert.match(code, /api\.onVoiceSpeech\?\.\(\(open\) => \{/)
    assert.match(code, /if \(next === 'off'\) voiceSpeech = false/)
    assert.match(preload, /onVoiceSpeech\(callback\)/)
    assert.match(preload, /orb:voice-speech/)
    assert.match(main, /orb:voice-speech/)
  })
})
