#!/usr/bin/env bash
# The three-VM end-to-end test (`make e2e`): create the VMs, start the release
# and git servers on the Mac and the infrastructure containers on A, build
# releases N, N+1 and a broken N+2 (test-signed), then run every check of the
# checklist and write RESULTS.md. Checks report PASS/FAIL/BLOCKED and the run
# goes on after a failure; the exit code is 1 when any check failed.
#
#   KEEP=1       keep the VMs afterwards (to look around or rerun one check)
#   CHECKS="1 2 3"  run only these checks (default: all 40)
#   E2E_A, E2E_B, E2E_C, E2E_PORT, E2E_OUT, ...  see lib.sh
#
# Steps can run alone: up.sh, serve.sh, infra.sh, build.sh [step], publish.sh <v>,
# checks.sh [N ...], down.sh.
source "$(dirname "$0")/lib.sh"
dir=$(dirname "$0")

cleanup() {
  if [ -z "${KEEP:-}" ]; then
    "$dir/down.sh"
  else
    log "KEEP=1: VMs $E2E_A, $E2E_B and $E2E_C and the servers on the Mac are still running (test/e2e-colima/down.sh removes them)"
  fi
}
trap cleanup EXIT

"$dir/up.sh"
"$dir/serve.sh"
"$dir/infra.sh"
"$dir/build.sh"
# shellcheck disable=SC2086
"$dir/checks.sh" ${CHECKS:-}
if grep -qx FAIL "$E2E_STATE"/results/*.status 2>/dev/null; then
  log "e2e finished with failures: see test/e2e-colima/RESULTS.md"
  exit 1
fi
log "e2e passed (see test/e2e-colima/RESULTS.md)"
