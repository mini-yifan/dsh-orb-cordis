#!/usr/bin/env bash
#
# Install the dsh-orb bundle into a dsh profile.
#
#   scripts/install-orb.sh [--profile web] [--tgz path] [--dry-run] [--uninstall]
#
# `dsh plugin add` alone is not enough, for two reasons this script handles:
#
#   1. pnpm 11 refuses to finish while any dependency's build decision is still
#      pending. koffi ships working prebuilt binaries in its own package (its
#      install script only fetches an optional prebuild), so it is recorded as
#      "no build needed" instead of leaving the prompt in place.
#   2. Adding the tarball to `dependencies` does not compose it. A bundle only
#      joins the tree when its name appears in `dsh.profile.bundles` inside the
#      profile's package.json.
#
# The profile's package.json and pnpm-workspace.yaml are backed up next to
# themselves (`.dsh-orb-backup`) before either is touched.

set -euo pipefail

PROFILE=web
TGZ=""
MODE=install
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-web}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --tgz) TGZ="${2:-}"; shift 2 ;;
    --tgz=*) TGZ="${1#*=}"; shift ;;
    --dry-run) MODE=dry; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
WORKSPACE="$PROFILE_DIR/pnpm-workspace.yaml"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "no such profile: $PROFILE_DIR" >&2
  exit 1
fi

say() { printf '  %s\n' "$*"; }

if [ "$MODE" = uninstall ]; then
  echo "removing dsh-orb from profile '$PROFILE'"
  python3 - "$PKG" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
data.get('dsh', {}).get('profile', {}).get('bundles', [])[:] = [
    b for b in data.get('dsh', {}).get('profile', {}).get('bundles', []) if b != 'dsh-orb'
]
data.get('dependencies', {}).pop('dsh-orb', None)
p.write_text(json.dumps(data, indent=2) + '\n')
print('  package.json updated')
PY
  say "run 'dsh plugin --profile $PROFILE remove dsh-orb' for the on-disk dependency"
  exit 0
fi

if [ -z "$TGZ" ]; then
  for candidate in "$(dirname "$0")/../"dsh-orb-*.tgz; do
    [ -f "$candidate" ] && TGZ="$candidate"
  done
fi
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "no tarball found; build one with 'pnpm --filter dsh-orb pack' or pass --tgz" >&2
  exit 1
fi
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"

echo "profile:  $PROFILE_DIR"
echo "tarball:  $TGZ"
echo

if [ "$MODE" = dry ]; then
  say "would back up package.json and pnpm-workspace.yaml"
  say "would set allowBuilds.koffi and run: dsh plugin --profile $PROFILE add $TGZ"
  say "would append 'dsh-orb' to dsh.profile.bundles"
  exit 0
fi

cp -n "$PKG" "$PKG.dsh-orb-backup" 2>/dev/null || true
[ -f "$WORKSPACE" ] && { cp -n "$WORKSPACE" "$WORKSPACE.dsh-orb-backup" 2>/dev/null || true; }
say "backed up profile config (.dsh-orb-backup)"

python3 - "$WORKSPACE" <<'PY'
import pathlib, sys
# Optional native dependencies the bundle pulls in transitively. Each ships working
# prebuilt binaries or a pure-JS fallback, so none of them needs a build step; leaving
# the decision open is what makes pnpm exit non-zero with ERR_PNPM_IGNORED_BUILDS.
WANTED = ['koffi', 'usocket']
p = pathlib.Path(sys.argv[1])
if not p.exists():
    sys.exit(0)
lines = p.read_text().splitlines()
out, inside, written = [], False, False
for line in lines:
    if line.startswith('allowBuilds:'):
        inside = True
        out.append(line)
        continue
    if inside and line and not line.startswith(' '):
        # Leaving the block: record the decision before the next top-level key.
        if not written:
            out.append('  koffi: false')
            written = True
        inside = False
    if inside and any(line.strip().startswith(f'{name}:') for name in WANTED):
        out.append(f'  {line.strip().split(":")[0]}: false')
        written = True
        continue
    out.append(line)
if inside:
    # allowBuilds was the last block in the file, or it already listed nothing new.
    for name in WANTED:
        if f'{name}:' not in '\n'.join(out[out.index('allowBuilds:'):]):
            out.append(f'  {name}: false')
            written = True
while out and out[-1].strip() == '':
    out.pop()
block = out[out.index('allowBuilds:'):] if 'allowBuilds:' in out else []
for name in WANTED:
    if not any(line.strip().startswith(f'{name}:') for line in block):
        out.append(f'  {name}: false')
        written = True
if not written and 'allowBuilds:' not in out:
    if out and out[-1] != '':
        out.append('')
    out.append('allowBuilds:')
    for name in WANTED:
        out.append(f'  {name}: false')
p.write_text('\n'.join(out) + '\n')
print('  pnpm-workspace.yaml: koffi marked as needing no build')
PY

if ! command -v dsh >/dev/null 2>&1; then
  echo "dsh is not on PATH; add it (nvm bin) and re-run the add step" >&2
  exit 1
fi

say "running: dsh plugin --profile $PROFILE add $TGZ"
dsh plugin --profile "$PROFILE" add "$TGZ"

python3 - "$PKG" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
profile = data.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if 'dsh-orb' not in bundles:
    bundles.append('dsh-orb')
p.write_text(json.dumps(data, indent=2) + '\n')
print('  package.json: dsh-orb added to dsh.profile.bundles')
PY

cat <<NEXT

done.

  Restart dsh for the bundle to load:
    systemctl restart dsh        # when dsh web runs as a service
    # or stop and re-run 'dsh web'

  Undo with:
    scripts/install-orb.sh --profile $PROFILE --uninstall
    cp $PKG.dsh-orb-backup $PKG

NEXT
