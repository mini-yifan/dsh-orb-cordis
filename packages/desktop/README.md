# @dsh-orb/desktop

Desktop control for the orb's **background** agent.

The background agent gets two routes to the same machine, and one of them is the
default:

- **`desktop_inspect` / `desktop_act`** — the default. `desktop_inspect` resolves
  a window, says `tree=yes` or `tree=no` on its first line, and returns the
  accessibility tree with a ref per actionable element. `desktop_act` acts on a
  ref and hands back the new tree in the same call, so one action is one turn. It
  runs headless: no pointer movement, no focus stealing, no clipboard.
- **The picture tools** — `desktop_see`, `desktop_click`, `desktop_input_text`,
  `desktop_hotkey`, `desktop_scroll`, `desktop_drag`, `desktop_wait`,
  `desktop_open_app`. The Computer Use gesture set, retargeted at a named window.
  Use it when `desktop_inspect` answers `tree=no` (Electron and canvas windows
  usually do) or when a tree read comes back `tree_thin`. Each call does one
  thing and returns the window as it now looks; it moves the real pointer and
  raises its window, so whoever is at the machine sees it.

Both run on macOS and Windows. The picture path is why an app whose tree is
empty still works.

The foreground Computer Use mode is unchanged and independent of both.

## Why the visual route is first

One real task (open QQ, open the phone conversation, send a message) was measured
twice through the same model. Through the accessibility tree it took 55 turns and
174 s; in Computer Use, 8 turns and 23 s. Per-call latency was not the
difference — `list-windows` costs 0.23 s and a window capture 0.31 s — the round
trips were:

- seeing and acting were two calls, so one click cost two turns;
- an app with several windows refused an app-name read with `AMBIGUOUS_TARGET`,
  and each refusal cost another;
- a thin tree, a dead ref, or a lease that expired because the user touched the
  keyboard each cost one or two more.

So `desktop` does one thing per call and answers with the window as it now looks.
Points are a fraction of that picture on a 0–1000 grid, which removes the pixel
arithmetic (and the shadow padding, and the window rectangle) the model used to
do before every click.

QQ is an Electron client whose main window exposes almost no accessibility tree.
That is the second reason: on those windows the visual route is not a fallback,
it is the only route that works.

## Why a library and not a CLI

`agent-desktop` ships both. The CLI is a standalone executable; the FFI library
is a `.dylib`/`.dll`. Windows blocks unsigned executables launched by the system
(Smart App Control on a clean Windows 11 install), while a library loaded by a
trusted host process is the same shape this project already ships for koffi.
The library is also 1.4–1.9 MB per platform, so all four targets fit in the
bundle and users never download anything beyond the plugin.

The library is **never loaded in the desktop app's process**. Each chat session
gets a child process (`lib/host.js`) that owns the adapter; a wedged
accessibility bridge costs one child, not the orb.

The visual route does not use the library: it spawns the staged CLI for window
inventory, capture, focus and pointer input, because the CLI is the same code
path on macOS and Windows and the spawn cost is a fifth of a model turn.

## The rules it enforces

| Rule | Where |
|---|---|
| One call is one action plus the next picture | `registerGuiTools` in `gui.ts` |
| A point is a 0–1000 fraction of the picture, never a pixel | `pointToScreen` in `gui.ts` |
| A pointer action raises its window first | `ensureFront` in `gui.ts` |
| A text-only model is refused before anything is touched | `requireImageRoute` in `route.ts` |
| Text reaches a window with no accessibility tree | `hid.ts` pastes, then restores every clipboard type |
| A repeated click or key is refused instead of resent | `landed` map in `gui.ts`, `effects` in `tools.ts` |
| Elements are acted on headless, with no physical fallback | `ffi.ts` passes `AD_POLICY_KIND_HEADLESS` |
| Only one session may operate one app | `guard.ts` leases |
| The foreground agent's screen lock blocks background input | `screenLockOwner()` reads the orb's process-global lock |
| A ref the model was never shown is refused | `RefBook` in `sessions.ts` |
| The background agent cannot ask the user anything | the `desktop` preset has no `ask_user_question` row |

## Libraries

`native/<platform>/` is fetched, never committed:

```bash
pnpm --filter @dsh-orb/desktop fetch-native
```

The script pins release `1.2.0`, verifies each archive against the checksums from
the same GitHub release, and keeps only the library and its macOS helper. Set
`AGENT_DESKTOP_RELEASE_MIRROR` when GitHub is unreachable (default:
`https://gh-proxy.com/`).

At runtime the library is copied once into
`$DSH_HOME/dsh-orb/desktop/native/1.2.0-<platform>/`, because a loaded image
cannot be replaced on Windows while pnpm swaps the package folder.

## Limits worth knowing

- The visual route moves the pointer and brings the window forward. There is no
  "ask first" step and no idle check: the decision was that disturbing the user
  is cheaper than a queue of two-turn workarounds.
- Typing by point needs the pasteboard, which this package only implements on
  macOS. On Windows the `desktop` tool answers `PLATFORM_NOT_SUPPORTED` and the
  accessibility pair is the route for text.
- Some apps expose no semantic actions at all. Those steps fail with
  `ACTION_NOT_SUPPORTED` and the result points at the visual route rather than
  retrying them.
- Windows refuses `SetForegroundWindow` from a background process often enough
  that a focus change reports failure instead of forcing it.

## Raw comparison mode

`lib/cli-path.js` is a separate plugin used only by the temporary `desktop-raw`
preset: it stages the **unmodified upstream CLI** inside
`$DSH_HOME/dsh-orb/bin/<version>-<platform>/` and prepends that folder to PATH,
so a main-window session can call `agent-desktop` exactly as upstream documents
it. No ribbon, no guard, no ref book, no policy escalation. It exists to answer
whether upstream is good enough on its own.

## Tests

```bash
pnpm --filter @dsh-orb/desktop test
```

The suite covers the renderer, the ownership rules, ref bookkeeping, the point
geometry, window selection, the paste script's clipboard restore, and the
accessibility pair's execute paths with a stubbed child. It never touches the
real desktop.
