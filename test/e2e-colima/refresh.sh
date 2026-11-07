#!/usr/bin/env bash
# Puts the working tree on the kept VMs through the product's own update
# path, so single checks can be rerun against new code without a fresh
# `make e2e`: builds the next test release (0.2.3, then 0.2.4, ...) the way
# build.sh builds the others (agents, the panel image on A, signed manifest),
# publishes it as latest and runs updates.updatePanel: the panel first, then
# the nodes one by one. New migrations apply as in any update (0000_init is
# frozen since the first release; schema changes are new migrations).
#
# After a refresh, check 22 (N -> N+1, broken N+2) cannot be rerun alone: the
# VMs run a newer version than N+1. A fresh `make e2e` starts over.
#
# Usage: test/e2e-colima/refresh.sh        (make e2e-refresh)
source "$(dirname "$0")/lib.sh"
dir=$(dirname "$0")

[ -n "$(state_get api-key)" ] || fail "no API key in $E2E_STATE (run the checks once first)"
curl -fsS -m 5 -o /dev/null "$(panel_url)/api/health" || fail "the e2e panel at $(panel_url) does not answer"

last=$(state_get refresh-version)
[ -n "$last" ] || last=$E2E_V3
v=${last%.*}.$((${last##*.} + 1))
log "building test release $v from the working tree"
E2E_BUILD_VERSIONS=$v "$dir/build.sh" agents panel release
"$dir/publish.sh" "$v"

panel_version() { curl -fsS -m 5 "$(panel_url)/api/health" | jq -r .version; }
agents_at() { api nodes.list | jq -e --arg v "$1" '[.nodes[] | select((.agentVersion // "" | split(" ")[0]) != $v)] | length == 0' >/dev/null; }
run_finished() { api updates.history '{"limit":1}' | jq -e '.runs[0].status != "running"' >/dev/null; }

api updates.check '{}' >/dev/null || fail "updates.check failed"
seen=$(api updates.status | jq -r .panel.latestVersion)
[ "$seen" = "$v" ] || fail "the panel sees $seen as the latest release, not $v"
api updates.updatePanel '{"panelOnly":false}' >/dev/null || fail "updates.updatePanel failed"
log "updating the panel, then the nodes, to $v"
wait_for 600 "the panel at $v" sh -c "[ \"\$(curl -fsS -m 5 '$(panel_url)/api/health' | jq -r .version)\" = '$v' ]" ||
  fail "the panel is at $(panel_version), not $v"
wait_for 900 "every agent at $v" agents_at "$v" ||
  fail "not every agent is at $v: $(api nodes.list | jq -c '[.nodes[] | "\(.name)=\(.agentVersion)"]')"
wait_for 300 "the update run to finish" run_finished || true
state_set refresh-version "$v"
log "the VMs run $v: $(api updates.history '{"limit":1}' | jq -c '.runs[0] | {targetVersion, status}')"
