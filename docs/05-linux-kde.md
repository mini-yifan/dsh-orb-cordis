# dsh-orb on Linux / KDE Plasma

This document covers what the Linux port is, what it needs from the system, and
what it does not do yet. It assumes KDE Plasma 6. Other compositors are out of
scope: window geometry and focus come from KWin's scripting interface, which
only Plasma implements.

## What works

| Capability | Implementation | Verified on |
|---|---|---|
| Window list, geometry, focus, titles | KWin scripting over the session bus (`org.kde.kwin.Scripting`) | KWin 6.7, Plasma 6, Wayland |
| Screen capture | `spectacle` (whole desktop, or the active window) | spectacle 6.7 |
| Cropping to the observed rectangle | ImageMagick (`magick`) | ImageMagick 7 |
| Pointer positioning and clicking | `/dev/uinput` absolute pointer via `koffi` → libc | kernel 6.x, libinput |
| Keyboard | `/dev/uinput` keyboard via the same path | same |
| Text entry | clipboard + `Ctrl+V` (matches the macOS backend, which pastes too) | Plasma |
| Clipboard text | `wl-copy` when installed, otherwise the `org.kde.klipper` session service | Plasma |
| Launching and focusing apps | `gtk-launch` / `kioclient6` / `xdg-open`; activation through KWin | Plasma |
| The floating ball | Electron on the X11 (XWayland) backend | Electron 39–44 |

Verified end to end on this machine: `list_apps`, `inspect_foreground`,
`list_screens`, and `capture` all returned live data from the running desktop;
the absolute pointer landed on the exact requested logical coordinate across two
outputs at different scales (1707×960 @ 2.25 and 1920×1080 @ 1).

## Why XWayland for the ball

A Wayland client cannot place its own toplevel or keep it above other windows —
there is no protocol for either. The ball needs both (it parks at a screen edge
and floats over everything), so the helper pins Chromium's X11 backend with
`--ozone-platform=x11`. Everything else — capture, input, window queries — is
compositor-native and unaffected.

The ball is therefore an X11 window: KWin manages it, `spectacle` photographs
it, and `setPosition`/`setAlwaysOnTop` behave the way the macOS and Windows
ports already expect.

## How the ball stays out of screenshots

macOS hides the ball with `NSWindowSharingNone` and Windows with
`WDA_EXCLUDEFROMCAPTURE`. Linux has neither, so the cloak takes a different
route: the ball goes fully transparent for the duration of a capture and back
afterwards. Transparency rather than `hide()` because unmapping is an X11
unmap/remap — the ball vanished and popped back for every capture, `openApp` and
HID interval, which read as the floating window being covered and uncovered
several times a turn. A transparent window stays mapped, and the compositor still
leaves it out of the capture.

**Only a capture conceals the ball.** An input interval just makes it
click-through (`setIgnoreMouseEvents`) so posted clicks land underneath, which
needs no concealment at all. Concealing on input as well made every click-typed
tool call and every GUI turn blink the ball off screen.

A short tail (250 ms) keeps the chrome concealed between two captures, because a
turn typically captures, acts and captures again within a few hundred
milliseconds.

## System requirements

```sh
sudo pacman -S spectacle imagemagick wl-clipboard
```

- `spectacle` — capture. Required.
- `imagemagick` — cropping. Required. (`magick` must be on `PATH`.)
- `wl-clipboard` — optional. Without it, text still reaches the clipboard
  through Klipper, but **images cannot be put on the clipboard** (`screenshot`
  says so explicitly). Install it if you want `screenshot` to copy.
- `xdg-utils` — `xdg-open`, normally already present. Required for
  `open_in_browser` and `open_in_finder`.
- `gtk3` (for `gtk-launch`) or KDE's `kioclient6` — at least one, for
  `open_app`.

## Synthetic input: `/dev/uinput`

`/dev/uinput` is `root:root 0600` by default, so the desktop user needs access
to it. `scripts/linux-setup.sh` does this idempotently:

```sh
sudo scripts/linux-setup.sh
```

It creates a `uinput` group, installs
`/etc/udev/rules.d/60-dsh-orb-uinput.rules`, loads the `uinput` module at boot,
and adds your user to the group. **Group membership needs a fresh login**; the
script also applies a temporary ACL so the current session works immediately.

Revoke everything:

```sh
sudo scripts/linux-setup.sh --remove
```

Without this step the ball still runs and still answers questions, but every GUI
tool fails with `/dev/uinput is not accessible`.

## Installing into dsh

Two things `dsh plugin add` does not do on its own. `scripts/install-orb.sh`
handles both and backs the profile config up first:

1. **pnpm 11 will not finish while a dependency's build decision is pending.**
   It writes `koffi: set this to true or false` into the profile's
   `pnpm-workspace.yaml` and exits non-zero. koffi ships working prebuilt
   binaries inside its own package — its install script only fetches an optional
   prebuild — so the decision is `false`. Without this the add fails with
   `ERR_PNPM_IGNORED_BUILDS`, even though the files were already written.
2. **A package in `dependencies` is not composed into the tree.** A bundle only
   joins when its name is listed in `dsh.profile.bundles` inside the profile's
   `package.json`. `dsh plugin add` does not do that, so the plugin loads
   nothing and prints no `dsh-orb:` lines at startup.

```sh
pnpm build                              # builds every package and assembles the bundle
node packages/bundle/scripts/pack.mjs   # produces ./dsh-orb-0.0.0.tgz
scripts/install-orb.sh --profile web    # backs up, adds the package, wires the bundle
systemctl restart dsh                   # when dsh web runs as a service
```

> **Do not reach for `pnpm pack` here.** pnpm has a built-in `pack` command of
> its own, so `pnpm --filter dsh-orb pack` never runs
> `packages/bundle/scripts/pack.mjs`: it packages whatever the in-place build
> left in `packages/bundle/`, which has no readmes and may be stale. Invoke the
> script directly as shown above.

> **`dsh plugin add` re-uses its own unpack for an unchanged version.** Installing
> a rebuilt tarball with the same version number can leave the previous copy in
> `node_modules/dsh-orb`. Remove that directory (`rm -rf
> ~/.dsh/profiles/web/node_modules/dsh-orb`) before re-adding, or the profile
> keeps running the old code.


Undo:

```sh
scripts/install-orb.sh --profile web --uninstall
cp ~/.dsh/profiles/web/package.json.dsh-orb-backup ~/.dsh/profiles/web/package.json
```

## How the pieces map onto the macOS backend

| macOS | KDE Wayland |
|---|---|
| `CGWindowListCopyWindowInfo` (window walk) | KWin `workspace.windowList()` |
| `NSScreen` geometry and scale | KWin `workspace.screens` |
| `screencapture -R x,y,w,h` | `spectacle -b -n -f` + `magick -crop` |
| `CGEventCreateMouseEvent` (absolute) | `uinput` `EV_ABS` on a virtual pointer |
| `CGEventKeyboardSetUnicodeString` | clipboard + `Ctrl+V` |
| `NSWorkspace` app list | KWin window list + `.desktop` names |
| `open -a` / `open -R` | `gtk-launch` / `xdg-open` / `dolphin --select` |
| `NSWindowSharingNone` | `setOpacity(0)` for the interval |

`cmd` in a hotkey maps to **Control**, not Meta: an agent asking for `cmd+c`
wants a copy, and Control is what copies on Linux. `win`, `super`, and `meta`
map to the real Meta key.

## Motion: how a click finds its target

1. KWin reports the frontmost window's frame rectangle in **logical**
   compositor coordinates.
2. The model answers with a 0–1000 fraction of the attached screenshot.
3. The backend maps that fraction onto the window rectangle
   (`mapNormalizedToGlobal`, shared with the macOS and Windows backends).
4. The absolute pointer's axis range is the compositor's **virtual desktop**
   rectangle, so the logical coordinate is written straight into `EV_ABS` with
   the desktop origin subtracted. KWin maps it back one-to-one — no acceleration
   curve, no scaling guesswork.

The pointer device is rebuilt whenever the desktop rectangle changes (a monitor
plugged in, a resolution change), because the axis range is baked in at device
creation.

## Window geometry on X11

Three X11 behaviours shaped the drag and expand code. Each one produced a
user-visible defect before it was handled, and each one is easy to reintroduce.

**The size a window reports is rounded.** A 96-logical-pixel window measures
97x97 once the compositor rounds its physical size (96 x 2.25 = 216).
`isCollapsed` compares against the nominal size plus a small tolerance; without
that, every collapsed window reads as an open panel and a drag places the window
with the panel's corner offset — a few hundred pixels away from the pointer.

**The position a window reports is rounded too.** A drag that re-derived its
origin from `getBounds()` on every frame dropped the sub-pixel remainder each
time and drifted steadily toward the top-left, losing about 12% of the travelled
distance. The drag therefore accumulates on its own sub-pixel origin and rounds
only when it sets bounds. A regression test drives 200 steps of -3.5 and asserts
the ball lands exactly 700 to the left.

**Resizing paints the old buffer first.** Growing the window from 96x96 to
344x444 draws the old buffer into the new window's top-left corner before the
client's next frame arrives, which is why the ball used to appear in the panel's
top-left for a frame. Two mechanisms cover it: the host asks the page for the
upcoming direction and waits for it to move the ball *before* the window grows,
and the page hides the ball (`layout-changing`) across the resize, revealing it
once a frame at the new size has been painted. A drag is the exception — hiding
the ball would drop its pointer capture — so a drag accepts the one-frame gap.

**A drag sends deltas, never positions.** `window.screenX` and `event.screenX`
disagree with the compositor's window geometry by a couple of hundred pixels in
this setup, so an absolute target parked the window that far from the pointer.
The page sends pointer deltas, coalesced to one per frame, and the host applies
them to its own geometry.

## Known limitations

- **KDE Plasma only.** Window geometry and focus come from KWin. GNOME, wlroots
  compositors, and bare X11 sessions have no backend.
- **Capture costs about 1.5 s** on this machine. The window path (active window,
  matching the observed surface) is used when it is valid; the whole-desktop
  path plus a crop is the fallback and costs about 8 s. `org.kde.KWin.ScreenShot2`
  would remove most of that by capturing through a passed file descriptor without
  starting a process — not implemented yet.
- **No portal prompts.** Nothing here asks for permission through
  `xdg-desktop-portal`; the plugin relies on `uinput` membership and on being
  able to run `spectacle`.
- **A window is captured only while it holds focus.** `spectacle -a` is the fast
  path, so the observed surface and the focused window are the same thing by
  construction. If focus moves between `list_screens` and `capture`, the backend
  falls back to a region crop of the remembered rectangle.
- **Text entry goes through the clipboard** and does not restore its previous
  contents — the same behaviour as the macOS backend.
- **Selection monitoring** (the translate/search toolbar) has no Linux backend;
  the feature is off, as it already is upstream.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `KWin is not reachable on the session bus` | Not running Plasma, or `DBUS_SESSION_BUS_ADDRESS` cannot be resolved. `dsh web` normally runs from a system service with an empty environment; the host resolves the socket from `/run/user/$UID/bus`. |
| `/dev/uinput is not accessible` | Run `scripts/linux-setup.sh` and log in again. |
| `spectacle is not installed` | Install `spectacle`. |
| `ImageMagick ... is not installed` | Install `imagemagick`; the binary must be `magick`. |
| `no clipboard writer is available` | Install `wl-clipboard`, or make sure Plasma's Klipper service is running. |
| Capture shows the ball | Check `cloakConceal` and the helper's `overlay-capture` interval. |
| Clicks land slightly off | The pointer's axis range is the desktop rectangle at creation time. Unplug/replug a monitor while the plugin is running and the range is refreshed on the next GUI action; if it persists, restart the ball. |
