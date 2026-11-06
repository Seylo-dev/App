#!/usr/bin/env bash
# Installs the panel + node on A with the real installer, creates the owner
# through the setup link, then joins B with a join token from the panel.
# Leaves the owner's session cookie in dist/e2e/cookies for checks.sh.
#
# Usage: test/e2e-colima/install.sh
source "$(dirname "$0")/lib.sh"

arch=$(vm_arch)
bin=$E2E_OUT/${BRAND_SLUG}_linux_$arch
[ -x "$bin" ] || fail "run build.sh first"
ip_a=$(vm_ip "$E2E_A")
panel=http://$ip_a:$E2E_PORT

log "installing the panel + node on $E2E_A"
out=$(on "$E2E_A" "sh '$E2E_OUT/install.sh' --binary '$bin' --image '$E2E_IMAGE' --port $E2E_PORT --yes" 2>&1) || {
  echo "$out"
  fail "installer failed on $E2E_A"
}
echo "$out"
setup_token=$(printf '%s\n' "$out" | sed -n 's/.*\/setup?t=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)
[ -n "$setup_token" ] || fail "the installer printed no setup link"

wait_for 120 "the panel at $panel" curl -fsS "$panel/api/health"

log "creating the owner through the setup link"
rm -f "$E2E_OUT/cookies"
email=owner@e2e.test
password=$(openssl rand -hex 16)
printf '%s\n%s\n' "$email" "$password" >"$E2E_OUT/owner"
panel_api POST setup.createOwner "{\"token\":\"$setup_token\",\"email\":\"$email\",\"name\":\"E2E\",\"password\":\"$password\"}" >/dev/null ||
  fail "setup.createOwner failed"

log "waiting for $E2E_A's own node to join"
wait_for 120 "the panel node" sh -c "panel_list=\$(curl -fsS -b '$E2E_OUT/cookies' '$panel/api/v1/nodes.list'); echo \"\$panel_list\" | grep -q '\"online\":true'"

log "joining $E2E_B"
join=$(panel_api POST nodes.createJoinToken '{}') || fail "nodes.createJoinToken failed"
token=$(printf '%s' "$join" | json_field token)
[ -n "$token" ] || fail "no join token in: $join"
on "$E2E_B" "sh '$E2E_OUT/install.sh' join '$panel' --token '$token' --binary '$bin' --name e2e-b --yes" ||
  fail "installer join failed on $E2E_B"

wait_for 120 "two online nodes" sh -c "test \$(curl -fsS -b '$E2E_OUT/cookies' '$panel/api/v1/nodes.list' | grep -o '\"online\":true' | wc -l) -ge 2"
log "both nodes are online"
