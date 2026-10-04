#!/usr/bin/env bash
#
# dsh-orb on Linux / KDE Plasma: make synthetic input available and check the
# tools the desktop backend shells out to.
#
#   sudo scripts/linux-setup.sh           # grant /dev/uinput access
#   sudo scripts/linux-setup.sh --check   # report only, change nothing
#   sudo scripts/linux-setup.sh --remove  # undo every change this script made
#
# The change is three small pieces: a group, one udev rule, and a modules-load
# file. Everything is idempotent and reversible.

set -euo pipefail

RULE_PATH=/etc/udev/rules.d/60-dsh-orb-uinput.rules
MODULES_PATH=/etc/modules-load.d/uinput.conf
GROUP_NAME=uinput

MODE=apply
for arg in "$@"; do
  case "$arg" in
    --check)  MODE=check ;;
    --remove) MODE=remove ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root: sudo $0 ${MODE:+$*}" >&2
  exit 1
fi

# The desktop user is whoever owns the active session, not whoever ran sudo.
TARGET_USER="${SUDO_USER:-$(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $3}' | head -1)}"
if [ -z "${TARGET_USER:-}" ] || [ "$TARGET_USER" = "root" ]; then
  echo "could not determine the desktop user; pass SUDO_USER explicitly" >&2
  exit 1
fi

say() { printf '  %s\n' "$*"; }

check_tools() {
  echo "desktop tools:"
  local missing=0
  for tool in spectacle magick xdg-open; do
    if command -v "$tool" >/dev/null 2>&1; then
      say "ok       $tool"
    else
      say "MISSING  $tool"
      missing=1
    fi
  done
  for tool in wl-copy gtk-launch kioclient6; do
    if command -v "$tool" >/dev/null 2>&1; then
      say "ok       $tool"
    else
      say "optional $tool (not installed)"
    fi
  done
  if [ "$missing" -eq 1 ]; then
    echo
    echo "install the required ones with:"
    echo "  sudo pacman -S spectacle imagemagick xdg-utils"
    echo "and, for image clipboard support:"
    echo "  sudo pacman -S wl-clipboard"
  fi
}

if [ "$MODE" = check ]; then
  check_tools
  echo
  echo "/dev/uinput:"
  if [ -e /dev/uinput ]; then
    say "$(ls -l /dev/uinput)"
    if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$GROUP_NAME"; then
      say "user $TARGET_USER is in group $GROUP_NAME"
    else
      say "user $TARGET_USER is NOT in group $GROUP_NAME"
    fi
  else
    say "missing; load the module with: modprobe uinput"
  fi
  exit 0
fi

if [ "$MODE" = remove ]; then
  echo "removing dsh-orb uinput access"
  rm -f "$RULE_PATH" "$MODULES_PATH"
  if getent group "$GROUP_NAME" >/dev/null; then
    gpasswd -d "$TARGET_USER" "$GROUP_NAME" 2>/dev/null || true
    say "removed $TARGET_USER from $GROUP_NAME"
  fi
  udevadm control --reload-rules 2>/dev/null || true
  udevadm trigger --subsystem-match=misc 2>/dev/null || true
  setfacl -x "u:$TARGET_USER" /dev/uinput 2>/dev/null || true
  echo "done. The group itself is left in place; remove it with 'groupdel $GROUP_NAME' if nothing else uses it."
  exit 0
fi

echo "granting /dev/uinput access to $TARGET_USER"

check_tools
echo

getent group "$GROUP_NAME" >/dev/null || groupadd --system "$GROUP_NAME"
say "group $GROUP_NAME present"

cat > "$RULE_PATH" <<'RULE'
# dsh-orb: synthetic pointer and keyboard for Computer Use.
KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="uinput", MODE="0660", OPTIONS+="static_node=uinput"
RULE
say "wrote $RULE_PATH"

printf 'uinput\n' > "$MODULES_PATH"
say "wrote $MODULES_PATH"

modprobe uinput 2>/dev/null || true
usermod -aG "$GROUP_NAME" "$TARGET_USER"
say "added $TARGET_USER to $GROUP_NAME"

udevadm control --reload-rules
udevadm trigger --subsystem-match=misc
if [ -e /dev/uinput ]; then
  # The udev rule only applies to the node the kernel creates next boot, so the
  # current session gets an ACL instead. It disappears on reboot, by which time
  # the group membership is in effect.
  setfacl -m "u:$TARGET_USER:rw" /dev/uinput 2>/dev/null || chmod 0660 /dev/uinput
  say "granted the current session immediate access via ACL"
fi

cat <<NEXT

done.

  Log out and back in once so the group membership takes effect; until then the
  ACL above keeps the current session working.

  Verify with:
    ls -l /dev/uinput          # group uinput, mode 660
    id -nG $TARGET_USER        # includes uinput after the next login
NEXT
