# @dsh-orb/desktop

Silent desktop control for the orb's **background** agent.

The foreground Computer Use mode is unchanged: it still drives the frontmost
window with screenshots and HID input, and the user still has to watch it. This
package gives the *background* agent a different pair of hands: it reads an
application's accessibility tree and acts on elements by ref, without moving the
pointer, stealing keyboard focus, or taking over the screen.

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

## The rules it enforces

| Rule | Where |
|---|---|
| Headless by default: semantic actions only, never physical input | `ffi.ts` passes `AD_POLICY_KIND_HEADLESS` on every call |
| A background task never operates the app the user is working in | `guard.ts` (`frontmost` + 60 s of input) |
| Borrowing the foreground needs 2 s of quiet, returns after 90 s, and returns the moment the user touches anything | `guard.ts`, `sessions.ts` |
| Only one session may operate one app, and only one may hold the foreground | `guard.ts` leases |
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

- Reading the frontmost app is allowed; operating it is not, unless the user has
  been idle for a minute or this session borrowed it.
- Some apps expose no semantic actions at all. Those steps fail with
  `ACTION_NOT_SUPPORTED` and are handed back to the foreground agent; the
  background agent never falls back to physical input.
- Windows refuses `SetForegroundWindow` from a background process often enough
  that `desktop_raise` reports failure instead of forcing it.

## Tests

```bash
pnpm --filter @dsh-orb/desktop test
```

The suite covers the renderer, the ownership rules, ref bookkeeping, and every
tool's execute path with a stubbed child. It never touches the real desktop.