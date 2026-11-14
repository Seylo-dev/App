#!/usr/bin/env bash
# Browser tests in one command: starts a panel on a fresh data dir and the
# Vite dev server in front of it, runs the Playwright specs, stops both.
#
#   test/playwright/run.sh                     everything: smoke (setup, sign-in, real
#                                              panel), flows (settings and CLI sign-in
#                                              on the real panel), databases (the engine
#                                              form and connection tabs) and screens
#                                              (every screen with demo data, every preset light and dark)
#   PRESETS=seylo MODES=dark test/playwright/run.sh  screens in one preset and half only
#   test/playwright/run.sh --project smoke     extra arguments go to `playwright test`
#
# Environment: PANEL_PORT (3151), WEB_PORT (5251), DATA_DIR (a new temp dir,
# deleted afterwards unless set), SHOTS_DIR (test/playwright/shots),
# CPU_THROTTLE (say 6: every page runs that many times slower, which brings
# out timing bugs such as a render loop that needs slow renders).
#
# Every test fails on an uncaught page error or a React render loop warning
# in any page it opens (the `test` in helpers.ts), with the page's stack.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
source "$root/installer/brand.env"
prefix="$(printf '%s' "$BRAND_SLUG" | tr '[:lower:]-' '[:upper:]_')_"

panel_port="${PANEL_PORT:-3151}"
web_port="${WEB_PORT:-5251}"
keep_data=1
if [ -z "${DATA_DIR:-}" ]; then
  DATA_DIR="$(mktemp -d)"
  keep_data=0
fi
shots="${SHOTS_DIR:-$here/shots}"
mkdir -p "$shots"
# The setup step needs a panel that never had an owner.
rm -rf "${DATA_DIR:?}"/panel.db* "$DATA_DIR"/metrics.db* "$DATA_DIR"/master.key "$DATA_DIR"/setup-token

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "$keep_data" = 0 ]; then rm -rf "$DATA_DIR"; fi
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "run.sh: $name did not come up at $url" >&2
  exit 1
}

(cd "$here" && bun install --frozen-lockfile >/dev/null)
"$here/node_modules/.bin/playwright" install chromium >/dev/null

# The specs stand in for GitHub where they need it, so this panel never talks
# to it: a placeholder client id keeps GitHub off whatever brand.json holds,
# and the official template catalog's URL is the panel's own 404 (compiled
# in with --define, templates/remote.ts __TEST_CATALOG_URL__), so its
# catalog check says the catalog is not published yet, as GitHub does until
# the Templates repo publishes its first one.
# DO_NOT_TRACK and <SLUG>_TELEMETRY are emptied: a runner that exports one would lock telemetry off, and the
# smoke spec checks the default-on setup page.
env DO_NOT_TRACK= "${prefix}TELEMETRY=" "${prefix}DATA_DIR=$DATA_DIR" "${prefix}PORT=$panel_port" "${prefix}HOST=127.0.0.1" "${prefix}SECURE_COOKIES=false" \
  "${prefix}GITHUB_CLIENT_ID=PLACEHOLDER_GITHUB_OAUTH_CLIENT_ID" \
  bun --define "__TEST_CATALOG_URL__:\"http://127.0.0.1:$panel_port/api/templates/-/catalog.json\"" \
  "$root/apps/panel/src/main.ts" >"$shots/panel.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$panel_port/api/v1/settings.boot" "the panel"

(cd "$root/apps/web" && PANEL_URL="http://127.0.0.1:$panel_port" exec ./node_modules/.bin/vite --port "$web_port" --strictPort --host 127.0.0.1 \
  >"$shots/vite.log" 2>&1) &
pids+=($!)
wait_for "http://127.0.0.1:$web_port/" "Vite"

cd "$here"
BASE_URL="http://127.0.0.1:$web_port" PANEL_DATA_DIR="$DATA_DIR" SHOTS_DIR="$shots" RESULTS_DIR="$shots/results" \
  ./node_modules/.bin/playwright test "$@"
