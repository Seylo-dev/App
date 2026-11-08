#!/usr/bin/env bash
# Tests deploy/panel-entrypoint.sh, rendered the way deploy/panel.Dockerfile
# renders it, with shims for id, stat, chown, chmod and setpriv: which user
# the panel command runs as, and that a root-owned folder goes to the panel
# user. Nothing here needs Docker or root.
#
# Usage: deploy/test/panel-entrypoint.sh   (make test-installer)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck disable=SC1091
. "$root/installer/brand.env"
PREFIX=$(printf %s "$BRAND_SLUG" | tr '[:lower:]-' '[:upper:]_')
PANEL_UID=$(sed -n 's/^ARG PANEL_UID=//p' "$root/deploy/panel.Dockerfile")
[ -n "$PANEL_UID" ] || { echo "panel entrypoint tests: no ARG PANEL_UID in deploy/panel.Dockerfile" >&2; exit 1; }
SH=$(command -v dash || command -v sh)

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
script=$T/panel-entrypoint
sed -e "s|@@PANEL_UID@@|$PANEL_UID|g" -e "s|@@ENV_PREFIX@@|$PREFIX|g" -e "s|@@DATA_DIR@@|$T/data|g" \
  "$root/deploy/panel-entrypoint.sh" >"$script"
if grep -q '@@[A-Z_]*@@' "$script"; then
  echo "panel entrypoint tests: placeholders left after rendering" >&2
  exit 1
fi

shims=$T/shims
mkdir -p "$shims"
cat >"$shims/id" <<'SHIM'
#!/bin/sh
[ "$1" = -u ] && echo "$FAKE_UID"
SHIM
cat >"$shims/stat" <<'SHIM'
#!/bin/sh
# stat -c %u|%g <path>: FAKE_OWNER is "uid:gid"
case $2 in
%u) echo "${FAKE_OWNER%%:*}" ;;
%g) echo "${FAKE_OWNER#*:}" ;;
esac
SHIM
for c in chown chmod; do
  printf '#!/bin/sh\necho "%s $*" >>"$LOG"\n' "$c" >"$shims/$c"
done
cat >"$shims/setpriv" <<'SHIM'
#!/bin/sh
echo "setpriv $*" >>"$LOG"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
SHIM
chmod +x "$shims"/*

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
  printf 'FAIL %s\n' "$1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/     | /'
  failures=$((failures + 1))
}

# run <uid> <owner uid:gid> [VAR=value...]: runs the entrypoint with "echo ran"; sets OUT and LOGTEXT.
run() {
  local uid=$1 owner=$2
  shift 2
  : >"$T/log"
  OUT=$(env -i PATH="$shims:/usr/bin:/bin" LOG="$T/log" FAKE_UID="$uid" FAKE_OWNER="$owner" "$@" "$SH" "$script" echo ran 2>&1) || OUT="exit $?: $OUT"
  LOGTEXT=$(cat "$T/log")
}

run "$PANEL_UID" "$PANEL_UID:$PANEL_UID"
[ "$OUT" = ran ] && [ -z "$LOGTEXT" ] && pass "started with --user (an agent from 0.2.0-rc.2 on): the command runs as is" ||
  flunk "started with --user" "$OUT / $LOGTEXT"

run 0 "1000:1000"
[ "$OUT" = ran ] && printf '%s' "$LOGTEXT" | grep -q -- "setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs -- echo ran" &&
  ! printf '%s' "$LOGTEXT" | grep -q chown && pass "as root on a folder of uid 1000 (an older agent): runs as uid 1000, folder untouched" ||
  flunk "as root on a uid 1000 folder" "$OUT / $LOGTEXT"
printf '%s' "$LOGTEXT" | grep -q "chmod 0700 $T/data/panel" && pass "the folder is closed to other users" || flunk "chmod 0700" "$LOGTEXT"

run 0 "0:0"
[ "$OUT" = ran ] && printf '%s' "$LOGTEXT" | grep -q "chown -hR $PANEL_UID:$PANEL_UID $T/data/panel" &&
  printf '%s' "$LOGTEXT" | grep -q -- "setpriv --reuid=$PANEL_UID --regid=$PANEL_UID " &&
  pass "as root on a root-owned folder: the folder goes to the panel user, the command runs as it" ||
  flunk "as root on a root-owned folder" "$OUT / $LOGTEXT"

run 0 "$PANEL_UID:$PANEL_UID"
printf '%s' "$LOGTEXT" | grep -q -- "setpriv --reuid=$PANEL_UID --regid=$PANEL_UID " && ! printf '%s' "$LOGTEXT" | grep -q chown &&
  pass "as root on a moved folder (docker run by hand): runs as the panel user" || flunk "as root on a moved folder" "$LOGTEXT"

run 0 "1000:0"
printf '%s' "$LOGTEXT" | grep -q -- "setpriv --reuid=1000 --regid=1000 " && pass "never root's group either" || flunk "root group" "$LOGTEXT"

mkdir -p "$T/other"
run 0 "0:0" "${PREFIX}_DATA_DIR=$T/other"
printf '%s' "$LOGTEXT" | grep -q "chown -hR $PANEL_UID:$PANEL_UID $T/other" && pass "${PREFIX}_DATA_DIR names the folder" ||
  flunk "${PREFIX}_DATA_DIR" "$LOGTEXT"

if [ "$failures" -gt 0 ]; then
  echo "panel entrypoint tests: $failures failed"
  exit 1
fi
echo "panel entrypoint tests: all passed"
