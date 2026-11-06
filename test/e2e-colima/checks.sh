#!/usr/bin/env bash
# The e2e checklist against the three VMs. One function per check
# (check_01 .. check_31); each prints its sub-results with evidence and ends
# PASS, FAIL, BLOCKED (a precondition is missing, with the reason) or SKIP.
# Results are kept per check in dist/e2e/state/results and RESULTS.md (next
# to this file) is rewritten from them after every run, so a single check
# can be rerun alone.
#
# Usage: test/e2e-colima/checks.sh [N ...]     (default: 1..31 in order)
#        test/e2e-colima/checks.sh report      rewrite RESULTS.md only
#
# Panel calls go through the REST op routes (/api/v1/<op id>) with the API
# key check 2 creates (dist/e2e/state/api-key); the CLI checks use the seylo
# binary as the check says.
source "$(dirname "$0")/lib.sh"

RES=$E2E_STATE/results
mkdir -p "$RES"
ORG=$BRAND_GITHUB_ORG
REPO=$BRAND_GITHUB_REPO
REG=127.0.0.1:$E2E_REG_PORT
PUBKEY=$(sed -n 2p "$E2E_KEYS/e2e-test.pub")
arch=$(vm_arch)

# ---------------------------------------------------------------- framework

TITLES=(
  ""
  "install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service"
  "Owner through the setup link; API key; REST op routes"
  "Join B and C (C gets Docker from install.sh); 3 nodes online; health checks"
  "Image service on B with an auto domain; first-run IP:port -> 308 -> closed"
  "Railpack git build on A, run on B through the 127.0.0.1:5755 relay"
  "Dockerfile from git, inline Dockerfile and uploaded archive deploy"
  "Zero downtime redeploy; failing health check keeps old; rollback"
  "Crash policy: 5s restart, stop after N, crash report + one alert per streak"
  "Env references across services; env.analyze flags cross-node address"
  "Postgres: internal URL, project isolation, TLS exposure, web UI, DB shell"
  "Backup Postgres and a volume to MinIO, restore both"
  "Cron: schedule, run-now, history, keeps running while the panel is down"
  "Logs search/follow across deploys; console stdin; shell PTY; files"
  "Metrics: node and service series have samples"
  "Move a service with a volume B -> C; data intact; domain follows"
  "Replicas on B and C, entry on B; failover when one container dies"
  "Compose stack from pasted YAML (two services, shared volume)"
  "A template from the catalog creates and runs"
  "Global and per-service maintenance pages; timed expose locked to an IP"
  "Panel down: apps, routes, crash restarts, cron keep working; outbox delivers"
  "Agent restart adopts running services without restarting them"
  "Self-update N -> N+1 (panel first, then nodes); broken N+2 panel rolls back"
  "Cleanup preview + run removes only seylo-labeled garbage"
  "Laptop CLI: login, deploy, env set/list, logs -f"
  "MCP: read-only token lists tools and runs a query; destructive call -> approval"
  "seylo troubleshoot --dry-run redacts; seylo status shows the connection"
  "Uninstall on C leaves nothing behind"
  "C (systemd cgroup driver) runs containers under seylo.slice"
  "(stretch) ACME certificate from a local Pebble CA"
  "Web smoke with Playwright against the e2e panel"
  "Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI"
)
# The last check. Check 31 gives the panel a domain and puts everything back
# afterwards; it runs last so a failed cleanup cannot spoil the others.
LAST=31

CUR=
CUR_FAILS=0
CUR_STATUS=
# ev <text>: one evidence line for the current check.
ev() {
  printf '    %s\n' "$*" >&2
  printf '%s\n' "$*" >>"$RES/$CUR.evidence"
}
# expect <description> <command...>: a sub-assertion; failures mark the check FAIL.
expect() {
  local what=$1
  shift
  if "$@" >>"$RES/$CUR.log" 2>&1; then
    ev "ok   $what"
  else
    ev "FAIL $what"
    CUR_FAILS=$((CUR_FAILS + 1))
  fi
}
# bad <text>: record a failed sub-result with its cause.
bad() {
  ev "FAIL $*"
  CUR_FAILS=$((CUR_FAILS + 1))
}
good() { ev "ok   $*"; }
# blocked <reason>: the check cannot run (missing precondition or product gap).
blocked() {
  ev "BLOCKED $*"
  CUR_STATUS=BLOCKED
  return 3
}

run_check() {
  local n fn
  n=$(printf '%02d' "$((10#$1))")
  fn=check_$n
  CUR=$n
  CUR_FAILS=0
  CUR_STATUS=
  : >"$RES/$n.evidence"
  : >"$RES/$n.log"
  printf '\n[check %s] %s\n' "$n" "${TITLES[$((10#$n))]}" >&2
  local start=$SECONDS rc=0
  if declare -F "$fn" >/dev/null; then
    "$fn" || rc=$?
  else
    ev "not implemented in checks.sh"
    CUR_STATUS=SKIP
  fi
  local status=$CUR_STATUS
  if [ -z "$status" ]; then
    if [ "$rc" = 0 ] && [ "$CUR_FAILS" = 0 ]; then status=PASS; else status=FAIL; fi
  fi
  printf '%s\n' "$status" >"$RES/$n.status"
  # The panel version too: single checks rerun after refresh.sh run newer code than the rest.
  local version
  version=$(curl -fsS -m 3 "$(panel_url)/api/health" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
  printf '%s\n' "$((SECONDS - start))s, $(date '+%Y-%m-%d %H:%M')${version:+, panel $version}" >"$RES/$n.meta"
  printf '[check %s] %s (%ss)\n' "$n" "$status" "$((SECONDS - start))" >&2
}

write_report() {
  local out=$E2E_DIR/RESULTS.md n status pass=0 failn=0 other=0
  {
    printf '# E2E results\n\n'
    printf 'Written by `test/e2e-colima/checks.sh` from `~/.cache/seylo-e2e/state/results` (rerun one check with\n'
    printf '`test/e2e-colima/checks.sh <N>`). VMs: %s (panel + node, Colima), %s (Colima), %s (plain\n' "$E2E_A" "$E2E_B" "$E2E_C"
    printf 'Lima Ubuntu 24.04, Docker installed by install.sh). Release server and git server on the Mac.\n\n'
    printf '| # | Check | Status | When |\n|---|---|---|---|\n'
    for i in $(seq 1 "$LAST"); do
      n=$(printf '%02d' "$i")
      status=$(cat "$RES/$n.status" 2>/dev/null || echo "NOT RUN")
      printf '| %s | %s | %s | %s |\n' "$i" "${TITLES[$i]}" "$status" "$(cat "$RES/$n.meta" 2>/dev/null || true)"
      case $status in PASS) pass=$((pass + 1)) ;; FAIL) failn=$((failn + 1)) ;; *) other=$((other + 1)) ;; esac
    done
    printf '\n%s passed, %s failed, %s blocked/skipped/not run.\n\n## Evidence\n' "$pass" "$failn" "$other"
    for i in $(seq 1 "$LAST"); do
      n=$(printf '%02d' "$i")
      [ -f "$RES/$n.status" ] || continue
      printf '\n### %s. %s: %s\n\n```\n' "$i" "${TITLES[$i]}" "$(cat "$RES/$n.status")"
      cat "$RES/$n.evidence"
      printf '```\n'
    done
  } >"$out"
  log "wrote $out ($pass passed, $failn failed, $other other)"
}

# ---------------------------------------------------------------- helpers

# run_for <seconds> <command...>: runs a command and stops it after that long
# (macOS has no timeout(1)). Returns the command's status, 124 when stopped.
run_for() {
  local secs=$1
  shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local killer=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$killer" 2>/dev/null || true
  wait "$killer" 2>/dev/null || true
  [ "$rc" != 143 ] || rc=124
  return $rc
}

need_key() { [ -n "$(state_get api-key)" ] || blocked "no API key yet (run check 2)"; }
node_id() { state_get "node-$1"; } # a|b|c
node_ip() {
  case $1 in a) vm_ip "$E2E_A" ;; b) vm_ip "$E2E_B" ;; c) vm_ip "$E2E_C" ;; esac
}
vm_of() {
  case $1 in a) echo "$E2E_A" ;; b) echo "$E2E_B" ;; c) echo "$E2E_C" ;; esac
}
on_node() { local n=$1; shift; on "$(vm_of "$n")" "$@"; }

# installer_cmd: what a server runs to fetch the installer from the release server.
installer_fetch() { echo "curl -fsSL $(release_base)/install.sh"; }

# The update key the agents trust for e2e releases, also as a systemd drop-in
# on every node (on top of the build-time key), written before install.sh.
write_key_dropin() {
  on "$1" "mkdir -p /etc/systemd/system/$SLUG.service.d && printf '%s\n' '[Service]' \
    'Environment=$(printf %s "$SLUG" | tr '[:lower:]-' '[:upper:]_')_UPDATE_PUBLIC_KEY=$PUBKEY' \
    >/etc/systemd/system/$SLUG.service.d/e2e-test-key.conf"
}

panel_container() { on "$E2E_A" "docker ps -aq --filter label=$SLUG.service=panel00000000000 | head -1"; }

# panel_sql <sql>: read-only query on the panel's SQLite inside its container (JSON rows).
panel_sql() {
  local c
  c=$(panel_container)
  [ -n "$c" ] || return 1
  printf '%s' "$1" | on "$E2E_A" "docker exec -i $c bun -e '
    const { Database } = require(\"bun:sqlite\");
    const sql = await Bun.stdin.text();
    const db = new Database(\"$BRAND_DATA_DIR/panel/panel.db\", { readonly: true });
    console.log(JSON.stringify(db.query(sql).all()));
  '"
}

# panel_sql_write <sql>: one write on the panel's SQLite (only to move a
# stored time into the past, standing in for waiting a day).
panel_sql_write() {
  local c
  c=$(panel_container)
  [ -n "$c" ] || return 1
  printf '%s' "$1" | on "$E2E_A" "docker exec -i $c bun -e '
    const { Database } = require(\"bun:sqlite\");
    const sql = await Bun.stdin.text();
    const db = new Database(\"$BRAND_DATA_DIR/panel/panel.db\");
    db.exec(\"PRAGMA busy_timeout = 5000\");
    console.log(JSON.stringify(db.run(sql)));
  '"
}

project_id() { # name -> id (creates it)
  local name=$1 id
  id=$(state_get "project-$name")
  if [ -n "$id" ] && api projects.get "{\"projectId\":\"$id\"}" >/dev/null 2>&1; then
    echo "$id"
    return
  fi
  id=$(api projects.list | jq -r --arg n "$name" '.projects[] | select(.name==$n) | .id' | head -1)
  [ -n "$id" ] || id=$(api projects.create "{\"name\":\"$name\"}" | jq -r '.project.id // .id')
  state_set "project-$name" "$id"
  echo "$id"
}

# service_id <project-name> <service-name>: id of an existing service, or "".
service_id() {
  local pid
  pid=$(project_id "$1")
  api services.list "{\"projectId\":\"$pid\"}" | jq -r --arg n "$2" '.services[] | select(.name==$n) | .id' | head -1
}

# delete_service <project> <name>: removes a service left by an earlier run.
delete_service() {
  local id
  id=$(service_id "$1" "$2")
  [ -z "$id" ] || api services.delete "{\"serviceId\":\"$id\",\"confirmName\":\"$2\"}" >/dev/null || true
  [ -z "$id" ] || sleep 3
}

svc_status() { api services.get "{\"serviceId\":\"$1\"}" | jq -r .status; }
svc_running() { [ "$(svc_status "$1")" = running ]; }

# latest_deploy <service>: newest deployment as JSON.
latest_deploy() { api deployments.list "{\"serviceId\":\"$1\",\"limit\":1}" | jq -c '.deployments[0]'; }

# wait_deploy <service> <seconds> [deployment id]: waits for a final state, prints it.
wait_deploy() {
  local svc=$1 secs=$2 dep=${3:-} end=$((SECONDS + $2)) st=
  [ -n "$dep" ] || dep=$(latest_deploy "$svc" | jq -r .id)
  while [ $SECONDS -lt $end ]; do
    st=$(api deployments.get "{\"serviceId\":\"$svc\",\"deploymentId\":\"$dep\"}" | jq -r .deployment.status) || st=error
    case $st in live | failed | cancelled | superseded) break ;; esac
    sleep 3
  done
  printf '%s\n' "$st"
}

deploy_info() { api deployments.get "{\"serviceId\":\"$1\",\"deploymentId\":\"$2\"}"; }

deploy_log_tail() {
  api deployments.log "{\"serviceId\":\"$1\",\"deploymentId\":\"$2\",\"limit\":400}" 2>/dev/null |
    jq -r '(.lines // .entries // [])[] | (.line // .text // tostring)' | tail -"${3:-15}"
}

# first_run_addr <service>: the open first-run IP:port, or "".
# Nodes without a detected public IPv4 show their name as the host
# ("e2e-b:38033"): map node names to the VM addresses.
first_run_addr() { addr_of "$(api exposures.get "{\"serviceId\":\"$1\"}" | jq -r '.firstRun.address // empty')"; }
addr_of() {
  local a=$1 host port
  [ -n "$a" ] || return 0
  host=${a%:*}
  port=${a##*:}
  case $host in
  *e2e-a*) host=$(node_ip a) ;;
  *e2e-b*) host=$(node_ip b) ;;
  *e2e-c*) host=$(node_ip c) ;;
  esac
  echo "$host:$port"
}

# create_service <json>: services.create, prints the new id.
create_service() { api services.create "$1" | jq -r '.service.id // .id'; }

http_code() { curl -s -o /dev/null -m "${3:-5}" -w '%{http_code}' "$@" 2>/dev/null || true; }

# ---------------------------------------------------------------- 1-3 install

check_01() {
  local out link token cid1 cid2 cid3 started1 started3 labels
  write_key_dropin "$E2E_A"
  if on "$E2E_A" "grep -q '^node_id:' $BRAND_DATA_DIR/config.yml 2>/dev/null"; then
    ev "A was installed by an earlier run; re-running the installer (keeps the node)"
  fi
  # No --image: the installer takes the panel image from the signed release
  # manifest, pinned by its digest, as a real install does.
  out=$(on "$E2E_A" "$(installer_fetch) | sh -s -- --release-url $(release_base)/$ORG/$REPO/releases \
    --version $E2E_V1 --port $E2E_PORT" 2>&1) || {
    printf '%s\n' "$out" >>"$RES/$CUR.log"
    bad "install.sh failed on A: $(printf '%s' "$out" | grep -i error | tail -2 | tr '\n' ' ')"
    return 1
  }
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  link=$(printf '%s\n' "$out" | grep -o 'https\?://[^ ]*/setup?t=[A-Za-z0-9_-]*' | head -1 || true)
  if [ -n "$link" ]; then
    token=${link##*t=}
    state_set setup-token "$token"
    good "install.sh printed the setup link ${link%%t=*}t=<redacted>"
    case $link in
    *"$(vm_ip "$E2E_A")"*) good "the link uses A's address $(vm_ip "$E2E_A")" ;;
    *) ev "note: the link host is not A's vzNAT address $(vm_ip "$E2E_A") (the VM has two interfaces)" ;;
    esac
  elif printf '%s' "$out" | grep -q 'Already installed'; then
    ev "installer: already installed, no new setup link (expected on a rerun)"
  else
    bad "install.sh printed no setup link"
  fi
  expect "panel answers on $(panel_url)/api/health" wait_for 120 "panel health" curl -fsS "$(panel_url)/api/health"
  expect "$SLUG.service is active on A" on "$E2E_A" "systemctl is-active --quiet $SLUG.service"
  wait_for 120 "A's agent connected" on "$E2E_A" "$SLUG status 2>&1 | grep -qi 'connected'" &&
    good "A's agent joined its own panel: $(on "$E2E_A" "$SLUG status 2>&1 | grep -i -m1 connect" | tr -s ' ')" ||
    bad "A's agent did not connect to the panel: $(on "$E2E_A" "$SLUG status 2>&1 | tail -5" | tr '\n' ' ')"

  cid1=$(panel_container)
  [ -n "$cid1" ] || { bad "no container labelled $SLUG.service=panel00000000000"; return 1; }
  local want_image
  if ! printf '%s' "$out" | grep -q 'Already installed'; then
    printf '%s' "$out" | grep -q 'Release signature verified' &&
      good "install.sh checked the signed release manifest" ||
      bad "install.sh did not report a verified release signature"
    want_image="$REG/$SLUG:$E2E_V1@$(state_get "panel-digest-$E2E_V1")"
    expect "the panel runs the release's image pinned by digest ($want_image)" \
      test "$(on "$E2E_A" "docker inspect -f '{{.Config.Image}}' $cid1")" = "$want_image"
  fi
  labels=$(on "$E2E_A" "docker inspect -f '{{json .Config.Labels}}' $cid1")
  printf '%s\n' "$labels" >>"$RES/$CUR.log"
  ev "panel container $cid1: $(printf '%s' "$labels" | jq -c "with_entries(select(.key|startswith(\"$SLUG.\")))")"
  expect "panel container is in project panelproject0000" test "$(printf '%s' "$labels" | jq -r ".[\"$SLUG.project\"]")" = panelproject0000
  expect "panel container is protected" test "$(printf '%s' "$labels" | jq -r ".[\"$SLUG.protected\"]")" = true
  started1=$(on "$E2E_A" "docker inspect -f '{{.State.StartedAt}}' $cid1")
  # Give reconcile time to adopt (or wrongly roll) the container.
  sleep 25
  cid2=$(panel_container)
  expect "no roll after the join: same container $cid1 (now $cid2)" test "$cid1" = "$cid2"
  local pstatus
  pstatus=$(on "$E2E_A" "$SLUG panel status 2>&1" | tr -s ' \n' ' ' | head -c 300)
  ev "seylo panel status: $pstatus"
  case $pstatus in
  *"not on this node"* | *stopped*) bad "the agent does not manage the panel as its protected service (seylo panel status: $pstatus)" ;;
  *) good "the agent manages the panel service" ;;
  esac
  on "$E2E_A" "systemctl restart $SLUG.service"
  wait_for 90 "A's agent back" on "$E2E_A" "$SLUG status 2>&1 | grep -qi 'connected'" || true
  sleep 20
  cid3=$(panel_container)
  started3=$(on "$E2E_A" "docker inspect -f '{{.State.StartedAt}}' $cid3 2>/dev/null")
  expect "panel container survives an agent restart (same id, StartedAt $started1)" \
    test "$cid1" = "$cid3" -a "$started1" = "$started3"
  expect "panel still answers after the agent restart" wait_for 60 "panel health" curl -fsS "$(panel_url)/api/health"
  state_set panel-container "$cid1"
}

# reauth <cookie jar>: confirms the owner's password on that browser session,
# which then counts as a fresh sign-in for 15 minutes. apiKeys.create and
# cliLogin.approve need one; a panel from before re-auth existed has no
# auth.reauth and needs none, so a failure here is not one.
reauth() {
  local pw
  pw=$(sed -n 2p "$E2E_STATE/owner" 2>/dev/null)
  [ -n "$pw" ] || return 0
  curl -sS -m 30 -o /dev/null -c "$1" -b "$1" -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
    --data "$(jq -nc --arg p "$pw" '{password: $p}')" "$(panel_url)/api/v1/auth.reauth" >/dev/null 2>&1 || true
}

# create_key <cookie jar>: apiKeys.create with the owner's browser session.
create_key() {
  local key
  reauth "$1"
  key=$(curl -fsS -c "$1" -b "$1" -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
    --data '{"kind":"api","name":"e2e","actions":["*"],"readOnly":false,"expiresInDays":30}' \
    "$(panel_url)/api/v1/apiKeys.create" | jq -r .token) || true
  [ -n "$key" ] && [ "$key" != null ] || { bad "apiKeys.create returned no token"; return 1; }
  state_set api-key "$key"
  good "API key created with the owner session (prefix ${key:0:12}...)"
}

check_02() {
  local token jar status email password key whoami projects pp svc
  token=$(state_get setup-token)
  jar=$E2E_STATE/cookies
  email=owner@e2e.test
  if [ -n "$(state_get api-key)" ] && api auth.whoami >/dev/null 2>&1; then
    ev "owner and API key exist from an earlier run"
  else
    if [ -s "$E2E_STATE/owner" ] && [ ! -s "$jar" ]; then rm -f "$jar"; fi
    if [ -s "$jar" ] && curl -fsS -b "$jar" "$(panel_url)/api/v1/auth.whoami" >/dev/null 2>&1; then
      ev "owner exists; creating the API key with the saved session"
      create_key "$jar" || return 1
    else
    [ -n "$token" ] || { blocked "no setup token (run check 1)"; return 3; }
    status=$(curl -fsS "$(panel_url)/api/v1/setup.status?token=$token") || { bad "setup.status failed"; return 1; }
    ev "setup.status: $(printf '%s' "$status" | jq -c '{ownerExists, link}')"
    expect "the setup link is valid" test "$(printf '%s' "$status" | jq -r .link.valid)" = true
    password=$(openssl rand -hex 16)
    printf '%s\n%s\n' "$email" "$password" >"$E2E_STATE/owner"
    rm -f "$jar"
    curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $(panel_url)" \
      -X POST --data "{\"token\":\"$token\",\"email\":\"$email\",\"name\":\"E2E Owner\",\"password\":\"$password\"}" \
      "$(panel_url)/api/v1/setup.createOwner" >>"$RES/$CUR.log" || { bad "setup.createOwner failed"; return 1; }
    good "owner $email created through setup.createOwner (session cookie)"
    create_key "$jar" || return 1
    fi
  fi
  whoami=$(api auth.whoami) && good "auth.whoami with the API key: $(printf '%s' "$whoami" | jq -c '{email: (.viewer.email // .email // .user.email), kind: (.principal.kind // .kind // null)}')" ||
    bad "auth.whoami with the API key failed"
  projects=$(api projects.list) || { bad "projects.list failed"; return 1; }
  pp=$(printf '%s' "$projects" | jq -c '.projects[] | select(.id=="panelproject0000")')
  if [ -n "$pp" ]; then
    good "Panel project: $(printf '%s' "$pp" | jq -c '{id,name,protected,serviceCount}')"
    expect "Panel project is protected" test "$(printf '%s' "$pp" | jq -r .protected)" = true
    svc=$(api services.list '{"projectId":"panelproject0000"}' | jq -c '.services[] | select(.id=="panel00000000000")')
    [ -n "$svc" ] && good "panel service: $(printf '%s' "$svc" | jq -c '{id,name,status,protected,placements:[.placements[].nodeName]}')" ||
      bad "no panel service panel00000000000 in the Panel project"
  else
    bad "no Panel project panelproject0000 (projects: $(printf '%s' "$projects" | jq -c '[.projects[].name]')); the installer's panel bootstrap did not create it"
  fi
}

# join_node <vm> <letter> [extra installer flags]
join_node() {
  local vm=$1 letter=$2 extra=${3:-} join cmd out
  join=$(api nodes.createJoinToken '{}') || { bad "nodes.createJoinToken failed"; return 1; }
  cmd=$(printf '%s' "$join" | jq -r .command)
  ev "join command from the panel: $(printf '%s' "$cmd" | sed 's/--token [^ ]*/--token <redacted>/; s/seylo_join_[A-Za-z0-9_-]*/<redacted>/')"
  # A panel without a domain hands out its agents' TLS port with the key pinned.
  if [ "$CUR" = 03 ]; then
    case $cmd in
    *"--panel 'https://"*"--pin 'sha256:"*) good "the join command uses the agents' TLS port with --pin (insecureTransport $(printf '%s' "$join" | jq -r .insecureTransport))" ;;
    *) bad "the join command is not https:// with --pin: $(printf '%s' "$cmd" | grep -o "\-\-panel '[^']*'")" ;;
    esac
    case $cmd in
    *--insecure*) bad "the join command carries --insecure" ;;
    *) good "the join command needs no --insecure" ;;
    esac
  fi
  # Same command, with the installer from the e2e release server.
  cmd=$(printf '%s' "$cmd" | sed -E "s#curl -fsSL [^ |]+#$(installer_fetch)#")
  case $cmd in
  *"--panel 'http://127.0.0.1"* | *"--panel 'http://localhost"*)
    local msg
    msg="the join command points other servers at the panel's loopback address ($(printf '%s' "$cmd" | grep -o "\-\-panel '[^']*'")); using $(panel_url) instead"
    # Check 3 owns this finding; later joins only note it.
    if [ "$CUR" = 03 ]; then bad "$msg"; else ev "note: $msg"; fi
    cmd=$(printf '%s' "$cmd" | sed -E "s#--panel '[^']*'#--panel '$(panel_url)'#")
    ;;
  esac
  cmd="$cmd --release-url $(release_base)/$ORG/$REPO/releases --version $(state_get published) $extra"
  # A node left half-joined by an earlier run joins again.
  if on "$vm" "test -f $BRAND_DATA_DIR/config.yml"; then cmd="$cmd --force"; fi
  write_key_dropin "$vm"
  out=$(on "$vm" "$cmd" 2>&1) || {
    printf '%s\n' "$out" >>"$RES/$CUR.log"
    bad "join on $vm failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    return 1
  }
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  good "installer join on $vm finished: $(printf '%s' "$out" | grep -E 'Docker|Joining|joins' | tr '\n' ';' | head -c 300)"
}

# pinned_join <vm>: config.yml holds an https:// panel URL and its pin, and no insecure_transport.
pinned_join() {
  local cfg
  cfg=$(on "$1" "cat $BRAND_DATA_DIR/config.yml") || return 1
  printf '%s\n' "$cfg" | grep -q '^panel_url: https://' && printf '%s\n' "$cfg" | grep -q '^panel_pin: sha256:' &&
    ! printf '%s\n' "$cfg" | grep -q '^insecure_transport:'
}

# refuses_plain_join: on B, in a scratch data dir, `join http://<A>:<port>` fails naming --insecure and writes no config.yml.
refuses_plain_join() {
  local out
  if out=$(on "$E2E_B" "rm -rf /tmp/e2e-plain-join; $SLUG --data-dir /tmp/e2e-plain-join join http://$(vm_ip "$E2E_A"):$E2E_PORT --token ${SLUG}_join_refused --no-start" 2>&1); then
    ev "plain join was accepted: $out"
    return 1
  fi
  ev "plain join refused: $(printf '%s' "$out" | tail -1 | head -c 240)"
  printf '%s' "$out" | grep -q -- '--insecure' && on "$E2E_B" "test ! -e /tmp/e2e-plain-join/config.yml"
}

nodes_online() { api nodes.list | jq '[.nodes[] | select(.status=="online")] | length'; }
# For wait_for: these re-evaluate on every try.
online_ge() { [ "$(nodes_online)" -ge "$1" ]; }
has_first_run() { [ -n "$(first_run_addr "$1")" ]; }

map_nodes() {
  local nodes
  nodes=$(api nodes.list) || return 1
  state_set node-a "$(printf '%s' "$nodes" | jq -r '.nodes[] | select(.isPanelNode) | .id' | head -1)"
  for l in b c; do
    local vm ip
    vm=$(vm_of $l)
    ip=$(node_ip $l)
    state_set "node-$l" "$(printf '%s' "$nodes" | jq -r --arg vm "$vm" --arg ip "$ip" \
      '.nodes[] | select((.facts.hostname // "" | contains($vm)) or .publicIpv4 == $ip or (.name | contains($vm))) | .id' | head -1)"
  done
}

check_03() {
  need_key || return 3
  local n nodes report
  map_nodes
  if [ -n "$(node_id b)" ]; then ev "B already joined ($(node_id b))"; else join_node "$E2E_B" b "--name e2e-b"; fi
  if [ -n "$(node_id c)" ]; then
    ev "C already joined ($(node_id c))"
  else
    if on "$E2E_C" "command -v docker >/dev/null"; then
      [ -n "$(state_get c-docker-before)" ] || state_set c-docker-before yes
    else
      state_set c-docker-before no
    fi
    case $(state_get c-docker-before) in
    no) good "C had no Docker before its first join" ;;
    *) bad "C had Docker before its first join (not a fresh VM)" ;;
    esac
    join_node "$E2E_C" c "--name e2e-c --yes"
  fi
  wait_for 180 "3 online nodes" online_ge 3 || true
  map_nodes
  nodes=$(api nodes.list)
  printf '%s\n' "$nodes" >>"$RES/$CUR.log"
  expect "3 nodes online" online_ge 3
  for l in a b c; do
    n=$(node_id $l)
    [ -n "$n" ] || { bad "node $l not found in nodes.list"; continue; }
    ev "node $l: $(printf '%s' "$nodes" | jq -c --arg id "$n" '.nodes[] | select(.id==$id) | {id,name,status,publicIpv4,agentVersion,canBuild,facts:(.facts|{hostname,os,arch,cpuCores,dockerVersion,cgroupVersion})}')"
    expect "node $l has facts" test "$(printf '%s' "$nodes" | jq -r --arg id "$n" '.nodes[] | select(.id==$id) | .facts.dockerVersion // empty')" != ""
    report=$(api nodes.runHealthCheck "{\"nodeId\":\"$n\"}") || { bad "nodes.runHealthCheck $l failed"; continue; }
    printf '%s\n' "$report" >>"$RES/$CUR.log"
    ev "health $l: $(printf '%s' "$report" | jq -c .summary) not passing: $(printf '%s' "$report" | jq -c '[.results[] | select(.status!="pass") | "\(.id)=\(.status): \(.detail|.[0:90])"]')"
    expect "health check on $l has no fail" test "$(printf '%s' "$report" | jq .summary.fail)" = 0
  done
  # B and C reached the panel over TLS with its key pinned, not plain HTTP.
  for l in b c; do
    ev "$l config.yml: $(on "$(vm_of $l)" "grep -E '^(panel_url|panel_pin|insecure_transport):' $BRAND_DATA_DIR/config.yml" 2>/dev/null | tr '\n' ' ')"
    expect "$l joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)" pinned_join "$(vm_of $l)"
  done
  expect "the agent refuses a plain-HTTP join to another server without --insecure (and writes nothing)" refuses_plain_join
  ev "C Docker after install.sh: $(on "$E2E_C" "docker version --format '{{.Server.Version}}'; docker info --format 'cgroup driver {{.CgroupDriver}} v{{.CgroupVersion}}'" 2>&1 | tr '\n' ' ')"
}

# ---------------------------------------------------------------- 4-9 apps

ipdash() { node_ip "$1" | tr . -; }
wildcard_of() { echo "$(ipdash "$1").sslip.io"; }

# image_service <project> <name> <node letter> <image> <port|""> [extra json merged into the create input]
image_service() {
  local pid nid ports input extra=${6:-}
  [ -n "$extra" ] || extra='{}'
  pid=$(project_id "$1")
  nid=$(node_id "$3")
  ports='[]'
  [ -z "$5" ] || ports="[{\"containerPort\":$5,\"protocol\":\"tcp\"}]"
  input=$(jq -nc --arg p "$pid" --arg n "$2" --arg node "$nid" --arg img "$4" --argjson ports "$ports" --argjson extra "$extra" \
    '{projectId:$p, name:$n, kind:"app", nodeId:$node, source:{type:"image", image:$img, registryId:null}, ports:$ports, deployNow:true} * $extra | del(.container)')
  # services.create takes no container settings: create, update, then deploy.
  if printf '%s' "$extra" | jq -e 'has("container")' >/dev/null; then
    local id deploy
    deploy=$(printf '%s' "$input" | jq -r .deployNow)
    id=$(create_service "$(printf '%s' "$input" | jq -c '.deployNow=false')") || return 1
    api services.update "$(jq -nc --arg id "$id" --argjson c "$(printf '%s' "$extra" | jq -c .container)" '{serviceId:$id, container:$c}')" >/dev/null || return 1
    [ "$deploy" != true ] || api deployments.deploy "{\"serviceId\":\"$id\"}" >/dev/null || return 1
    echo "$id"
    return
  fi
  create_service "$input"
}

# curl_host <letter> <host> [path]: GET through the node's Traefik with a Host header.
curl_host() { curl -sS -m 5 -H "Host: $2" "http://$(node_ip "$1")${3:-/}"; }

check_04() {
  need_key || return 3
  local nb svc st addr dom host domid code fr closeat wait_s
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined (check 3)"; return 3; }
  api nodes.updateSettings "{\"nodeId\":\"$nb\",\"wildcardDomain\":\"$(wildcard_of b)\"}" >/dev/null &&
    good "B's wildcard domain: $(wildcard_of b) (sslip.io resolves it to B's address)" || bad "nodes.updateSettings wildcardDomain failed"
  delete_service e2e whoami
  svc=$(image_service e2e whoami b traefik/whoami:v1.10.3 80) || { bad "services.create whoami failed"; return 1; }
  state_set svc-whoami "$svc"
  st=$(wait_deploy "$svc" 300)
  [ "$st" = live ] && good "whoami deployed on B (deployment $st)" || { bad "whoami deployment ended $st"; return 1; }
  wait_for 60 "first-run address" has_first_run "$svc" || true
  addr=$(first_run_addr "$svc")
  if [ -n "$addr" ]; then
    code=$(http_code "http://$addr/")
    [ "$code" = 200 ] && good "first-run IP:port $addr answers 200 before any domain" || bad "first-run $addr answered $code"
  else
    bad "no first-run IP:port opened ($(api exposures.get "{\"serviceId\":\"$svc\"}" | jq -c .firstRun))"
  fi
  dom=$(api domains.addAuto "{\"serviceId\":\"$svc\",\"subdomain\":\"whoami\",\"targetPort\":80}") || { bad "domains.addAuto failed"; return 1; }
  host=$(printf '%s' "$dom" | jq -r .host)
  domid=$(printf '%s' "$dom" | jq -r .id)
  state_set host-whoami "$host"
  ev "auto domain $host (https $(printf '%s' "$dom" | jq -r .https))"
  # No public CA can reach a private address: serve the domain over plain HTTP.
  api domains.update "{\"serviceId\":\"$svc\",\"domainId\":\"$domid\",\"https\":\"off\",\"redirectToHttps\":false}" >/dev/null ||
    bad "domains.update https off failed"
  if wait_for 120 "the domain through B's Traefik" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q Hostname"; then
    good "http://$host answers through B's Traefik: $(curl_host b "$host" | grep -m1 Hostname)"
  else
    bad "the domain does not answer through B's Traefik (code $(http_code -H "Host: $host" "http://$(node_ip b)/"))"
  fi
  [ -n "$addr" ] || return 1
  if wait_for 180 "first-run redirect" sh -c "curl -s -o /dev/null -m 5 -w '%{http_code}' http://$addr/ | grep -q 308"; then
    good "first-run $addr now redirects: $(curl -s -o /dev/null -m 5 -w '%{http_code} -> %{redirect_url}' "http://$addr/")"
  else
    bad "first-run $addr did not switch to a 308 (code $(http_code "http://$addr/"), firstRun $(api exposures.get "{\"serviceId\":\"$svc\"}" | jq -c .firstRun), domain $(api domains.list "{\"serviceId\":\"$svc\"}" | jq -c '[.domains[]? // .[]? | {host, liveAt, dnsStatus}]' 2>/dev/null))"
    return 1
  fi
  fr=$(api exposures.get "{\"serviceId\":\"$svc\"}" | jq -c .firstRun)
  ev "firstRun after the domain went live: $fr"
  closeat=$(printf '%s' "$fr" | jq -r '.closeAt // empty')
  wait_s=99999
  if [ -n "$closeat" ]; then
    wait_s=$(($(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${closeat%%.*}" +%s 2>/dev/null || date +%s) - $(date +%s) + 15))
    if [ "$wait_s" -le 900 ] && [ "$wait_s" -gt 0 ]; then ev "waiting ${wait_s}s for the close at $closeat"; sleep "$wait_s"; fi
  fi
  if [ -n "$closeat" ] && [ "$wait_s" -le 900 ] 2>/dev/null; then
    code=$(http_code "http://$addr/")
    [ "$code" = 000 ] && good "first-run $addr closed by itself at $closeat" ||
      bad "first-run $addr still answers $code after closeAt ${closeat:-<none>}"
    return
  fi
  # Too far to wait: move the stored close time into the past (as if a day
  # went by) and let the panel's own minute sweep close it.
  ev "the redirect closes by itself at ${closeat:-<never>} (too far to wait); moving that time 1 minute into the past in the panel database"
  panel_sql_write "update port_exposures set close_at = $(( $(date +%s) * 1000 - 60000 )) where service_id = '$svc' and kind = 'first_run'" >>"$RES/$CUR.log" ||
    bad "could not move closeAt"
  if wait_for 150 "the first-run listener to close by itself" sh -c "[ \"\$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://$addr/)\" = 000 ]"; then
    good "first-run $addr closed by itself once closeAt passed (connection refused; exposures.get: $(api exposures.get "{\"serviceId\":\"$svc\"}" | jq -c '.firstRun | {status, address}'))"
  else
    bad "first-run $addr still answers $(http_code "http://$addr/") after closeAt passed"
  fi
}

check_05() {
  need_key || return 3
  local pid na nb svc st dep info cid img
  pid=$(project_id e2e)
  na=$(node_id a)
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  delete_service e2e node-app
  svc=$(create_service "$(jq -nc --arg p "$pid" --arg nb "$nb" --arg na "$na" --arg url "$(state_get git-base)/node-app.git" \
    '{projectId:$p, name:"node-app", kind:"app", nodeId:$nb,
      source:{type:"git", url:$url, branch:"main", credentialId:null, deployOnPush:false},
      build:{builder:"railpack", buildNodeId:$na}, ports:[{containerPort:3000, protocol:"tcp"}], deployNow:true}')") ||
    { bad "services.create node-app failed"; return 1; }
  state_set svc-node-app "$svc"
  dep=$(latest_deploy "$svc" | jq -r .id)
  st=$(wait_deploy "$svc" 900 "$dep")
  info=$(deploy_info "$svc" "$dep")
  printf '%s\n' "$info" >>"$RES/$CUR.log"
  state_set dep-node-app-1 "$dep"
  ev "deployment: $(printf '%s' "$info" | jq -c '.deployment | {status, builder, builtOn: .builtOn.name, shippedTo: [.shippedTo[].name], image: .image.reference, digest: .image.digest, steps: [.steps[] | "\(.key)=\(.status)"], error}')"
  [ "$st" = live ] && good "Railpack build from $(state_get git-base)/node-app.git is live" || {
    bad "deployment ended $st: $(printf '%s' "$info" | jq -r .deployment.error)"
    ev "last log lines: $(deploy_log_tail "$svc" "$dep" 12 | tr '\n' '|')"
    return 1
  }
  expect "built on A (can-build): builtOn=$(printf '%s' "$info" | jq -r .deployment.builtOn.name)" \
    test "$(printf '%s' "$info" | jq -r .deployment.builtOn.id)" = "$na"
  expect "shipped to B" sh -c "printf '%s' '$(printf '%s' "$info" | jq -c '[.deployment.shippedTo[].id]')' | grep -q $nb"
  ev "deploy log says: $(deploy_log_tail "$svc" "$dep" 400 | grep -i -m3 'build.*on\|built on\|building on\|ship' | tr '\n' '|')"
  cid=$(on "$E2E_B" "docker ps -q --filter label=$SLUG.service=$svc | head -1")
  img=$(on "$E2E_B" "docker inspect -f '{{.Config.Image}}' $cid 2>/dev/null")
  ev "container on B runs image $img"
  case $img in
  127.0.0.1:5755/*@sha256:*) good "B pulled it through the 127.0.0.1:5755 relay by digest" ;;
  *) bad "B's container image is not a 127.0.0.1:5755 reference by digest: $img" ;;
  esac
  wait_for 60 "first-run address" has_first_run "$svc" || true
  expect "the app answers on its first-run address $(first_run_addr "$svc")" \
    sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q node-app"
}

check_06() {
  need_key || return 3
  local pid na nb svc st dep url code
  pid=$(project_id e2e)
  na=$(node_id a)
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }

  delete_service e2e go-app
  svc=$(create_service "$(jq -nc --arg p "$pid" --arg nb "$nb" --arg na "$na" --arg url "$(state_get git-base)/go-app.git" \
    '{projectId:$p, name:"go-app", kind:"app", nodeId:$nb,
      source:{type:"git", url:$url, branch:"main", credentialId:null, deployOnPush:false},
      build:{builder:"dockerfile", dockerfilePath:"Dockerfile", buildNodeId:$na}, ports:[{containerPort:8080, protocol:"tcp"}], deployNow:true}')") ||
    { bad "services.create go-app failed"; }
  if [ -n "$svc" ]; then
    st=$(wait_deploy "$svc" 900)
    [ "$st" = live ] && good "Dockerfile build from git (go-app) is live" ||
      bad "go-app deployment ended $st: $(latest_deploy "$svc" | jq -r .error) | $(deploy_log_tail "$svc" "$(latest_deploy "$svc" | jq -r .id)" 6 | tr '\n' '|')"
    wait_for 60 "go-app first-run" has_first_run "$svc" || true
    expect "go-app answers: $(curl -s -m 5 "http://$(first_run_addr "$svc")/" | head -1)" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q go-app"
  fi

  delete_service e2e inline-app
  svc=$(create_service "$(jq -nc --arg p "$pid" --arg nb "$nb" \
    '{projectId:$p, name:"inline-app", kind:"app", nodeId:$nb, source:{type:"inline"},
      build:{builder:"dockerfile", inlineDockerfile:"FROM busybox:1.37\nRUN mkdir -p /www && echo inline-ok > /www/index.html\nEXPOSE 8080\nCMD [\"httpd\", \"-f\", \"-p\", \"8080\", \"-h\", \"/www\"]\n"},
      ports:[{containerPort:8080, protocol:"tcp"}], deployNow:true}')") || bad "services.create inline-app failed"
  if [ -n "$svc" ]; then
    st=$(wait_deploy "$svc" 600)
    [ "$st" = live ] && good "inline Dockerfile service is live" || bad "inline-app deployment ended $st: $(latest_deploy "$svc" | jq -r .error)"
    wait_for 60 "inline first-run" has_first_run "$svc" || true
    expect "inline-app answers inline-ok" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q inline-ok"
  fi

  delete_service e2e upload-app
  svc=$(create_service "$(jq -nc --arg p "$pid" --arg nb "$nb" \
    '{projectId:$p, name:"upload-app", kind:"app", nodeId:$nb, source:{type:"upload", fileName:null},
      build:{builder:"dockerfile", dockerfilePath:"Dockerfile"}, ports:[{containerPort:8080, protocol:"tcp"}], deployNow:false}')") ||
    bad "services.create upload-app failed"
  if [ -n "$svc" ]; then
    url="$(panel_url)/api/uploads/services/$svc"
    code=$(curl -sS -o "$RES/$CUR.upload" -w '%{http_code}' -m 120 -H "authorization: Bearer $(state_get api-key)" \
      -H 'x-file-name: upload-app.tar.gz' -H 'content-type: application/gzip' --data-binary "@$E2E_OUT/upload-app.tar.gz" "$url") || code=000
    ev "POST /api/uploads/services/<id> -> $code $(head -c 200 "$RES/$CUR.upload")"
    if [ "${code:0:1}" = 2 ]; then
      st=$(wait_deploy "$svc" 600 "$(jq -r '.deployment.id // empty' "$RES/$CUR.upload")")
      [ "$st" = live ] && good "uploaded archive service is live" || bad "upload-app deployment ended $st: $(latest_deploy "$svc" | jq -r .error)"
      wait_for 60 "upload first-run" has_first_run "$svc" || true
      expect "upload-app answers upload-app ok" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q 'upload-app ok'"
    else
      bad "archive upload answered $code"
    fi
  fi
}

# load_loop <seconds> <url> <host header> <outfile>: one request every 100ms; writes codes.
load_loop() {
  local end=$((SECONDS + $1))
  : >"$4"
  while [ $SECONDS -lt $end ]; do
    curl -s -o /dev/null -m 3 -w '%{http_code}\n' -H "Host: $3" "$2" >>"$4" 2>/dev/null || echo 000 >>"$4"
    sleep 0.1
  done
}

check_07() {
  need_key || return 3
  local svc host dep st codes failed total name d1 d2 out
  svc=$(state_get svc-whoami)
  host=$(state_get host-whoami)
  [ -n "$svc" ] && [ -n "$host" ] || { blocked "no whoami service with a domain (check 4)"; return 3; }
  api services.setHealthCheck "{\"serviceId\":\"$svc\",\"healthCheck\":{\"probe\":{\"type\":\"tcp\",\"port\":80},\"intervalSeconds\":2,\"timeoutSeconds\":2,\"startPeriodSeconds\":0,\"failureThreshold\":3},\"deploy\":{\"mode\":\"rolling\",\"healthTimeoutSeconds\":60}}" >/dev/null || true
  api env.set "{\"serviceId\":\"$svc\",\"text\":\"WHOAMI_NAME=v1\"}" >/dev/null || bad "env.set failed"
  dep=$(api deployments.deploy "{\"serviceId\":\"$svc\"}" | jq -r '.deployment.id // .id')
  st=$(wait_deploy "$svc" 300 "$dep")
  [ "$st" = live ] || bad "v1 deploy ended $st"
  # Zero downtime: a request loop through B's Traefik during a redeploy.
  api env.set "{\"serviceId\":\"$svc\",\"text\":\"WHOAMI_NAME=v2\"}" >/dev/null
  codes=$RES/$CUR.codes
  load_loop 75 "http://$(node_ip b)/" "$host" "$codes" &
  local loop=$!
  sleep 3
  dep=$(api deployments.deploy "{\"serviceId\":\"$svc\"}" | jq -r '.deployment.id // .id')
  st=$(wait_deploy "$svc" 300 "$dep")
  wait $loop || true
  total=$(wc -l <"$codes" | tr -d ' ')
  failed=$(grep -cv '^200$' "$codes" || true)
  name=$(curl_host b "$host" | sed -n 's/^Name: //p')
  ev "redeploy v1 -> v2 ended $st; $total requests during it, $failed not 200 ($(sort "$codes" | uniq -c | tr -s ' \n' ' '))"
  [ "$st" = live ] && [ "$failed" = 0 ] && [ "$total" -gt 50 ] && good "zero downtime: no failed request during the redeploy" ||
    bad "requests failed during the redeploy ($failed of $total)"
  expect "v2 serves after the redeploy (Name: $name)" test "$name" = v2
  # A deploy whose health check never passes leaves v2 serving and fails.
  api services.setHealthCheck "{\"serviceId\":\"$svc\",\"healthCheck\":{\"probe\":{\"type\":\"http\",\"port\":80,\"path\":\"/\",\"host\":\"\",\"expectedStatus\":418},\"intervalSeconds\":2,\"timeoutSeconds\":2,\"startPeriodSeconds\":0,\"failureThreshold\":2},\"deploy\":{\"mode\":\"rolling\",\"healthTimeoutSeconds\":30}}" >/dev/null ||
    bad "services.setHealthCheck (failing probe) failed"
  api env.set "{\"serviceId\":\"$svc\",\"text\":\"WHOAMI_NAME=v3-broken\"}" >/dev/null
  dep=$(api deployments.deploy "{\"serviceId\":\"$svc\"}" | jq -r '.deployment.id // .id')
  st=$(wait_deploy "$svc" 300 "$dep")
  name=$(curl_host b "$host" | sed -n 's/^Name: //p')
  ev "deploy with a failing health check ended $st: $(deploy_info "$svc" "$dep" | jq -c '.deployment | {error, steps: [.steps[] | "\(.key)=\(.status)"]}')"
  expect "the failing deploy is marked failed" test "$st" = failed
  expect "the old version keeps serving (Name: $name)" test "$name" = v2
  api services.setHealthCheck "{\"serviceId\":\"$svc\",\"healthCheck\":{\"probe\":{\"type\":\"tcp\",\"port\":80},\"intervalSeconds\":2,\"timeoutSeconds\":2,\"startPeriodSeconds\":0,\"failureThreshold\":3},\"deploy\":{\"mode\":\"rolling\",\"healthTimeoutSeconds\":60}}" >/dev/null
  api env.set "{\"serviceId\":\"$svc\",\"text\":\"WHOAMI_NAME=v2\"}" >/dev/null

  # Rollback to the previous image: node-app v1 -> v2 (new commit) -> rollback.
  svc=$(state_get svc-node-app)
  d1=$(state_get dep-node-app-1)
  [ -n "$svc" ] && [ -n "$d1" ] || { bad "no node-app deployment to roll back to (check 5)"; return 1; }
  git_commit_app node-app 's/process.env.APP_VERSION || "v1"/process.env.APP_VERSION || "v2"/' "node-app v2"
  d2=$(api deployments.deploy "{\"serviceId\":\"$svc\"}" | jq -r '.deployment.id // .id')
  st=$(wait_deploy "$svc" 900 "$d2")
  out=$(curl -s -m 5 "http://$(first_run_addr "$svc")/")
  ev "node-app redeploy of the new commit ended $st: $out"
  expect "node-app v2 is live" sh -c "[ '$st' = live ] && printf '%s' '$out' | grep -q '\"version\":\"v2\"'"
  dep=$(api deployments.rollback "{\"serviceId\":\"$svc\",\"deploymentId\":\"$d1\"}" | jq -r '.deployment.id // .id') || bad "deployments.rollback failed"
  st=$(wait_deploy "$svc" 300 "$dep")
  out=$(curl -s -m 5 "http://$(first_run_addr "$svc")/")
  ev "rollback to $d1 ended $st ($(deploy_info "$svc" "$dep" | jq -c '.deployment | {trigger, rollbackOf, image: .image.reference}')): $out"
  expect "rollback serves v1 again" sh -c "[ '$st' = live ] && printf '%s' '$out' | grep -q '\"version\":\"v1\"'"
  # Keep the repository at v1 for later runs.
  git_commit_app node-app 's/process.env.APP_VERSION || "v2"/process.env.APP_VERSION || "v1"/' "node-app back to v1"
}

# git_commit_app <app> <sed expression for index.js/main.go> <message>: a new commit in the e2e repo.
git_commit_app() {
  local bare=$E2E_REL/git/$1.git work
  work=$(mktemp -d)
  git clone -q "$bare" "$work/r"
  local f
  for f in "$work/r/index.js" "$work/r/main.go"; do [ -f "$f" ] && sed -i '' -e "$2" "$f"; done
  git -C "$work/r" -c user.name=e2e -c user.email=e2e@e2e.test commit -qam "$3"
  git -C "$work/r" push -q origin main
  git -C "$bare" update-server-info
  rm -rf "$work"
}

# container_events <vm> <service> <since-epoch>: die/start times of the service's containers.
container_events() {
  on "$1" "timeout 2 docker events --since $3 --until $(date +%s) --filter label=$SLUG.service=$2 \
    --filter event=die --filter event=start --format '{{.Time}} {{.Action}} {{.Actor.ID}}'" 2>/dev/null || true
}

svc_stopped() { case $(svc_status "$1") in crashed | stopped) return 0 ;; esac; return 1; }
has_alert() { api alerts.list "{\"serviceId\":\"$1\"}" | jq -e --arg e "$2" '[.alerts[] | select(.event==$e)] | length >= 1' >/dev/null; }

check_08() {
  need_key || return 3
  local svc t0 ev1 gaps crashes reports alerts st
  delete_service e2e crasher
  svc=$(image_service e2e crasher b busybox:1.37 "" \
    '{"container":{"command":["sh","-c","echo crash-line-$(date +%s); echo second-line; sleep 6; exit 3"]}}') ||
    { bad "services.create crasher failed"; return 1; }
  state_set svc-crasher "$svc"
  api services.setCrashPolicy "{\"serviceId\":\"$svc\",\"restart\":true,\"stopAfterCrashes\":0}" >/dev/null || bad "setCrashPolicy failed"
  t0=$(date +%s)
  sleep 45
  ev1=$(container_events "$E2E_B" "$svc" "$t0")
  printf '%s\n' "$ev1" >>"$RES/$CUR.log"
  crashes=$(printf '%s\n' "$ev1" | grep -c ' die ' || true)
  # Gap from each die to the next start (seconds).
  gaps=$(printf '%s\n' "$ev1" | awk '$2=="die"{d=$1} $2=="start" && d{printf "%d ", $1-d; d=0}')
  ev "restart on: $crashes crashes in 45s; die -> next start gaps: ${gaps:-none}s"
  expect "the service is restarted after each crash" test "$crashes" -ge 2
  expect "the wait before a restart is the fixed 5s (gaps $gaps)" sh -c "for g in $gaps; do [ \$g -ge 4 ] && [ \$g -le 8 ] || exit 1; done; [ -n '$gaps' ]"
  reports=$(panel_sql "select streak, action, exit_code, last_lines from crash_reports where service_id='$svc' order by occurred_at")
  printf '%s\n' "$reports" >>"$RES/$CUR.log"
  ev "crash reports in the panel: $(printf '%s' "$reports" | jq -c 'length') ($(printf '%s' "$reports" | jq -c '[.[] | {streak, action, exit_code}] | .[0:4]'))"
  expect "a crash report carries the last log lines (crash-line)" sh -c "printf '%s' '$(printf '%s' "$reports" | jq -c '[.[].last_lines]')' | grep -q crash-line"
  alerts=$(api alerts.list "{\"serviceId\":\"$svc\"}" | jq -c '[.alerts[] | select(.event=="crash")]')
  ev "crash alerts: $(printf '%s' "$alerts" | jq -c '[.[] | {title, message}]')"
  expect "one alert for the whole streak ($crashes crashes)" test "$(printf '%s' "$alerts" | jq length)" = 1

  # Stop after N crashes in a row.
  api services.setCrashPolicy "{\"serviceId\":\"$svc\",\"restart\":true,\"stopAfterCrashes\":2}" >/dev/null
  wait_for 120 "the crash limit alert" has_alert "$svc" crash_limit || true
  sleep 3
  st=$(svc_status "$svc")
  t0=$(date +%s)
  sleep 20
  crashes=$(container_events "$E2E_B" "$svc" "$t0" | grep -c ' start ' || true)
  ev "stopAfterCrashes=2: status $st, $crashes starts in the 20s after"
  expect "the service stays stopped after the crash limit" sh -c "[ '$st' = crashed -o '$st' = stopped ] && [ $crashes = 0 ]"
  expect "a crash_limit alert was raised" has_alert "$svc" crash_limit

  # Restart off: the first crash leaves it stopped.
  api services.setCrashPolicy "{\"serviceId\":\"$svc\",\"restart\":false,\"stopAfterCrashes\":0}" >/dev/null
  t0=$(date +%s)
  api services.restart "{\"serviceId\":\"$svc\"}" >/dev/null || bad "services.restart failed"
  sleep 30
  crashes=$(container_events "$E2E_B" "$svc" "$t0" | grep -c ' start ' || true)
  st=$(svc_status "$svc")
  ev "restart off: $crashes start(s) in 30s after services.restart (one crash after 6s), status $st"
  expect "with restart off the crashed service is not restarted" sh -c "[ $crashes = 1 ] && [ '$st' != running ]"
  api services.stop "{\"serviceId\":\"$svc\"}" >/dev/null || true
}

check_09() {
  need_key || return 3
  local whoami nb nc svc far diag logs
  whoami=$(state_get svc-whoami)
  [ -n "$whoami" ] || { blocked "no whoami service (check 4)"; return 3; }
  api env.set "{\"serviceId\":\"$whoami\",\"text\":\"WHOAMI_NAME=v2\\nSECRET_TOKEN=s3cr3t-e2e\"}" >/dev/null || bad "env.set on whoami failed"
  delete_service e2e envref
  svc=$(image_service e2e envref b busybox:1.37 "" \
    '{"container":{"command":["sh","-c","echo GREETING=$GREETING; echo PEER=$PEER; sleep 86400"]},"deployNow":false}') ||
    { bad "services.create envref failed"; return 1; }
  api env.set "{\"serviceId\":\"$svc\",\"text\":\"GREETING=\${{whoami.SECRET_TOKEN}}\\nPEER=\${{whoami.WHOAMI_NAME}}\"}" >/dev/null || bad "env.set with references failed"
  ev "references button: $(api env.references "{\"serviceId\":\"$svc\"}" | jq -c '[.targets[] | "\(.name): \([.variables[].name] | .[0:4] | join(","))"] | .[0:6]' 2>/dev/null)"
  api deployments.deploy "{\"serviceId\":\"$svc\"}" >/dev/null
  st=$(wait_deploy "$svc" 300)
  [ "$st" = live ] || bad "envref deploy ended $st"
  sleep 3
  logs=$(on "$E2E_B" "docker logs \$(docker ps -q --filter label=$SLUG.service=$svc | head -1) 2>&1 | head -5")
  ev "envref container output: $(printf '%s' "$logs" | tr '\n' ' ')"
  expect "\${{whoami.SECRET_TOKEN}} resolved at deploy" sh -c "printf '%s' '$logs' | grep -q 'GREETING=s3cr3t-e2e'"
  expect "\${{whoami.WHOAMI_NAME}} resolved at deploy" sh -c "printf '%s' '$logs' | grep -q 'PEER=v2'"

  nc=$(node_id c)
  [ -n "$nc" ] || { bad "node C is not joined: cannot test the cross-node diagnostic"; return 1; }
  delete_service e2e far-client
  far=$(image_service e2e far-client c busybox:1.37 "" '{"container":{"command":["sleep","86400"]},"deployNow":false}') ||
    { bad "services.create far-client failed"; return 1; }
  api env.set "{\"serviceId\":\"$far\",\"text\":\"UPSTREAM_URL=http://whoami:80\\nTOKEN=\${{whoami.SECRET_TOKEN}}\"}" >/dev/null
  diag=$(api env.analyze "{\"serviceId\":\"$far\"}")
  printf '%s\n' "$diag" >>"$RES/$CUR.log"
  ev "env.analyze on far-client (node C): $(printf '%s' "$diag" | jq -c '[.diagnostics[] | {code, severity, message}]')"
  expect "the internal address of whoami (node B) is flagged on node C" \
    sh -c "printf '%s' '$(printf '%s' "$diag" | jq -c '[.diagnostics[].code]')' | grep -q 'other-node'"
}

# ---------------------------------------------------------------- 10-16 data, observe, multi-node

# ws_url <path from a ticket>: absolute WebSocket URL on the panel.
ws_url() {
  case $1 in
  ws://* | wss://*) echo "$1" ;;
  http://*) echo "ws://${1#http://}" ;;
  *) echo "ws://$(vm_ip "$E2E_A"):$E2E_PORT$1" ;;
  esac
}
# ws <url> [wsclient args]: the e2e WebSocket client.
ws() { bun "$E2E_DIR/wsclient.ts" "$@"; }

# container_on <letter> <service>: newest running container of a service on a node.
container_on() { on_node "$1" "docker ps -q --filter label=$SLUG.service=$2 | head -1"; }

# pg_on_b <sql>: psql inside the Postgres container on B (harness side, for setup and checks).
# (By name: the service's web UI sidecar <slug>-<id>-db-ui carries its label too.)
pg_exec() { on_node "$1" "docker exec \$(docker ps -q --filter label=$SLUG.service=$2 --filter name=^$SLUG-$2-[0-9] | head -1) psql -U app -d app -tAc \"$3\""; }

pg_probe_cmd='["sh","-c","for i in $(seq 1 30); do if psql \"$DATABASE_URL\" -tAc \"select 1\" >/dev/null 2>&1; then echo PG-CONNECTED; sleep 86400; fi; echo PG-FAILED-$i; sleep 2; done; sleep 86400"]'

check_10() {
  need_key || return 3
  local pid other nb db conn internal st app app2 logs exp port url out ticket wurl
  pid=$(project_id e2e)
  other=$(project_id e2e-other)
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  db=$(service_id e2e pg)
  if [ -z "$db" ]; then
    db=$(api databases.create "{\"projectId\":\"$pid\",\"name\":\"pg\",\"engine\":\"postgres\",\"version\":\"17\",\"nodeId\":\"$nb\",\"database\":\"app\",\"user\":\"app\",\"password\":\"e2e-pg-password-1\"}" | jq -r .serviceId) ||
      { bad "databases.create failed"; return 1; }
  fi
  state_set svc-pg "$db"
  wait_for 300 "postgres running" svc_running "$db" || { bad "postgres did not reach running ($(svc_status "$db"))"; return 1; }
  wait_for 90 "postgres accepting" pg_exec b "$db" "select 1" || true
  conn=$(api databases.connection "{\"serviceId\":\"$db\"}")
  internal=$(printf '%s' "$conn" | jq -r .internal.url)
  ev "internal URL: $(printf '%s' "$internal" | sed 's#://\([^:]*\):[^@]*@#://\1:<redacted>@#')"
  good "Postgres 17 on B is running"

  delete_service e2e pg-client
  app=$(image_service e2e pg-client b postgres:17.6-alpine "" "{\"container\":{\"command\":$pg_probe_cmd},\"deployNow\":false}") ||
    { bad "services.create pg-client failed"; return 1; }
  api env.set "$(jq -nc --arg s "$app" --arg u "$internal" '{serviceId:$s, text:("DATABASE_URL=" + $u)}')" >/dev/null
  api deployments.deploy "{\"serviceId\":\"$app\"}" >/dev/null
  wait_for 120 "pg-client output" sh -c "colima ssh -p $E2E_B -- sudo docker logs \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$app | head -1) 2>&1 | grep -q PG-CONNECTED" || true
  logs=$(on "$E2E_B" "docker logs \$(docker ps -q --filter label=$SLUG.service=$app | head -1) 2>&1 | tail -3")
  expect "an app in the same project connects by the internal URL ($(printf '%s' "$logs" | tr '\n' ' '))" sh -c "printf '%s' '$logs' | grep -q PG-CONNECTED"

  delete_service e2e-other pg-intruder
  app2=$(image_service e2e-other pg-intruder b postgres:17.6-alpine "" "{\"container\":{\"command\":$pg_probe_cmd},\"deployNow\":false}") ||
    { bad "services.create pg-intruder failed"; return 1; }
  api env.set "$(jq -nc --arg s "$app2" --arg u "$internal" '{serviceId:$s, text:("DATABASE_URL=" + $u)}')" >/dev/null
  api deployments.deploy "{\"serviceId\":\"$app2\"}" >/dev/null
  sleep 25
  logs=$(on "$E2E_B" "docker logs \$(docker ps -q --filter label=$SLUG.service=$app2 | head -1) 2>&1 | tail -2")
  expect "an app in ANOTHER project cannot reach it ($(printf '%s' "$logs" | tr '\n' ' '))" \
    sh -c "printf '%s' '$logs' | grep -q PG-FAILED && ! printf '%s' '$logs' | grep -q PG-CONNECTED"
  api services.stop "{\"serviceId\":\"$app2\"}" >/dev/null || true

  # TLS exposure on a port, from the Mac.
  port=25432
  api databases.setExposure "{\"serviceId\":\"$db\",\"enabled\":true,\"port\":$port,\"allowedCidrs\":[\"$(host_ip)/32\",\"192.168.64.0/24\"]}" >/dev/null ||
    bad "databases.setExposure failed"
  sleep 15
  exp=$(api databases.connection "{\"serviceId\":\"$db\"}" | jq -c .exposed)
  if [ "$exp" = null ] || [ "$(printf '%s' "$exp" | jq -r .port)" = null ]; then
    bad "databases.connection has no exposed URL after setExposure (exposure: $(api databases.get "{\"serviceId\":\"$db\"}" | jq -c '.exposure | {enabled, host, port, user, certificate}'))"
    # Go on with what the agent does: set a known password for the exposed user.
    local xpass=e2e-exposed-pass-1 xuser
    xuser=$(api databases.get "{\"serviceId\":\"$db\"}" | jq -r .exposure.user)
    api databases.resetPassword "{\"serviceId\":\"$db\",\"user\":\"exposed\",\"password\":\"$xpass\"}" >/dev/null || bad "databases.resetPassword (exposed) failed"
    sleep 35
    url="postgresql://$xuser:$xpass@$(node_ip b):$port/app"
  else
    ev "exposed: $(printf '%s' "$exp" | jq -c '{host, port, user, tlsParams}')"
    url=$(printf '%s' "$exp" | jq -r '"postgresql://\(.user):\(.password)@\(.host):\(.port)/\(.database)"')
    url=${url/@e2e-b:/@$(node_ip b):}
  fi
  out=""
  if wait_for 90 "psql with sslmode=require" sh -c "psql '$url?sslmode=require' -tAc 'select ssl from pg_stat_ssl where pid = pg_backend_pid()' | grep -q t"; then
    out=$(psql "$url?sslmode=require" -tAc "select 'tls=' || ssl || ' ' || version from pg_stat_ssl where pid = pg_backend_pid()")
    good "psql from the Mac over TLS (sslmode=require): $out"
  else
    bad "psql sslmode=require to $(node_ip b):$port failed: $(psql "$url?sslmode=require" -tAc 'select 1' 2>&1 | head -2 | tr '\n' ' ')"
  fi
  expect "the exposed user cannot log in without TLS" sh -c "! psql '$url?sslmode=disable' -tAc 'select 1' >/dev/null 2>&1"

  # Web UI ticket through the edge.
  out=$(api databases.openWebUi "{\"serviceId\":\"$db\"}") || bad "databases.openWebUi failed"
  wurl=$(printf '%s' "$out" | jq -r .url)
  ev "web UI ticket URL: $(printf '%s' "$wurl" | sed -E 's/([?&]t(icket)?=)[^&]*/\1<redacted>/')"
  if [ -n "$wurl" ] && [ "$wurl" != null ]; then
    local whost wpath
    whost=$(printf '%s' "$wurl" | sed -E 's#^https?://([^/:]+).*#\1#')
    wpath=$(printf '%s' "$wurl" | sed -E 's#^https?://[^/]+##')
    # The edge answers on B's Traefik with the URL's host name.
    # https with the certificate unchecked: no public CA issues for a private address.
    if curl -s -L -k -m 30 -c "$RES/$CUR.jar" -b "$RES/$CUR.jar" --resolve "$whost:80:$(node_ip b)" --resolve "$whost:443:$(node_ip b)" \
      "$wurl" -o "$RES/$CUR.pgweb" -w '%{http_code}' >"$RES/$CUR.code" 2>>"$RES/$CUR.log" && grep -qi pgweb "$RES/$CUR.pgweb"; then
      good "the web UI ticket opens pgweb through B's edge ($whost, $(cat "$RES/$CUR.code"))"
    elif wait_for 90 "pgweb through the edge" curl -s -k -m 10 -b "$RES/$CUR.jar" --resolve "$whost:443:$(node_ip b)" -o "$RES/$CUR.pgweb" "https://$whost/" &&
      grep -qi pgweb "$RES/$CUR.pgweb"; then
      good "pgweb answered through B's edge after it started ($whost)"
    else
      bad "pgweb did not answer through the edge: HTTP $(cat "$RES/$CUR.code" 2>/dev/null), body $(head -c 120 "$RES/$CUR.pgweb" 2>/dev/null | tr '\n' ' ')"
    fi
  fi

  # Pre-logged DB shell.
  ticket=$(api databases.openShell "{\"serviceId\":\"$db\"}") || { bad "databases.openShell failed"; return 1; }
  out=$(ws "$(ws_url "$(printf '%s' "$ticket" | jq -r '.url // .socketPath')")" --seconds 25 --send-after-ready \
    --send-binary 'select 40+2 as e2e_answer;\n' --wait-for '(1 row)' 2>&1 || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -v 'select 40' | grep -qE '(^|[^0-9+])42([^0-9]|$)' &&
    good "the DB shell ran a query without a password (select 40+2 -> 42)" ||
    bad "DB shell: no 42 in the output ($(printf '%s' "$out" | tail -3 | tr '\n' ' ' | head -c 200))"
}

check_11() {
  need_key || return 3
  local db vol dest minio policy run st rrun volid
  db=$(state_get svc-pg)
  [ -n "$db" ] || { blocked "no Postgres (check 10)"; return 3; }
  read -r murl muser mpass <<<"$(state_get minio)"
  dest=$(api backups.listDestinations | jq -r '.destinations[]? | select(.name=="e2e-minio") | .id' | head -1)
  if [ -z "$dest" ]; then
    dest=$(api backups.createDestination "$(jq -nc --arg e "$murl" --arg k "$muser" --arg s "$mpass" \
      '{name:"e2e-minio", provider:"minio", endpoint:$e, region:"us-east-1", bucket:"e2e-backups", pathPrefix:"e2e", pathStyle:true, accessKeyId:$k, secretAccessKey:$s}')" | jq -r .id) ||
      { bad "backups.createDestination failed"; return 1; }
  fi
  good "MinIO destination $murl/e2e-backups"
  pg_exec b "$db" "create table if not exists e2e_backup(v text); delete from e2e_backup; insert into e2e_backup values ('before-backup')" >/dev/null ||
    bad "could not write the marker row"
  policy=$(api backups.createPolicy "{\"serviceId\":\"$db\",\"target\":\"database\",\"destinationId\":\"$dest\",\"schedule\":\"0 3 * * *\",\"keepLast\":3,\"stopService\":false,\"enabled\":true}" | jq -r '.id // .policy.id') ||
    { bad "backups.createPolicy failed"; return 1; }
  run=$(api backups.runNow "{\"serviceId\":\"$db\",\"policyId\":\"$policy\"}" | jq -r .id) || { bad "backups.runNow failed"; return 1; }
  wait_for 300 "the database backup" run_done "$db" "$run" || true
  st=$(run_info "$db" "$run")
  ev "database backup run: $st"
  expect "the Postgres backup succeeded" sh -c "printf '%s' '$st' | jq -e '.status==\"succeeded\"'"
  expect "the backup object is in MinIO" on "$E2E_A" "docker exec e2e-minio sh -c 'mc alias set e2e http://127.0.0.1:9000 $muser $mpass >/dev/null && mc ls -r e2e/e2e-backups' | grep -q ."
  pg_exec b "$db" "drop table e2e_backup" >/dev/null
  rrun=$(api backups.restore "{\"serviceId\":\"$db\",\"runId\":\"$run\",\"confirmName\":\"pg\",\"backupFirst\":false}" | jq -r '.id // .run.id') ||
    { bad "backups.restore failed"; return 1; }
  wait_for 300 "the database restore" run_done "$db" "$rrun" || true
  ev "restore run: $(run_info "$db" "$rrun")"
  wait_for 60 "postgres after the restore" pg_exec b "$db" "select 1" || true
  expect "the restored database has the marker row" sh -c "[ \"\$(colima ssh -p $E2E_B -- sudo docker exec \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$db --filter name=^$SLUG-$db-[0-9] | head -1) psql -U app -d app -tAc 'select v from e2e_backup')\" = before-backup ]"

  # A volume.
  delete_service e2e vol
  vol=$(image_service e2e vol b busybox:1.37 "" '{"container":{"command":["sleep","86400"]},"deployNow":false}') ||
    { bad "services.create vol failed"; return 1; }
  state_set svc-vol "$vol"
  api services.setVolumes "{\"serviceId\":\"$vol\",\"volumes\":[{\"name\":\"data\",\"mountPath\":\"/data\"}]}" >/dev/null || bad "services.setVolumes failed"
  api deployments.deploy "{\"serviceId\":\"$vol\"}" >/dev/null
  [ "$(wait_deploy "$vol" 300)" = live ] || bad "vol deploy failed"
  on "$E2E_B" "docker exec \$(docker ps -q --filter label=$SLUG.service=$vol | head -1) sh -c 'echo volume-marker-1 > /data/marker.txt'"
  volid=$(api services.get "{\"serviceId\":\"$vol\"}" | jq -r '.volumes[] | select(.name=="data") | .id')
  policy=$(api backups.createPolicy "{\"serviceId\":\"$vol\",\"target\":\"volume\",\"volumeId\":\"$volid\",\"destinationId\":\"$dest\",\"schedule\":\"0 3 * * *\",\"keepLast\":3,\"stopService\":false,\"enabled\":true}" | jq -r '.id // .policy.id') ||
    { bad "volume backup policy failed"; return 1; }
  run=$(api backups.runNow "{\"serviceId\":\"$vol\",\"policyId\":\"$policy\"}" | jq -r .id) || { bad "volume backups.runNow failed"; return 1; }
  wait_for 300 "the volume backup" run_done "$vol" "$run" || true
  ev "volume backup run: $(run_info "$vol" "$run")"
  on "$E2E_B" "docker exec \$(docker ps -q --filter label=$SLUG.service=$vol | head -1) rm -f /data/marker.txt"
  rrun=$(api backups.restore "{\"serviceId\":\"$vol\",\"runId\":\"$run\",\"confirmName\":\"vol\",\"backupFirst\":false}" | jq -r '.id // .run.id') ||
    { bad "volume backups.restore failed"; return 1; }
  wait_for 300 "the volume restore" run_done "$vol" "$rrun" || true
  ev "volume restore run: $(run_info "$vol" "$rrun")"
  wait_for 60 "vol running" svc_running "$vol" || true
  expect "the restored volume has marker.txt" sh -c "colima ssh -p $E2E_B -- sudo docker exec \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$vol | head -1) cat /data/marker.txt | grep -q volume-marker-1"
}
run_info() { api backups.listRuns "{\"serviceId\":\"$1\",\"limit\":20}" | jq -c --arg id "$2" '.runs[] | select(.id==$id) | {kind, status, objectKey, sizeBytes, error}'; }
run_done() { run_info "$1" "$2" | jq -e '.status != "running"' >/dev/null; }

check_12() {
  need_key || return 3
  local vol job runs n0 t0 tdown tup during c
  vol=$(state_get svc-vol)
  [ -n "$vol" ] || { blocked "no vol service (check 11)"; return 3; }
  for j in $(api cron.list "{\"serviceId\":\"$vol\"}" | jq -r '(.jobs // .cronJobs // [])[].id'); do
    api cron.delete "{\"serviceId\":\"$vol\",\"cronJobId\":\"$j\"}" >/dev/null || true
  done
  job=$(api cron.create "{\"serviceId\":\"$vol\",\"name\":\"e2e-tick\",\"schedule\":\"* * * * *\",\"timeZone\":\"UTC\",\"command\":\"echo cron-ok; date >> /data/cron.log\",\"timeoutSeconds\":60,\"concurrency\":\"forbid\",\"enabled\":true}" | jq -r .id) ||
    { bad "cron.create failed"; return 1; }
  state_set cron-job "$job"
  if ! api cron.runNow "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\"}" >/dev/null 2>>"$RES/$CUR.log"; then
    ev "note: cron.runNow right after cron.create answered NOT_FOUND (the node had not received the job yet); retrying"
    wait_for 60 "cron.runNow" api cron.runNow "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\"}" || bad "cron.runNow failed"
  fi
  sleep 10
  runs=$(api cron.runs "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\",\"limit\":20}")
  expect "run-now result in the history ($(printf '%s' "$runs" | jq -c '[.runs[] | select(.manual) | {result, exitCode}]'))" \
    sh -c "printf '%s' '$runs' | jq -e '[.runs[] | select(.manual and .result==\"succeeded\")] | length >= 1'"
  wait_for 100 "a scheduled run" sched_runs_ge "$vol" "$job" 1 || true
  runs=$(api cron.runs "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\",\"limit\":20}")
  expect "a scheduled run in the history ($(printf '%s' "$runs" | jq -c '[.runs[] | select(.manual|not) | {result, startedAt}] | .[0:2]'))" \
    sh -c "printf '%s' '$runs' | jq -e '[.runs[] | select((.manual|not) and .result==\"succeeded\")] | length >= 1'"
  # The panel down for ~2.5 minutes: the node keeps the schedule.
  c=$(panel_container)
  tdown=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  on "$E2E_A" "docker pause $c" >/dev/null || { bad "could not pause the panel container"; return 1; }
  ev "panel paused at $tdown"
  sleep 150
  tup=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  on "$E2E_A" "docker unpause $c" >/dev/null
  ev "panel back at $tup"
  wait_for 120 "nodes back" online_ge 3 || true
  sleep 20
  runs=$(api cron.runs "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\",\"limit\":30}")
  during=$(printf '%s' "$runs" | jq --arg a "$tdown" --arg b "$tup" '[.runs[] | select(.startedAt >= $a and .startedAt <= $b)] | length')
  ev "runs that started while the panel was down: $during ($(printf '%s' "$runs" | jq -c --arg a "$tdown" --arg b "$tup" '[.runs[] | select(.startedAt >= $a and .startedAt <= $b) | {startedAt, result}]'))"
  expect "cron kept running while the panel was down (2 or more runs in 150s)" test "$during" -ge 2
}
sched_runs_ge() { api cron.runs "{\"serviceId\":\"$1\",\"cronJobId\":\"$2\",\"limit\":20}" | jq -e --argjson n "$3" '[.runs[] | select((.manual|not) and .result!="running")] | length >= $n' >/dev/null; }

check_13() {
  need_key || return 3
  local app vol res gens ticket out echoer sh_svc path up down content
  app=$(state_get svc-node-app)
  [ -n "$app" ] || { blocked "no node-app (check 5)"; return 3; }
  res=$(api logs.search "{\"serviceId\":\"$app\",\"query\":\"listening\",\"limit\":50}") || { bad "logs.search failed"; }
  gens=$(printf '%s' "$res" | jq -c '[.entries[].generation] | unique')
  ev "logs.search 'listening': $(printf '%s' "$res" | jq '.entries | length') lines across generations $gens"
  expect "search finds lines from two or more deploys" test "$(printf '%s' "$gens" | jq length)" -ge 2
  ticket=$(api logs.follow "{\"serviceId\":\"$app\",\"tail\":5}") || bad "logs.follow failed"
  ( sleep 4; api services.restart "{\"serviceId\":\"$app\"}" >/dev/null ) &
  out=$(ws "$(ws_url "$(printf '%s' "$ticket" | jq -r .url)")" --seconds 60 --wait-for 'listening on' 2>&1 || true)
  wait || true
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "logs.follow streamed lines (tail, then the restart's 'listening on')" ||
    bad "logs.follow showed no 'listening on' ($(printf '%s' "$out" | head -3 | tr '\n' ' ' | head -c 200))"

  # Console: stdin of the main process.
  delete_service e2e echoer
  echoer=$(image_service e2e echoer b busybox:1.37 "" '{"container":{"command":["sh","-c","echo echoer-ready; while read l; do echo \"echo:$l\"; done"]}}') ||
    { bad "services.create echoer failed"; return 1; }
  [ "$(wait_deploy "$echoer" 300)" = live ] || bad "echoer deploy failed"
  ticket=$(api terminals.console "{\"serviceId\":\"$echoer\"}") || { bad "terminals.console failed"; return 1; }
  out=$(ws "$(ws_url "$(printf '%s' "$ticket" | jq -r .url)")" --seconds 20 --send-after-ready --send-binary 'hello-e2e\n' --wait-for 'echo:hello-e2e' 2>&1 || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "Console echoed stdin (echo:hello-e2e); ready: $(printf '%s' "$out" | grep -m1 '"ready"' | cut -c3- | head -c 160)" ||
    bad "Console did not echo ($(printf '%s' "$out" | tail -4 | tr '\n' ' ' | head -c 240))"

  # Shell PTY.
  ticket=$(api terminals.shell "{\"serviceId\":\"$echoer\",\"columns\":100,\"rows\":30}") || { bad "terminals.shell failed"; return 1; }
  out=$(ws "$(ws_url "$(printf '%s' "$ticket" | jq -r .url)")" --seconds 20 --send-after-ready --send-binary 'echo shell-$((40+2)); tty\n' --wait-for 'shell-42' 2>&1 || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "Shell PTY ran a command (shell-42; tty: $(printf '%s' "$out" | grep -o '/dev/pts/[0-9]*' | head -1))" ||
    bad "Shell did not run the command ($(printf '%s' "$out" | tail -4 | tr '\n' ' ' | head -c 240))"

  # Files in a volume.
  vol=$(state_get svc-vol)
  [ -n "$vol" ] || { bad "no vol service for Files (check 11)"; return 1; }
  api files.write "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e/hello.txt\",\"content\":\"hello from files.write\",\"createParents\":true}" >/dev/null &&
    good "files.write created /e2e/hello.txt" || bad "files.write failed"
  out=$(api files.list "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e\"}")
  expect "files.list shows it ($(printf '%s' "$out" | jq -c '[.entries[] | "\(.name):\(.size)"]'))" sh -c "printf '%s' '$out' | jq -e '[.entries[] | select(.name==\"hello.txt\")] | length == 1'"
  up=$(api files.uploadTicket "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e/upload.bin\",\"sizeBytes\":4096,\"createParents\":true}" | jq -r .url) ||
    bad "files.uploadTicket failed"
  head -c 4096 /dev/urandom >"$RES/$CUR.upload"
  path=$up
  case $path in http*) ;; *) path="$(panel_url)$path" ;; esac
  expect "upload through the ticket" curl -fsS -m 30 -X PUT --data-binary "@$RES/$CUR.upload" "$path"
  down=$(api files.downloadTicket "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e/upload.bin\"}" | jq -r .url) || bad "files.downloadTicket failed"
  case $down in http*) ;; *) down="$(panel_url)$down" ;; esac
  curl -fsS -m 30 -o "$RES/$CUR.download" "$down" || true
  expect "download returns the uploaded bytes" cmp -s "$RES/$CUR.upload" "$RES/$CUR.download"
  api files.write "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e/hello.txt\",\"content\":\"edited by the e2e\"}" >/dev/null || bad "files.write (edit) failed"
  content=$(api files.read "{\"serviceId\":\"$vol\",\"volume\":\"data\",\"path\":\"/e2e/hello.txt\"}" | jq -r '.content // .text // empty')
  expect "files.read returns the edit ($content)" test "$content" = "edited by the e2e"
  expect "the container sees the edited file" sh -c "colima ssh -p $E2E_B -- sudo docker exec \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$vol | head -1) cat /data/e2e/hello.txt | grep -q 'edited by the e2e'"
}

check_14() {
  need_key || return 3
  local nodes svc m l
  nodes=$(api metrics.nodes '{"range":"1h"}') || { bad "metrics.nodes failed"; return 1; }
  printf '%s\n' "$nodes" >>"$RES/$CUR.log"
  for l in a b c; do
    m=$(api metrics.node "{\"nodeId\":\"$(node_id $l)\",\"range\":\"1h\"}") || { bad "metrics.node $l failed"; continue; }
    ev "node $l: $(printf '%s' "$m" | jq -c '{points: (.series.points|length), latest: (.series.latest | {cpuPercent, memoryUsedBytes})}')"
    expect "node $l has samples" test "$(printf '%s' "$m" | jq '.series.points|length')" -gt 0
  done
  for svc in "$(state_get svc-whoami)" "$(state_get svc-node-app)"; do
    [ -n "$svc" ] || continue
    m=$(api metrics.service "{\"serviceId\":\"$svc\",\"range\":\"1h\"}") || { bad "metrics.service failed"; continue; }
    ev "service $svc: $(printf '%s' "$m" | jq -c '{points: (.points|length), current: [.current[] | {cpuPercent, memoryBytes}]}')"
    expect "service $svc has samples" test "$(printf '%s' "$m" | jq '(.points|length) + (.current|length)')" -gt 0
  done
}

check_15() {
  need_key || return 3
  local nb nc svc st host dep code body
  nb=$(node_id b)
  nc=$(node_id c)
  [ -n "$nc" ] || { blocked "node C is not joined"; return 3; }
  delete_service e2e mover
  svc=$(image_service e2e mover b busybox:1.37 8080 '{"container":{"command":["httpd","-f","-p","8080","-h","/site"]},"deployNow":false}') ||
    { bad "services.create mover failed"; return 1; }
  state_set svc-mover "$svc"
  api services.setVolumes "{\"serviceId\":\"$svc\",\"volumes\":[{\"name\":\"site\",\"mountPath\":\"/site\"}]}" >/dev/null || bad "setVolumes failed"
  api deployments.deploy "{\"serviceId\":\"$svc\"}" >/dev/null
  [ "$(wait_deploy "$svc" 300)" = live ] || bad "mover deploy failed"
  api files.write "{\"serviceId\":\"$svc\",\"volume\":\"site\",\"path\":\"/index.html\",\"content\":\"mover-data-intact\"}" >/dev/null || bad "files.write failed"
  host=mover.e2e.test
  api domains.add "{\"serviceId\":\"$svc\",\"host\":\"$host\",\"targetPort\":8080,\"https\":\"off\",\"primary\":true}" >/dev/null || bad "domains.add failed"
  wait_for 90 "mover on B" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q mover-data-intact" &&
    good "before the move: $host serves the volume's page through B" || bad "mover not reachable through B"
  dep=$(api services.move "{\"serviceId\":\"$svc\",\"toNodeId\":\"$nc\"}" | jq -r '.deployment.id // .id // empty') || { bad "services.move failed"; return 1; }
  st=$(wait_deploy "$svc" 600 "$dep")
  ev "move deployment: $st $(latest_deploy "$svc" | jq -c '{trigger, shippedTo: [.shippedTo[]?.name], error}')"
  expect "placements now on C ($(api services.get "{\"serviceId\":\"$svc\"}" | jq -c '[.placements[].nodeName]'))" \
    sh -c "[ \"\$(curl -s -H 'authorization: Bearer $(state_get api-key)' '$(panel_url)/api/v1/services.get?serviceId=$svc' | jq -r '.placements[0].nodeId')\" = $nc ]"
  if wait_for 120 "mover on C" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip c)/ | grep -q mover-data-intact"; then
    good "after the move the domain follows to C and the volume data is intact"
  else
    bad "C does not serve $host with the old data (code $(http_code -H "Host: $host" "http://$(node_ip c)/"), body $(curl -s -m 5 -H "Host: $host" "http://$(node_ip c)/" | head -c 80))"
  fi
  code=$(http_code -H "Host: $host" "http://$(node_ip b)/")
  ev "B answers $code for $host after the move"
  expect "no container of the service is left on B" sh -c "[ -z \"\$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$svc)\" ]"
}

check_16() {
  need_key || return 3
  local nb nc svc host hosts codes failed total cid
  nb=$(node_id b)
  nc=$(node_id c)
  [ -n "$nc" ] || { blocked "node C is not joined"; return 3; }
  delete_service e2e lb
  svc=$(image_service e2e lb b traefik/whoami:v1.10.3 80) || { bad "services.create lb failed"; return 1; }
  state_set svc-lb "$svc"
  [ "$(wait_deploy "$svc" 300)" = live ] || bad "lb first deploy failed"
  api services.setPlacements "{\"serviceId\":\"$svc\",\"placements\":[{\"nodeId\":\"$nb\",\"replicas\":1},{\"nodeId\":\"$nc\",\"replicas\":1}],\"stickySessions\":false,\"entryNodeId\":\"$nb\"}" >/dev/null ||
    { bad "services.setPlacements failed"; return 1; }
  api deployments.deploy "{\"serviceId\":\"$svc\"}" >/dev/null || true
  [ "$(wait_deploy "$svc" 600)" = live ] || bad "lb deploy across B and C failed: $(latest_deploy "$svc" | jq -r .error)"
  host=lb.e2e.test
  api domains.add "{\"serviceId\":\"$svc\",\"host\":\"$host\",\"targetPort\":80,\"https\":\"off\",\"primary\":true}" >/dev/null || bad "domains.add failed"
  wait_for 120 "lb domain" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q Hostname" || true
  # Every replica has the host name "lb"; the last Traefik hop (X-Forwarded-Server,
  # a container id) and the replica's address tell them apart.
  hosts=$(for i in $(seq 1 30); do curl -s -m 5 -H "Host: $host" "http://$(node_ip b)/" |
    awk '/^IP: 1[07]/{ip=$2} /^X-Forwarded-Server:/{fs=$2} END{print fs "/" ip}'; done | sort | uniq -c | tr -s ' \n' ' ')
  ev "30 requests to the entry node B answered from (traefik/replica): $hosts"
  ev "B's route for $host: $(on "$E2E_B" "grep -h 'url:' \$(grep -l '$host' $BRAND_DATA_DIR/traefik/dynamic/*.yml) 2>/dev/null" | tr -s ' \n' ' ')"
  expect "both replicas (B and C) answer through the entry node" test "$(printf '%s' "$hosts" | wc -w)" -ge 4
  cid=$(container_on c "$svc")
  [ -n "$cid" ] || { bad "no replica container on C"; return 1; }
  codes=$RES/$CUR.codes
  load_loop 25 "http://$(node_ip b)/" "$host" "$codes" &
  local loop=$!
  sleep 3
  on "$E2E_C" "docker kill $cid >/dev/null"
  ev "killed the replica on C ($cid) during the load"
  wait $loop || true
  total=$(wc -l <"$codes" | tr -d ' ')
  failed=$(grep -cv '^200$' "$codes" || true)
  ev "$total requests during the failover, $failed not 200 ($(sort "$codes" | uniq -c | tr -s ' \n' ' '))"
  expect "requests keep succeeding when one replica dies" test "$failed" = 0
}

# ---------------------------------------------------------------- 17-21 stacks, pages, resilience

check_17() {
  need_key || return 3
  local pid nb yaml out stack members m cid
  pid=$(project_id e2e)
  nb=$(node_id b)
  delete_service e2e stack
  yaml='services:
  writer:
    image: busybox:1.37
    command: ["sh", "-c", "while true; do date +%s > /shared/now.txt; echo wrote; sleep 2; done"]
    volumes:
      - shared:/shared
  reader:
    image: busybox:1.37
    command: ["sh", "-c", "sleep 4; while true; do echo read-$(cat /shared/now.txt); sleep 3; done"]
    volumes:
      - shared:/shared
volumes:
  shared: {}
'
  out=$(api compose.create "$(jq -nc --arg p "$pid" --arg n "$nb" --arg y "$yaml" '{projectId:$p, name:"stack", nodeId:$n, source:{type:"inline", yaml:$y}, deployNow:true}')") ||
    { bad "compose.create failed"; return 1; }
  stack=$(printf '%s' "$out" | jq -r .stack.id)
  members=$(printf '%s' "$out" | jq -r '.members[].id')
  ev "stack $stack with members $(printf '%s' "$out" | jq -c '[.members[].name]')"
  for m in $members; do
    wait_for 300 "member $m running" svc_running "$m" || bad "member $m is $(svc_status "$m")"
  done
  sleep 12
  for m in $members; do
    cid=$(container_on b "$m")
    ev "member $m container $cid: $(on "$E2E_B" "docker logs --tail 2 $cid 2>&1" | tr '\n' ' ')"
  done
  local all=""
  for m in $members; do
    all="$all $(on "$E2E_B" "docker logs --tail 3 \$(docker ps -q --filter label=$SLUG.service=$m | head -1) 2>&1" | tr '\n' ' ')"
  done
  expect "the reader sees the writer's file through the shared volume" sh -c "printf '%s' '$all' | grep -q 'read-[0-9]'"
}

check_18() {
  need_key || return 3
  local pid nb list slug out svc st host
  pid=$(project_id e2e)
  nb=$(node_id b)
  list=$(api templates.list) || { bad "templates.list failed"; return 1; }
  ev "catalog: $(printf '%s' "$list" | jq '.templates | length') templates ($(printf '%s' "$list" | jq -c '[.templates[].slug] | .[0:8]'))"
  slug=it-tools
  printf '%s' "$list" | jq -e --arg s "$slug" '.templates[] | select(.slug==$s)' >/dev/null || { bad "no $slug template in the catalog"; return 1; }
  delete_service e2e it-tools
  out=$(api templates.create "{\"projectId\":\"$pid\",\"slug\":\"$slug\",\"name\":\"it-tools\",\"nodeId\":\"$nb\",\"values\":{\"image\":\"corentinth/it-tools:2024.10.22-7ca5933\"},\"deployNow\":true}") ||
    { bad "templates.create failed"; return 1; }
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  svc=$(printf '%s' "$out" | jq -r '(.services // .created // [])[0].id // .serviceIds[0] // .service.id // empty')
  [ -n "$svc" ] || svc=$(service_id e2e it-tools)
  [ -n "$svc" ] || { bad "templates.create returned no service ($(printf '%s' "$out" | head -c 200))"; return 1; }
  st=$(wait_deploy "$svc" 600)
  [ "$st" = live ] && good "it-tools from the catalog is live" || bad "it-tools deployment ended $st"
  host=$(api domains.list "{\"serviceId\":\"$svc\"}" | jq -r '(.domains // .)[0].host // empty')
  ev "template domain: ${host:-none}"
  if [ -n "$host" ]; then
    local did
    did=$(api domains.list "{\"serviceId\":\"$svc\"}" | jq -r '(.domains // .)[0].id')
    api domains.update "{\"serviceId\":\"$svc\",\"domainId\":\"$did\",\"https\":\"off\",\"redirectToHttps\":false}" >/dev/null || true
    expect "it-tools answers through B's Traefik" wait_for 120 "it-tools" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -qi 'it-tools\|IT Tools'"
  else
    wait_for 60 "first-run" has_first_run "$svc" || true
    expect "it-tools answers on its first-run address" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -qi 'it-tools\|IT Tools'"
  fi
}

check_19() {
  need_key || return 3
  local svc host other code exp eport expires wait_s
  svc=$(state_get svc-whoami)
  host=$(state_get host-whoami)
  [ -n "$svc" ] && [ -n "$host" ] || { blocked "no whoami domain (check 4)"; return 3; }

  # Timed expose locked to the Mac's address (5 minutes is the shortest).
  exp=$(api exposures.openTimed "{\"serviceId\":\"$svc\",\"targetPort\":80,\"durationMinutes\":5,\"allowedCidrs\":[\"$(host_ip)/32\"]}") ||
    bad "exposures.openTimed failed"
  ev "timed expose: $(printf '%s' "$exp" | jq -c '{host, port, allowedCidrs, expiresAt}')"
  eport=$(printf '%s' "$exp" | jq -r '.port // empty')
  expires=$(printf '%s' "$exp" | jq -r '.expiresAt // empty')
  if [ -z "$eport" ]; then sleep 5; eport=$(api exposures.get "{\"serviceId\":\"$svc\"}" | jq -r '.timed[0].port // empty'); fi
  if [ -n "$eport" ]; then
    wait_for 30 "the timed port" sh -c "curl -fsS -m 3 http://$(node_ip b):$eport/ | grep -q Hostname" &&
      good "the Mac ($(host_ip)) reaches $(node_ip b):$eport" || bad "the Mac cannot reach the timed expose $(node_ip b):$eport"
    code=$(on "$E2E_A" "curl -s -o /dev/null -m 3 -w '%{http_code}' http://$(node_ip b):$eport/" 2>/dev/null || true)
    expect "VM A ($(node_ip a)) is refused (got ${code:-none})" sh -c "[ '${code:-000}' != 200 ]"
  else
    bad "no port for the timed expose"
  fi

  api maintenance.setGlobal '{"enabled":true,"message":"e2e global maintenance"}' >/dev/null || bad "maintenance.setGlobal failed"
  wait_for 60 "the global page" sh -c "curl -s -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q 'e2e global maintenance'" &&
    good "global maintenance page on $host (HTTP $(http_code -H "Host: $host" "http://$(node_ip b)/"))" ||
    bad "no global maintenance page on $host: $(curl -s -m 5 -H "Host: $host" "http://$(node_ip b)/" | head -c 120)"
  api maintenance.setGlobal '{"enabled":false,"message":""}' >/dev/null
  wait_for 60 "the page gone" sh -c "curl -s -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q Hostname" || bad "the app did not come back after global maintenance"
  api maintenance.set "{\"serviceId\":\"$svc\",\"enabled\":true,\"message\":\"e2e service maintenance\"}" >/dev/null || bad "maintenance.set failed"
  wait_for 60 "the service page" sh -c "curl -s -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q 'e2e service maintenance'" &&
    good "per-service maintenance page on $host" || bad "no per-service maintenance page: $(curl -s -m 5 -H "Host: $host" "http://$(node_ip b)/" | head -c 120)"
  other=$(state_get svc-lb)
  if [ -n "$other" ]; then
    expect "another service (lb.e2e.test) is not in maintenance" sh -c "curl -s -m 5 -H 'Host: lb.e2e.test' http://$(node_ip b)/ | grep -q Hostname"
  fi
  api maintenance.set "{\"serviceId\":\"$svc\",\"enabled\":false,\"message\":\"\"}" >/dev/null
  wait_for 60 "the page gone" sh -c "curl -s -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q Hostname" || bad "the app did not come back after its maintenance"

  [ -n "$eport" ] || return 1
  wait_s=330
  [ -z "$expires" ] || wait_s=$(($(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${expires%%.*}" +%s 2>/dev/null || date +%s) - $(date +%s) + 20))
  if [ "$wait_s" -gt 0 ] && [ "$wait_s" -le 400 ]; then ev "waiting ${wait_s}s for the expose to expire at $expires"; sleep "$wait_s"; fi
  code=$(http_code "http://$(node_ip b):$eport/")
  expect "the timed expose closed by itself on time (got $code)" test "$code" = 000
}

check_20() {
  need_key || return 3
  local svc host c t0 t1 tdown tup crasher job vol ok fail dies reports runs n
  svc=$(state_get svc-whoami)
  host=$(state_get host-whoami)
  vol=$(state_get svc-vol)
  job=$(state_get cron-job)
  [ -n "$host" ] && [ -n "$vol" ] && [ -n "$job" ] || { blocked "needs whoami (4), vol (11) and its cron job (12)"; return 3; }
  delete_service e2e crasher2
  crasher=$(image_service e2e crasher2 b busybox:1.37 "" \
    '{"container":{"command":["sh","-c","echo crash2-$(date +%s); sleep 8; exit 4"]}}') || { bad "services.create crasher2 failed"; return 1; }
  state_set svc-crasher2 "$crasher"
  sleep 20
  c=$(panel_container)
  t0=$(date +%s)
  tdown=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  on "$E2E_A" "docker pause $c" >/dev/null || { bad "could not pause the panel container"; return 1; }
  ev "panel paused at $tdown"
  ok=0
  fail=0
  for i in $(seq 1 30); do
    if curl -fsS -m 3 -H "Host: $host" "http://$(node_ip b)/" | grep -q Hostname; then ok=$((ok + 1)); else fail=$((fail + 1)); fi
    sleep 5
  done
  t1=$(date +%s)
  tup=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  expect "the app and its route kept serving while the panel was down ($ok ok, $fail failed)" test "$fail" = 0
  dies=$(on "$E2E_B" "timeout 2 docker events --since $t0 --until $t1 --filter label=$SLUG.service=$crasher --filter event=die --format x" 2>/dev/null | wc -l | tr -d ' ')
  local starts
  starts=$(on "$E2E_B" "timeout 2 docker events --since $t0 --until $t1 --filter label=$SLUG.service=$crasher --filter event=start --format x" 2>/dev/null | wc -l | tr -d ' ')
  expect "crash restarts kept working while the panel was down ($dies crashes, $starts restarts)" sh -c "[ $dies -ge 3 ] && [ $starts -ge 3 ]"
  on "$E2E_A" "docker unpause $c" >/dev/null
  ev "panel back at $tup"
  wait_for 180 "3 nodes back online" online_ge 3 && good "all 3 nodes resynced and online" || bad "nodes did not come back ($(nodes_online) online)"
  sleep 30
  reports=$(panel_sql "select count(*) as n from crash_reports where service_id='$crasher' and occurred_at >= $((t0 * 1000)) and occurred_at <= $((t1 * 1000))" | jq '.[0].n')
  [ "$reports" != null ] || reports=$(panel_sql "select count(*) as n from crash_reports where service_id='$crasher'" | jq '.[0].n')
  ev "crash reports for the downtime in the panel: $reports (node saw $dies crashes)"
  expect "the outbox delivered every crash report from the downtime" sh -c "[ '$reports' -ge '$dies' ]"
  runs=$(api cron.runs "{\"serviceId\":\"$vol\",\"cronJobId\":\"$job\",\"limit\":30}" | jq --arg a "$tdown" --arg b "$tup" '[.runs[] | select(.startedAt >= $a and .startedAt <= $b)] | length')
  expect "cron runs from the downtime were delivered ($runs in 150s)" test "$runs" -ge 2
  api services.stop "{\"serviceId\":\"$crasher\"}" >/dev/null || true
}

# seylo_containers <vm>: id, name and StartedAt of every running managed
# container, without the crash-test services (they restart by design).
seylo_containers() {
  local skip="$(state_get svc-crasher)|$(state_get svc-crasher2)"
  on "$1" "for c in \$(docker ps -q --filter label=$SLUG.managed=true); do docker inspect -f '{{.Id}} {{.Name}} {{.State.StartedAt}} {{index .Config.Labels \"$SLUG.service\"}}' \$c; done" |
    grep -vE " (${skip})\$" | sort
}

check_21() {
  need_key || return 3
  local before after
  # Let services stopped by earlier checks settle first.
  for s in "$(state_get svc-crasher)" "$(state_get svc-crasher2)"; do
    [ -z "$s" ] || api services.stop "{\"serviceId\":\"$s\"}" >/dev/null 2>&1 || true
  done
  sleep 15
  before=$(seylo_containers "$E2E_B")
  ev "B runs $(printf '%s\n' "$before" | grep -c . || true) seylo containers before the restart (crash-test services left out)"
  on "$E2E_B" "systemctl restart $SLUG.service"
  wait_for 90 "B's agent connected" on "$E2E_B" "$SLUG status 2>&1 | grep -qi 'connected'" || bad "B's agent did not reconnect"
  wait_for 90 "B online" online_ge 3 || true
  sleep 30
  after=$(seylo_containers "$E2E_B")
  printf 'before:\n%s\nafter:\n%s\n' "$before" "$after" >>"$RES/$CUR.log"
  if [ "$before" = "$after" ]; then
    good "every running container on B kept its id and StartedAt across systemctl restart $SLUG"
  else
    bad "containers changed across the agent restart: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^[<>]' | head -6 | tr '\n' ' ')"
  fi
  expect "whoami still answers" sh -c "curl -fsS -m 5 -H 'Host: $(state_get host-whoami)' http://$(node_ip b)/ | grep -q Hostname"
}

# ---------------------------------------------------------------- 22-30 lifecycle, tools, UI

panel_version() { curl -fsS -m 5 -H "authorization: Bearer $(state_get api-key)" "$(panel_url)/api/v1/system.version" | jq -r .version; }
node_versions() { api nodes.list | jq -c '[.nodes[] | "\(.name)=\(.agentVersion // "?" | split(" ")[0])"]'; }
all_agents_at() { api nodes.list | jq -e --arg v "$1" '[.nodes[] | select((.agentVersion // "" | split(" ")[0]) != $v)] | length == 0' >/dev/null; }
latest_run() { api updates.history '{"limit":1}' | jq -c '.runs[0]'; }
run_finished() { latest_run | jq -e '.status != "running"' >/dev/null; }

check_22() {
  need_key || return 3
  local st run v img
  "$E2E_DIR/publish.sh" "$E2E_V2" 2>>"$RES/$CUR.log"
  st=$(api updates.check '{}' 2>&1) || true
  st=$(api updates.status)
  printf '%s\n' "$st" >>"$RES/$CUR.log"
  ev "updates.status after publishing $E2E_V2: $(printf '%s' "$st" | jq -c '{panel, checkError, nodes: [.nodes[] | "\(.name)=\(.version)"]}')"
  if [ "$(printf '%s' "$st" | jq -r .panel.latestVersion)" != "$E2E_V2" ]; then
    bad "the panel does not see $E2E_V2 (checkError: $(printf '%s' "$st" | jq -r .checkError))"
    return 1
  fi
  good "the panel sees $E2E_V2 on the local release server (signed with the test key)"
  api updates.setAutoUpdate '{"enabled":true}' >/dev/null || bad "updates.setAutoUpdate failed"
  # Auto-update runs on its own schedule; start the same run now if it has not begun.
  sleep 20
  if ! api updates.status | jq -e '.activeRun != null' >/dev/null; then
    api updates.updatePanel '{"panelOnly":false}' >/dev/null || bad "updates.updatePanel failed"
    ev "auto-update had not started within 20s; started the run with updates.updatePanel"
  fi
  wait_for 600 "the panel at $E2E_V2" sh -c "[ \"\$(curl -fsS -m 5 -H 'authorization: Bearer $(state_get api-key)' '$(panel_url)/api/v1/system.version' | jq -r .version)\" = '$E2E_V2' ]" &&
    good "the panel runs $E2E_V2 (system.version)" || bad "the panel is still at $(panel_version)"
  wait_for 900 "every agent at $E2E_V2" all_agents_at "$E2E_V2" &&
    good "every node runs $E2E_V2: $(node_versions)" || bad "agents not updated: $(node_versions)"
  wait_for 300 "the update run to finish" run_finished || true
  run=$(latest_run)
  printf '%s\n' "$run" >>"$RES/$CUR.log"
  ev "update run: $(printf '%s' "$run" | jq -c '{targetVersion, trigger, status, error, steps: [.steps[] | "\(.position):\(.target):\(.nodeName // "panel"):\(.status)"]}')"
  expect "the panel step comes first, then the nodes one by one" sh -c \
    "printf '%s' '$(printf '%s' "$run" | jq -c '[.steps | sort_by(.position)[] | .target]')' | grep -q '^\[\"panel\",\"agent\"'"
  expect "the update run succeeded" sh -c "printf '%s' '$run' | jq -e '.status==\"succeeded\"' >/dev/null"
  img=$(on "$E2E_A" "docker inspect -f '{{.Config.Image}}' \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1)")
  ev "panel container image now: $img"

  # A broken N+2 panel: the swap fails, the snapshot and the old image come back.
  api updates.setAutoUpdate '{"enabled":false}' >/dev/null || true
  "$E2E_DIR/publish.sh" "$E2E_V3" 2>>"$RES/$CUR.log"
  api updates.check '{}' >/dev/null 2>&1 || true
  api projects.create '{"name":"e2e-before-broken"}' >/dev/null 2>&1 || true
  api updates.updatePanel '{"panelOnly":true}' >/dev/null || bad "updates.updatePanel to $E2E_V3 failed to start"
  sleep 10
  wait_for 600 "the broken update run to finish" run_finished || true
  wait_for 300 "the panel back" curl -fsS -m 5 "$(panel_url)/api/health" || bad "the panel did not come back after the broken update"
  run=$(latest_run)
  printf '%s\n' "$run" >>"$RES/$CUR.log"
  ev "broken update run: $(printf '%s' "$run" | jq -c '{targetVersion, status, error, steps: [.steps[] | "\(.target):\(.status):\(.error // "" | .[0:80])"]}')"
  expect "the $E2E_V3 run is marked failed or rolled back" sh -c "printf '%s' '$run' | jq -e '.targetVersion==\"$E2E_V3\" and (.status==\"failed\" or ([.steps[].status] | index(\"rolledBack\")))' >/dev/null"
  v=$(panel_version)
  expect "the panel still runs $E2E_V2 after the rollback (now $v)" test "$v" = "$E2E_V2"
  expect "the restored database is intact (the API key works, projects are there)" sh -c \
    "curl -fsS -m 5 -H 'authorization: Bearer $(state_get api-key)' '$(panel_url)/api/v1/projects.list' | jq -e '[.projects[].name] | index(\"e2e\")' >/dev/null"
  img=$(on "$E2E_A" "docker inspect -f '{{.Config.Image}}' \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1)")
  expect "the old image runs again ($img)" sh -c "printf '%s' '$img' | grep -qE ':$E2E_V2|$(state_get "panel-digest-$E2E_V2")'"
  # Leave N+1 published so later runs see a consistent latest.
  "$E2E_DIR/publish.sh" "$E2E_V2" 2>>"$RES/$CUR.log"
}

check_23() {
  need_key || return 3
  local nb prev items
  nb=$(node_id b)
  # Unlabeled look-alikes, and garbage of a service this node no longer runs
  # (a labelled image, volume and data folder; reconcile itself removes
  # labelled containers of unknown services at once, so none is made here).
  on "$E2E_B" "docker rm -f e2e-unlabeled-ctr >/dev/null 2>&1; docker volume rm e2e-unlabeled-vol >/dev/null 2>&1;
    docker run --name e2e-unlabeled-ctr busybox:1.37 true >/dev/null &&
    docker volume create e2e-unlabeled-vol >/dev/null &&
    docker tag busybox:1.37 e2e-unlabeled-img:1 &&
    docker volume create --label $SLUG.managed=true --label $SLUG.service=deadbeefdeadbeef e2e-seylo-garbage-vol >/dev/null &&
    printf 'FROM busybox:1.37\nLABEL $SLUG.managed=true $SLUG.service=deadbeefdeadbeef\n' | docker build -q -t e2e-seylo-garbage-img:1 - >/dev/null &&
    mkdir -p $BRAND_DATA_DIR/services/deadbeefdeadbeef/volumes/x && echo garbage >$BRAND_DATA_DIR/services/deadbeefdeadbeef/volumes/x/f"
  ev "made an unlabeled stopped container, volume and image, plus a labelled image, volume and data folder of a removed service"
  prev=$(api cleanup.preview "{\"nodeId\":\"$nb\",\"images\":true,\"buildCache\":true,\"stoppedContainers\":true,\"orphanedServiceData\":true}") ||
    { bad "cleanup.preview failed"; return 1; }
  printf '%s\n' "$prev" >>"$RES/$CUR.log"
  items=$(printf '%s' "$prev" | jq -r '.items[]')
  ev "preview: $(printf '%s' "$prev" | jq -c '{bytes, count: (.items|length), items: .items[0:8]}')"
  expect "the preview never lists the unlabeled resources" sh -c "! printf '%s' '$items' | grep -q 'e2e-unlabeled'"
  expect "the preview lists the removed service's image, volume and data" sh -c \
    "printf '%s' '$items' | grep -q e2e-seylo-garbage-img && printf '%s' '$items' | grep -q e2e-seylo-garbage-vol && printf '%s' '$items' | grep -q deadbeefdeadbeef"
  api cleanup.run "{\"nodeId\":\"$nb\",\"images\":true,\"buildCache\":true,\"stoppedContainers\":true,\"orphanedServiceData\":true}" >>"$RES/$CUR.log" ||
    bad "cleanup.run failed"
  sleep 15
  expect "the unlabeled container survives" on "$E2E_B" "docker inspect e2e-unlabeled-ctr >/dev/null"
  expect "the unlabeled volume survives" on "$E2E_B" "docker volume inspect e2e-unlabeled-vol >/dev/null"
  expect "the unlabeled image survives" on "$E2E_B" "docker image inspect e2e-unlabeled-img:1 >/dev/null"
  expect "the infrastructure containers on A survive (not cleaned there either)" on "$E2E_A" "docker inspect e2e-registry e2e-minio >/dev/null"
  expect "the labelled garbage image is gone" on "$E2E_B" "! docker image inspect e2e-seylo-garbage-img:1 >/dev/null 2>&1"
  expect "the labelled garbage volume is gone" on "$E2E_B" "! docker volume inspect e2e-seylo-garbage-vol >/dev/null 2>&1"
  expect "the removed service's data folder is gone" on "$E2E_B" "! test -e $BRAND_DATA_DIR/services/deadbeefdeadbeef"
  expect "running services are untouched (whoami answers)" sh -c "curl -fsS -m 5 -H 'Host: $(state_get host-whoami)' http://$(node_ip b)/ | grep -q Hostname"
}

check_24() {
  need_key || return 3
  local cli home out
  cli=$E2E_OUT/${SLUG}_darwin_$(vm_arch)
  CGO_ENABLED=0 GOOS=darwin go -C "$E2E_ROOT/go" build -trimpath -o "$cli" ./cmd/seylo 2>>"$RES/$CUR.log" ||
    { bad "could not build the macOS CLI"; return 1; }
  home=$E2E_STATE/cli-home
  rm -rf "$home"
  mkdir -p "$home"
  # A private HOME: the saved login never touches the owner's real config.
  out=$(printf '%s\n' "$(state_get api-key)" | HOME=$home XDG_CONFIG_HOME=$home/.config "$cli" login "$(panel_url)" --token-stdin 2>&1) &&
    good "seylo login (API key): $out" || bad "seylo login failed: $out"
  # Browser approval: the CLI prints a code and a link and waits; the owner
  # (the saved browser session, as on the /cli/approve page) approves it read-only.
  local bhome blog code
  bhome=$E2E_STATE/cli-home-browser
  rm -rf "$bhome"
  mkdir -p "$bhome"
  blog=$RES/$CUR.browser-login
  # Empty it first: the login below truncates it only once its subshell runs,
  # and a code left by an earlier run would satisfy the wait before that.
  : >"$blog"
  (HOME=$bhome XDG_CONFIG_HOME=$bhome/.config run_for 120 "$cli" login "$(panel_url)" --no-browser --profile web >"$blog" 2>&1) &
  local lpid=$!
  wait_for 30 "the sign-in code" grep -q 'sign-in code' "$blog" || true
  code=$(sed -n 's/.*sign-in code: \([A-Z0-9-]*\).*/\1/p' "$blog" | head -1)
  ev "seylo login (browser): $(grep -E 'code|Approve' "$blog" | sed "s/$code/<code>/" | tr '\n' ' ')"
  if [ -n "$code" ]; then
    curl -fsS -b "$E2E_STATE/cookies" -H 'content-type: application/json' -H "origin: $(panel_url)" \
      "$(panel_url)/api/v1/cliLogin.get?userCode=$code" >>"$RES/$CUR.log" 2>&1 &&
      good "the approval page's request shows the computer: $(curl -fsS -b "$E2E_STATE/cookies" "$(panel_url)/api/v1/cliLogin.get?userCode=$code" |
        jq -c --arg host "$(hostname)" '.request | {clientName: (.clientName | if startswith($host) then "<this computer>" + .[($host | length):] else . end), status}')" ||
      bad "cliLogin.get with the owner session failed"
    reauth "$E2E_STATE/cookies"
    curl -fsS -b "$E2E_STATE/cookies" -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
      --data "{\"userCode\":\"$code\",\"readOnly\":true,\"expiresInDays\":1}" "$(panel_url)/api/v1/cliLogin.approve" >>"$RES/$CUR.log" 2>&1 ||
      bad "cliLogin.approve with the owner session failed"
  else
    bad "seylo login printed no sign-in code: $(tail -3 "$blog" | tr '\n' ' ')"
  fi
  wait "$lpid" || true
  expect "seylo login (browser approval) signed in: $(tail -1 "$blog")" grep -q 'Signed in to' "$blog"
  out=$(HOME=$bhome XDG_CONFIG_HOME=$bhome/.config "$cli" --profile web env list e2e/envref 2>&1 || true)
  expect "the approved read-only key reads (env list)" sh -c "printf '%s' '$(printf '%s' "$out" | head -c 300 | tr -d "'")' | grep -q '='"
  out=$(HOME=$bhome XDG_CONFIG_HOME=$bhome/.config "$cli" --profile web env set e2e/envref E2E_RO=1 --no-deploy 2>&1 || true)
  expect "the approved read-only key cannot write ($(printf '%s' "$out" | tail -1 | head -c 120))" sh -c "! printf '%s' '$(printf '%s' "$out" | tr -d "'")' | grep -q '^Saved'"
  out=$(HOME=$home XDG_CONFIG_HOME=$home/.config "$cli" env set e2e/envref E2E_CLI=from-cli --no-deploy 2>&1) &&
    good "seylo env set: $(printf '%s' "$out" | tail -1)" || bad "seylo env set failed: $out"
  out=$(HOME=$home XDG_CONFIG_HOME=$home/.config "$cli" env list e2e/envref 2>&1)
  expect "seylo env list shows E2E_CLI ($(printf '%s' "$out" | tr '\n' ' ' | head -c 160))" sh -c "printf '%s' '$out' | grep -q 'E2E_CLI'"
  out=$(HOME=$home XDG_CONFIG_HOME=$home/.config run_for 400 "$cli" deploy e2e/whoami 2>&1) &&
    good "seylo deploy e2e/whoami: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')" || bad "seylo deploy failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  ( sleep 5; api services.restart "{\"serviceId\":\"$(state_get svc-node-app)\"}" >/dev/null ) &
  out=$(HOME=$home XDG_CONFIG_HOME=$home/.config run_for 40 "$cli" logs e2e/node-app -f -n 5 2>&1 || true)
  wait || true
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  expect "seylo logs -f streamed lines ($(printf '%s' "$out" | grep -c 'listening') 'listening' lines)" sh -c "printf '%s' '$out' | grep -q 'listening on'"
}

mcp_post() { # token json
  curl -sS -m 30 -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' -X POST --data "$2" "$(panel_url)/mcp"
}

mcp_key() { # name readOnly
  reauth "$E2E_STATE/cookies"
  curl -fsS -b "$E2E_STATE/cookies" -c "$E2E_STATE/cookies" -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
    --data "{\"kind\":\"mcp\",\"name\":\"$1\",\"actions\":[\"*\"],\"readOnly\":$2,\"expiresInDays\":1}" \
    "$(panel_url)/api/v1/apiKeys.create" 2>/dev/null | jq -r .token ||
    api apiKeys.create "{\"kind\":\"mcp\",\"name\":\"$1\",\"actions\":[\"*\"],\"readOnly\":$2,\"expiresInDays\":1}" | jq -r .token
}

check_25() {
  need_key || return 3
  local ro rw out tools n svc appr
  api mcp.update '{"enabled":true}' >/dev/null || bad "mcp.update enabled failed"
  ro=$(mcp_key e2e-mcp-ro true)
  rw=$(mcp_key e2e-mcp-rw false)
  [ -n "$ro" ] && [ "$ro" != null ] && [ -n "$rw" ] && [ "$rw" != null ] || { bad "could not create MCP tokens"; return 1; }
  out=$(mcp_post "$ro" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')
  ev "initialize: $(printf '%s' "$out" | jq -c '.result | {protocolVersion, serverInfo}' 2>/dev/null || printf '%s' "$out" | head -c 200)"
  tools=$(mcp_post "$ro" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  n=$(printf '%s' "$tools" | jq '.result.tools | length' 2>/dev/null || echo 0)
  ev "read-only token sees $n tools, destructive ones: $(printf '%s' "$tools" | jq -c '[.result.tools[] | select(.annotations.readOnlyHint != true) | .name] | .[0:5]' 2>/dev/null)"
  expect "the read-only token lists tools" test "$n" -gt 0
  expect "the read-only token sees no destructive tool" sh -c "printf '%s' '$(printf '%s' "$tools" | jq -c '[.result.tools[] | select(.annotations.readOnlyHint != true)] | length')' | grep -qx 0"
  out=$(mcp_post "$ro" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nodes_list","arguments":{}}}')
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  expect "a query tool (nodes_list) runs and returns the nodes" sh -c "printf '%s' '$(printf '%s' "$out" | jq -c '.result.content' 2>/dev/null)' | grep -q 'e2e-b'"
  delete_service e2e mcp-victim
  svc=$(image_service e2e mcp-victim b busybox:1.37 "" '{"deployNow":false}') || { bad "services.create mcp-victim failed"; return 1; }
  out=$(mcp_post "$rw" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"services_delete\",\"arguments\":{\"serviceId\":\"$svc\",\"confirmName\":\"mcp-victim\"}}}")
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  ev "destructive call (services_delete) answered: $(printf '%s' "$out" | jq -r '.result.content[0].text // .error.message' 2>/dev/null | head -c 220)"
  appr=$(api approvals.list '{"status":"pending"}' | jq -c '[.approvals[]? | select((.opId // .op.id // .op // "" | tostring) | contains("services.delete"))]')
  expect "the destructive call created a pending approval ($(printf '%s' "$appr" | jq -c '[.[] | {id, status}]'))" test "$(printf '%s' "$appr" | jq length)" -ge 1
  expect "the service still exists while the approval waits" sh -c "[ -n \"\$(curl -fsS -H 'authorization: Bearer $(state_get api-key)' '$(panel_url)/api/v1/services.get?serviceId=$svc' | jq -r .id)\" ]"
  for a in $(printf '%s' "$appr" | jq -r '.[].id'); do api approvals.deny "{\"approvalId\":\"$a\",\"note\":\"e2e cleanup\"}" >/dev/null || true; done
}

check_26() {
  local out st
  out=$(on "$E2E_B" "$SLUG troubleshoot --dry-run 2>&1")
  printf '%s\n' "$out" >"$RES/$CUR.report.md"
  ev "troubleshoot --dry-run on B: $(printf '%s' "$out" | wc -l | tr -d ' ') lines, $(printf '%s' "$out" | grep -c 'REDACTED\|<redacted>\|\*\*\*') redaction markers"
  expect "the report is redacted (markers present)" sh -c "printf '%s' \"\$(cat '$RES/$CUR.report.md')\" | grep -q 'REDACTED\|<redacted>\|\*\*\*'"
  expect "no join token, API key or private key in the report" sh -c "! grep -qE '${SLUG}_(join|key|setup)_[A-Za-z0-9_-]{20}|PRIVATE KEY' '$RES/$CUR.report.md'"
  st=$(on "$E2E_B" "$SLUG status 2>&1")
  ev "seylo status on B: $(printf '%s' "$st" | head -6 | tr -s ' \n' ' ')"
  expect "seylo status shows the connection" sh -c "printf '%s' '$st' | grep -qi 'connected'"
}

check_27() {
  need_key || return 3
  local nc out left
  nc=$(node_id c)
  [ -n "$nc" ] || { blocked "C is not joined"; return 3; }
  # Services on C go first so the node can be removed from the panel after.
  for s in mover far-client; do delete_service e2e "$s"; done
  local lb
  lb=$(state_get svc-lb)
  [ -z "$lb" ] || api services.setPlacements "{\"serviceId\":\"$lb\",\"placements\":[{\"nodeId\":\"$(node_id b)\",\"replicas\":1}],\"stickySessions\":false,\"entryNodeId\":null}" >/dev/null || true
  sleep 20
  out=$(on "$E2E_C" "$(installer_fetch) | sh -s -- uninstall --purge" 2>&1) || bad "install.sh uninstall --purge failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  left=$(on "$E2E_C" "echo containers: \$(docker ps -aq --filter label=$SLUG.managed=true | wc -l); echo networks: \$(docker network ls -q --filter label=$SLUG.managed=true | wc -l); echo volumes: \$(docker volume ls -q --filter label=$SLUG.managed=true | wc -l); echo seylo-named: \$(docker ps -a --format '{{.Names}}' | grep -c '^$SLUG-' || true); ls /etc/systemd/system | grep -c '^$SLUG' || true; test -e $BRAND_DATA_DIR && echo datadir-present || echo datadir-gone; test -e /usr/local/bin/$SLUG && echo binary-present || echo binary-gone")
  ev "after uninstall on C: $(printf '%s' "$left" | tr '\n' ' ')"
  expect "no seylo containers, networks or volumes left" sh -c "printf '%s' '$left' | grep -q 'containers: 0' && printf '%s' '$left' | grep -q 'networks: 0' && printf '%s' '$left' | grep -q 'volumes: 0' && printf '%s' '$left' | grep -q 'seylo-named: 0'"
  ev "systemd units named $SLUG.* still loaded: $(on "$E2E_C" "systemctl list-units --all --plain --no-legend '$SLUG.*' | awk '{print \$1 \"=\" \$3 \"/\" \$4}'" | tr '\n' ' ')"
  expect "no $SLUG unit files or drop-ins left" on "$E2E_C" "! ls /etc/systemd/system | grep -q '^$SLUG'"
  expect "systemd no longer knows $SLUG.service" on "$E2E_C" "! systemctl cat $SLUG.service >/dev/null 2>&1"
  expect "$BRAND_DATA_DIR and the binary are gone" sh -c "printf '%s' '$left' | grep -q datadir-gone && printf '%s' '$left' | grep -q binary-gone"
  # Join C again so the VMs stay ready for the next stage.
  api nodes.remove "{\"nodeId\":\"$nc\",\"confirmName\":\"e2e-c\"}" >/dev/null 2>&1 || ev "note: nodes.remove of the old C entry refused"
  state_set node-c ""
  join_node "$E2E_C" c "--name e2e-c --yes" && wait_for 120 "C back" online_ge 3 && map_nodes && ev "C joined again as $(node_id c)"
}

check_28() {
  need_key || return 3
  local cid parent cg driver
  driver=$(on "$E2E_C" "docker info --format '{{.CgroupDriver}}'")
  ev "C Docker cgroup driver: $driver"
  expect "C uses the systemd cgroup driver" test "$driver" = systemd
  cid=$(on "$E2E_C" "docker ps -q --filter label=$SLUG.managed=true | head -1")
  if [ -z "$cid" ]; then
    delete_service e2e slice-probe
    image_service e2e slice-probe c busybox:1.37 "" '{"container":{"command":["sleep","86400"]}}' >/dev/null || bad "services.create slice-probe failed"
    wait_for 180 "a container on C" sh -c "[ -n \"\$(limactl shell --workdir / $E2E_C -- sudo docker ps -q --filter label=$SLUG.managed=true)\" ]" || true
    cid=$(on "$E2E_C" "docker ps -q --filter label=$SLUG.managed=true | head -1")
  fi
  [ -n "$cid" ] || { bad "no seylo container on C"; return 1; }
  parent=$(on "$E2E_C" "docker inspect -f '{{.HostConfig.CgroupParent}}' $cid")
  cg=$(on "$E2E_C" "cat /proc/\$(docker inspect -f '{{.State.Pid}}' $cid)/cgroup")
  ev "container $cid: CgroupParent=$parent, /proc cgroup=$cg"
  expect "the container's cgroup parent is $SLUG.slice" test "$parent" = "$SLUG.slice"
  expect "the process runs under $SLUG.slice" sh -c "printf '%s' '$cg' | grep -q '$SLUG.slice'"
  expect "systemd shows it in $SLUG.slice" on "$E2E_C" "systemctl status $SLUG.slice --no-pager | grep -q docker-"
}

check_29() {
  need_key || return 3
  local svc host did st
  # The root that signed Pebble's own TLS certificate (the image has no cat).
  on "$E2E_A" "docker cp e2e-pebble:/test/certs/pebble.minica.pem - | tar -xO" | on "$E2E_B" "cat >$BRAND_DATA_DIR/e2e-pebble-root.pem"
  on "$E2E_B" "grep -q 'BEGIN CERTIFICATE' $BRAND_DATA_DIR/e2e-pebble-root.pem" || { bad "could not copy Pebble's root to B"; return 1; }
  on "$E2E_B" "sed -i '/^acme_ca/d' $BRAND_DATA_DIR/config.yml; printf 'acme_ca: https://$(node_ip a):14000/dir\nacme_ca_certificates: $BRAND_DATA_DIR/e2e-pebble-root.pem\nacme_ca_server_name: pebble\n' >>$BRAND_DATA_DIR/config.yml; systemctl restart $SLUG.service"
  wait_for 90 "B back" online_ge 3 || true
  svc=$(state_get svc-whoami)
  host=acme.$(wildcard_of b)
  did=$(api domains.list "{\"serviceId\":\"$svc\"}" | jq -r --arg h "$host" '(.domains // .)[] | select(.host==$h) | .id' | head -1)
  [ -n "$did" ] || did=$(api domains.add "{\"serviceId\":\"$svc\",\"host\":\"$host\",\"targetPort\":80,\"https\":\"acme\",\"primary\":false}" | jq -r .id) ||
    { bad "domains.add acme failed"; return 1; }
  wait_for 300 "a certificate" sh -c "curl -fsS -m 5 'https://$(node_ip b)' -H 'Host: $host' -k -o /dev/null --resolve '$host:443:$(node_ip b)' && echo | openssl s_client -connect $(node_ip b):443 -servername $host 2>/dev/null | openssl x509 -noout -issuer | grep -qi pebble" &&
    good "$host serves a certificate issued by Pebble" || bad "no Pebble certificate for $host: $(api domains.list "{\"serviceId\":\"$svc\"}" | jq -c --arg h "$host" '[.domains[]? // .[]? | select(.host==$h) | .certificate]')"
}

check_30() {
  local dir=$E2E_DIR/web out rc=0 pw=$E2E_ROOT/test/playwright/node_modules
  [ -x "$pw/.bin/playwright" ] || { blocked "Playwright is not installed in test/playwright (bun install there)"; return 3; }
  [ -s "$E2E_STATE/owner" ] || { blocked "no owner credentials (check 2)"; return 3; }
  # The spec imports @playwright/test: link test/playwright's install (gitignored).
  [ -e "$dir/node_modules" ] || ln -s ../../playwright/node_modules "$dir/node_modules"
  out=$(cd "$dir" && E2E_PANEL_URL=$(panel_url) E2E_OWNER_FILE=$E2E_STATE/owner E2E_API_KEY=$(state_get api-key) \
    E2E_SHOTS=$E2E_STATE/shots "$pw/.bin/playwright" test --config "$dir/playwright.config.ts" 2>&1) || rc=$?
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  ev "$(printf '%s' "$out" | grep -E 'tabs visited|passed|failed|Error:|expect\(' | head -8 | tr -s ' ')"
  [ $rc = 0 ] && good "Playwright: dashboard shows the nodes, services and every tab load, console echoes, no page errors" ||
    bad "Playwright smoke failed (exit $rc), see $RES/$CUR.log and $E2E_STATE/shots"
}

# ---------------------------------------------------------------- 31 panel domain

# Check 31 gives the panel a domain on A: a new panel<time>.<A dashed>.sslip.io
# name each run (so a certificate from an earlier Pebble never gets in the way)
# with a certificate from the harness's Pebble. The VMs trust Pebble's root
# while the check runs (B's and C's agents restart to read it, Go loads the
# system roots once per process); on the Mac only the check's own curl calls
# (--cacert) and CLI runs (SSL_CERT_FILE) do, the keychain is left alone.
# A test build of the panel trusts <data dir>/panel/test-ca.pem in its domain
# probe, so the domain turns active by itself and the panel asks B and C to
# reconnect and move. p31_cleanup puts everything back (no domain, B and C on
# https://<A>:3443 with the pin, A without the ACME settings and the test CA,
# no Pebble root in the trust stores), so single checks rerun as before.
P31_ROOT=$E2E_STATE/pebble-root.pem
P31_CA=/usr/local/share/ca-certificates/$SLUG-e2e-pebble.crt
P31_DOM=
P31_BLOCKED=

# p31_curl <args...>: curl from the Mac trusting Pebble's root and nothing else.
p31_curl() { curl -sS -m 10 --cacert "$P31_ROOT" "$@"; }
# p31_cli <args...>: the macOS laptop CLI in a private HOME; Pebble's root is
# its only CA for this run (Go 1.27 honours SSL_CERT_FILE on macOS).
p31_cli() {
  HOME=$E2E_STATE/cli-home-domain XDG_CONFIG_HOME=$E2E_STATE/cli-home-domain/.config \
    SSL_CERT_FILE=$P31_ROOT GODEBUG=x509sslcertoverrideplatform=1 "$E2E_OUT/${SLUG}_darwin_$(vm_arch)" "$@"
}
p31_header() { tr -d '\r' <"$1" | grep -qiE "$2"; }
p31_no_header() { ! tr -d '\r' <"$1" | grep -qiE "$2"; }
p31_state() { api settings.general | jq -r .domainStatus.state; }
p31_state_is() { [ "$(p31_state)" = "$1" ]; }
p31_state_not() { [ "$(p31_state)" != "$1" ]; }
# p31_mark_active <domain>: the panelDomainStatus row the panel's probe writes
# for a domain whose HTTPS answers with a certificate it trusts.
p31_mark_active() {
  local now value
  now=$(($(date +%s) * 1000))
  value=$(jq -nc --arg d "$1" --argjson t "$now" '{domain: $d, state: "active", message: "", checkedAt: $t}')
  panel_sql_write "insert into settings (key, value, updated_at) values ('panelDomainStatus', '$value', $now)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
}
# p31_built <fixed string> <path in the tree>: the tree the VMs' build came
# from has it. build.sh copies that tree to /root/e2e-src on A; without the
# copy, the working tree.
p31_built() {
  if on "$E2E_A" "test -d /root/e2e-src" 2>/dev/null; then
    on "$E2E_A" "grep -rqsF -- '$1' /root/e2e-src/$2" 2>/dev/null
  else
    grep -rqsF -- "$1" "$E2E_ROOT/$2"
  fi
}
# p31_move_missing: why the nodes cannot move to a domain with the build the
# VMs run, or nothing when both halves are in it.
p31_move_missing() {
  p31_built 'string panel_url = 4' proto || { echo "the build the VMs run has no HelloAccepted.panel_url (rebuild with refresh.sh)"; return; }
  p31_built 'panelPin' apps/panel/src || { echo "the panel build the VMs run does not send HelloAccepted.panel_url (rebuild with refresh.sh)"; return; }
  p31_built 'GetPanelUrl()' go/internal/agent || echo "the agent build the VMs run does not act on HelloAccepted.panel_url (rebuild with refresh.sh)"
}
# p31_conn <letter>: the node's top-level panel_url, panel_pin and insecure_transport lines, sorted.
p31_conn() { on_node "$1" "grep -E '^(panel_url|panel_pin|insecure_transport):' $BRAND_DATA_DIR/config.yml | sort"; }
p31_moved() { p31_conn "$1" | grep -qE "^panel_url: [\"']?https://${P31_DOM//./\\.}(:443)?/?[\"']?\$"; }
p31_both_moved() { p31_moved b && p31_moved c; }
p31_no_key() { ! p31_conn "$1" | grep -q "^$2:"; }
p31_fallback() { on_node "$1" "grep -A2 '^fallback:' $BRAND_DATA_DIR/config.yml" 2>/dev/null | tr -s ' \n' ' '; }
p31_has_fallback() { on_node "$1" "grep -q '^fallback:' $BRAND_DATA_DIR/config.yml" 2>/dev/null; }
p31_standing() { on_node "$1" "grep -A4 '^fallback:' $BRAND_DATA_DIR/config.yml | grep -q 'standing: true'" 2>/dev/null; }
# p31_returned <letter>: dials the address it had before the check again, and is connected.
p31_returned() { [ "$(p31_conn "$1")" = "$(state_get "p31-conn-$1")" ] && p31_connected "$1"; }
p31_both_returned() { p31_returned b && p31_returned c; }
p31_journal() { on_node "$1" "journalctl -u $SLUG.service --since '-${3:-10} min' --no-pager -o cat 2>/dev/null | grep -F '$2' | tail -1"; }
# p31_peers <letter>: the ports on A the node holds TCP connections to.
p31_peers() { on_node "$1" "ss -Htn state established dst $(node_ip a)" | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' '; }
# p31_via_domain <letter> <agents' TLS port>: a connection to A:443 (Traefik) and none to the TLS port.
p31_via_domain() {
  local p
  p=" $(p31_peers "$1")"
  case $p in *" 443 "*) ;; *) return 1 ;; esac
  case $p in *" $2 "*) return 1 ;; esac
}
p31_status() { on_node "$1" "$SLUG status 2>&1" | grep -m1 '^Panel:' | tr -s ' '; }
p31_status_domain() { case $(p31_status "$1") in *"https://$P31_DOM"*"(connected"*) return 0 ;; esac; return 1; }
p31_connected() { on_node "$1" "$SLUG status 2>&1 | grep -q '^Panel:.*(connected'"; }
p31_both_connected() { p31_connected b && p31_connected c; }
p31_to_https() { case $1 in 30[1278]" https://$P31_DOM/") return 0 ;; esac; return 1; }
# p31_back <letter>: on the agents' TLS port with the pin again, and connected.
p31_back() { pinned_join "$(vm_of "$1")" && ! p31_has_fallback "$1" && p31_connected "$1"; }
p31_restart() { local l; for l in "$@"; do on_node "$l" "systemctl restart $SLUG.service"; done; }
p31_alerts() { api alerts.list "$(jq -nc --arg n "$(node_id "$1")" '{nodeId: $n, limit: 3}')" | jq -c '[.alerts[] | {event, title: (.title // .message // "" | .[0:120])}]'; }

check_31() {
  need_key || return 3
  local rc=0 s
  P31_BLOCKED=
  # A run that was stopped half way left state behind: undo it first.
  for s in p31-domain p31-conn-b p31-conn-c p31-a-acme p31-test-ca p31-ca; do
    if [ -e "$E2E_STATE/$s" ]; then
      ev "an earlier run of this check stopped half way; putting things back first"
      p31_cleanup
      break
    fi
  done
  p31_run || rc=$?
  p31_cleanup
  if [ -n "$P31_BLOCKED" ] && [ "$CUR_FAILS" = 0 ] && [ -z "$CUR_STATUS" ]; then CUR_STATUS=BLOCKED; fi
  return "$rc"
}

p31_run() {
  local ip_a l vm st out hfile pfile lfile jar cookie tls_port missing waited by_itself=
  ip_a=$(node_ip a)
  [ -n "$(node_id b)" ] && [ -n "$(node_id c)" ] || { blocked "B and C are not joined (check 3)"; return 3; }
  [ -s "$E2E_STATE/owner" ] || { blocked "no owner credentials (check 2)"; return 3; }
  on "$E2E_A" "docker inspect -f '{{.State.Running}}' e2e-pebble 2>/dev/null | grep -q true" ||
    { blocked "Pebble is not running on A (infra.sh)"; return 3; }
  [ "$(api settings.general | jq -r .domain)" = null ] ||
    { blocked "the panel already has a domain ($(api settings.general | jq -r .domain)); check 31 starts from IP:port"; return 3; }
  # Where B and C dial now; the cleanup puts it back (kept from an interrupted run).
  for l in b c; do
    [ -n "$(state_get "p31-conn-$l")" ] || state_set "p31-conn-$l" "$(p31_conn $l)"
  done
  tls_port=$(state_get p31-conn-b | sed -n 's#^panel_url: https://[^/]*:\([0-9][0-9]*\).*#\1#p')
  [ -n "$tls_port" ] || tls_port=3443
  missing=$(p31_move_missing)

  # Pebble signs with a new root on every start: read the current one from its management port.
  on "$E2E_A" "curl -fsS -k https://127.0.0.1:15001/roots/0" >"$P31_ROOT" 2>>"$RES/$CUR.log" && grep -q 'BEGIN CERTIFICATE' "$P31_ROOT" ||
    { bad "could not read Pebble's root (A:15001/roots/0)"; return 1; }
  state_set p31-ca yes
  for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
    on "$vm" "cat >$P31_CA && update-ca-certificates >/dev/null 2>&1" <"$P31_ROOT" || bad "could not add Pebble's root to the trust store of $vm"
  done
  good "A, B and C trust Pebble's root ($(openssl x509 -in "$P31_ROOT" -noout -subject 2>/dev/null | sed 's/^subject= *//')); on the Mac only this check's curl and CLI calls do"
  if [ -z "$missing" ]; then
    p31_restart b c
    wait_for 90 "B and C back" p31_both_connected || true
    ev "B's and C's agents restarted to read the new trust store"
  fi

  # A's Traefik gets its certificates from Pebble (check 29 does the same on B).
  if ! on "$E2E_A" "grep -q '^acme_ca:' $BRAND_DATA_DIR/config.yml" 2>/dev/null; then
    state_set p31-a-acme yes
    on "$E2E_A" "docker cp e2e-pebble:/test/certs/pebble.minica.pem - | tar -xO >$BRAND_DATA_DIR/e2e-pebble-acme.pem &&
      printf 'acme_ca: https://$ip_a:14000/dir\nacme_ca_certificates: $BRAND_DATA_DIR/e2e-pebble-acme.pem\nacme_ca_server_name: pebble\n' >>$BRAND_DATA_DIR/config.yml &&
      systemctl restart $SLUG.service" || { bad "could not point A's ACME client at Pebble"; return 1; }
    wait_for 90 "A's agent back" p31_connected a || bad "A's agent did not reconnect after the restart"
    ev "A's agent restarted with Pebble (https://$ip_a:14000/dir) as its ACME CA"
  fi
  # A test build of the panel trusts this file in its domain probe (a shipped one never reads it).
  state_set p31-test-ca yes
  on "$E2E_A" "cat >$BRAND_DATA_DIR/panel/test-ca.pem && chmod 0644 $BRAND_DATA_DIR/panel/test-ca.pem" <"$P31_ROOT" ||
    bad "could not write the panel's test CA"

  P31_DOM=panel$(date +%H%M%S).$(wildcard_of a)
  state_set p31-domain "$P31_DOM"
  api settings.updateGeneral "$(jq -nc --arg d "$P31_DOM" '{domain: $d}')" >/dev/null ||
    { bad "settings.updateGeneral could not set the domain $P31_DOM"; return 1; }
  good "panel domain $P31_DOM set (sslip.io answers $ip_a, A's address)"

  if wait_for 300 "a certificate for $P31_DOM" p31_curl -f -o /dev/null "https://$P31_DOM/api/health"; then
    good "https://$P31_DOM answers with a certificate Pebble's root verifies: $(echo | openssl s_client -connect "$ip_a:443" -servername "$P31_DOM" 2>/dev/null |
      openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')"
  else
    bad "https://$P31_DOM has no certificate Pebble's root verifies ($(p31_curl -o /dev/null "https://$P31_DOM/api/health" 2>&1 | tail -1)); domain status $(api settings.general | jq -c .domainStatus)"
    return 1
  fi
  out=$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' "http://$P31_DOM/")
  expect "http://$P31_DOM goes to HTTPS ($out)" p31_to_https "$out"

  # The panel's own check: DNS, then its HTTPS probe (with the test CA in a
  # test build). Asking again for the same domain re-runs it where the panel
  # supports that; otherwise the 5-minute schedule does.
  api settings.updateGeneral "$(jq -nc --arg d "$P31_DOM" '{domain: $d}')" >/dev/null || true
  waited=$SECONDS
  if p31_built 'testCaFile' apps/panel/src; then
    wait_for 400 "the panel's probe to find the domain active" p31_state_is active && by_itself=1
  else
    wait_for 60 "the panel's domain check" p31_state_not pending_dns || true
  fi
  st=$(api settings.general | jq -c .domainStatus)
  ev "the panel's domain check after $((SECONDS - waited))s: $st"
  case $(printf '%s' "$st" | jq -r .state) in
  active) good "the panel's own probe found $P31_DOM active (it trusts the test CA in a test build)" ;;
  issuing_certificate)
    ev "DNS passed; the panel's HTTPS probe does not trust Pebble in this build, so the check records the state a public certificate gets"
    p31_mark_active "$P31_DOM" >>"$RES/$CUR.log" || bad "could not record $P31_DOM as active"
    ;;
  *)
    bad "the panel's domain check did not get past DNS: $st"
    return 1
    ;;
  esac
  expect "settings.general reports the domain active" p31_state_is active

  # HSTS on HTTPS only; the session cookie a sign-in over HTTPS sets is Secure.
  hfile=$RES/$CUR.https-headers
  pfile=$RES/$CUR.http-headers
  p31_curl -D "$hfile" -o /dev/null "https://$P31_DOM/api/health" 2>>"$RES/$CUR.log" || true
  curl -sS -m 5 -D "$pfile" -o /dev/null "$(panel_url)/api/health" 2>>"$RES/$CUR.log" || true
  expect "HTTPS answers carry HSTS ($(tr -d '\r' <"$hfile" | grep -i '^strict-transport-security' || true))" \
    p31_header "$hfile" '^strict-transport-security:[[:space:]]*max-age=31536000'
  expect "plain HTTP on IP:port carries no HSTS" p31_no_header "$pfile" '^strict-transport-security:'
  jar=$E2E_STATE/p31-cookies
  lfile=$RES/$CUR.login-headers
  rm -f "$jar"
  p31_curl -D "$lfile" -o "$RES/$CUR.login-body" -c "$jar" -H 'content-type: application/json' -H "origin: https://$P31_DOM" -X POST \
    --data "$(jq -nc --arg e "$(sed -n 1p "$E2E_STATE/owner")" --arg p "$(sed -n 2p "$E2E_STATE/owner")" '{email: $e, password: $p}')" \
    "https://$P31_DOM/api/v1/auth.login" 2>>"$RES/$CUR.log" || true
  cookie=$(tr -d '\r' <"$lfile" | grep -i '^set-cookie:' | head -1 | sed -E 's/=[^;]*/=<redacted>/' || true)
  ev "auth.login over https://$P31_DOM: $(head -1 "$lfile" | tr -d '\r'); $cookie"
  expect "the session cookie set over HTTPS is Secure" p31_header "$lfile" '^set-cookie:.*;[[:space:]]*secure([[:space:]]*;|$)'
  expect "the session cookie is HttpOnly" p31_header "$lfile" '^set-cookie:.*;[[:space:]]*httponly([[:space:]]*;|$)'
  expect "the HTTPS session works (auth.whoami)" p31_curl -f -o /dev/null -b "$jar" "https://$P31_DOM/api/v1/auth.whoami"
  p31_curl -o /dev/null -b "$jar" -c "$jar" -H 'content-type: application/json' -H "origin: https://$P31_DOM" -X POST --data '{}' \
    "https://$P31_DOM/api/v1/auth.logout" 2>>"$RES/$CUR.log" || true
  rm -f "$jar"

  # IP:port pages go to the domain; the API, loopback and the domain itself do not.
  out=$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' -H 'accept: text/html' "$(panel_url)/settings/general?e2e=31")
  expect "a page load on IP:port answers 302 to the domain ($out)" test "$out" = "302 https://$P31_DOM/settings/general?e2e=31"
  expect "the panel's pages answer on the domain" test "$(p31_curl -o /dev/null -w '%{http_code}' "https://$P31_DOM/settings/general")" = 200
  expect "the API on IP:port is not redirected (scripts, CLI and agents keep working)" test "$(http_code "$(panel_url)/api/health")" = 200
  expect "pages on A's loopback are not redirected (the way back in over SSH)" \
    on "$E2E_A" "test \"\$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:$E2E_PORT/)\" = 200"

  # The laptop CLI against the domain.
  if CGO_ENABLED=0 GOOS=darwin go -C "$E2E_ROOT/go" build -trimpath -o "$E2E_OUT/${SLUG}_darwin_$(vm_arch)" ./cmd/seylo 2>>"$RES/$CUR.log"; then
    rm -rf "$E2E_STATE/cli-home-domain"
    mkdir -p "$E2E_STATE/cli-home-domain"
    out=$(state_get api-key | p31_cli login "https://$P31_DOM" --token-stdin 2>&1) &&
      good "seylo login https://$P31_DOM (macOS CLI, API key): $out" || bad "seylo login https://$P31_DOM failed: $out"
    if [ -n "$(service_id e2e whoami)" ]; then
      out=$(p31_cli env set e2e/whoami E2E_DOMAIN_CLI=31 --no-deploy 2>&1) &&
        good "seylo env set e2e/whoami over the domain: $(printf '%s' "$out" | tail -1)" || bad "seylo env set over the domain failed: $out"
      out=$(p31_cli env list e2e/whoami 2>&1 || true)
      printf '%s\n' "$out" >>"$RES/$CUR.log"
      expect "seylo env list over the domain shows E2E_DOMAIN_CLI" grep -q 'E2E_DOMAIN_CLI' <<<"$out"
      p31_cli env unset e2e/whoami E2E_DOMAIN_CLI --no-deploy >>"$RES/$CUR.log" 2>&1 || true
    else
      ev "no e2e/whoami service (check 4), so only the login ran"
    fi
  else
    bad "could not build the macOS CLI"
  fi

  # B and C move to the domain. When the panel's own probe made it
  # active, the panel closes their connections itself; after the SQL stand-in
  # an agent restart is their next connect.
  if [ -n "$missing" ]; then
    ev "BLOCKED B and C moving to the domain: $missing"
    P31_BLOCKED=1
    return 0
  fi
  if [ -n "$by_itself" ]; then
    if wait_for 120 "B and C to move after the panel asked them to reconnect" p31_both_moved; then
      good "the panel asked B and C to reconnect and both moved without a restart"
    else
      bad "B and C did not move on their own within 120s of the domain going active (b: $(p31_conn b | tr '\n' ' '), c: $(p31_conn c | tr '\n' ' ')); restarting their agents"
      p31_restart b c
    fi
  else
    p31_restart b c
  fi
  wait_for 180 "B and C to move to the domain" p31_both_moved || true
  for l in b c; do
    if p31_moved $l; then
      good "$l moved to the domain: $(p31_conn $l | tr '\n' ' ')"
    else
      bad "$l did not move to https://$P31_DOM: $(p31_conn $l | tr '\n' ' '); node alerts $(p31_alerts $l)"
      ev "     $l agent log: $(on_node $l "journalctl -u $SLUG.service --since '-10 min' --no-pager -o cat 2>/dev/null | grep -iE 'move|address|panel_url' | tail -3" | tr '\n' ' ' | head -c 600)"
    fi
  done
  p31_both_moved || return 1
  case $(on "$E2E_A" "grep '^panel_url:' $BRAND_DATA_DIR/config.yml") in
  "panel_url: http://127.0.0.1"* | "panel_url: http://localhost"* | "panel_url: http://[::1]"*) good "A (the panel's node) keeps dialing loopback" ;;
  *) bad "A no longer dials loopback: $(on "$E2E_A" "grep '^panel_url:' $BRAND_DATA_DIR/config.yml")" ;;
  esac
  for l in b c; do
    expect "$l has no panel_pin (the domain's certificate is checked with system roots)" p31_no_key $l panel_pin
    expect "$l dropped insecure_transport" p31_no_key $l insecure_transport
    expect "$l keeps the old address as a fallback for one cycle ($(p31_fallback $l | sed -E 's/sha256:[0-9a-f]{56}/sha256:.../'))" p31_has_fallback $l
    ev "$l agent log: $(p31_journal $l 'moved to the panel' | head -c 240)"
    wait_for 90 "$l connected through the domain" p31_status_domain $l || true
    expect "$l is connected through the domain: $(p31_status $l)" p31_status_domain $l
    expect "$l's agent talks to A:443, not to the agents' TLS port $tls_port (ports on A it holds: $(p31_peers $l))" p31_via_domain $l "$tls_port"
  done
  wait_for 120 "3 online nodes" online_ge 3 || true
  expect "3 nodes online after the move" online_ge 3

  # The new address sticks: after a restart the agent dials the domain; the
  # old address, https:// with a pin, stays as a standing fallback.
  p31_restart b c
  sleep 5
  for l in b c; do
    wait_for 120 "$l back through the domain" p31_status_domain $l || true
    expect "$l reconnects through the domain after an agent restart: $(p31_status $l)" p31_status_domain $l
    expect "$l still dials the domain" p31_moved $l
    wait_for 30 "$l's fallback to become standing" p31_standing $l || true
    expect "$l keeps its pinned old address as a standing fallback ($(p31_journal $l 'keeping the previous pinned one' 3 | sed 's/.*msg=//' | head -c 160))" p31_standing $l
    expect "$l holds no connection to the agents' TLS port (ports on A: $(p31_peers $l))" p31_via_domain $l "$tls_port"
  done
  wait_for 120 "3 online nodes" online_ge 3 || true
  expect "3 nodes online after restarting B's and C's agents" online_ge 3

  # The domain goes away: with no route left, B and C find the panel again on
  # their standing fallback after about 5 minutes of failed connects (the
  # restart drops their open connection through Traefik).
  api settings.updateGeneral '{"domain":null}' >/dev/null || { bad "settings.updateGeneral {domain: null} failed"; return 1; }
  rm -f "$E2E_STATE/p31-domain"
  good "panel domain removed (settings.updateGeneral {domain: null})"
  expect "IP:port pages are served again" test "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H 'accept: text/html' "$(panel_url)/")" = 200
  p31_restart b c
  waited=$SECONDS
  if wait_for 480 "B and C back on their fallback" p31_both_returned; then
    good "B and C came back to https://$ip_a:$tls_port by themselves $((SECONDS - waited))s after the restart: b $(p31_conn b | tr '\n' ' '), c $(p31_conn c | tr '\n' ' ')"
  else
    for l in b c; do
      p31_returned $l || bad "$l did not come back from the removed domain: $(p31_conn $l | tr '\n' ' '); $(p31_status $l); log: $(p31_journal $l fallback 10 | sed 's/.*msg=//' | head -c 200)"
    done
  fi
}

# p31_cleanup: undoes what check 31 changed, in an order that works from any
# point it stopped at. The domain goes first, so nothing sends B or C to it again.
p31_cleanup() {
  local l vm saved restart_a=
  if [ -n "$(state_get p31-domain)" ]; then
    if api settings.updateGeneral '{"domain":null}' >/dev/null; then
      ev "cleanup: panel domain removed"
    else
      bad "cleanup: settings.updateGeneral {domain: null} failed (REQUESTS 'P-e2e -> P-panel: removing the panel domain fails'); removing it in the database"
      panel_sql_write "delete from settings where key = 'panelDomain'" >>"$RES/$CUR.log" 2>&1 || bad "cleanup: could not remove the panel domain"
      restart_a=1
    fi
    panel_sql_write "delete from settings where key = 'panelDomainStatus'" >>"$RES/$CUR.log" 2>&1 || true
    rm -f "$E2E_STATE/p31-domain"
  fi
  if [ "$(state_get p31-test-ca)" = yes ]; then
    on "$E2E_A" "rm -f $BRAND_DATA_DIR/panel/test-ca.pem" || true
    rm -f "$E2E_STATE/p31-test-ca"
  fi
  # B and C: the old address and pin back, no fallback block (the agent is
  # stopped meanwhile so it cannot write config.yml).
  for l in b c; do
    saved=$(state_get "p31-conn-$l")
    [ -n "$saved" ] || continue
    if [ "$(p31_conn $l)" != "$saved" ] || p31_has_fallback $l; then
      printf '%s\n' "$saved" | on_node $l "systemctl stop $SLUG.service && f=$BRAND_DATA_DIR/config.yml &&
        awk '/^fallback:/ { skip = 1; next } skip && /^[[:space:]]/ { next } { skip = 0 } !/^(panel_url|panel_pin|insecure_transport):/' \$f >\$f.e2e &&
        cat >>\$f.e2e && chmod --reference=\$f \$f.e2e && mv \$f.e2e \$f && systemctl start $SLUG.service" ||
        bad "cleanup: could not put back $l's panel address"
      ev "cleanup: $l dials $(printf '%s\n' "$saved" | sed -n 's/^panel_url: //p') again"
    fi
    rm -f "$E2E_STATE/p31-conn-$l"
  done
  if [ "$(state_get p31-a-acme)" = yes ]; then
    on "$E2E_A" "sed -i '/^acme_ca/d' $BRAND_DATA_DIR/config.yml && rm -f $BRAND_DATA_DIR/e2e-pebble-acme.pem" ||
      bad "cleanup: could not remove A's ACME settings"
    restart_a=1
    rm -f "$E2E_STATE/p31-a-acme"
  fi
  if [ -n "$restart_a" ]; then
    # Also the way the panel route goes when the domain was removed in the database.
    on "$E2E_A" "systemctl restart $SLUG.service" || true
    wait_for 90 "A's agent back" p31_connected a || bad "cleanup: A's agent did not reconnect"
    ev "cleanup: A's agent restarted without the Pebble ACME settings"
  fi
  if [ "$(state_get p31-ca)" = yes ]; then
    for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do on "$vm" "rm -f $P31_CA && update-ca-certificates >/dev/null 2>&1" || true; done
    rm -f "$E2E_STATE/p31-ca"
  fi
  for l in b c; do
    wait_for 90 "$l connected" p31_connected $l || true
    expect "cleanup: $l is back on the agents' TLS port with the pin, no fallback, connected ($(p31_status $l))" p31_back $l
  done
  wait_for 120 "3 online nodes" online_ge 3 || true
  expect "cleanup: 3 nodes online" online_ge 3
}

# ---------------------------------------------------------------- main

# The whole file is read before main runs, so editing it during a run is safe.
main() {
  if [ "${1:-}" = report ]; then
    write_report
    return 0
  fi
  local list n
  list=${*:-$(seq 1 "$LAST")}
  for n in $list; do
    run_check "$n"
    write_report 2>/dev/null
  done
  write_report
}
main "$@"; exit $?
