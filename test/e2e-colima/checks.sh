#!/usr/bin/env bash
# The e2e checklist against the three VMs. One function per check
# (check_01 .. check_41); each prints its sub-results with evidence and ends
# PASS, FAIL, BLOCKED (a precondition is missing, with the reason) or SKIP.
# Results are kept per check in dist/e2e/state/results and RESULTS.md (next
# to this file) is rewritten from them after every run, so a single check
# can be rerun alone.
#
# Usage: test/e2e-colima/checks.sh [N ...]     (default: 1..30, 32..40, then 31)
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
  "Replicas on B and C, entry on B; failover when either container dies (round robin and sticky)"
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
  "Docker Hub: search, tags, inspect traefik/whoami on the real Docker Hub; dockerHub.create on B live on its auto domain"
  "Gitea provider on A: a push outside the watch path skips (reason logged), inside deploys, [skip ci] skips"
  "Scheduled cleanup on B: a disk line triggers a run that removes only labelled resources and reports them"
  "Host shell on B: owner turns it on with re-auth, hostname through the panel's socket, audited, agent refuses when off"
  "Clone whoami with its data into another project on C; move a service between projects (impact list, keeps serving)"
  "Valkey, ClickHouse, Postgres 18 + pgvector on B: app connects, TLS exposure, shell query, backup to MinIO, restore"
  "Upgrade: a $E2E_BASE panel and node with real rows move to this build by the normal update; 0001 applies, data survives"
  "Build default: Add node's box decides Can build, a refused join exits 3; Serve on IP address off over the domain, CLI and domain-death reopen"
  "Panel on Tailscale (Headscale): Serve over HTTP to the panel's socket, reached from C, Lock to Tailscale, automatic and CLI recovery"
  "Move the panel A -> B in the browser: data, keys, registry and sign-ins come along, every node follows; a failed move rolls back; back to A"
)
# The highest check number. Check 31 gives the panel a domain and puts
# everything back afterwards; it runs last (after 32..41) so a failed
# cleanup cannot spoil the others. Checks 39, 40 and 41 put back what they
# change too.
LAST=41
DOMAIN_CHECK=31

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

# panel_user_of <vm>: the panel container's --user, then owner:group:mode of
# the panel folder and of master.key (go/internal/docker PanelUser).
panel_user_of() {
  on "$1" "c=\$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1); printf '%s %s %s' \"\$(docker inspect -f '{{.Config.User}}' \$c)\" \"\$(stat -c '%u:%g:%a' $BRAND_DATA_DIR/panel)\" \"\$(stat -c '%u:%g:%a' $BRAND_DATA_DIR/panel/master.key)\""
}
# panel_user_ok <vm>: the panel runs as uid 61000, which no login user has, and only it and root read its folder.
panel_user_ok() { test "$(panel_user_of "$1")" = "61000:61000 61000:61000:700 61000:61000:600"; }

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
  local out link token cid1 cid2 cid3 started1 started3 labels again=
  write_key_dropin "$E2E_A"
  if on "$E2E_A" "grep -q '^node_id:' $BRAND_DATA_DIR/config.yml 2>/dev/null"; then
    ev "A was installed by an earlier run; re-running the installer (keeps the node)"
    # A kept A may run a later release (the update checks): the installer
    # refuses to install the older $E2E_V1 over it without --downgrade.
    again=--downgrade
  fi
  # No --image: the installer takes the panel image from the signed release
  # manifest, pinned by its digest, as a real install does.
  out=$(on "$E2E_A" "$(installer_fetch) | sh -s -- --release-url $(release_base)/$ORG/$REPO/releases \
    --version $E2E_V1 --port $E2E_PORT $again" 2>&1) || {
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
  expect "the panel runs as the panel user with its folder closed to login users ($(panel_user_of "$E2E_A"))" panel_user_ok "$E2E_A"
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

# A browser session is the cookie plus the session key the panel hands out
# next to it (header x-<slug>-session-key); the cookie alone signs nobody in.
# The web app keeps the key in localStorage; these checks keep it in
# <jar>.key next to the cookie jar.
SESSION_KEY_HEADER=x-$SLUG-session-key

# scurl <jar> <curl args...>: curl as that browser session: sends the jar's
# cookie and key, and keeps a new cookie or key the answer hands out.
scurl() {
  local jar=$1 hdr rc key
  shift
  hdr=$(mktemp)
  key=$(cat "$jar.key" 2>/dev/null || true)
  if [ -n "$key" ]; then
    curl -c "$jar" -b "$jar" -D "$hdr" -H "$SESSION_KEY_HEADER: $key" "$@"
  else
    curl -c "$jar" -b "$jar" -D "$hdr" "$@"
  fi
  rc=$?
  if grep -qi "^$SESSION_KEY_HEADER:" "$hdr"; then
    tr -d '\r' <"$hdr" | grep -i "^$SESSION_KEY_HEADER:" | tail -1 | sed 's/^[^:]*:[[:space:]]*//' >"$jar.key"
  fi
  rm -f "$hdr"
  return $rc
}

# reauth <cookie jar>: confirms the owner's password on that browser session,
# which then counts as a fresh sign-in for 15 minutes. apiKeys.create and
# cliLogin.approve need one; a panel from before re-auth existed has no
# auth.reauth and needs none, so a failure here is not one.
reauth() {
  local pw
  pw=$(sed -n 2p "$E2E_STATE/owner" 2>/dev/null)
  [ -n "$pw" ] || return 0
  scurl "$1" -sS -m 30 -o /dev/null -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
    --data "$(jq -nc --arg p "$pw" '{password: $p}')" "$(panel_url)/api/v1/auth.reauth" >/dev/null 2>&1 || true
}

# create_key <cookie jar>: apiKeys.create with the owner's browser session.
create_key() {
  local key
  reauth "$1"
  key=$(scurl "$1" -fsS -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
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
    if [ -s "$jar" ] && scurl "$jar" -fsS "$(panel_url)/api/v1/auth.whoami" >/dev/null 2>&1; then
      ev "owner exists; creating the API key with the saved session"
      create_key "$jar" || return 1
    else
    [ -n "$token" ] || { blocked "no setup token (run check 1)"; return 3; }
    status=$(curl -fsS "$(panel_url)/api/v1/setup.status?token=$token") || { bad "setup.status failed"; return 1; }
    ev "setup.status: $(printf '%s' "$status" | jq -c '{ownerExists, link}')"
    expect "the setup link is valid" test "$(printf '%s' "$status" | jq -r .link.valid)" = true
    password=$(openssl rand -hex 16)
    printf '%s\n%s\n' "$email" "$password" >"$E2E_STATE/owner"
    rm -f "$jar" "$jar.key"
    scurl "$jar" -fsS -H 'content-type: application/json' -H "origin: $(panel_url)" \
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

# join_node <vm> <letter> [extra installer flags] [nodes.createJoinToken input]
# Runs the panel's join command on the VM. JOIN_TOKEN keeps the token's
# {tokenId, canBuild}, JOIN_CMD the command as run (with the token in it)
# and JOIN_OUT its output, for checks that look closer.
JOIN_TOKEN=
JOIN_CMD=
JOIN_OUT=
join_node() {
  local vm=$1 extra=${3:-} input=${4:-'{}'} join cmd out
  JOIN_TOKEN=''
  JOIN_CMD=''
  JOIN_OUT=''
  join=$(api nodes.createJoinToken "$input") || { bad "nodes.createJoinToken $input failed"; return 1; }
  JOIN_TOKEN=$(printf '%s' "$join" | jq -c '{tokenId, canBuild}')
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
  JOIN_CMD=$cmd
  out=$(on "$vm" "$cmd" 2>&1) || {
    JOIN_OUT=$out
    printf '%s\n' "$out" >>"$RES/$CUR.log"
    bad "join on $vm failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    return 1
  }
  JOIN_OUT=$out
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  good "installer join on $vm finished: $(printf '%s' "$out" | grep -E 'Docker|Joining|joins|Connected|connected' | tr '\n' ';' | head -c 300)"
}

# join_connected: the last join's installer waited for the agent's first
# connection and said so, with the closing block of a connected join.
join_connected() {
  printf '%s' "$JOIN_OUT" | grep -qF 'Connected: the node shows up in the panel now.' &&
    printf '%s' "$JOIN_OUT" | grep -qF 'This server is a node of the panel now.'
}

# node_can_build <letter>: the node's Can build in nodes.list (true, false or empty when not found).
node_can_build() { api nodes.list | jq -r --arg id "$(node_id "$1")" '.nodes[] | select(.id==$id) | .canBuild'; }

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
  # A by its VM like B and C (check 41 moves the panel, so the panel node is not always A); the panel node when nothing matches.
  state_set node-a "$(printf '%s' "$nodes" | jq -r --arg vm "$E2E_A" --arg ip "$(node_ip a)" \
    '([.nodes[] | select((.facts.hostname // "" | contains($vm)) or .publicIpv4 == $ip or (.name | contains($vm)))] + [.nodes[] | select(.isPanelNode)]) | .[0].id // empty')"
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
  local n nodes report l joined=
  map_nodes
  if [ -n "$(node_id b)" ]; then
    ev "B already joined ($(node_id b))"
  elif join_node "$E2E_B" b "--name e2e-b"; then
    joined="$joined b"
    expect "the installer on B waited for the agent's first connection and says it is connected" join_connected
  fi
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
    # No --yes or --install-docker: the installer installs a missing Docker by itself, with nobody to ask.
    if join_node "$E2E_C" c "--name e2e-c"; then
      joined="$joined c"
      if [ "$(state_get c-docker-before)" = no ]; then
        expect "the installer on C installed Docker by itself, without --yes ($(printf '%s' "$JOIN_OUT" | grep -m1 'Docker is missing' || true))" \
          grep -qF 'Docker is missing: installing it with the official script from get.docker.com' <<<"$JOIN_OUT"
      fi
      expect "the installer on C waited for the agent's first connection and says it is connected" join_connected
    fi
  fi
  wait_for 180 "3 online nodes" online_ge 3 || true
  map_nodes
  nodes=$(api nodes.list)
  printf '%s\n' "$nodes" >>"$RES/$CUR.log"
  expect "3 nodes online" online_ge 3
  # Add node's "Build images on this node" is ticked by default: a default join command makes a build node.
  for l in $joined; do
    expect "$l joined with a default join command builds images (canBuild $(node_can_build $l))" test "$(node_can_build $l)" = true
  done
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

# expect_built_on <service> <deployment> <node id> <label>: the deployment was
# built on that node, its own. A node with Can build off (kept VMs joined
# before 0.2.1) only gets a note: check 3 asserts the join default.
expect_built_on() {
  local on_id on_name builds
  on_id=$(deploy_info "$1" "$2" | jq -r '.deployment.builtOn.id // empty')
  on_name=$(deploy_info "$1" "$2" | jq -r '.deployment.builtOn.name // "nowhere"')
  builds=$(api nodes.list | jq -r --arg id "$3" '.nodes[] | select(.id==$id) | .canBuild')
  if [ "$builds" != true ]; then
    ev "note: $4 has Can build off (joined before 0.2.1), so it built elsewhere: builtOn=$on_name"
    return 0
  fi
  expect "built on $4, its own node (builtOn=$on_name)" test "$on_id" = "$3"
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
    dep=$(latest_deploy "$svc" | jq -r .id)
    st=$(wait_deploy "$svc" 600 "$dep")
    [ "$st" = live ] && good "inline Dockerfile service is live" || bad "inline-app deployment ended $st: $(latest_deploy "$svc" | jq -r .error)"
    # No build node chosen: B builds images (the join default), so its own service builds there.
    expect_built_on "$svc" "$dep" "$nb" B
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
      dep=$(jq -r '.deployment.id // empty' "$RES/$CUR.upload")
      [ -n "$dep" ] || dep=$(latest_deploy "$svc" | jq -r .id)
      st=$(wait_deploy "$svc" 600 "$dep")
      [ "$st" = live ] && good "uploaded archive service is live" || bad "upload-app deployment ended $st: $(latest_deploy "$svc" | jq -r .error)"
      expect_built_on "$svc" "$dep" "$nb" B
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
    local whost
    whost=$(printf '%s' "$wurl" | sed -E 's#^https?://([^/:]+).*#\1#')
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
  local db vol dest policy run st rrun volid
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
  local vol job runs t0 tdown tup during c
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
  local app vol res gens ticket out echoer path up down content
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

  # The copy on the entry node itself dies: its share goes to C.
  lb_failover b "$svc" "$host" "" "requests keep succeeding when the entry node's own replica dies"

  # Sticky sessions: a client pinned to either copy keeps being answered
  # when that copy dies (the cookie works on this plain-HTTP domain).
  api services.setPlacements "{\"serviceId\":\"$svc\",\"placements\":[{\"nodeId\":\"$nb\",\"replicas\":1},{\"nodeId\":\"$nc\",\"replicas\":1}],\"stickySessions\":true,\"entryNodeId\":\"$nb\"}" >/dev/null ||
    { bad "services.setPlacements (sticky) failed"; return 1; }
  api deployments.deploy "{\"serviceId\":\"$svc\"}" >/dev/null || true
  [ "$(wait_deploy "$svc" 600)" = live ] || bad "sticky deploy failed"
  local jar n
  for n in b c; do
    jar=$RES/$CUR.jar-$n
    lb_failover "$n" "$svc" "$host" "$jar" "a client pinned to the copy on $(printf '%s' "$n" | tr a-z A-Z) keeps being answered when it dies"
  done
  api services.setPlacements "{\"serviceId\":\"$svc\",\"placements\":[{\"nodeId\":\"$nb\",\"replicas\":1},{\"nodeId\":\"$nc\",\"replicas\":1}],\"stickySessions\":false,\"entryNodeId\":\"$nb\"}" >/dev/null || true
  api deployments.deploy "{\"serviceId\":\"$svc\"}" >/dev/null || true
  wait_deploy "$svc" 600 >/dev/null
}

# lb_failover <node> <svc> <host> <jar> <claim>: load through the entry
# node B (with the cookie jar, pinned to the copy on <node>, when <jar> is
# set), kill that node's copy and expect every request to be answered.
lb_failover() {
  local node=$1 svc=$2 host=$3 jar=$4 claim=$5 cid ip i got codes failed total
  for i in $(seq 1 60); do
    cid=$(container_on "$node" "$svc")
    [ -n "$cid" ] && break
    sleep 1
  done
  [ -n "$cid" ] || { bad "no replica container on $node"; return 1; }
  sleep 3
  if [ -n "$jar" ]; then
    ip=$(on_node "$node" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $cid" | awk '{print $1}')
    for i in $(seq 1 20); do
      rm -f "$jar"
      got=$(curl -s -m 3 -c "$jar" -H "Host: $host" "http://$(node_ip b)/" | awk '/^IP: /{print $2}' | tr '\n' ' ')
      case " $got " in *" $ip "*) break ;; esac
    done
    got=$(for i in $(seq 1 6); do printf ' %s\n' "$(curl -s -m 3 -b "$jar" -c "$jar" -H "Host: $host" "http://$(node_ip b)/" | awk '/^IP: /{print $2}' | tr '\n' ' ')"; done | grep -cF " $ip " || true)
    ev "cookie jar pinned to $node's copy ($ip): $got of 6 requests answered by it"
    expect "the sticky cookie pins a client to one copy" test "$got" = 6
  fi
  codes=$RES/$CUR.codes-$node${jar:+-sticky}
  : >"$codes"
  (
    end=$((SECONDS + 22))
    while [ $SECONDS -lt $end ]; do
      curl -s -o /dev/null -m 3 -w '%{http_code}\n' ${jar:+-b "$jar" -c "$jar"} -H "Host: $host" "http://$(node_ip b)/" >>"$codes" 2>/dev/null || echo 000 >>"$codes"
      sleep 0.1
    done
  ) &
  local loop=$!
  sleep 3
  on_node "$node" "docker kill $cid >/dev/null"
  ev "killed the replica on $node ($cid) during the load${jar:+ (sticky)}"
  wait $loop || true
  total=$(wc -l <"$codes" | tr -d ' ')
  failed=$(grep -cv '^200$' "$codes" || true)
  ev "$total requests during the failover, $failed not 200 ($(sort "$codes" | uniq -c | tr -s ' \n' ' '))"
  expect "$claim" test "$failed" = 0
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
  local skip
  skip="$(state_get svc-crasher)|$(state_get svc-crasher2)"
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
    scurl "$E2E_STATE/cookies" -fsS -H 'content-type: application/json' -H "origin: $(panel_url)" \
      "$(panel_url)/api/v1/cliLogin.get?userCode=$code" >>"$RES/$CUR.log" 2>&1 &&
      good "the approval page's request shows the computer: $(scurl "$E2E_STATE/cookies" -fsS "$(panel_url)/api/v1/cliLogin.get?userCode=$code" |
        jq -c --arg host "$(hostname)" '.request | {clientName: (.clientName | if startswith($host) then "<this computer>" + .[($host | length):] else . end), status}')" ||
      bad "cliLogin.get with the owner session failed"
    reauth "$E2E_STATE/cookies"
    scurl "$E2E_STATE/cookies" -fsS -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
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
  scurl "$E2E_STATE/cookies" -fsS -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST \
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
  local svc host did st nb pa dns
  # The root that signed Pebble's own TLS certificate (the image has no cat).
  on "$E2E_A" "docker cp e2e-pebble:/test/certs/pebble.minica.pem - | tar -xO" | on "$E2E_B" "cat >$BRAND_DATA_DIR/e2e-pebble-root.pem"
  on "$E2E_B" "grep -q 'BEGIN CERTIFICATE' $BRAND_DATA_DIR/e2e-pebble-root.pem" || { bad "could not copy Pebble's root to B"; return 1; }
  on "$E2E_B" "sed -i '/^acme_ca/d' $BRAND_DATA_DIR/config.yml; printf 'acme_ca: https://$(node_ip a):14000/dir\nacme_ca_certificates: $BRAND_DATA_DIR/e2e-pebble-root.pem\nacme_ca_server_name: pebble\n' >>$BRAND_DATA_DIR/config.yml; systemctl restart $SLUG.service"
  wait_for 90 "B back" online_ge 3 || true
  svc=$(state_get svc-whoami)
  host=acme.$(wildcard_of b)
  did=$(api domains.list "{\"serviceId\":\"$svc\"}" | jq -r --arg h "$host" '(.domains // .)[] | select(.host==$h) | .id' | head -1)
  [ -n "$did" ] || did=$(api domains.add "{\"serviceId\":\"$svc\",\"host\":\"$host\",\"targetPort\":80,\"https\":\"acme\",\"primary\":false}" | jq -r .domain.id) ||
    { bad "domains.add acme failed"; return 1; }
  wait_for 300 "a certificate" sh -c "curl -fsS -m 5 'https://$(node_ip b)' -H 'Host: $host' -k -o /dev/null --resolve '$host:443:$(node_ip b)' && echo | openssl s_client -connect $(node_ip b):443 -servername $host 2>/dev/null | openssl x509 -noout -issuer | grep -qi pebble" &&
    good "$host serves a certificate issued by Pebble" || bad "no Pebble certificate for $host: $(api domains.list "{\"serviceId\":\"$svc\"}" | jq -c --arg h "$host" '[.domains[]? // .[]? | select(.host==$h) | .certificate]')"
  # The origin check: the panel fetches http://$host/.well-known/$SLUG-origin/<challenge>,
  # which sslip.io sends to B, and B's agent signs the challenge with its key. DNS
  # counts as ok (and the check runs) only against a known node address, and the
  # VMs have private ones only: B gets its own as its public address meanwhile.
  nb=$(node_id b)
  pa=$(api nodes.get "{\"nodeId\":\"$nb\"}" | jq -c '.publicAddress // null')
  api nodes.updateSettings "{\"nodeId\":\"$nb\",\"publicAddress\":\"$(node_ip b)\"}" >/dev/null || bad "nodes.updateSettings publicAddress failed"
  dns=$(api domains.checkDns "{\"serviceId\":\"$svc\",\"domainId\":\"$did\"}")
  ev "domains.checkDns $host: $(printf '%s' "$dns" | jq -c '{status, origin}')"
  [ "$(printf '%s' "$dns" | jq -r '.origin // empty')" = node ] && good "the origin check of $host reached B (origin node)" ||
    bad "the origin check of $host did not reach B: $(printf '%s' "$dns" | jq -c '{status, origin, message}')"
  api nodes.updateSettings "{\"nodeId\":\"$nb\",\"publicAddress\":${pa:-null}}" >/dev/null || bad "restoring B's public address failed"
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
# Set by p31_domain_up.
P31_TLS_PORT=
P31_MISSING=
P31_BY_ITSELF=

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

# p31_check_active: the stored domain state is active, after asking the
# panel to check now (settings.checkDomain, once per 10 seconds; a refusal
# for the rate limit is fine, the next try asks again).
p31_check_active() {
  p31_state_is active && return 0
  api settings.checkDomain '{}' >/dev/null 2>&1 || true
  p31_state_is active
}

# p31_domain_up: gives the panel a new domain with a Pebble certificate and
# waits until the panel finds it active (check 31, and check 39 for the
# panel access switches). Sets P31_DOM, P31_TLS_PORT (the agents' TLS port
# B and C dial), P31_MISSING (why B and C cannot move to the domain with
# the build the VMs run, empty when they can) and P31_BY_ITSELF (1 when the
# panel's own probe made it active, empty when the check wrote the state).
# Returns 3 when a precondition is missing (blocked), 1 on a failure.
# p31_cleanup undoes it from any point it stopped at.
p31_domain_up() {
  local ip_a l vm st waited
  P31_DOM=''
  P31_TLS_PORT=''
  P31_MISSING=''
  P31_BY_ITSELF=''
  ip_a=$(node_ip a)
  [ -n "$(node_id b)" ] && [ -n "$(node_id c)" ] || { blocked "B and C are not joined (check 3)"; return 3; }
  [ -s "$E2E_STATE/owner" ] || { blocked "no owner credentials (check 2)"; return 3; }
  on "$E2E_A" "docker inspect -f '{{.State.Running}}' e2e-pebble 2>/dev/null | grep -q true" ||
    { blocked "Pebble is not running on A (infra.sh)"; return 3; }
  [ "$(api settings.general | jq -r .domain)" = null ] ||
    { blocked "the panel already has a domain ($(api settings.general | jq -r .domain)); check $CUR starts from IP:port"; return 3; }
  # Where B and C dial now; the cleanup puts it back (kept from an interrupted run).
  for l in b c; do
    [ -n "$(state_get "p31-conn-$l")" ] || state_set "p31-conn-$l" "$(p31_conn $l)"
  done
  P31_TLS_PORT=$(state_get p31-conn-b | sed -n 's#^panel_url: https://[^/]*:\([0-9][0-9]*\).*#\1#p')
  [ -n "$P31_TLS_PORT" ] || P31_TLS_PORT=3443
  P31_MISSING=$(p31_move_missing)

  # Pebble signs with a new root on every start: read the current one from its management port.
  on "$E2E_A" "curl -fsS -k https://127.0.0.1:15001/roots/0" >"$P31_ROOT" 2>>"$RES/$CUR.log" && grep -q 'BEGIN CERTIFICATE' "$P31_ROOT" ||
    { bad "could not read Pebble's root (A:15001/roots/0)"; return 1; }
  state_set p31-ca yes
  for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
    on "$vm" "cat >$P31_CA && update-ca-certificates >/dev/null 2>&1" <"$P31_ROOT" || bad "could not add Pebble's root to the trust store of $vm"
  done
  good "A, B and C trust Pebble's root ($(openssl x509 -in "$P31_ROOT" -noout -subject 2>/dev/null | sed 's/^subject= *//')); on the Mac only this check's curl and CLI calls do"
  if [ -z "$P31_MISSING" ]; then
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
  p31_test_ca_on || bad "could not write the panel's test CA"

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

  # The panel's own check: DNS, then its HTTPS probe (with the test CA in a
  # test build). settings.checkDomain runs it now; a panel without that op
  # re-runs it when it is asked for the same domain again, else the 5-minute
  # schedule does.
  api settings.updateGeneral "$(jq -nc --arg d "$P31_DOM" '{domain: $d}')" >/dev/null || true
  waited=$SECONDS
  if p31_built 'testCaFile' apps/panel/src; then
    wait_for 400 "the panel's probe to find the domain active" p31_check_active && P31_BY_ITSELF=1
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
}

# p31_test_ca_on / p31_test_ca_off: the panel's domain probe trusts Pebble
# (a test build reads <data dir>/panel/test-ca.pem), or no longer does,
# which makes its next check fail as if the domain stopped working.
p31_test_ca_on() {
  on "$E2E_A" "cat >$BRAND_DATA_DIR/panel/test-ca.pem && chmod 0644 $BRAND_DATA_DIR/panel/test-ca.pem" <"$P31_ROOT"
}
p31_test_ca_off() { on "$E2E_A" "rm -f $BRAND_DATA_DIR/panel/test-ca.pem"; }

p31_run() {
  local ip_a l out hfile pfile lfile jar cookie key tls_port missing waited refusal by_itself
  ip_a=$(node_ip a)
  p31_domain_up || return $?
  tls_port=$P31_TLS_PORT
  missing=$P31_MISSING
  by_itself=$P31_BY_ITSELF
  out=$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' "http://$P31_DOM/")
  expect "http://$P31_DOM goes to HTTPS ($out)" p31_to_https "$out"

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
  rm -f "$jar" "$jar.key"
  p31_curl -D "$lfile" -o "$RES/$CUR.login-body" -c "$jar" -H 'content-type: application/json' -H "origin: https://$P31_DOM" -X POST \
    --data "$(jq -nc --arg e "$(sed -n 1p "$E2E_STATE/owner")" --arg p "$(sed -n 2p "$E2E_STATE/owner")" '{email: $e, password: $p}')" \
    "https://$P31_DOM/api/v1/auth.login" 2>>"$RES/$CUR.log" || true
  cookie=$(tr -d '\r' <"$lfile" | grep -i '^set-cookie:' | head -1 | sed -E 's/=[^;]*/=<redacted>/' || true)
  ev "auth.login over https://$P31_DOM: $(head -1 "$lfile" | tr -d '\r'); $cookie"
  expect "the session cookie set over HTTPS is Secure" p31_header "$lfile" '^set-cookie:.*;[[:space:]]*secure([[:space:]]*;|$)'
  expect "the session cookie is HttpOnly" p31_header "$lfile" '^set-cookie:.*;[[:space:]]*httponly([[:space:]]*;|$)'
  expect "the session cookie over HTTPS is __Host- prefixed" p31_header "$lfile" "^set-cookie:[[:space:]]*__Host-${SLUG}_session="
  expect "the session cookie names no Domain" p31_no_header "$lfile" '^set-cookie:.*;[[:space:]]*domain='
  key=$(tr -d '\r' <"$lfile" | grep -i "^$SESSION_KEY_HEADER:" | tail -1 | sed 's/^[^:]*:[[:space:]]*//')
  expect "the HTTPS cookie alone is no session" sh -c "[ \"\$(curl -sS -m 10 --cacert '$P31_ROOT' -o /dev/null -w '%{http_code}' -b '$jar' 'https://$P31_DOM/api/v1/auth.whoami')\" = 401 ]"
  expect "the HTTPS session works (auth.whoami with the session key)" p31_curl -f -o /dev/null -b "$jar" -H "$SESSION_KEY_HEADER: $key" "https://$P31_DOM/api/v1/auth.whoami"
  p31_curl -o /dev/null -b "$jar" -c "$jar" -H "$SESSION_KEY_HEADER: $key" -H 'content-type: application/json' -H "origin: https://$P31_DOM" -X POST --data '{}' \
    "https://$P31_DOM/api/v1/auth.logout" 2>>"$RES/$CUR.log" || true
  rm -f "$jar" "$jar.key"

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
  # restart drops their open connection through Traefik). B and C dial the
  # domain, so the panel refuses until the call says it knows they go offline.
  if refusal=$(api settings.updateGeneral '{"domain":null}' 2>&1 >/dev/null); then
    bad "settings.updateGeneral {domain: null} went through without acknowledgeNodesOffline while B and C dial the domain"
  else
    case "$refusal" in
      *nodesOnDomain*) good "removing the domain without acknowledgeNodesOffline is refused ($(printf '%s' "$refusal" | grep -o '"message":"[^"]*' | head -c 160))" ;;
      *) bad "removing the domain was refused for another reason: $(printf '%s' "$refusal" | head -c 300)" ;;
    esac
  fi
  api settings.updateGeneral '{"domain":null,"acknowledgeNodesOffline":true}' >/dev/null ||
    { bad "settings.updateGeneral {domain: null, acknowledgeNodesOffline: true} failed"; return 1; }
  rm -f "$E2E_STATE/p31-domain"
  good "panel domain removed (settings.updateGeneral {domain: null, acknowledgeNodesOffline: true})"
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
    if api settings.updateGeneral '{"domain":null,"acknowledgeNodesOffline":true}' >/dev/null; then
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

# ---------------------------------------------------------------- 32-37 0.2 features

# json_ok <json> <jq filter>: the filter holds for the JSON (in this shell, so any text is fine).
json_ok() { printf '%s' "$1" | jq -e "$2" >/dev/null; }

# domain_of <service>: the host of the service's first domain.
domain_of() { api domains.list "{\"serviceId\":\"$1\"}" | jq -r '(.domains // .)[0].host // empty'; }
# plain_http <service> <domain host>: the domain over plain HTTP (no public CA reaches a private address, as in check 4).
plain_http() {
  local did
  did=$(api domains.list "{\"serviceId\":\"$1\"}" | jq -r --arg h "$2" '(.domains // .)[] | select(.host==$h) | .id' | head -1)
  [ -n "$did" ] && api domains.update "{\"serviceId\":\"$1\",\"domainId\":\"$did\",\"https\":\"off\",\"redirectToHttps\":false}" >/dev/null
}
deploy_count() { api deployments.list "{\"serviceId\":\"$1\",\"limit\":50}" | jq '.deployments | length'; }

check_32() {
  need_key || return 3
  local nb pid out tag inspect svc st host
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  pid=$(project_id e2e)
  # The real Docker Hub, through the panel (search v4 or v2, the tags API, the registry for the config).
  out=$(api dockerHub.search '{"query":"traefik/whoami"}') || { bad "dockerHub.search failed"; return 1; }
  ev "search traefik/whoami: $(printf '%s' "$out" | jq -c '[.results[0:3][] | {repository, publisher, badge, pullCount}]')"
  expect "search finds traefik/whoami first" sh -c "printf '%s' '$(printf '%s' "$out" | jq -c '[.results[0].repository]')' | grep -q '\"traefik/whoami\"'"
  out=$(api dockerHub.tags '{"repository":"traefik/whoami"}') || { bad "dockerHub.tags failed"; return 1; }
  tag=$(printf '%s' "$out" | jq -r '.suggested // empty')
  ev "tags: suggested $tag, newest $(printf '%s' "$out" | jq -c '[.tags[0:4][] | {name, platforms: [.platforms[].platform]}]')"
  expect "tags lists versions with their platforms and suggests one ($tag)" sh -c \
    "[ -n '$tag' ] && printf '%s' '$(printf '%s' "$out" | jq -c '[.tags[] | select(.platforms | length > 0)] | length')' | grep -qv '^0$'"
  # v1.10.3 is the tag the other checks run (already on B); inspect reads its config for B's CPU.
  inspect=$(api dockerHub.inspect "{\"repository\":\"traefik/whoami\",\"tag\":\"v1.10.3\",\"arch\":\"$arch\"}") || { bad "dockerHub.inspect failed"; return 1; }
  ev "inspect v1.10.3: $(printf '%s' "$inspect" | jq -c '{digest, platform, ports, entrypoint, user, private}')"
  expect "inspect reads port 80/tcp, the entrypoint and a digest for linux/$arch" json_ok "$(printf '%s' "$inspect" | jq -c .)" "(.ports | map(.port) | index(80)) != null and (.digest | startswith(\"sha256:\")) and (.platform | startswith(\"linux/$arch\")) and (.entrypoint | length > 0)"

  delete_service e2e hub-whoami
  svc=$(api dockerHub.create "$(jq -nc --arg p "$pid" --arg n "$nb" \
    '{projectId:$p, name:"hub-whoami", nodeId:$n, repository:"traefik/whoami", tag:"v1.10.3", port:80, public:true, env:"WHOAMI_NAME=from-docker-hub\n"}')" | jq -r .id) ||
    { bad "dockerHub.create failed"; return 1; }
  state_set svc-hub-whoami "$svc"
  ev "service: $(api services.get "{\"serviceId\":\"$svc\"}" | jq -c '{name, sourceConfig, ports: [.ports[] | .containerPort]}')"
  st=$(wait_deploy "$svc" 300)
  [ "$st" = live ] && good "dockerHub.create deployed traefik/whoami:v1.10.3 on B" || { bad "the deployment ended $st"; return 1; }
  host=$(domain_of "$svc")
  [ -n "$host" ] || { bad "no automatic domain on the new service (B's wildcard $(wildcard_of b))"; return 1; }
  case $host in *".$(wildcard_of b)") good "it got B's automatic domain $host" ;; *) bad "the domain $host is not under B's wildcard $(wildcard_of b)" ;; esac
  plain_http "$svc" "$host" || bad "domains.update https off failed"
  if wait_for 120 "the Docker Hub app on its domain" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q 'Hostname'"; then
    good "http://$host answers through B's Traefik: $(curl_host b "$host" | grep -m1 Hostname)"
  else
    bad "http://$host does not answer through B's Traefik (code $(http_code -H "Host: $host" "http://$(node_ip b)/"))"
  fi
  expect "the .env from the create form reached the container (WHOAMI_NAME)" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q from-docker-hub"
}

# ---- 33: a Gitea on A as a git provider

GITEA_IMAGE=gitea/gitea:1.24.6
GITEA_PORT=13000
gitea_url() { echo "https://$(node_ip a):$GITEA_PORT"; }
gitea_api() { # method path [json]
  curl -fsS -m 30 --cacert "$E2E_STATE/tls/ca.crt" -X "$1" -H "authorization: token $(state_get gitea-token)" \
    -H 'content-type: application/json' ${3:+--data "$3"} "$(gitea_url)/api/v1$2"
}

# gitea_up: the e2e-gitea container on A (unlabeled, like the other infra),
# HTTPS with a certificate from the e2e's test-only CA, which the VMs and the
# e2e panel image trust; an admin user "e2e" and a token in state.
gitea_up() {
  local dir=$E2E_STATE/gitea ip
  ip=$(node_ip a)
  mkdir -p "$dir"
  if [ ! -s "$dir/cert.pem" ] || ! openssl x509 -in "$dir/cert.pem" -noout -ext subjectAltName 2>/dev/null | grep -q "$ip"; then
    openssl req -newkey rsa:2048 -nodes -subj "/CN=e2e-gitea" -keyout "$dir/key.pem" -out "$dir/req.csr" 2>/dev/null
    printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "$ip" >"$dir/ext.cnf"
    openssl x509 -req -in "$dir/req.csr" -CA "$E2E_STATE/tls/ca.crt" -CAkey "$E2E_STATE/tls/ca.key" -CAcreateserial \
      -days 30 -extfile "$dir/ext.cnf" -out "$dir/cert.pem" 2>/dev/null || return 1
  fi
  if ! on "$E2E_A" "docker inspect -f '{{.State.Running}}' e2e-gitea 2>/dev/null | grep -q true"; then
    # Pulled first, with a few tries: Docker Hub times out now and then.
    wait_for 120 "the Gitea image" on "$E2E_A" "docker image inspect $GITEA_IMAGE >/dev/null 2>&1 || docker pull -q $GITEA_IMAGE" || return 1
    on "$E2E_A" "docker rm -fv e2e-gitea >/dev/null 2>&1; docker create --name e2e-gitea --restart unless-stopped -p $GITEA_PORT:3000 \
      -e USER_UID=1000 -e USER_GID=1000 -e GITEA__security__INSTALL_LOCK=true -e GITEA__database__DB_TYPE=sqlite3 \
      -e GITEA__server__PROTOCOL=https -e GITEA__server__HTTP_PORT=3000 -e GITEA__server__ROOT_URL=$(gitea_url)/ \
      -e GITEA__server__CERT_FILE=/data/certs/cert.pem -e GITEA__server__KEY_FILE=/data/certs/key.pem \
      -e GITEA__webhook__ALLOWED_HOST_LIST='*' -e GITEA__webhook__DELIVER_TIMEOUT=10 \
      -e GITEA__service__DISABLE_REGISTRATION=true -e GITEA__log__LEVEL=Warn $GITEA_IMAGE >/dev/null" || return 1
    COPYFILE_DISABLE=1 tar -c -C "$dir" -f - cert.pem key.pem | on "$E2E_A" "mkdir -p /root/e2e-gitea-certs && tar -x -C /root/e2e-gitea-certs && chmod 0644 /root/e2e-gitea-certs/*.pem && docker cp /root/e2e-gitea-certs e2e-gitea:/data/certs && docker start e2e-gitea >/dev/null" || return 1
    state_set gitea-token ""
  fi
  wait_for 120 "Gitea" curl -fsS -m 5 --cacert "$E2E_STATE/tls/ca.crt" "$(gitea_url)/api/healthz" || return 1
  if [ -z "$(state_get gitea-token)" ] || ! gitea_api GET /user >/dev/null 2>&1; then
    on "$E2E_A" "docker exec -u git e2e-gitea gitea admin user create --username e2e --password e2e-$(openssl rand -hex 12) \
      --email e2e@e2e.test --admin --must-change-password=false >/dev/null 2>&1 || true"
    state_set gitea-token "$(on "$E2E_A" "docker exec -u git e2e-gitea gitea admin user generate-access-token --username e2e --token-name e2e-$(date +%s) --scopes all --raw")"
  fi
  gitea_api GET /user >/dev/null
}

# gitea_push <message> <file> <content>: one commit to e2e/watch-app's main from the Mac.
gitea_push() {
  local work=$E2E_STATE/gitea/work
  if [ ! -d "$work/.git" ]; then
    rm -rf "$work"
    GIT_SSL_CAINFO=$E2E_STATE/tls/ca.crt git clone -q "https://e2e:$(state_get gitea-token)@$(node_ip a):$GITEA_PORT/e2e/watch-app.git" "$work" || return 1
  fi
  mkdir -p "$(dirname "$work/$2")"
  printf '%s\n' "$3" >"$work/$2"
  git -C "$work" add -A
  git -C "$work" -c user.name=e2e -c user.email=e2e@e2e.test commit -qm "$1"
  GIT_SSL_CAINFO=$E2E_STATE/tls/ca.crt git -C "$work" push -q origin HEAD:main
}

# deliveries_of <service>: the webhook deliveries the panel recorded, newest first.
deliveries_of() { api webhooks.listDeliveries "{\"serviceId\":\"$1\"}" | jq -c '[.deliveries[] | {id, event, outcome, detail, deploymentId}]'; }
# new_delivery <service> <count before>: a delivery newer than the ones counted.
new_delivery() { [ "$(deliveries_of "$1" | jq 'length')" -gt "$2" ]; }

check_33() {
  need_key || return 3
  local na nb pid provider svc before dep st n host addr list log
  na=$(node_id a)
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  [ -s "$E2E_STATE/tls/ca.crt" ] || { blocked "no e2e test CA (serve.sh)"; return 3; }
  pid=$(project_id e2e)
  gitea_up >>"$RES/$CUR.log" 2>&1 || { bad "Gitea did not start on A"; return 1; }
  good "Gitea $GITEA_IMAGE on A at $(gitea_url) (certificate from the e2e test CA)"

  # A fresh repository each run: watch paths decide on what a push changes.
  gitea_api DELETE /repos/e2e/watch-app >/dev/null 2>&1 || true
  rm -rf "$E2E_STATE/gitea/work"
  gitea_api POST /user/repos '{"name":"watch-app","private":true,"default_branch":"main"}' >/dev/null || { bad "creating the Gitea repository failed"; return 1; }
  mkdir -p "$E2E_STATE/gitea/work"
  (
    cd "$E2E_STATE/gitea/work" && git init -q -b main &&
      printf '%s\n' 'FROM busybox:1.37' 'COPY app/ /www/' 'EXPOSE 8080' 'CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]' >Dockerfile &&
      mkdir -p app docs && echo 'watch-app v1' >app/index.html && echo 'notes v1' >docs/notes.md &&
      git add -A && git -c user.name=e2e -c user.email=e2e@e2e.test commit -qm 'watch-app v1' &&
      git remote add origin "https://e2e:$(state_get gitea-token)@$(node_ip a):$GITEA_PORT/e2e/watch-app.git" &&
      GIT_SSL_CAINFO=$E2E_STATE/tls/ca.crt git push -q origin main
  ) >>"$RES/$CUR.log" 2>&1 || { bad "the first push to Gitea failed"; return 1; }
  # Gitea records a new repository's first branch after the push returns; until then its branch API
  # fails (a nil pointer in Gitea 1.24's GetBranch), and that is what the panel asks when connecting.
  wait_for 60 "Gitea to serve the pushed branch" gitea_api GET /repos/e2e/watch-app/branches/main ||
    { bad "Gitea does not serve e2e/watch-app's main branch"; return 1; }
  good "e2e/watch-app (private) pushed to Gitea: Dockerfile, app/index.html, docs/notes.md"

  provider=$(api gitProviders.list | jq -r '.items[] | select(.name=="e2e-gitea") | .id' | head -1)
  if [ -n "$provider" ]; then
    delete_service e2e watch-app
    api gitProviders.delete "{\"providerId\":\"$provider\"}" >/dev/null || ev "note: gitProviders.delete of the old connection refused"
  fi
  provider=$(api gitProviders.create "$(jq -nc --arg u "$(gitea_url)" --arg t "$(state_get gitea-token)" '{kind:"gitea", name:"e2e-gitea", url:$u, token:$t}')" | jq -r .id) ||
    { bad "gitProviders.create (Gitea) failed: the panel must trust the e2e CA (test image layer)"; return 1; }
  ev "connection: $(api gitProviders.list | jq -c --arg id "$provider" '.items[] | select(.id==$id) | {kind, host, account}')"
  list=$(api gitProviders.repos "{\"projectId\":\"$pid\",\"providerId\":\"$provider\"}" | jq -c '[.repos[].fullName]')
  expect "the connection lists e2e/watch-app ($list)" sh -c "printf '%s' '$list' | grep -q e2e/watch-app"

  delete_service e2e watch-app
  svc=$(create_service "$(jq -nc --arg p "$pid" --arg nb "$nb" --arg na "$na" \
    '{projectId:$p, name:"watch-app", kind:"app", nodeId:$nb, build:{builder:"dockerfile", dockerfilePath:"Dockerfile", buildNodeId:$na},
      ports:[{containerPort:8080, protocol:"tcp"}], deployNow:false}')") || { bad "services.create watch-app failed"; return 1; }
  state_set svc-watch-app "$svc"
  api gitProviders.connectRepo "{\"serviceId\":\"$svc\",\"providerId\":\"$provider\",\"repo\":\"e2e/watch-app\",\"branch\":\"main\",\"deployOnPush\":true}" >/dev/null ||
    { bad "gitProviders.connectRepo failed"; return 1; }
  ev "webhook: $(api gitProviders.webhook "{\"serviceId\":\"$svc\"}" | jq -c '{created, url, error, insecure}')"
  expect "the panel created the webhook on the Gitea repository" test "$(api gitProviders.webhook "{\"serviceId\":\"$svc\"}" | jq -r .created)" = true
  api services.setWatchPaths "{\"serviceId\":\"$svc\",\"watchPaths\":[\"app/**\"]}" >/dev/null || bad "services.setWatchPaths failed"
  dep=$(api deployments.deploy "{\"serviceId\":\"$svc\"}" | jq -r '.id // .deployment.id')
  st=$(wait_deploy "$svc" 900 "$dep")
  [ "$st" = live ] && good "the first deploy (Dockerfile from the private Gitea repository, built on A) is live" || {
    bad "the first deploy ended $st: $(deploy_log_tail "$svc" "$dep" 8 | tr '\n' '|')"
    return 1
  }
  wait_for 60 "watch-app first-run" has_first_run "$svc" || true
  addr=$(first_run_addr "$svc")
  expect "watch-app answers v1 on $addr" sh -c "curl -fsS -m 5 http://$addr/ | grep -q 'watch-app v1'"

  # 1. Outside the watch path: no deploy, the delivery says why.
  n=$(deliveries_of "$svc" | jq 'length')
  before=$(deploy_count "$svc")
  gitea_push "Update the notes" docs/notes.md "notes v2" >>"$RES/$CUR.log" 2>&1 || bad "push 1 failed"
  wait_for 60 "the webhook delivery of push 1" new_delivery "$svc" "$n" || bad "no delivery recorded for push 1"
  list=$(deliveries_of "$svc")
  ev "push 1 (docs/notes.md): $(printf '%s' "$list" | jq -c '.[0] | {event, outcome, detail}')"
  expect "push 1 is skipped by the watch path, with the reason" json_ok "$(printf '%s' "$list" | jq -c '.[0]')" '.outcome=="ignored" and (.detail | test("watch paths"; "i"))'
  sleep 5
  expect "push 1 started no deploy ($before deployments)" test "$(deploy_count "$svc")" = "$before"

  # 2. Inside it: a deploy that names the matching file.
  n=$(deliveries_of "$svc" | jq 'length')
  gitea_push "Change the page" app/index.html "watch-app v2" >>"$RES/$CUR.log" 2>&1 || bad "push 2 failed"
  wait_for 60 "the webhook delivery of push 2" new_delivery "$svc" "$n" || bad "no delivery recorded for push 2"
  list=$(deliveries_of "$svc")
  ev "push 2 (app/index.html): $(printf '%s' "$list" | jq -c '.[0] | {event, outcome, detail}')"
  dep=$(printf '%s' "$list" | jq -r '.[0].deploymentId // empty')
  if [ -n "$dep" ]; then
    st=$(wait_deploy "$svc" 900 "$dep")
    log=$(deploy_log_tail "$svc" "$dep" 400 | grep -m1 'Watch paths' || true)
    ev "push 2 deploy: $st; log: $log"
    expect "push 2 deployed (live)" test "$st" = live
    expect "the deploy log names the file and the pattern" sh -c "printf '%s' '$log' | grep -q 'app/index.html matches app/'"
    wait_for 60 "v2 on the first-run address" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q 'watch-app v2'" &&
      good "watch-app now answers v2" || bad "watch-app does not answer v2"
  else
    bad "push 2 started no deploy: $(printf '%s' "$list" | jq -c '.[0]')"
  fi

  # 3. [skip ci] in the message: no deploy, even inside the watch path.
  n=$(deliveries_of "$svc" | jq 'length')
  before=$(deploy_count "$svc")
  gitea_push "Small tweak [skip ci]" app/index.html "watch-app v3" >>"$RES/$CUR.log" 2>&1 || bad "push 3 failed"
  wait_for 60 "the webhook delivery of push 3" new_delivery "$svc" "$n" || bad "no delivery recorded for push 3"
  list=$(deliveries_of "$svc")
  ev "push 3 ([skip ci]): $(printf '%s' "$list" | jq -c '.[0] | {event, outcome, detail}')"
  expect "push 3 is skipped for [skip ci]" json_ok "$(printf '%s' "$list" | jq -c '.[0]')" '.outcome=="ignored" and (.detail | test("skip ci"))'
  sleep 5
  expect "push 3 started no deploy" test "$(deploy_count "$svc")" = "$before"
  expect "watch-app still answers v2" sh -c "curl -fsS -m 5 http://$(first_run_addr "$svc")/ | grep -q 'watch-app v2'"
}


# ---- 34: scheduled cleanup on a disk line

# disk_use <letter>: the fullest of the data dir's and Docker root's file systems, in percent (as the agent reads it).
disk_use() {
  on_node "$1" "df -P $BRAND_DATA_DIR /var/lib/docker | awk 'NR>1 {sub(\"%\",\"\",\$5); if (\$5>m) m=\$5} END {print m+0}'"
}
newest_cleanup() { api cleanup.runs "{\"nodeId\":\"$1\",\"limit\":5}" | jq -c '.runs[0] // empty'; }
cleanup_since() { # node, epoch ms: a disk-triggered run that started after it
  api cleanup.runs "{\"nodeId\":\"$1\",\"limit\":10}" | jq -e --argjson t "$2" \
    '[.runs[] | select(.trigger=="disk" and ((.startedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000 >= $t))] | length >= 1' >/dev/null
}

check_34() {
  need_key || return 3
  local nb use line fill since run lines garbage_id
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  garbage_id=cafecafecafecafe
  # Labelled garbage of a service B no longer runs, next to unlabeled look-alikes (as in check 23).
  on "$E2E_B" "docker rm -f e2e34-unlabeled-ctr >/dev/null 2>&1; docker volume rm e2e34-unlabeled-vol >/dev/null 2>&1;
    docker run --name e2e34-unlabeled-ctr busybox:1.37 true >/dev/null && docker volume create e2e34-unlabeled-vol >/dev/null &&
    docker tag busybox:1.37 e2e34-unlabeled-img:1 &&
    docker volume create --label $SLUG.managed=true --label $SLUG.service=$garbage_id e2e34-labelled-vol >/dev/null &&
    printf 'FROM busybox:1.37\nLABEL $SLUG.managed=true $SLUG.service=$garbage_id\n' | docker build -q -t e2e34-labelled-img:1 - >/dev/null" >>"$RES/$CUR.log" 2>&1 ||
    { bad "could not make the test resources on B"; return 1; }
  ev "made a labelled image and volume of a removed service, and an unlabeled stopped container, volume and image"

  # A disk line a little above today's use, then fill the disk past it.
  use=$(disk_use b)
  line=$((use + 4))
  [ "$line" -ge 50 ] || line=50
  [ "$line" -le 95 ] || { blocked "B's disk is already ${use}% full"; return 3; }
  api cleanup.setSchedule "{\"nodeId\":\"$nb\",\"schedule\":{\"enabled\":true,\"cron\":null,\"diskPercent\":$line,\"kinds\":{\"images\":true,\"buildCache\":false,\"stoppedContainers\":true,\"unusedVolumes\":true}}}" >>"$RES/$CUR.log" ||
    { bad "cleanup.setSchedule failed"; return 1; }
  ev "schedule: $(api cleanup.getSchedule "{\"nodeId\":\"$nb\"}" | jq -c '{schedule, supported}')"
  expect "the schedule is saved and the node can run it" json_ok "$(api cleanup.getSchedule "{\"nodeId\":\"$nb\"}" | jq -c .)" ".schedule.enabled and .schedule.diskPercent == $line and .supported"
  sleep 10
  # The fullest of the two file systems, filled to 3 points over the line (fallocate: no data written).
  fill=$(on "$E2E_B" "df -P -B1 $BRAND_DATA_DIR | awk 'NR==2 {t=\$3+\$4; want=int(t*($line+3)/100); print (want>\$3 ? want-\$3 : 0)}'")
  on "$E2E_B" "rm -f $BRAND_DATA_DIR/e2e34-fill && fallocate -l $fill $BRAND_DATA_DIR/e2e34-fill" >>"$RES/$CUR.log" 2>&1 || { bad "could not fill B's disk"; return 1; }
  ev "B's disk: ${use}% before, $(disk_use b)% after filling; the line is ${line}%"
  # The agent checks its disks when it starts and every 10 minutes after.
  since=$(($(date +%s) * 1000 - 5000))
  on "$E2E_B" "systemctl restart $SLUG.service"
  if wait_for 780 "a disk-triggered cleanup run" cleanup_since "$nb" "$since"; then
    run=$(api cleanup.runs "{\"nodeId\":\"$nb\",\"limit\":10}" | jq -c '[.runs[] | select(.trigger=="disk")][0]')
    printf '%s\n' "$run" >>"$RES/$CUR.log"
    ev "run: $(printf '%s' "$run" | jq -c '{trigger, status, diskPercent, removedCount, bytesFreed, error}')"
    ev "it reported: $(printf '%s' "$run" | jq -c '.lines[0:12]')"
    good "the disk line started a cleanup run on B by itself"
    lines=$(printf '%s' "$run" | jq -r '.lines[]')
    expect "the run succeeded at ${line}% or more" json_ok "$run" ".status==\"succeeded\" and .diskPercent >= $line"
    expect "it reports the labelled image and volume" sh -c "printf '%s' '$lines' | grep -q e2e34-labelled-img && printf '%s' '$lines' | grep -q e2e34-labelled-vol"
    expect "it reports nothing unlabeled" sh -c "! printf '%s' '$lines' | grep -q e2e34-unlabeled"
  else
    run=$(api cleanup.runs "{\"nodeId\":\"$nb\",\"limit\":3}" | jq -c '[.runs[] | {trigger, status, startedAt}]')
    bad "no disk-triggered run within 13 minutes (runs: $run)"
  fi
  on "$E2E_B" "rm -f $BRAND_DATA_DIR/e2e34-fill"
  expect "the labelled image is gone" on "$E2E_B" "! docker image inspect e2e34-labelled-img:1 >/dev/null 2>&1"
  expect "the labelled volume is gone" on "$E2E_B" "! docker volume inspect e2e34-labelled-vol >/dev/null 2>&1"
  expect "the unlabeled container, volume and image survive" on "$E2E_B" \
    "docker inspect e2e34-unlabeled-ctr >/dev/null && docker volume inspect e2e34-unlabeled-vol >/dev/null && docker image inspect e2e34-unlabeled-img:1 >/dev/null"
  expect "running services are untouched (whoami answers)" sh -c "curl -fsS -m 5 -H 'Host: $(state_get host-whoami)' http://$(node_ip b)/ | grep -q Hostname"
  api cleanup.setSchedule "{\"nodeId\":\"$nb\",\"schedule\":{\"enabled\":false,\"cron\":\"0 4 * * *\",\"diskPercent\":80,\"kinds\":{\"images\":true,\"buildCache\":true,\"stoppedContainers\":true,\"unusedVolumes\":false}}}" >/dev/null ||
    ev "note: turning the schedule off again failed"
  on "$E2E_B" "docker rm -f e2e34-unlabeled-ctr >/dev/null 2>&1; docker volume rm e2e34-unlabeled-vol >/dev/null 2>&1; docker rmi e2e34-unlabeled-img:1 >/dev/null 2>&1; true"
}

# ---- 35: host shell

# session_op <op> <json>: an op with the owner's browser session (cookie jar from check 2), like the web app.
session_op() {
  local jar=$E2E_STATE/cookies
  scurl "$jar" -sS -m 60 -H 'content-type: application/json' -H "origin: $(panel_url)" -X POST --data "$2" "$(panel_url)/api/v1/$1"
}
# owner_session: a signed-in owner session in the jar (signs in again when it ended).
owner_session() {
  local jar=$E2E_STATE/cookies email pw
  scurl "$jar" -fsS -m 10 "$(panel_url)/api/v1/auth.whoami" >/dev/null 2>&1 && return 0
  email=$(sed -n 1p "$E2E_STATE/owner")
  pw=$(sed -n 2p "$E2E_STATE/owner")
  session_op auth.login "$(jq -nc --arg e "$email" --arg p "$pw" '{email:$e, password:$p}')" >/dev/null &&
    scurl "$jar" -fsS -m 10 "$(panel_url)/api/v1/auth.whoami" >/dev/null
}
# host_shell <node id> <wsclient args...>: opens a host shell with the owner session and runs the ws client on it.
host_shell() {
  local nid=$1 out url
  shift
  out=$(session_op hostShell.open "{\"nodeId\":\"$nid\"}")
  url=$(printf '%s' "$out" | jq -r '.url // empty' 2>/dev/null)
  [ -n "$url" ] || { printf 'hostShell.open: %s\n' "$out"; return 2; }
  ws "$(ws_url "$url")" "$@"
}
audit_has() { # op id [reason regex]: an audit entry for it about node B since the check began (with that close reason)
  api audit.list "{\"opId\":\"$1\",\"limit\":20,\"from\":\"$C35_SINCE\"}" | jq -e --arg n "$(node_id b)" --arg r "${2:-}" \
    '[.entries[] | select(((.target.id // "") == $n or ((.input.nodeId // "") == $n)) and ((.input.reason // "" | tostring) | test($r; "i")))] | length >= 1' >/dev/null
}

check_35() {
  need_key || return 3
  local nb out hostname_b
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  owner_session || { blocked "no owner browser session (check 2's cookie jar or the owner password)"; return 3; }
  hostname_b=$(on "$E2E_B" hostname)
  C35_SINCE=$(date -u -v-5S +%Y-%m-%dT%H:%M:%S.000Z)
  session_op hostShell.setEnabled "{\"nodeId\":\"$nb\",\"enabled\":false}" >/dev/null
  # Turning it on needs a sign-in or "Confirm it's you" from the last 15 minutes; an API key cannot.
  out=$(api hostShell.setEnabled "{\"nodeId\":\"$nb\",\"enabled\":true}" 2>&1 || true)
  expect "an API key cannot turn host shells on" sh -c "! printf '%s' '$(printf '%s' "$out" | tr -d "'")' | jq -e '.enabled == true' >/dev/null 2>&1"
  reauth "$E2E_STATE/cookies"
  out=$(session_op hostShell.setEnabled "{\"nodeId\":\"$nb\",\"enabled\":true}")
  ev "hostShell.setEnabled (owner session after auth.reauth): $out"
  expect "the owner turned host shells on for B" json_ok "$out" '.enabled == true'
  ev "status: $(api hostShell.status "{\"nodeId\":\"$nb\"}" | jq -c '{enabled, available, maxSessions, idleTimeoutSeconds}')"
  sleep 5

  # The input says $(hostname); only a shell that ran it prints the name after "e2e-host=".
  out=$(host_shell "$nb" --seconds 30 --send-after-ready --send-binary 'echo e2e-host=$(hostname)\n' --wait-for "e2e-host=$hostname_b" 2>&1 || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q "FOUND" &&
    good "a root shell on B through the panel's host-shell socket ran hostname: $hostname_b ($(printf '%s' "$out" | grep -o 'uid=[^ ]*\|"user":"[^"]*"' | head -1))" ||
    bad "the host shell did not run hostname: $(printf '%s' "$out" | tail -4 | tr '\n' ' ' | head -c 300)"
  sleep 3
  expect "hostShell.setEnabled is in the audit log" audit_has hostShell.setEnabled
  expect "hostShell.open is in the audit log" audit_has hostShell.open
  expect "the shell's close is in the audit log (hostShell.close)" audit_has hostShell.close
  if api alerts.list '{}' | jq -e --arg h "$(api nodes.get "{\"nodeId\":\"$nb\"}" | jq -r .name)" '[.alerts[] | select(.event=="security_change" and (.title | contains("root shell")))] | length >= 1' >/dev/null; then
    good "a security_change alert names the root shell"
  else
    bad "no security_change alert for the root shell"
  fi

  # Off again: the panel refuses, and so does the agent on its own. The panel
  # row is put back to "on" without telling the node (one SQLite write), so
  # only the node's own setting is left to say no.
  out=$(session_op hostShell.setEnabled "{\"nodeId\":\"$nb\",\"enabled\":false}")
  expect "host shells are off again" json_ok "$out" '.enabled == false'
  sleep 10
  out=$(session_op hostShell.open "{\"nodeId\":\"$nb\"}")
  ev "hostShell.open while off: $(printf '%s' "$out" | jq -c '.error | {code, message}' 2>/dev/null || printf '%s' "$out" | head -c 200)"
  expect "the panel refuses to open one while off" json_ok "$out" '.error.details.reason == "hostShellOff"'
  panel_sql_write "update nodes set host_shell = 1 where id = '$nb'" >>"$RES/$CUR.log" || bad "could not write the panel row"
  host_shell "$nb" --seconds 20 --send-after-ready --send-binary 'echo e2e-should-$((6 * 7))\n' >"$RES/$CUR.refused" 2>&1 || true
  panel_sql_write "update nodes set host_shell = 0 where id = '$nb'" >>"$RES/$CUR.log" || bad "could not put the panel row back"
  cat "$RES/$CUR.refused" >>"$RES/$CUR.log"
  ev "with only the node saying no: $(grep -E '^T |CLOSE' "$RES/$CUR.refused" | tail -3 | tr '\n' ' ' | head -c 300)"
  # The command echoes e2e-should-42 only when a shell ran it (the input itself says $((6 * 7))).
  expect "the agent refused the shell: nothing ran" sh -c "! grep -q 'e2e-should-42' '$RES/$CUR.refused' && grep -qiE 'refused|turned off|are off|not allowed' '$RES/$CUR.refused'"
  sleep 3
  expect "the refused shell is audited as refused by the node (hostShell.close)" audit_has hostShell.close refused
}


# ---- 36: clone and move between projects

clone_copy_done() { api services.get "{\"serviceId\":\"$1\"}" | jq -e '.dataCopy.status == "done" or .dataCopy.status == "failed"' >/dev/null; }
loop_failures() { grep -cvx 200 "$1" || true; }

check_36() {
  need_key || return 3
  local nc src clones moved marker preview out clone addr st ref impact dep loadpid fails total host
  nc=$(node_id c)
  [ -n "$nc" ] || { blocked "node C is not joined"; return 3; }
  src=$(state_get svc-whoami)
  host=$(state_get host-whoami)
  [ -n "$src" ] || { blocked "no whoami service (check 4)"; return 3; }
  clones=$(project_id e2e-clones)
  moved=$(project_id e2e-moved)
  for p in e2e-clones e2e-moved; do for s in whoami-clone ref-app; do delete_service "$p" "$s"; done; done

  # whoami gets a data volume with a marker file, so there is data to copy.
  if ! api services.get "{\"serviceId\":\"$src\"}" | jq -e '[.volumes[] | select(.name=="data")] | length == 1' >/dev/null; then
    api services.setVolumes "{\"serviceId\":\"$src\",\"volumes\":[{\"name\":\"data\",\"mountPath\":\"/data\"}]}" >/dev/null || { bad "services.setVolumes on whoami failed"; return 1; }
    api deployments.deploy "{\"serviceId\":\"$src\"}" >/dev/null || { bad "redeploying whoami failed"; return 1; }
    [ "$(wait_deploy "$src" 300)" = live ] || { bad "whoami with a volume did not go live"; return 1; }
  fi
  marker=clone-marker-$(openssl rand -hex 4)
  api files.write "$(jq -nc --arg s "$src" --arg m "$marker" '{serviceId:$s, volume:"data", path:"/marker.txt", content:$m, createParents:true}')" >/dev/null ||
    { bad "files.write of the marker failed"; return 1; }
  good "whoami on B has a data volume with /marker.txt ($marker)"

  preview=$(api services.clonePreview "{\"serviceId\":\"$src\",\"projectId\":\"$clones\",\"nodeId\":\"$nc\"}") || { bad "services.clonePreview failed"; return 1; }
  ev "clone preview: $(printf '%s' "$preview" | jq -c '{name, env, volumes, data, autoDomain}')"
  expect "the preview offers a copy of the data volume" json_ok "$preview" '.data.available and (.volumes | map(.name) | index("data")) != null'

  # The source keeps serving while its data is read (stopSource false).
  load_loop 60 "http://$(node_ip b)/" "$host" "$RES/$CUR.load-clone" &
  loadpid=$!
  out=$(api services.clone "{\"serviceId\":\"$src\",\"projectId\":\"$clones\",\"nodeId\":\"$nc\",\"name\":\"whoami-clone\",\"data\":\"copy\",\"stopSource\":false,\"autoDomain\":false}") ||
    { kill "$loadpid" 2>/dev/null; bad "services.clone failed"; return 1; }
  clone=$(printf '%s' "$out" | jq -r .service.id)
  state_set svc-whoami-clone "$clone"
  ev "clone: $(printf '%s' "$out" | jq -c '{copied, dataCopy: (.dataCopy | {status, volumes})}')"
  wait_for 240 "the data copy" clone_copy_done "$clone" || true
  ev "data copy: $(api services.get "{\"serviceId\":\"$clone\"}" | jq -c '.dataCopy | {status, bytesCopied, error}')"
  expect "the data copy finished" json_ok "$(api services.get "{\"serviceId\":\"$clone\"}" | jq -c .dataCopy)" '.status=="done"'
  wait "$loadpid" 2>/dev/null || true
  fails=$(loop_failures "$RES/$CUR.load-clone")
  total=$(wc -l <"$RES/$CUR.load-clone" | tr -d ' ')
  expect "whoami kept serving while it was cloned ($total requests, $fails failed)" test "$fails" = 0

  api services.start "{\"serviceId\":\"$clone\"}" >/dev/null || bad "services.start (first deploy of the clone) failed"
  st=$(wait_deploy "$clone" 300)
  [ "$st" = live ] && good "the clone runs on C in project e2e-clones" || bad "the clone's first deploy ended $st"
  wait_for 60 "the clone's first-run address" has_first_run "$clone" || true
  addr=$(first_run_addr "$clone")
  expect "the clone answers on C's IP:port ($addr)" sh -c "curl -fsS -m 5 http://$addr/ | grep -q Hostname"
  out=$(api files.read "{\"serviceId\":\"$clone\",\"volume\":\"data\",\"path\":\"/marker.txt\"}" | jq -r '.content // empty' | tr -d '\n')
  expect "the clone's volume has the copied marker ($out)" test "$out" = "$marker"

  # Move it to another project: a service of the old project referencing it shows up in the impact.
  ref=$(create_service "$(jq -nc --arg p "$clones" --arg n "$nc" \
    '{projectId:$p, name:"ref-app", kind:"app", nodeId:$n, source:{type:"image", image:"busybox:1.37", registryId:null}, deployNow:false}')") ||
    { bad "services.create ref-app failed"; return 1; }
  # shellcheck disable=SC2016
  api env.set "$(jq -nc --arg s "$ref" '{serviceId:$s, text:"WHO=${{whoami-clone.INTERNAL_URL}}\n"}')" >/dev/null || bad "env.set on ref-app failed"
  impact=$(api services.moveProjectImpact "{\"serviceId\":\"$clone\",\"projectId\":\"$moved\"}") || { bad "services.moveProjectImpact failed"; return 1; }
  ev "move impact: $(printf '%s' "$impact" | jq -c '{blockers, referencedBy, switches, grants, sharedLost}')"
  expect "the impact lists ref-app (WHO) losing the reference and a running switch" json_ok "$impact" '(.blockers | length == 0) and .switches and ([.referencedBy[] | select(.name=="ref-app" and (.keys | index("WHO")) != null)] | length == 1)'
  out=$(api services.moveProject "{\"serviceId\":\"$clone\",\"projectId\":\"$moved\"}" 2>&1 || true)
  expect "moving without confirm is refused when the impact lists something" sh -c "! printf '%s' '$(printf '%s' "$out" | tr -d "'")' | jq -e '.deploymentId' >/dev/null 2>&1"
  load_loop 90 "http://$addr/" "" "$RES/$CUR.load-move" &
  loadpid=$!
  sleep 3
  out=$(api services.moveProject "{\"serviceId\":\"$clone\",\"projectId\":\"$moved\",\"confirm\":true}") || { kill "$loadpid" 2>/dev/null; bad "services.moveProject failed"; return 1; }
  dep=$(printf '%s' "$out" | jq -r '.deploymentId // empty')
  ev "moveProject: switch deployment $dep"
  st=live
  [ -z "$dep" ] || st=$(wait_deploy "$clone" 300 "$dep")
  expect "the switch to the new project's network went live" test "$st" = live
  wait "$loadpid" 2>/dev/null || true
  fails=$(loop_failures "$RES/$CUR.load-move")
  total=$(wc -l <"$RES/$CUR.load-move" | tr -d ' ')
  expect "the clone kept serving through the move ($total requests, $fails failed)" test "$fails" = 0
  expect "the clone now belongs to e2e-moved" test "$(api services.get "{\"serviceId\":\"$clone\"}" | jq -r .projectId)" = "$moved"
  expect "its container is on e2e-moved's network only" on "$E2E_C" \
    "docker inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' \$(docker ps -q --filter label=$SLUG.service=$clone | head -1) | grep -q '$moved' && ! docker inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' \$(docker ps -q --filter label=$SLUG.service=$clone | head -1) | grep -q '$clones'"
  expect "whoami (the source) still answers on B" sh -c "curl -fsS -m 5 -H 'Host: $host' http://$(node_ip b)/ | grep -q Hostname"
}

# ---- 37: Valkey, ClickHouse and Postgres 18 with pgvector

# db_exec <letter> <service> <command>: a command in the database's own container.
db_exec() { on_node "$1" "docker exec -i \$(docker ps -q --filter label=$SLUG.service=$2 --filter name=^$SLUG-$2-[0-9] | head -1) $3"; }
db_secret() { api databases.connection "{\"serviceId\":\"$1\"}" | jq -r "$2"; }
# db_shell <service> <input> <wait-for>: the pre-logged-in shell through the panel's terminal socket.
db_shell() {
  local ticket
  ticket=$(api databases.openShell "{\"serviceId\":\"$1\"}") || return 1
  ws "$(ws_url "$(printf '%s' "$ticket" | jq -r '.url // .socketPath')")" --seconds 40 --send-after-ready --send-binary "$2" --wait-for "$3" 2>&1
}
# db_backup <service> <name> <destination>: runs a database backup now, prints the run id when it succeeded.
db_backup() {
  local policy run
  policy=$(api backups.listPolicies "{\"serviceId\":\"$1\"}" | jq -r '(.policies // .)[]? | select(.target=="database") | .id' | head -1)
  [ -n "$policy" ] || policy=$(api backups.createPolicy "{\"serviceId\":\"$1\",\"target\":\"database\",\"destinationId\":\"$3\",\"schedule\":\"0 3 * * *\",\"keepLast\":3,\"stopService\":false,\"enabled\":true}" | jq -r '.id // .policy.id') || return 1
  run=$(api backups.runNow "{\"serviceId\":\"$1\",\"policyId\":\"$policy\"}" | jq -r .id) || return 1
  wait_for 600 "the $2 backup" run_done "$1" "$run" || true
  run_info "$1" "$run" | jq -e '.status=="succeeded"' >/dev/null || { run_info "$1" "$run" >&2; return 1; }
  echo "$run"
}
db_restore() { # service name run
  local rrun
  rrun=$(api backups.restore "{\"serviceId\":\"$1\",\"runId\":\"$3\",\"confirmName\":\"$2\",\"backupFirst\":false}" | jq -r '.id // .run.id') || return 1
  wait_for 600 "the $2 restore" run_done "$1" "$rrun" || true
  run_info "$1" "$rrun" | jq -e '.status=="succeeded"' >/dev/null || { run_info "$1" "$rrun" >&2; return 1; }
}
minio_destination() {
  local dest
  read -r murl muser mpass <<<"$(state_get minio)"
  dest=$(api backups.listDestinations | jq -r '.destinations[]? | select(.name=="e2e-minio") | .id' | head -1)
  [ -n "$dest" ] || dest=$(api backups.createDestination "$(jq -nc --arg e "$murl" --arg k "$muser" --arg s "$mpass" \
    '{name:"e2e-minio", provider:"minio", endpoint:$e, region:"us-east-1", bucket:"e2e-backups", pathPrefix:"e2e", pathStyle:true, accessKeyId:$k, secretAccessKey:$s}')" | jq -r .id)
  echo "$dest"
}

# The probe app: one container of the project reaches all three by ${{name.VAR}} references.
read -r -d '' data_probe_sh <<'EOS' || true
for i in $(seq 1 100); do
  vk=$(printf 'AUTH %s\r\nPING\r\n' "$VK_PASS" | nc -w 3 "$VK_HOST" "$VK_PORT" | tr -d '\r' | tr '\n' ' ')
  ch=$(wget -qO- "${CH_URL%/*}/?query=SELECT%2040%2B2" 2>&1)
  pg=$(psql "$PG_URL" -tAc "select extversion from pg_extension where extname = 'vector'" 2>&1)
  echo "PROBE vk=[$vk] ch=[$ch] pg=[$pg]"
  case "$vk $ch $pg" in *PONG*42*[0-9].[0-9]*) echo DATA-PROBE-OK; sleep 86400 ;; esac
  sleep 3
done
sleep 86400
EOS
data_probe_cmd=$(jq -nc --arg s "$data_probe_sh" '["sh", "-c", $s]')

check_37() {
  need_key || return 3
  local nb pid dest vk ch pg probe logs pass user out conn run exp url ip_b murl muser mpass
  nb=$(node_id b)
  [ -n "$nb" ] || { blocked "node B is not joined"; return 3; }
  ip_b=$(node_ip b)
  pid=$(project_id e2e-data)
  read -r murl muser mpass <<<"$(state_get minio)"
  dest=$(minio_destination)
  [ -n "$dest" ] && [ "$dest" != null ] || { bad "no MinIO backup destination"; return 1; }
  ev "engines: $(api databases.engines | jq -c '[.engines[] | select(.engine=="valkey" or .engine=="clickhouse" or .engine=="postgres") | {engine, versions: [.versions[].version], variants: [.variants[]?.id]}]')"

  vk=$(service_id e2e-data vk)
  [ -n "$vk" ] || vk=$(api databases.create "{\"projectId\":\"$pid\",\"name\":\"vk\",\"engine\":\"valkey\",\"version\":\"9.1\",\"nodeId\":\"$nb\"}" | jq -r .serviceId) ||
    { bad "databases.create valkey failed"; return 1; }
  ch=$(service_id e2e-data ch)
  [ -n "$ch" ] || ch=$(api databases.create "{\"projectId\":\"$pid\",\"name\":\"ch\",\"engine\":\"clickhouse\",\"version\":\"26.8\",\"nodeId\":\"$nb\",\"database\":\"e2e\"}" | jq -r .serviceId) ||
    { bad "databases.create clickhouse failed"; return 1; }
  pg=$(service_id e2e-data pg18)
  [ -n "$pg" ] || pg=$(api databases.create "{\"projectId\":\"$pid\",\"name\":\"pg18\",\"engine\":\"postgres\",\"version\":\"18\",\"variant\":\"pgvector\",\"nodeId\":\"$nb\",\"database\":\"app\",\"user\":\"app\"}" | jq -r .serviceId) ||
    { bad "databases.create postgres 18 pgvector failed"; return 1; }
  state_set svc-vk "$vk"
  state_set svc-ch "$ch"
  state_set svc-pg18 "$pg"
  for s in "$vk" "$ch" "$pg"; do
    wait_for 420 "$s running" svc_running "$s" || bad "$(api databases.get "{\"serviceId\":\"$s\"}" | jq -r .name) did not reach running ($(svc_status "$s"))"
  done
  ev "databases: $(for s in "$vk" "$ch" "$pg"; do api databases.get "{\"serviceId\":\"$s\"}" | jq -c '{name, engine, version, variant, internal, shellClient}'; done | tr '\n' ' ')"
  good "Valkey 9.1, ClickHouse 26.8 and Postgres 18 (pgvector image) run on B"

  # pgvector through the pre-logged-in psql: CREATE EXTENSION and a distance.
  out=$(db_shell "$pg" "CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 'e2e-' || ('[1,2,3]'::vector <-> '[1,2,5]'::vector)::text AS dist;\n" 'e2e-2' || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "psql shell: CREATE EXTENSION vector, and [1,2,3] <-> [1,2,5] = 2" ||
    bad "the Postgres shell did not create the extension: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | head -c 200)"
  # valkey-cli prints a GET's value in quotes; the typed command has none. Its line editor takes Enter as \r only.
  out=$(db_shell "$vk" 'SET e2e-shell ok-42\rGET e2e-shell\r' '"ok-42"' || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "valkey-cli shell: SET and GET without a password" ||
    bad "the Valkey shell did not answer: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | head -c 200)"
  # Only the result reads e2e-42: the typed query says toString(40 + 2).
  out=$(db_shell "$ch" "SELECT concat('e2e-', toString(40 + 2)) AS answer;\n" 'e2e-42' || true)
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  printf '%s' "$out" | grep -q FOUND && good "clickhouse-client shell: SELECT concat('e2e-', toString(40 + 2)) -> e2e-42" ||
    bad "the ClickHouse shell did not answer 42: $(printf '%s' "$out" | tail -3 | tr '\n' ' ' | head -c 200)"

  # An app of the same project reaches all three by references.
  delete_service e2e-data data-probe
  probe=$(image_service e2e-data data-probe b postgres:17.6-alpine "" "{\"container\":{\"command\":$data_probe_cmd},\"deployNow\":false}") ||
    { bad "services.create data-probe failed"; return 1; }
  # shellcheck disable=SC2016
  api env.set "$(jq -nc --arg s "$probe" '{serviceId:$s, text:"VK_HOST=${{vk.INTERNAL_HOST}}\nVK_PORT=${{vk.INTERNAL_PORT}}\nVK_PASS=${{vk.PASSWORD}}\nCH_URL=${{ch.INTERNAL_HTTP_URL}}\nPG_URL=${{pg18.INTERNAL_URL}}\n"}')" >/dev/null ||
    bad "env.set on data-probe failed"
  api deployments.deploy "{\"serviceId\":\"$probe\"}" >/dev/null
  wait_for 240 "the probe connects" sh -c "colima ssh -p $E2E_B -- sudo docker logs \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$probe | head -1) 2>&1 | grep -q DATA-PROBE-OK" || true
  on "$E2E_B" "docker logs \$(docker ps -q --filter label=$SLUG.service=$probe | head -1) 2>&1 | grep -E '^(PROBE|DATA-PROBE-OK)' | tail -2" >"$RES/$CUR.probe"
  ev "probe: $(tr '\n' ' ' <"$RES/$CUR.probe")"
  expect "an app of the project reaches Valkey (PONG), ClickHouse over HTTP (42) and pgvector by references" sh -c \
    "grep -qx DATA-PROBE-OK '$RES/$CUR.probe' && grep -q PONG '$RES/$CUR.probe' && grep -q 'ch=\\[42' '$RES/$CUR.probe' && grep -qE 'pg=\\[[0-9]+\\.[0-9]' '$RES/$CUR.probe'"

  # TLS exposure: Valkey and ClickHouse from a container on A, Postgres from the Mac.
  api databases.setExposure "{\"serviceId\":\"$vk\",\"enabled\":true,\"port\":26380,\"allowedCidrs\":[\"192.168.64.0/24\"]}" >/dev/null || bad "setExposure valkey failed"
  api databases.setExposure "{\"serviceId\":\"$ch\",\"enabled\":true,\"port\":29440,\"allowedCidrs\":[\"192.168.64.0/24\"]}" >/dev/null || bad "setExposure clickhouse failed"
  api databases.setExposure "{\"serviceId\":\"$pg\",\"enabled\":true,\"port\":25433,\"allowedCidrs\":[\"$(host_ip)/32\",\"192.168.64.0/24\"]}" >/dev/null || bad "setExposure postgres failed"
  sleep 20
  conn=$(api databases.connection "{\"serviceId\":\"$vk\"}" | jq -c .exposed)
  ev "valkey exposed: $(printf '%s' "$conn" | jq -c '{host, port, user, tlsParams}')"
  if wait_for 90 "valkey-cli --tls" on "$E2E_A" "docker run --rm --network host valkey/valkey:9.1.3-alpine valkey-cli --tls --insecure -h $ip_b -p 26380 \
      --user $(printf '%s' "$conn" | jq -r .user) --pass $(printf '%s' "$conn" | jq -r .password) --no-auth-warning PING | grep -q PONG"; then
    good "valkey-cli --tls from A reaches Valkey through B's TLS port 26380 (PONG)"
  else
    bad "valkey-cli --tls to $ip_b:26380 failed"
  fi
  expect "Valkey's exposed port refuses plain TCP clients" on "$E2E_A" \
    "! docker run --rm --network host valkey/valkey:9.1.3-alpine valkey-cli -h $ip_b -p 26380 --pass x --no-auth-warning PING 2>&1 | grep -q PONG"
  conn=$(api databases.connection "{\"serviceId\":\"$ch\"}" | jq -c .exposed)
  ev "clickhouse exposed: $(printf '%s' "$conn" | jq -c '{host, port, user, tlsParams}')"
  if wait_for 120 "clickhouse-client --secure" on "$E2E_A" "docker run --rm --network host clickhouse/clickhouse-server:26.8.36.3 clickhouse-client --host $ip_b --port 29440 --secure \
      --accept-invalid-certificate --user $(printf '%s' "$conn" | jq -r .user) --password $(printf '%s' "$conn" | jq -r .password) --query 'SELECT 40 + 2' | grep -qx 42"; then
    good "clickhouse-client --secure from A reaches ClickHouse's native port through B's TLS port 29440 (42)"
  else
    bad "clickhouse-client --secure to $ip_b:29440 failed"
  fi
  exp=$(api databases.connection "{\"serviceId\":\"$pg\"}" | jq -c .exposed)
  url=$(printf '%s' "$exp" | jq -r '"postgresql://\(.user):\(.password)@'"$ip_b"':\(.port)/\(.database)"')
  if wait_for 90 "psql sslmode=require" sh -c "psql '$url?sslmode=require' -tAc 'select ssl from pg_stat_ssl where pid = pg_backend_pid()' | grep -q t"; then
    good "psql from the Mac reaches Postgres 18 over TLS ($(psql "$url?sslmode=require" -tAc 'show server_version' | cut -d' ' -f1))"
  else
    bad "psql sslmode=require to $ip_b:25433 failed: $(psql "$url?sslmode=require" -tAc 'select 1' 2>&1 | head -2 | tr '\n' ' ')"
  fi
  expect "Postgres' exposed user cannot log in without TLS" sh -c "! psql '$url?sslmode=disable' -tAc 'select 1' >/dev/null 2>&1"

  # Backups to MinIO and restores.
  pass=$(db_secret "$vk" .internal.password)
  db_exec b "$vk" "valkey-cli -a $pass --no-auth-warning SET e2e-backup before-backup" >>"$RES/$CUR.log" 2>&1
  if run=$(db_backup "$vk" vk "$dest" 2>>"$RES/$CUR.log"); then
    db_exec b "$vk" "valkey-cli -a $pass --no-auth-warning SET e2e-backup after-backup" >>"$RES/$CUR.log" 2>&1
    if db_restore "$vk" vk "$run" 2>>"$RES/$CUR.log"; then
      wait_for 120 "valkey after the restore" sh -c "colima ssh -p $E2E_B -- sudo docker exec \$(colima ssh -p $E2E_B -- sudo docker ps -q --filter label=$SLUG.service=$vk --filter name=^$SLUG-$vk-[0-9] | head -1) valkey-cli -a $pass --no-auth-warning GET e2e-backup | grep -qx before-backup" &&
        good "Valkey: backup to MinIO, then the restore brings back the value from before" || bad "Valkey after the restore: $(db_exec b "$vk" "valkey-cli -a $pass --no-auth-warning GET e2e-backup" 2>&1)"
    else bad "the Valkey restore failed"; fi
  else bad "the Valkey backup failed"; fi

  user=$(db_secret "$ch" .internal.user)
  pass=$(db_secret "$ch" .internal.password)
  printf '%s\n' "DROP TABLE IF EXISTS e2e.backup_rows;" "CREATE TABLE e2e.backup_rows (v String) ENGINE = MergeTree ORDER BY v;" \
    "INSERT INTO e2e.backup_rows VALUES ('before-backup');" | db_exec b "$ch" "clickhouse-client --user $user --password $pass --multiquery" >>"$RES/$CUR.log" 2>&1 ||
    bad "could not write the ClickHouse rows"
  if run=$(db_backup "$ch" ch "$dest" 2>>"$RES/$CUR.log"); then
    db_exec b "$ch" "clickhouse-client --user $user --password $pass --query 'DROP TABLE e2e.backup_rows'" >>"$RES/$CUR.log" 2>&1
    if db_restore "$ch" ch "$run" 2>>"$RES/$CUR.log"; then
      out=$(db_exec b "$ch" "clickhouse-client --user $user --password $pass --query 'SELECT v FROM e2e.backup_rows'" 2>&1)
      expect "ClickHouse: backup to MinIO, the dropped table is back after the restore ($out)" test "$out" = before-backup
    else bad "the ClickHouse restore failed"; fi
  else bad "the ClickHouse backup failed"; fi

  printf '%s\n' "drop table if exists e2e_vectors;" "create table e2e_vectors (id int, v vector(3));" "insert into e2e_vectors values (1, '[1,2,3]');" |
    db_exec b "$pg" "psql -v ON_ERROR_STOP=1 -U app -d app -tA" >>"$RES/$CUR.log" 2>&1 || bad "could not write the pgvector row"
  if run=$(db_backup "$pg" pg18 "$dest" 2>>"$RES/$CUR.log"); then
    db_exec b "$pg" "psql -U app -d app -tAc 'drop table e2e_vectors'" >>"$RES/$CUR.log" 2>&1
    if db_restore "$pg" pg18 "$run" 2>>"$RES/$CUR.log"; then
      wait_for 60 "postgres after the restore" db_exec b "$pg" "psql -U app -d app -tAc 'select 1'" || true
      out=$(echo "select v::text from e2e_vectors where id = 1;" | db_exec b "$pg" "psql -U app -d app -tA" 2>&1)
      expect "Postgres 18: backup to MinIO, the dropped vector table is back after the restore ($out)" test "$out" = "[1,2,3]"
    else bad "the Postgres restore failed"; fi
  else bad "the Postgres backup failed"; fi
  expect "the backups are in MinIO" on "$E2E_A" "docker exec e2e-minio sh -c 'mc alias set e2e http://127.0.0.1:9000 $muser $mpass >/dev/null && mc ls -r e2e/e2e-backups' | grep -c . | grep -qv '^0$'"
}


# ---------------------------------------------------------------- 38 upgrade from the last release

# up_sql <sql>: read-only query on the panel database on C (the upgraded panel).
up_sql() {
  local c
  c=$(on "$E2E_C" "docker ps -aq --filter label=$SLUG.service=panel00000000000 | head -1")
  [ -n "$c" ] || return 1
  printf '%s' "$1" | on "$E2E_C" "docker exec -i $c bun -e '
    const { Database } = require(\"bun:sqlite\");
    const db = new Database(\"$BRAND_DATA_DIR/panel/panel.db\", { readonly: true });
    console.log(JSON.stringify(db.query(await Bun.stdin.text()).all()));
  '"
}

# free_c: removes C from A's panel (its services first) and uninstalls it.
free_c() {
  local nc lb p s
  nc=$(node_id c)
  lb=$(state_get svc-lb)
  [ -z "$lb" ] || api services.setPlacements "{\"serviceId\":\"$lb\",\"placements\":[{\"nodeId\":\"$(node_id b)\",\"replicas\":1}],\"stickySessions\":false,\"entryNodeId\":null}" >/dev/null 2>&1 || true
  if [ -n "$nc" ]; then
    for p in $(api projects.list | jq -r '.projects[].id'); do
      api services.list "{\"projectId\":\"$p\"}" | jq -c --arg n "$nc" '.services[] | select(.protected | not) | select([.placements[]?.nodeId] | index($n)) | {id, name}' |
        while read -r s; do
          api services.delete "$(printf '%s' "$s" | jq -c '{serviceId: .id, confirmName: .name}')" >/dev/null 2>&1 || true
        done
    done
    sleep 20
  fi
  on "$E2E_C" "$(installer_fetch) | sh -s -- uninstall --purge" >>"$RES/$CUR.log" 2>&1 || return 1
  [ -z "$nc" ] || api nodes.remove "{\"nodeId\":\"$nc\",\"confirmName\":\"e2e-c\"}" >/dev/null 2>&1 || ev "note: nodes.remove of C refused"
  state_set node-c ""
}

up_agent_at() { api nodes.list | jq -e --arg v "$1" '[.nodes[] | select((.agentVersion // "" | split(" ")[0]) != $v)] | length == 0' >/dev/null; }

check_38() {
  need_key || return 3
  local base_dir to rc=0
  base_dir=$E2E_REL/$ORG/$REPO/releases/download/v$E2E_BASE
  [ -f "$base_dir/manifest.json.minisig" ] || { blocked "release $E2E_BASE is not built (build.sh base)"; return 3; }
  # The newest working-tree release: a refreshed VM set runs one newer than N.
  to=$(state_get refresh-version)
  [ -n "$to" ] || to=$E2E_V1
  [ -f "$E2E_REL/$ORG/$REPO/releases/download/v$to/manifest.json.minisig" ] || { blocked "release $to is not built"; return 3; }
  local published
  published=$(state_get published)
  upgrade_body "$to" || rc=$?
  # Back to A's panel, C back in its place as a node of A, the published release as it was.
  unset E2E_PANEL_URL API_KEY
  "$E2E_DIR/publish.sh" "${published:-$E2E_V2}" >>"$RES/$CUR.log" 2>&1 || true
  on "$E2E_C" "$(installer_fetch) | sh -s -- uninstall --purge" >>"$RES/$CUR.log" 2>&1 || ev "note: uninstalling the upgraded panel from C failed"
  relay_stop "$E2E_C"
  relay_stop "$E2E_A"
  if join_node "$E2E_C" c "--name e2e-c --yes" && wait_for 180 "C back on A's panel" online_ge 3 && map_nodes; then
    ev "C joined A's panel again as $(node_id c)"
  else
    bad "C did not join A's panel again"
  fi
  return $rc
}

upgrade_body() {
  local to=$1 out link token jar email pw key up nodeid pid web pg worker job addr st run before after n want can_build
  up=http://$(node_ip c):$E2E_PORT

  free_c || { bad "uninstalling C from A's panel failed"; return 1; }
  good "C left A's panel and was uninstalled"
  on "$E2E_A" "command -v python3 >/dev/null" && on "$E2E_C" "command -v python3 >/dev/null" || { blocked "python3 is missing on A or C (registry relay)"; return 3; }
  relay_start "$E2E_A" "$(node_ip a)" "$E2E_FWD_PORT" 127.0.0.1 "$E2E_REG_PORT" || { bad "registry relay on A failed"; return 1; }
  relay_start "$E2E_C" 127.0.0.1 "$E2E_REG_PORT" "$(node_ip a)" "$E2E_FWD_PORT" || { bad "registry relay on C failed"; return 1; }
  wait_for 30 "the registry from C" on "$E2E_C" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:$E2E_REG_PORT/v2/" || { bad "C cannot reach the panel image registry"; return 1; }

  # 1. The released version's own installer: panel + node on C.
  write_key_dropin "$E2E_C"
  out=$(on "$E2E_C" "curl -fsSL $(release_base)/$ORG/$REPO/releases/download/v$E2E_BASE/install.sh | sh -s -- \
    --release-url $(release_base)/$ORG/$REPO/releases --version $E2E_BASE --port $E2E_PORT" 2>&1) || {
    printf '%s\n' "$out" >>"$RES/$CUR.log"
    bad "the $E2E_BASE installer failed on C: $(printf '%s' "$out" | grep -i error | tail -2 | tr '\n' ' ')"
    return 1
  }
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  link=$(printf '%s\n' "$out" | grep -o 'https\?://[^ ]*/setup?t=[A-Za-z0-9_-]*' | head -1 || true)
  token=${link##*t=}
  [ -n "$token" ] || { bad "the $E2E_BASE installer printed no setup link"; return 1; }
  wait_for 120 "the $E2E_BASE panel on C" curl -fsS "$up/api/health" || { bad "the panel on C did not answer"; return 1; }
  expect "C runs panel $E2E_BASE ($(curl -fsS "$up/api/health" | jq -c .))" test "$(curl -fsS "$up/api/health" | jq -r .version)" = "$E2E_BASE"
  out=$(on "$E2E_C" "docker inspect -f '{{.Config.Image}}' \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1)")
  expect "the $E2E_BASE panel runs its release image by digest ($out)" test "$out" = "$REG/$SLUG:$E2E_BASE@$(state_get "panel-digest-$E2E_BASE")"

  # 2. An owner and a key, through the old panel's own API.
  jar=$E2E_STATE/up-cookies
  rm -f "$jar"
  email=owner@upgrade.test
  pw=$(openssl rand -hex 16)
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $up" -X POST \
    --data "{\"token\":\"$token\",\"email\":\"$email\",\"name\":\"Upgrade Owner\",\"password\":\"$pw\"}" "$up/api/v1/setup.createOwner" >>"$RES/$CUR.log" ||
    { bad "setup.createOwner on C failed"; return 1; }
  curl -sS -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $up" -X POST \
    --data "$(jq -nc --arg p "$pw" '{password: $p}')" "$up/api/v1/auth.reauth" >/dev/null 2>&1 || true
  key=$(curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $up" -X POST \
    --data '{"kind":"api","name":"upgrade","actions":["*"],"readOnly":false,"expiresInDays":30}' "$up/api/v1/apiKeys.create" | jq -r .token)
  [ -n "$key" ] && [ "$key" != null ] || { bad "apiKeys.create on C failed"; return 1; }
  export E2E_PANEL_URL=$up API_KEY=$key
  wait_for 120 "C's own node online" sh -c "curl -fsS -H 'authorization: Bearer $key' '$up/api/v1/nodes.list' | jq -e '[.nodes[] | select(.status==\"online\")] | length == 1' >/dev/null"
  nodeid=$(api nodes.list | jq -r '.nodes[0].id')
  good "owner, API key and C's own node on the $E2E_BASE panel"

  # 3. Real rows on the old version: a project, an app with env, a Postgres with data, a cron job saved with 7 for Sunday.
  pid=$(api projects.create '{"name":"upgrade"}' | jq -r '.project.id // .id') || { bad "projects.create on $E2E_BASE failed"; return 1; }
  web=$(create_service "$(jq -nc --arg p "$pid" --arg n "$nodeid" '{projectId:$p, name:"web", kind:"app", nodeId:$n,
    source:{type:"image", image:"traefik/whoami:v1.10.3", registryId:null}, ports:[{containerPort:80, protocol:"tcp"}], deployNow:false}')") || { bad "services.create web failed"; return 1; }
  api env.set "{\"serviceId\":\"$web\",\"text\":\"WHOAMI_NAME=upgrade-web\\n\"}" >/dev/null || bad "env.set on web failed"
  api deployments.deploy "{\"serviceId\":\"$web\"}" >/dev/null || bad "deploying web failed"
  st=$(wait_deploy "$web" 300)
  [ "$st" = live ] || { bad "web on $E2E_BASE ended $st"; return 1; }
  wait_for 60 "web's first-run address" has_first_run "$web" || true
  addr=$(first_run_addr "$web")
  pg=$(api databases.create "{\"projectId\":\"$pid\",\"name\":\"pg\",\"engine\":\"postgres\",\"version\":\"17\",\"nodeId\":\"$nodeid\",\"database\":\"app\",\"user\":\"app\",\"password\":\"upgrade-pg-password-1\"}" | jq -r .serviceId) ||
    { bad "databases.create on $E2E_BASE failed"; return 1; }
  wait_for 300 "postgres on C" svc_running "$pg" || bad "postgres on $E2E_BASE did not run"
  wait_for 90 "postgres accepting" pg_exec c "$pg" "select 1" || true
  pg_exec c "$pg" "create table upgrade_rows (v text); insert into upgrade_rows values ('from-$E2E_BASE')" >/dev/null || bad "could not write the Postgres row"
  worker=$(create_service "$(jq -nc --arg p "$pid" --arg n "$nodeid" '{projectId:$p, name:"worker", kind:"app", nodeId:$n,
    source:{type:"image", image:"busybox:1.37", registryId:null}, deployNow:false}')") || { bad "services.create worker failed"; return 1; }
  api services.update "{\"serviceId\":\"$worker\",\"container\":{\"command\":[\"sleep\",\"86400\"]}}" >/dev/null
  api deployments.deploy "{\"serviceId\":\"$worker\"}" >/dev/null
  [ "$(wait_deploy "$worker" 300)" = live ] || bad "worker on $E2E_BASE did not go live"
  job=$(api cron.create "{\"serviceId\":\"$worker\",\"name\":\"sunday\",\"schedule\":\"0 4 * * 7\",\"command\":\"echo cron-ran-\$((6 * 7))\"}" | jq -r .id) ||
    { bad "cron.create with 7 for Sunday failed on $E2E_BASE"; return 1; }
  # A 0.1 node cannot read 7 and leaves the job out: its run-now finds no such job.
  out=$(api cron.runNow "{\"serviceId\":\"$worker\",\"cronJobId\":\"$job\"}" 2>&1 | head -c 300)
  ev "on $E2E_BASE: cron job saved as $(api cron.list "{\"serviceId\":\"$worker\"}" | jq -c '.jobs[0] | {schedule, nextRunAt}'); run now: $out"
  before=$(api projects.list | jq -c '[.projects[].name] | sort')
  # A node's Can build is never changed by an update (0004 only adds join_tokens.can_build).
  can_build=$(api nodes.list | jq -r --arg id "$nodeid" '.nodes[] | select(.id==$id) | .canBuild')
  n=$(up_sql "select count(*) as n from __drizzle_migrations" | jq -r '.[0].n')
  ev "before: projects $before; services $(api services.list "{\"projectId\":\"$pid\"}" | jq -c '[.services[] | "\(.name)=\(.status)"]'); web deployments $(deploy_count "$web"); migrations applied $n"
  good "rows on $E2E_BASE: project upgrade, web (whoami with env) on $addr, Postgres 17 with a row, worker with a cron job saved as 0 4 * * 7"

  # 4. The normal update path to this build: the panel first, then the node.
  "$E2E_DIR/publish.sh" "$to" >>"$RES/$CUR.log" 2>&1 || { bad "publishing $to failed"; return 1; }
  api updates.check '{}' >/dev/null 2>&1 || true
  ev "updates.status on $E2E_BASE: $(api updates.status | jq -c '{panel, checkError}')"
  expect "the $E2E_BASE panel sees $to as its update" test "$(api updates.status | jq -r .panel.latestVersion)" = "$to"
  api updates.updatePanel '{"panelOnly":false}' >/dev/null || { bad "updates.updatePanel failed"; return 1; }
  wait_for 600 "the panel on C at $to" sh -c "[ \"\$(curl -fsS -m 5 '$up/api/health' | jq -r .version)\" = '$to' ]" &&
    good "the panel on C runs $to" || { bad "the panel on C is at $(curl -fsS -m 5 "$up/api/health" | jq -r .version)"; return 1; }
  wait_for 600 "C's agent at $to" up_agent_at "$to" && good "C's agent runs $to" || bad "C's agent is at $(api nodes.list | jq -r '.nodes[0].agentVersion')"
  wait_for 300 "the update run" sh -c "curl -fsS -H 'authorization: Bearer $key' '$up/api/v1/updates.history?limit=1' | jq -e '.runs[0].status != \"running\"' >/dev/null" || true
  run=$(api updates.history '{"limit":1}' | jq -c '.runs[0]')
  ev "update run: $(printf '%s' "$run" | jq -c '{targetVersion, status, error, steps: [.steps[] | "\(.target):\(.status)"]}')"
  expect "the update run succeeded" json_ok "$run" '.status=="succeeded"'

  # 5. What survived, and the new migrations: every one this build has (the journal), not a fixed number.
  n=$(up_sql "select count(*) as n from __drizzle_migrations" | jq -r '.[0].n')
  want=$(panel_migrations)
  expect "every migration of this build applied: $want recorded (now $n)" test "$n" = "$want"
  out=$(up_sql "select name from sqlite_master where type = 'table' and name in ('git_providers', 'cleanup_runs', 'host_shell_sessions') order by name" | jq -c '[.[].name]')
  expect "0001's tables exist ($out)" test "$out" = '["cleanup_runs","git_providers","host_shell_sessions"]'
  out=$(up_sql "select name from pragma_table_info('update_steps') where name in ('retry', 'retry_run_id', 'retry_at') order by name" | jq -c '[.[].name]')
  expect "0002's update step columns exist ($out)" test "$out" = '["retry","retry_at","retry_run_id"]'
  out=$(up_sql "select name from pragma_table_info('join_tokens') where name = 'can_build'" | jq -c '[.[].name]')
  expect "0004's join_tokens.can_build column exists ($out)" test "$out" = '["can_build"]'
  out=$(api nodes.list | jq -r --arg id "$nodeid" '.nodes[] | select(.id==$id) | .canBuild')
  expect "C's node keeps its Can build through the update ($can_build before, $out after)" test "$out" = "$can_build"
  after=$(api projects.list | jq -c '[.projects[].name] | sort')
  expect "the projects are the same ($after)" test "$after" = "$before"
  expect "the API key made on $E2E_BASE still works" sh -c "curl -fsS -m 5 -H 'authorization: Bearer $key' '$up/api/v1/auth.whoami' >/dev/null"
  # The $E2E_BASE panel ran as uid 1000; the updated agent gives its folder to the panel user and replaces it once.
  wait_for 120 "the panel on C as the panel user" panel_user_ok "$E2E_C" || true
  expect "the upgraded panel runs as the panel user, its folder and master.key moved to it ($(panel_user_of "$E2E_C"))" panel_user_ok "$E2E_C"
  expect "web still answers on $addr with its env" sh -c "curl -fsS -m 5 http://$addr/ | grep -q upgrade-web"
  expect "the Postgres row from $E2E_BASE is there" test "$(pg_exec c "$pg" "select v from upgrade_rows")" = "from-$E2E_BASE"
  ev "cron job after the upgrade: $(api cron.list "{\"serviceId\":\"$worker\"}" | jq -c '.jobs[0] | {schedule, nextRunAt}')"
  expect "the cron job saved with 7 now reads 0 4 * * 0 and has a next run" json_ok "$(api cron.list "{\"serviceId\":\"$worker\"}" | jq -c '.jobs[0]')" '.schedule == "0 4 * * 0" and .nextRunAt != null'
  run=$(api cron.runNow "{\"serviceId\":\"$worker\",\"cronJobId\":\"$job\"}" | jq -r .id) || bad "cron.runNow after the upgrade failed"
  if [ -n "$run" ] && wait_for 120 "the cron run" sh -c "curl -fsS -H 'authorization: Bearer $key' '$up/api/v1/cron.run?serviceId=$worker&runId=$run' | jq -e '.run.result != \"running\"' >/dev/null"; then
    out=$(api cron.run "{\"serviceId\":\"$worker\",\"runId\":\"$run\"}" | jq -c '{result: .run.result, output}')
    expect "the node schedules the job now and runs it ($out)" json_ok "$out" '.result=="succeeded" and (.output | contains("cron-ran-42"))'
  else
    bad "the cron run after the upgrade did not finish"
  fi
  # The agent and panel work: a redeploy, and a 0.2 feature end to end.
  api deployments.deploy "{\"serviceId\":\"$web\"}" >/dev/null || bad "redeploying web failed"
  expect "a redeploy of web after the upgrade goes live" test "$(wait_deploy "$web" 300)" = live
  expect "web answers after the redeploy" sh -c "curl -fsS -m 5 http://$(first_run_addr "$web")/ | grep -q upgrade-web"
  expect "the upgraded node runs scheduled cleanup (cleanup.getSchedule supported)" json_ok "$(api cleanup.getSchedule "{\"nodeId\":\"$nodeid\"}" | jq -c .)" '.supported'
  expect "the upgraded node runs host shells (hostShell.status available)" json_ok "$(api hostShell.status "{\"nodeId\":\"$nodeid\"}" | jq -c .)" '.available'
}

# ---------------------------------------------------------------- 39-40 panel access helpers

# api_loop <op> [json]: like api, from A itself to the panel's loopback
# (http://127.0.0.1:<port>), which keeps answering while IP access is closed
# (the way back in that an SSH tunnel takes). The API key goes on stdin,
# never on a command line.
api_loop() {
  local op=$1 body=${2:-'{}'} url out code
  url="http://127.0.0.1:$E2E_PORT/api/v1/$op"
  if op_is_query "$op"; then
    out=$(state_get api-key | on "$E2E_A" "IFS= read -r k; curl -sS -m 120 -w '\n%{http_code}' -H \"authorization: Bearer \$k\" '$url?$(query_string "$body")'" 2>>"$RES/$CUR.log") || true
  else
    out=$({ state_get api-key; printf '%s' "$body"; } | on "$E2E_A" "IFS= read -r k; curl -sS -m 300 -w '\n%{http_code}' -H \"authorization: Bearer \$k\" \
      -H 'content-type: application/json' -X POST --data-binary @- '$url'" 2>>"$RES/$CUR.log") || true
  fi
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [ "${code:0:1}" != 2 ]; then
    printf '  api (A loopback) %s %s -> %s %s\n' "$op" "$(printf '%s' "$body" | head -c 300)" "$code" "$(printf '%s' "$out" | head -c 800)" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# sess <jar> <base url> <op> <json> [curl args...]: a mutation as the browser
# session in the jar (scurl), on that panel URL with its Origin; prints the
# body, fails on a non-2xx answer (the answer goes to stderr).
sess() {
  local jar=$1 base=$2 op=$3 body=$4 out code
  shift 4
  out=$(mktemp)
  code=$(scurl "$jar" -sS -m 60 -o "$out" -w '%{http_code}' "$@" -H 'content-type: application/json' -H "origin: $base" \
    -X POST --data "$body" "$base/api/v1/$op") || code=000
  if [ "${code:0:1}" != 2 ]; then
    printf '  %s %s (session on %s) -> %s %s\n' "$op" "$(printf '%s' "$body" | head -c 200)" "$base" "$code" "$(head -c 600 "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}
# sess_get <jar> <base url> <op> [curl args...]: a query without input the same way.
sess_get() {
  local jar=$1 base=$2 op=$3
  shift 3
  scurl "$jar" -fsS -m 60 "$@" "$base/api/v1/$op"
}
owner_login_json() { jq -nc --arg e "$(sed -n 1p "$E2E_STATE/owner")" --arg p "$(sed -n 2p "$E2E_STATE/owner")" '{email: $e, password: $p}'; }
# sess_login <jar> <base url> [curl args...]: the owner signs in on that URL, a new browser session (a fresh sign-in).
sess_login() {
  local jar=$1 base=$2
  shift 2
  rm -f "$jar" "$jar.key"
  sess "$jar" "$base" auth.login "$(owner_login_json)" "$@" >/dev/null
}

# jq_ok <json> <jq arguments...>: jq -e with them holds for the JSON.
jq_ok() {
  local j=$1
  shift
  printf '%s' "$j" | jq -e "$@" >/dev/null
}
# fails <command...>: the command fails (for expect).
fails() { ! "$@"; }
# refused_with <reason> <command...>: the command fails and its error output names the reason.
refused_with() {
  local reason=$1 out
  shift
  if out=$("$@" 2>&1 >/dev/null); then
    echo "accepted"
    return 1
  fi
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q -- "$reason"
}
# utc_ago <seconds>: that long ago as the panel writes times (ISO 8601, UTC), for comparisons.
utc_ago() { date -u -v-"$1"S +%Y-%m-%dT%H:%M:%S.000Z; }
now_ms() { echo $(($(date +%s) * 1000)); }

# ip_answers <mac|a|b|c>: http://<A>:<panel port>/api/health answers there with anything.
ip_answers() {
  local url
  url="http://$(node_ip a):$E2E_PORT/api/health"
  case $1 in
  mac) [ "$(http_code "$url")" != 000 ] ;;
  *) on_node "$1" "curl -s -o /dev/null -m 5 '$url'" ;;
  esac
}
ip_closed_from() { ! ip_answers "$1"; }
# agent_port_answers <letter>: a TCP connection from the node to A's agents' TLS port goes through.
agent_port_answers() { on_node "$1" "timeout 5 bash -c '</dev/tcp/$(node_ip a)/${2:-3443}'"; }
panel_access() { api_loop settings.panelAccess; }
pa_ip_is() { panel_access | jq -e --arg v "$1" '.actual.ip == $v' >/dev/null; }
pa_agent_port_is() { panel_access | jq -e --arg v "$1" '.actual.agentPort == $v' >/dev/null; }
pa_closed() { pa_ip_is closed && ip_closed_from mac; }
pa_open() { pa_ip_is open && ip_answers mac; }
pa_recloses() { panel_access | jq -e '.reclosesAt != null' >/dev/null; }
pa_brief() { panel_access 2>/dev/null | jq -c '{serveOnIp, agentPortOpen, onFailure, actual, openReason, reclosesAt, paths: [.privatePaths[]? | "\(.kind) working=\(.working)"], blocked: [.blocked[]?.code], lastChange}'; }
online_ge_loop() { [ "$(api_loop nodes.list | jq '[.nodes[] | select(.status=="online")] | length')" -ge "$1" ] 2>/dev/null; }
# panel_bindings: the panel container's published ports on A, as Docker has them.
panel_bindings() { on "$E2E_A" "docker inspect -f '{{json .HostConfig.PortBindings}}' \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1)"; }
panel_loopback_only() { panel_bindings | jq -e '."3000/tcp" | length > 0 and all(.HostIp == "127.0.0.1")' >/dev/null; }
panel_started() { on "$E2E_A" "docker inspect -f '{{.State.StartedAt}}' \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1)"; }
# security_alert <title> <since>: a security_change alert with that title raised since then.
security_alert() {
  api_loop alerts.list '{"limit":50}' | jq -e --arg t "$1" --arg s "$2" \
    '[.alerts[] | select(.event == "security_change" and .title == $t and .createdAt >= $s)] | length >= 1' >/dev/null
}
# settings_json_set <key> <path> <value>...: changes fields of a JSON value in the panel's settings
# table (only to move stored times into the past, standing in for waiting).
settings_json_set() {
  local key=$1 args=
  shift
  while [ $# -ge 2 ]; do
    args="$args, '$1', $2"
    shift 2
  done
  panel_sql_write "update settings set value = json_set(value$args) where key = '$key'" >>"$RES/$CUR.log" 2>&1
}

# ip_access_reset: both switches on, "reopen", and http://<A>:<port>
# answering again, with the API key (turning things back on needs no
# browser); `seylo panel ip-access on` on A when that call fails.
ip_access_reset() {
  if panel_access 2>/dev/null | jq -e '.serveOnIp and .agentPortOpen and .onFailure == "reopen" and .actual.ip != "closed" and .actual.agentPort != "closed"' >/dev/null 2>&1 &&
    ip_answers mac; then
    return 0
  fi
  if ! api_loop settings.updatePanelAccess '{"serveOnIp":true,"agentPortOpen":true,"onFailure":"reopen"}' >/dev/null 2>>"$RES/$CUR.log"; then
    ev "cleanup: settings.updatePanelAccess with the API key failed; running $SLUG panel ip-access on on A"
    on "$E2E_A" "$SLUG panel ip-access on" >>"$RES/$CUR.log" 2>&1 || true
  fi
  if wait_for 300 "IP access open again" pa_open; then
    ev "cleanup: IP access is open again (http://$(node_ip a):$E2E_PORT answers)"
  else
    bad "cleanup: http://$(node_ip a):$E2E_PORT does not answer again: $(pa_brief)"
  fi
}

# ---------------------------------------------------------------- 39 build default, panel access

# Check 39, part one: Add node's "Build images on this node" (the join
# token's canBuild) decides whether a new node builds, not the node's own
# --can-build. C leaves the panel (free_c) and joins with a command made
# with the box unticked plus --can-build; the same, now used, command again
# is refused (the installer exits 3); C joins once more with a default
# command and builds. Part two: the panel gets a domain the way check 31
# does (p31_domain_up), and the owner turns "Serve on IP address" off from
# a session on the domain: http://<A>:<port> stops answering from the Mac,
# B and C, while the domain and A's own agent keep working; `seylo panel
# ip-access on` opens it again; a domain that stops working (2 failed checks
# in a row, the first one backdated) opens it by itself, and it closes again
# an hour (backdated) after the domain works again. The check puts back IP
# access and removes the domain (p31_cleanup).
P39_BLOCKED=

check_39() {
  need_key || return 3
  local rc=0 r
  P39_BLOCKED=
  p39_builds || {
    r=$?
    if [ "$r" != 3 ]; then
      rc=$r
      p39_c_back
    fi
  }
  p39_access || {
    r=$?
    [ "$r" = 3 ] || rc=$r
  }
  # A part that was blocked (p31_domain_up's preconditions) does not hide the other part's failures.
  if [ "$CUR_STATUS" = BLOCKED ]; then
    CUR_STATUS=
    P39_BLOCKED=1
  fi
  if [ -n "$P39_BLOCKED" ] && [ "$CUR_FAILS" = 0 ] && [ "$rc" = 0 ]; then CUR_STATUS=BLOCKED; fi
  return "$rc"
}

p39_builds() {
  local nb report out rc again
  map_nodes
  nb=$(node_id b)
  if [ -z "$nb" ] || [ -z "$(node_id c)" ]; then
    ev "BLOCKED build default: B and C are not joined (check 3)"
    P39_BLOCKED=1
    return 3
  fi
  ev "Can build now: $(api nodes.list | jq -c '[.nodes[] | {name, canBuild, canBuildWarning, buildx: (.facts.buildx // null)}]')"
  report=$(api nodes.runHealthCheck "{\"nodeId\":\"$nb\"}") || report='{}'
  printf '%s\n' "$report" >>"$RES/$CUR.log"
  expect "the buildx health check passes on B ($(printf '%s' "$report" | jq -r '[.results[]? | select(.id=="docker.buildx") | "\(.status): \(.detail)"][0] // "no docker.buildx result"'))" \
    jq_ok "$report" '[.results[]? | select(.id=="docker.buildx" and .status=="pass")] | length == 1'

  # C leaves the panel, then joins with the box unticked and its own --can-build.
  free_c || { bad "taking C out of the panel failed"; return 1; }
  good "C left the panel and was uninstalled (its services went first)"
  join_node "$E2E_C" c "--name e2e-c --can-build" '{"canBuild":false}' || return 1
  expect "nodes.createJoinToken {canBuild: false} made a token that says so ($JOIN_TOKEN)" jq_ok "$JOIN_TOKEN" '.canBuild == false'
  expect "the installer on C waited for the agent's first connection and says it is connected" join_connected
  wait_for 120 "C online" online_ge 3 || true
  map_nodes
  expect "C, joined with the box unticked, does not build whatever its --can-build says (canBuild $(node_can_build c))" \
    test "$(node_can_build c)" = false
  ev "C's config.yml says $(on "$E2E_C" "grep '^can_build:' $BRAND_DATA_DIR/config.yml" 2>/dev/null || echo 'no can_build'), which the panel only reports"

  # The same command again: its token is used, the panel refuses the node and the installer exits 3.
  again=$JOIN_CMD
  case " $again " in *" --force "*) ;; *) again="$again --force" ;; esac
  rc=0
  out=$(on "$E2E_C" "$again" 2>&1) || rc=$?
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  ev "the used join command again: exit $rc, $(printf '%s' "$out" | grep -E 'refused|not valid|already used' | head -2 | tr '\n' ' ' | head -c 300)"
  expect "a join the panel refuses exits 3 (exit $rc)" test "$rc" = 3
  expect "and its closing block says the panel refused this node" grep -qF 'Installed, but the panel refused this node.' <<<"$out"

  # A default command: the node that joins builds. The old entry goes first so the name stays e2e-c.
  api nodes.remove "{\"nodeId\":\"$(node_id c)\",\"confirmName\":\"e2e-c\"}" >/dev/null || bad "nodes.remove of the refused C failed"
  state_set node-c ""
  join_node "$E2E_C" c "--name e2e-c" || return 1
  expect "a default join command made a token with canBuild true ($JOIN_TOKEN)" jq_ok "$JOIN_TOKEN" '.canBuild == true'
  expect "the installer on C waited for the agent's first connection and says it is connected" join_connected
  wait_for 120 "C online" online_ge 3 || true
  map_nodes
  expect "C, joined with a default command, builds images (canBuild $(node_can_build c))" test "$(node_can_build c)" = true
  expect "3 nodes online" online_ge 3
}

node_online() { api nodes.list | jq -e --arg id "$(node_id "$1")" '[.nodes[] | select(.id == $id and .status == "online")] | length == 1' >/dev/null; }

# p39_c_back: C is a connected node of the panel again after the build
# default part, whatever happened there, for the checks that follow.
p39_c_back() {
  map_nodes
  [ -n "$(node_id c)" ] && node_online c && return 0
  ev "putting C back as a node of the panel"
  [ -z "$(node_id c)" ] || api nodes.remove "{\"nodeId\":\"$(node_id c)\",\"confirmName\":\"e2e-c\"}" >/dev/null 2>&1 || true
  state_set node-c ""
  if join_node "$E2E_C" c "--name e2e-c" && wait_for 180 "C back" online_ge 3; then
    map_nodes
    ev "C joined the panel again as $(node_id c)"
  else
    bad "C did not join the panel again"
  fi
}

p39_access() {
  local s rc=0
  map_nodes
  # A run of check 31 or 39 that was stopped half way left state behind: undo it first.
  for s in p31-domain p31-conn-b p31-conn-c p31-a-acme p31-test-ca p31-ca; do
    if [ -e "$E2E_STATE/$s" ]; then
      ev "an earlier run of check 31 or 39 stopped half way; putting things back first"
      ip_access_reset
      p31_cleanup
      break
    fi
  done
  p31_domain_up || rc=$?
  [ "$rc" != 0 ] || p39_access_run || rc=$?
  ip_access_reset
  p31_cleanup
  return "$rc"
}

p39_access_run() {
  local ip_a port dom jar ipjar out st code since t
  ip_a=$(node_ip a)
  port=$E2E_PORT
  dom=https://$P31_DOM
  # B and C move to the domain once it is active; the restarts below are easier on them once that settled.
  if [ -z "$P31_MISSING" ]; then
    [ -n "$P31_BY_ITSELF" ] || p31_restart b c
    wait_for 240 "B and C on the domain" p31_both_moved ||
      ev "note: B and C did not both move to the domain (b: $(p31_conn b | tr '\n' ' '), c: $(p31_conn c | tr '\n' ' '))"
  fi
  wait_for 120 "B and C connected" p31_both_connected || true

  jar=$E2E_STATE/p39-domain-cookies
  ipjar=$E2E_STATE/p39-ip-cookies
  sess_login "$jar" "$dom" --cacert "$P31_ROOT" || { bad "the owner could not sign in over $dom"; return 1; }
  sess_login "$ipjar" "$(panel_url)" || { bad "the owner could not sign in over $(panel_url)"; return 1; }
  good "the owner signed in over $dom and over $(panel_url) (two browser sessions)"
  out=$(sess_get "$jar" "$dom" settings.panelAccess --cacert "$P31_ROOT") || out='{}'
  ev "settings.panelAccess on the domain: $(printf '%s' "$out" | jq -c '{serveOnIp, agentPortOpen, onFailure, panelPort, agentPort, actual, privatePaths, blocked: [.blocked[]?.code], agentPortBlocked: [.agentPortBlocked[]?.code], recovery}')"
  expect "the domain is a working private path and this session is on it" \
    jq_ok "$out" '[.privatePaths[]? | select(.kind == "domain" and .working and .usingNow)] | length == 1'
  ev "what refuses closing IP access: $(printf '%s' "$out" | jq -c '[.blocked[]? | {code, message}]')"
  ev "addresses the panel sees the nodes dial: $(for id in $(api nodes.list '{}' | jq -r '(.nodes // .)[].id'); do api nodes.get "{\"nodeId\":\"$id\"}" | jq -c '{name: (.node.name // .name), panelAddress: (.node.panelAddress // .panelAddress)}'; done | tr '\n' ' ')"
  expect "nothing refuses closing IP access for the owner on the domain" jq_ok "$out" '(.blocked | length) == 0'
  expect "the recovery SSH tunnel goes to 127.0.0.1:$port ($(printf '%s' "$out" | jq -r '.recovery.sshTunnel // empty'))" \
    jq_ok "$out" --arg p "ssh -L 3000:127.0.0.1:$port " '.recovery.sshTunnel | startswith($p)'

  # 0.2.7: the app and push notifications turn on only over the domain (the same origin proof
  # through Traefik), and the manifest follows the switch. Turned off again, as nothing below needs it.
  expect "push: turning the app on from the IP:port session is refused (notOnDomain)" \
    refused_with notOnDomain sess "$ipjar" "$(panel_url)" push.updateSettings '{"enabled":true}'
  expect "push: an API key cannot turn the app on" fails api push.updateSettings '{"enabled":true}'
  expect "push: no manifest while the app is off" sh -c "[ \"\$(curl -s -m 10 --cacert '$P31_ROOT' -o /dev/null -w '%{http_code}' '$dom/manifest.webmanifest')\" = 404 ]"
  out=$(sess "$jar" "$dom" push.updateSettings '{"enabled":true}' --cacert "$P31_ROOT") || out='{}'
  ev "push.updateSettings over $dom: $(printf '%s' "$out" | jq -c '{enabled, active, domainUrl, onDomainNow, blocks: [.blocks[]?.code]}')"
  expect "push: the app and push notifications turned on over $dom" jq_ok "$out" --arg d "$dom" '.enabled and .active and .onDomainNow and .domainUrl == $d'
  out=$(p31_curl -f "$dom/manifest.webmanifest") || out='{}'
  ev "the manifest on $dom: $(printf '%s' "$out" | jq -c '{name, short_name, display, start_url, icons: [.icons[]?.src]}')"
  expect "push: $dom serves the app manifest" jq_ok "$out" '.display == "standalone" and .start_url == "/" and (.icons | length) > 0'
  expect "push: the service worker is served as JavaScript, not cached" \
    sh -c "curl -sS -m 10 --cacert '$P31_ROOT' -D - -o /dev/null '$dom/sw.js' | tr -d '\r' | grep -qi '^content-type: text/javascript' && curl -sS -m 10 --cacert '$P31_ROOT' -D - -o /dev/null '$dom/sw.js' | tr -d '\r' | grep -qi '^cache-control: no-cache'"
  out=$(sess "$jar" "$dom" push.updateSettings '{"enabled":false}' --cacert "$P31_ROOT") || out='{}'
  expect "push: turned off again" jq_ok "$out" '.enabled == false'

  # Refused: an API key, and an IP:port session that claims to be on the domain.
  expect "an API key cannot turn Serve on IP address off (notBrowserSession)" \
    refused_with notBrowserSession api settings.updatePanelAccess '{"serveOnIp":false}'
  code=$(scurl "$ipjar" -sS -m 30 -o "$RES/$CUR.forged" -w '%{http_code}' -H 'content-type: application/json' -H "Host: $P31_DOM" \
    -H "origin: https://$P31_DOM" -H 'x-forwarded-proto: https' -X POST --data '{"serveOnIp":false}' \
    "$(panel_url)/api/v1/settings.updatePanelAccess") || code=000
  ev "the IP:port session with Host: $P31_DOM and X-Forwarded-Proto: https -> $code $(head -c 240 "$RES/$CUR.forged" 2>/dev/null)"
  expect "an IP:port session with a forged Host and X-Forwarded-Proto is refused ($code)" test "${code:0:1}" != 2
  expect "Serve on IP address is still on and IP:port answers" sh -c "[ \"\$(curl -s -m 5 -o /dev/null -w '%{http_code}' '$(panel_url)/api/health')\" = 200 ]"
  expect "settings.panelAccess still says serveOnIp" jq_ok "$(panel_access)" '.serveOnIp'

  # The owner turns it off on the domain.
  since=$(utc_ago 30)
  out=$(sess "$jar" "$dom" settings.updatePanelAccess '{"serveOnIp":false}' --cacert "$P31_ROOT") ||
    { bad "the owner could not turn Serve on IP address off over $dom"; return 1; }
  good "Serve on IP address turned off over $dom: $(printf '%s' "$out" | jq -c '{serveOnIp, actual, lastChange: .lastChange.reason}')"
  t=$SECONDS
  if wait_for 240 "IP access closed" pa_closed; then
    good "the panel restarted with its port on 127.0.0.1 only after $((SECONDS - t))s"
  else
    bad "IP access did not close: $(pa_brief)"
    return 1
  fi
  expect "http://$ip_a:$port no longer answers from the Mac" ip_closed_from mac
  expect "http://$ip_a:$port no longer answers from B" ip_closed_from b
  expect "http://$ip_a:$port no longer answers from C" ip_closed_from c
  expect "A's loopback still answers (the SSH tunnel's way in)" on "$E2E_A" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:$port/api/health"
  expect "Docker publishes the panel port on 127.0.0.1 only ($(panel_bindings))" panel_loopback_only
  expect "$dom still answers" p31_curl -f -o /dev/null "$dom/api/health"
  expect "the owner's session on the domain still works" sess_get "$jar" "$dom" auth.whoami --cacert "$P31_ROOT"
  wait_for 120 "A's agent connected" p31_connected a || true
  expect "the panel node's own agent stays connected ($(p31_status a))" p31_connected a
  wait_for 180 "3 nodes online" online_ge_loop 3 || true
  expect "B and C stay online" online_ge_loop 3
  out=$(on "$E2E_A" "$SLUG panel status 2>&1" || true)
  ev "seylo panel status on A: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  expect "seylo panel status says IP access is closed on 127.0.0.1:$port" grep -qF "IP access: closed (127.0.0.1:$port" <<<"$out"
  expect "a security_change alert says IP access closed" security_alert "IP access closed" "$since"

  # The agents' port closes only once no node needs it (B and C on the domain).
  # Asked from the domain session: with the API key the answer also lists
  # "only from a browser on a private path", which says nothing about the nodes.
  st=$(sess_get "$jar" "$dom" settings.panelAccess --cacert "$P31_ROOT") || st='{}'
  ev "agents' port from the domain session: $(printf '%s' "$st" | jq -c '[.agentPortBlocked[]? | {code, message}]')"
  if jq_ok "$st" '(.agentPortBlocked | length) == 0'; then
    if sess "$jar" "$dom" settings.updatePanelAccess '{"agentPortOpen":false}' --cacert "$P31_ROOT" >/dev/null; then
      good "the agents' port turned off over the domain (every node connects over the domain)"
      if wait_for 240 "the agents' port closed" pa_agent_port_is closed; then
        expect "C can no longer connect to A:$P31_TLS_PORT" fails agent_port_answers c "$P31_TLS_PORT"
        wait_for 180 "3 nodes online" online_ge_loop 3 || true
        expect "B and C stay online over the domain" online_ge_loop 3
      else
        bad "the agents' port did not close: $(pa_brief)"
      fi
    else
      bad "turning the agents' port off was refused although agentPortBlocked was empty"
    fi
  else
    ev "the agents' port stays open: $(printf '%s' "$st" | jq -c '[.agentPortBlocked[] | "\(.code): \(.message | .[0:120])"]')"
    expect "turning the agents' port off is refused while nodes need it" fails sess "$jar" "$dom" settings.updatePanelAccess '{"agentPortOpen":false}' --cacert "$P31_ROOT"
  fi

  # The way back in on the server: seylo panel ip-access on.
  since=$(utc_ago 30)
  out=$(on "$E2E_A" "$SLUG panel ip-access on" 2>&1) || bad "seylo panel ip-access on failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  ev "seylo panel ip-access on: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  t=$SECONDS
  if wait_for 300 "IP access open again" pa_open; then
    good "seylo panel ip-access on opened http://$ip_a:$port again: the Mac reaches it after $((SECONDS - t))s"
  else
    bad "seylo panel ip-access on did not open IP access again: $(pa_brief)"
    return 1
  fi
  st=$(panel_access)
  expect "both switches are on and set to reopen again ($(printf '%s' "$st" | jq -c '{serveOnIp, agentPortOpen, onFailure}'))" \
    jq_ok "$st" '.serveOnIp and .agentPortOpen and .onFailure == "reopen"'
  wait_for 120 "the agents' port open" pa_agent_port_is open || true
  expect "C reaches A's agents' port again" agent_port_answers c "$P31_TLS_PORT"
  expect "C reaches http://$ip_a:$port again" ip_answers c
  expect "the audit log has the reopen from the server's command line" \
    jq_ok "$(api audit.list "$(jq -nc --arg s "$since" '{opId: "settings.ipAccessOnFromServer", from: $s, limit: 5}')")" '.entries | length >= 1'

  # The domain stops working while IP access is closed: it opens by itself.
  if [ -z "$P31_BY_ITSELF" ]; then
    ev "BLOCKED the domain-death reopen: the panel build the VMs run does not trust the test CA, so its own probe never finds the domain working (rebuild with refresh.sh)"
    P39_BLOCKED=1
    return 0
  fi
  sess_login "$jar" "$dom" --cacert "$P31_ROOT" || { bad "the owner could not sign in over $dom again"; return 1; }
  sess "$jar" "$dom" settings.updatePanelAccess '{"serveOnIp":false}' --cacert "$P31_ROOT" >/dev/null ||
    { bad "turning Serve on IP address off over $dom a second time failed"; return 1; }
  wait_for 240 "IP access closed" pa_closed || { bad "IP access did not close the second time: $(pa_brief)"; return 1; }
  good "IP access closed again from the domain session"
  # The panel's probe stops trusting Pebble (no test CA), and the stored
  # status says one failed check counted 5 minutes ago: the next check is
  # the second in a row, after which the domain counts as down.
  since=$(utc_ago 30)
  p31_test_ca_off || bad "could not remove the panel's test CA"
  settings_json_set panelDomainStatus '$.failedChecks' 1 '$.lastFailedAt' "$(($(now_ms) - 300000))" || bad "could not backdate the domain's first failed check"
  api_loop settings.checkDomain '{}' >>"$RES/$CUR.log" 2>&1 || true
  ev "the panel's domain status after a failing check: $(api_loop settings.general | jq -c .domainStatus)"
  t=$SECONDS
  if wait_for 240 "IP access to reopen by itself" pa_open; then
    good "with the domain down (2 failed checks in a row), IP access reopened by itself after $((SECONDS - t))s"
  else
    bad "IP access did not reopen with the domain down: $(pa_brief)"
    return 1
  fi
  st=$(panel_access)
  ev "settings.panelAccess: $(pa_brief)"
  expect "the domain counts as not working" jq_ok "$st" '[.privatePaths[] | select(.kind == "domain" and (.working | not))] | length == 1'
  expect "Serve on IP address stays off as the owner set it, and the card says why IP access is open ($(printf '%s' "$st" | jq -r '.openReason // "no reason"'))" \
    jq_ok "$st" '(.serveOnIp | not) and (.openReason // "" | test("stopped working"))'
  expect "a security_change alert says IP access reopened" security_alert "IP access reopened" "$since"
  # The domain works again: IP access closes again once it has worked for an hour.
  p31_test_ca_on || bad "could not put the panel's test CA back"
  sleep 11 # settings.checkDomain runs once per 10 seconds
  wait_for 120 "the domain active again" p31_check_active || bad "the domain did not turn active again: $(api settings.general | jq -c .domainStatus)"
  wait_for 120 "a time to close again" pa_recloses || true
  st=$(panel_access)
  expect "with the domain working again, IP access stays open for an hour first (reclosesAt $(printf '%s' "$st" | jq -r .reclosesAt))" \
    jq_ok "$st" '.reclosesAt != null and .actual.ip == "open"'
  settings_json_set panelIpAccessApplied '$.reopenedAt' "$(($(now_ms) - 3660000))" || bad "could not backdate the reopen"
  settings_json_set panelDomainStatus '$.since' "$(($(now_ms) - 3660000))" || bad "could not backdate the domain's working time"
  t=$SECONDS
  if wait_for 240 "IP access to close again" pa_closed; then
    good "an hour (backdated) after the domain worked again, IP access closed again by itself after $((SECONDS - t))s"
  else
    bad "IP access did not close again an hour after the domain worked again: $(pa_brief)"
  fi
}

# ---------------------------------------------------------------- 40 panel on Tailscale (Headscale)

# Check 40 serves the panel on a tailnet that Headscale runs (e2e-headscale
# on A, infra.sh; nothing on the internet): A's own tailscaled plays the
# owner's server (kernel mode when A has /dev/net/tun), C's tailscaled the
# owner's laptop (userspace, curl goes through its SOCKS5 proxy). Both sign
# in with a pre-auth key: the CLI path (`tailscale up`), since the panel's
# sign-in link is for login.tailscale.com. Headscale gives no HTTPS
# certificates, so Serve runs in HTTP mode (http://<machine>.$E2E_HS_DOMAIN).
# After Lock to Tailscale it checks the ways back: tailscaled stopped for 5
# minutes (backdated) reopens IP access by itself, `seylo panel tailscale
# status` works with the agent stopped, `seylo panel ip-access on`, and
# `seylo panel tailscale off` / `on`. p40_cleanup turns Serve off, opens IP
# access, removes tailscaled from A and C and their Headscale nodes, so the
# check reruns from the start.
P40_SOCKS=1055
P40_DNS=
P40_TSIP=
P40_UP=
# C keeps the owner's tailnet browser session here: <this>.jar, .key, .hdr.
P40_JAR=/root/e2e-p40

# hs <args...>: the headscale CLI in its container on A.
hs() { on "$E2E_A" "docker exec e2e-headscale headscale $*"; }
hs_running() { on "$E2E_A" "docker inspect -f '{{.State.Running}}' e2e-headscale 2>/dev/null | grep -q true && curl -fsS -m 5 -o /dev/null https://$(node_ip a):$E2E_HS_PORT/health"; }

# tailscaled's unit, as Tailscale's packages ship it ($FLAGS from /etc/default/tailscaled).
# shellcheck disable=SC2016
ts_unit='[Unit]
Description=Tailscale node agent (e2e test, check 40)
Wants=network-pre.target
After=network-pre.target systemd-resolved.service

[Service]
EnvironmentFile=/etc/default/tailscaled
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} $FLAGS
ExecStopPost=/usr/sbin/tailscaled --cleanup
Restart=on-failure
RuntimeDirectory=tailscale
RuntimeDirectoryMode=0755
StateDirectory=tailscale
StateDirectoryMode=0700
CacheDirectory=tailscale
CacheDirectoryMode=0750
Type=notify

[Install]
WantedBy=multi-user.target
'

# ts_install <letter> <tailscaled flags>: Tailscale $E2E_TS_VERSION on the node, from the release server, sha256 checked.
ts_install() {
  local url sha
  url="$(release_base)/e2e-tools/$(e2e_ts_file)"
  sha=$(e2e_ts_sha256)
  on_node "$1" "set -e; d=\$(mktemp -d); curl -fsSL -o \$d/ts.tgz '$url'; echo '$sha  '\$d/ts.tgz | sha256sum -c --quiet
    tar -xzf \$d/ts.tgz -C \$d; install -m 0755 \$d/tailscale_*/tailscaled /usr/sbin/tailscaled; install -m 0755 \$d/tailscale_*/tailscale /usr/bin/tailscale
    rm -rf \$d; printf 'PORT=41641\nFLAGS=\"%s\"\n' '$2' >/etc/default/tailscaled" || return 1
  printf '%s' "$ts_unit" | on_node "$1" "cat >/etc/systemd/system/tailscaled.service && systemctl daemon-reload && systemctl enable --now tailscaled >/dev/null 2>&1"
}
# ts_remove <letter>: tailscaled, its state and its unit gone from the node.
ts_remove() {
  on_node "$1" "systemctl disable --now tailscaled >/dev/null 2>&1; test ! -x /usr/sbin/tailscaled || /usr/sbin/tailscaled --cleanup >/dev/null 2>&1
    rm -rf /var/lib/tailscale /var/cache/tailscale /run/tailscale /usr/sbin/tailscaled /usr/bin/tailscale /etc/systemd/system/tailscaled.service /etc/default/tailscaled
    systemctl daemon-reload; true"
}

# tcurl <curl args...>: curl on C through its tailscaled (SOCKS5), with the
# panel server's tailnet name and its short name resolving to its tailnet address.
tcurl() {
  on_node c "curl -sS -m 20 --socks5 127.0.0.1:$P40_SOCKS --resolve $P40_DNS:80:$P40_TSIP --resolve ${P40_DNS%%.*}:80:$P40_TSIP $(printf '%q ' "$@")"
}
tailnet_health() { [ "$(tcurl -o /dev/null -w '%{http_code}' "http://$P40_DNS/api/health" 2>/dev/null)" = 200 ]; }
tailnet_web_app() { tcurl "http://$P40_DNS/" 2>/dev/null | grep -qi '<!doctype html'; }

# tsess <op> [json]: an op as the owner's browser session on C over the
# tailnet (cookie jar and session key stay on C, in $P40_JAR.*), a query as
# GET. Prints the body, fails on a non-2xx answer. TSESS_EXTRA adds curl
# arguments (shell words).
tsess() {
  local op=$1 body=${2:-'{}'} req out code
  if op_is_query "$op"; then
    req="'http://$P40_DNS/api/v1/$op?$(query_string "$body")'"
  else
    req="-H 'content-type: application/json' -H 'origin: http://$P40_DNS' -X POST --data-binary @- 'http://$P40_DNS/api/v1/$op'"
  fi
  out=$(printf '%s' "$body" | on_node c "k=\$(cat $P40_JAR.key 2>/dev/null || true)
    curl -sS -m 60 --socks5 127.0.0.1:$P40_SOCKS --resolve $P40_DNS:80:$P40_TSIP -c $P40_JAR.jar -b $P40_JAR.jar -D $P40_JAR.hdr \\
      \${k:+-H \"$SESSION_KEY_HEADER: \$k\"} ${TSESS_EXTRA:-} -w '\n%{http_code}' $req
    n=\$(tr -d '\r' <$P40_JAR.hdr 2>/dev/null | grep -i '^$SESSION_KEY_HEADER:' | tail -1 | sed 's/^[^:]*:[[:space:]]*//')
    [ -z \"\$n\" ] || printf '%s\n' \"\$n\" >$P40_JAR.key" 2>>"$RES/$CUR.log") || true
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [ "${code:0:1}" != 2 ]; then
    printf '  %s %s (tailnet session on C) -> %s %s\n' "$op" "$(printf '%s' "$body" | head -c 200)" "$code" "$(printf '%s' "$out" | head -c 600)" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

ts_get() { api_loop tailscale.get; }
ts_brief() { ts_get 2>/dev/null | jq -c '{detected, agentSupported, version, backendState, tailnet, dnsName, magicDns, https, acceptDns, disabledOnServer, serve: (.serve | {wanted, state, url, panelAnswers, message}), owned}'; }
ts_detected() { ts_get | jq -e --argjson d "$1" '.detected == $d' >/dev/null; }
ts_state_is() { ts_get | jq -e --arg s "$1" '.backendState == $s' >/dev/null; }
ts_serving() { ts_get | jq -e '.serve.state == "active" and .serve.panelAnswers and .owned != null' >/dev/null; }
ts_disabled() { ts_get | jq -e --argjson d "$1" '.disabledOnServer == $d' >/dev/null; }
ts_serving_again() { ts_serving && ts_disabled false; }
tailnet_working() { panel_access | jq -e '[.privatePaths[] | select(.kind == "tailnet" and .working)] | length == 1' >/dev/null; }
tailnet_down_since() { panel_sql "select json_extract(value, '\$.downSince') as d from settings where key = 'tailscaleSeen'" | jq -e '.[0].d != null' >/dev/null; }
# serve_config: tailscaled's Serve config on A (JSON).
serve_config() { on "$E2E_A" "tailscale serve status --json 2>/dev/null || echo '{}'"; }
# entry_ours: the panel's entry is in the Serve config, pointing at the panel's socket.
entry_ours() {
  serve_config | jq -e --arg h "$P40_DNS:80" '.Web[$h].Handlers["/"].Proxy // "" | (startswith("unix:") and endswith("/panel/tailnet.sock"))' >/dev/null
}
# owner_entry_kept: the owner's own entry (http://<name>:8080 -> text:owner) is in the Serve config.
owner_entry_kept() {
  serve_config | jq -e --arg h "$P40_DNS:8080" '.Web[$h].Handlers["/"].Text == "owner"' >/dev/null
}
p40_loop_done() { on_node c "! systemctl is-active --quiet e2e-p40-loop"; }

check_40() {
  need_key || return 3
  local rc=0 s
  for s in p40-ts-a p40-ts-c; do
    if [ -e "$E2E_STATE/$s" ]; then
      ev "an earlier run of this check stopped half way; putting things back first"
      p40_cleanup
      break
    fi
  done
  p40_run || rc=$?
  p40_cleanup
  return "$rc"
}

p40_run() {
  local ip_a port ipjar out st key mode t since started codes total failed seeded
  ip_a=$(node_ip a)
  port=$E2E_PORT
  map_nodes
  [ -n "$(node_id b)" ] && [ -n "$(node_id c)" ] || { blocked "B and C are not joined (check 3)"; return 3; }
  [ -s "$E2E_STATE/owner" ] || { blocked "no owner credentials (check 2)"; return 3; }
  [ -n "$(e2e_ts_sha256)" ] || { blocked "no sha256 for Tailscale $E2E_TS_VERSION in lib.sh"; return 3; }
  [ -s "$E2E_REL/e2e-tools/$(e2e_ts_file)" ] || { blocked "no Tailscale tarball on the release server (serve.sh fetches $(e2e_ts_file))"; return 3; }
  hs_running || { blocked "Headscale does not answer on https://$ip_a:$E2E_HS_PORT (infra.sh starts e2e-headscale)"; return 3; }
  [ "$(api settings.general | jq -r .domain)" = null ] ||
    { blocked "the panel has a domain ($(api settings.general | jq -r .domain)); check 40 needs the tailnet to be its only private path"; return 3; }
  ip_access_reset

  # 1. No Tailscale on the server yet.
  ipjar=$E2E_STATE/p40-ip-cookies
  sess_login "$ipjar" "$(panel_url)" || { bad "the owner could not sign in over $(panel_url)"; return 1; }
  st=$(ts_get) || { bad "tailscale.get failed"; return 1; }
  ev "tailscale.get before Tailscale: $(ts_brief)"
  jq_ok "$st" '.agentSupported' || { blocked "A's agent does not read Tailscale (no tailnet.serve.v1): the build the VMs run predates it (refresh.sh)"; return 3; }
  expect "tailscale.get: not detected" jq_ok "$st" '.detected | not'
  expect "turning Serve on is refused: notInstalled" refused_with notInstalled sess "$ipjar" "$(panel_url)" tailscale.setServe '{"serve":true}'

  # 2. tailscaled on A (the owner's server) and C (the laptop), not signed in.
  mode=
  on "$E2E_A" "test -c /dev/net/tun || modprobe tun 2>/dev/null; test -c /dev/net/tun" || mode=--tun=userspace-networking
  state_set p40-ts-a yes
  ts_install a "$mode" || { bad "installing tailscaled $E2E_TS_VERSION on A failed"; return 1; }
  state_set p40-ts-c yes
  ts_install c "--tun=userspace-networking --socks5-server=127.0.0.1:$P40_SOCKS" || { bad "installing tailscaled on C failed"; return 1; }
  good "tailscaled $E2E_TS_VERSION on A (${mode:-kernel mode}) and on C (userspace, SOCKS5 on 127.0.0.1:$P40_SOCKS), sha256 checked"
  wait_for 120 "the agent to find tailscaled waiting for a sign-in" ts_state_is NeedsLogin || true
  ev "tailscale.get, not signed in: $(ts_brief)"
  expect "tailscale.get: detected, waiting for a sign-in" jq_ok "$(ts_get)" '.detected and .backendState == "NeedsLogin"'
  expect "turning Serve on is refused: notSignedIn" refused_with notSignedIn sess "$ipjar" "$(panel_url)" tailscale.setServe '{"serve":true}'

  # 3. Both sign in to Headscale with a pre-auth key, Tailscale DNS off.
  for s in $(hs nodes list -o json 2>/dev/null | jq -r '.[]?.id' 2>/dev/null); do hs nodes delete -i "$s" --force >/dev/null 2>&1 || true; done
  s=$(hs users list -o json 2>/dev/null | jq -r '.[]? | select(.name == "e2e") | .id' | head -1)
  [ -n "$s" ] || { hs users create e2e >/dev/null && s=$(hs users list -o json | jq -r '.[] | select(.name == "e2e") | .id' | head -1); }
  key=$(hs preauthkeys create --user "$s" --reusable --expiration 2h 2>/dev/null | tail -1 | tr -d '[:space:]')
  [ -n "$key" ] || { bad "Headscale made no pre-auth key"; return 1; }
  P40_UP="tailscale up --login-server=https://$ip_a:$E2E_HS_PORT --accept-dns=false --timeout=60s"
  on "$E2E_A" "$P40_UP --hostname=e2e-a --authkey=$key" >>"$RES/$CUR.log" 2>&1 || { bad "tailscale up on A failed"; return 1; }
  on_node c "$P40_UP --hostname=e2e-c --authkey=$key" >>"$RES/$CUR.log" 2>&1 || { bad "tailscale up on C failed"; return 1; }
  P40_UP="$P40_UP --hostname=e2e-a"
  wait_for 120 "the agent to see A signed in" ts_state_is Running || true
  st=$(ts_get)
  ev "tailscale.get, signed in: $(ts_brief)"
  P40_DNS=$(printf '%s' "$st" | jq -r '.dnsName // empty')
  P40_TSIP=$(on "$E2E_A" "tailscale ip -4" | head -1 | tr -d '[:space:]')
  [ -n "$P40_DNS" ] && [ -n "$P40_TSIP" ] || { bad "A has no tailnet name or address (dnsName '$P40_DNS', ip '$P40_TSIP')"; return 1; }
  good "A and C signed in to Headscale; A is $P40_DNS ($P40_TSIP) on tailnet $(printf '%s' "$st" | jq -r .tailnet)"
  expect "tailscale.get: Running, MagicDNS on, no HTTPS certificates, Tailscale DNS off, version OK" \
    jq_ok "$st" '.backendState == "Running" and .magicDns and (.https | not) and (.acceptDns | not) and .versionOk'

  # 4. An entry of the owner's own, which the panel must leave alone.
  seeded=
  if on "$E2E_A" "tailscale serve --bg --http=8080 text:owner" >>"$RES/$CUR.log" 2>&1 && owner_entry_kept; then
    seeded=1
    ev "the owner's own Serve entry: http://$P40_DNS:8080 -> text:owner"
  else
    ev "note: tailscale serve --bg --http=8080 text:owner did not add an entry here, so there is no owner's entry to keep"
  fi

  # 5. Serve on: refused for an API key, done for the owner's browser session. Nothing restarts.
  expect "an API key cannot turn Serve on" fails api tailscale.setServe '{"serve":true}'
  started=$(panel_started)
  out=$(sess "$ipjar" "$(panel_url)" tailscale.setServe '{"serve":true}') || { bad "the owner could not turn Serve on"; return 1; }
  good "tailscale.setServe {serve: true} from the owner's session: $(printf '%s' "$out" | jq -c '.tailscale.serve | {wanted, state}')"
  t=$SECONDS
  if wait_for 120 "Serve active" ts_serving; then
    good "the panel's Serve entry is active after $((SECONDS - t))s: $(ts_get | jq -c '{url: .serve.url, owned}')"
  else
    bad "Serve did not turn active: $(ts_brief)"
    return 1
  fi
  st=$(ts_get)
  expect "it serves http://$P40_DNS (HTTP mode, the tailnet has no certificates)" jq_ok "$st" --arg u "http://$P40_DNS" '.serve.url == $u'
  expect "the entry is $P40_DNS:80 / -> the panel's socket ($(printf '%s' "$st" | jq -c .owned))" \
    jq_ok "$st" --arg h "$P40_DNS:80" '.owned.hostPort == $h and .owned.path == "/" and (.owned.proxy | endswith("/panel/tailnet.sock"))'
  expect "tailscaled's Serve config has the same entry" entry_ours
  [ -z "$seeded" ] || expect "the owner's own 8080 entry is untouched" owner_entry_kept
  expect "the panel did not restart for it (StartedAt $started)" test "$(panel_started)" = "$started"
  out=$(on "$E2E_A" "stat -c '%u:%a' $BRAND_DATA_DIR/panel/tailnet.sock" 2>&1 || true)
  expect "the panel's socket is the panel user's, mode 0600 ($out)" test "$out" = "61000:600"
  expect "another user on A cannot use the socket" \
    on "$E2E_A" "! runuser -u nobody -- curl -s -m 5 -o /dev/null --unix-socket $BRAND_DATA_DIR/panel/tailnet.sock http://localhost/api/health"

  # 6. From C over the tailnet.
  wait_for 60 "the panel over the tailnet" tailnet_health || true
  expect "http://$P40_DNS/api/health answers 200 from C over the tailnet" tailnet_health
  expect "http://$P40_DNS/ serves the web app" tailnet_web_app
  out=$(tcurl -o /dev/null -w '%{http_code} %{redirect_url}' "http://${P40_DNS%%.*}/settings/general" 2>/dev/null || true)
  expect "the short name ${P40_DNS%%.*} goes to the full name ($out)" test "$out" = "308 http://$P40_DNS/settings/general"
  since=$(utc_ago 30)
  on_node c "rm -f $P40_JAR.jar $P40_JAR.key $P40_JAR.hdr"
  # Serve drops X-Forwarded-* a client sends and sets its own, so these never reach the panel.
  if TSESS_EXTRA="-H 'X-Forwarded-For: 1.2.3.4' -H 'X-Forwarded-Host: evil.example'" tsess auth.login "$(owner_login_json)" >/dev/null; then
    good "the owner signed in from C over the tailnet, with a forged X-Forwarded-For and X-Forwarded-Host"
    out=$(api_loop audit.list "$(jq -nc --arg s "$since" '{opId: "auth.login", from: $s, limit: 5}')" | jq -c '[.entries[] | .ip]')
    expect "the sign-in's audit row has C's tailnet address, not the forged one ($out)" \
      jq_ok "$out" 'length >= 1 and all(.[]; (. // "") | startswith("100."))'
  else
    bad "a sign-in over the tailnet with a forged X-Forwarded-For and X-Forwarded-Host was refused (Serve should replace them)"
    tsess auth.login "$(owner_login_json)" >/dev/null || { bad "the owner could not sign in from C over the tailnet"; return 1; }
    good "the owner signed in from C over the tailnet"
  fi
  st=$(tsess tailscale.get) || st='{}'
  expect "tailscale.get on the tailnet says this request came over it" jq_ok "$st" '.viaTailnet'
  expect "tailscale.get with the API key over IP:port does not" jq_ok "$(api tailscale.get)" '.viaTailnet | not'

  # 7. Lock to Tailscale: refused from IP:port, done from the tailnet session.
  expect "closing IP access from the IP:port session is refused (notOnPrivatePath)" \
    refused_with notOnPrivatePath sess "$ipjar" "$(panel_url)" settings.updatePanelAccess '{"serveOnIp":false}'
  st=$(tsess settings.panelAccess) || st='{}'
  ev "settings.panelAccess on the tailnet: $(printf '%s' "$st" | jq -c '{privatePaths, blocked: [.blocked[]?.code], agentPortBlocked: [.agentPortBlocked[]?.code]}')"
  expect "the tailnet is a working private path and this session is on it" \
    jq_ok "$st" '[.privatePaths[]? | select(.kind == "tailnet" and .working and .usingNow)] | length == 1'
  expect "nothing refuses closing IP access for the owner on the tailnet" jq_ok "$st" '(.blocked | length) == 0'
  expect "the agents' port has to stay open while B and C connect over it (nodesOnAgentPort)" \
    jq_ok "$st" '[.agentPortBlocked[]? | select(.code == "nodesOnAgentPort")] | length == 1'
  since=$(utc_ago 30)
  out=$(tsess settings.updatePanelAccess '{"serveOnIp":false}') || { bad "Lock to Tailscale (serveOnIp off from the tailnet session) failed"; return 1; }
  good "Lock to Tailscale: Serve on IP address turned off from the tailnet session"
  t=$SECONDS
  if wait_for 240 "IP access closed" pa_closed; then
    good "IP access closed after $((SECONDS - t))s"
  else
    bad "IP access did not close: $(pa_brief)"
    return 1
  fi
  expect "http://$ip_a:$port no longer answers from the Mac" ip_closed_from mac
  expect "http://$ip_a:$port no longer answers from B" ip_closed_from b
  expect "http://$ip_a:$port no longer answers from C (outside the tailnet)" ip_closed_from c
  expect "A's loopback still answers" on "$E2E_A" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:$port/api/health"
  wait_for 60 "the panel over the tailnet" tailnet_health || true
  expect "the panel answers over the tailnet" tailnet_health
  expect "the owner's tailnet session still works" tsess auth.whoami
  wait_for 120 "A's agent connected" p31_connected a || true
  expect "A's own agent stays connected" p31_connected a
  wait_for 180 "3 nodes online" online_ge_loop 3 || true
  expect "B and C stay online over the agents' port" online_ge_loop 3
  out=$(on "$E2E_A" "$SLUG panel status 2>&1" || true)
  ev "seylo panel status on A: $(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"
  expect "seylo panel status says IP access is closed" grep -qF "IP access: closed (127.0.0.1:$port" <<<"$out"
  expect "seylo panel status names the tailnet address" grep -qF "Tailnet: active (http://$P40_DNS)" <<<"$out"
  expect "a security_change alert says IP access closed" security_alert "IP access closed" "$since"

  # 8. Agent restarts never touch the tailnet path: requests twice a second from C while A's agent restarts.
  on_node c "rm -f /root/e2e-p40-loop.txt; systemctl reset-failed e2e-p40-loop >/dev/null 2>&1; systemd-run --unit=e2e-p40-loop --collect bash -c \
    'for i in \$(seq 1 60); do curl -s -o /dev/null -m 5 -w \"%{http_code}\\n\" --socks5 127.0.0.1:$P40_SOCKS --resolve $P40_DNS:80:$P40_TSIP http://$P40_DNS/api/health >>/root/e2e-p40-loop.txt; sleep 0.5; done' >/dev/null" ||
    bad "could not start the request loop on C"
  sleep 5
  on "$E2E_A" "systemctl restart $SLUG.service"
  wait_for 120 "the request loop" p40_loop_done || true
  codes=$(on_node c "cat /root/e2e-p40-loop.txt" 2>/dev/null || true)
  total=$(printf '%s\n' "$codes" | grep -c . || true)
  failed=$(printf '%s\n' "$codes" | grep -c -v -x 200 || true)
  [ -n "$codes" ] || failed=0
  expect "A's agent restarted during $total requests over the tailnet, $failed of them not 200" test "$total" -ge 50 -a "$failed" = 0
  wait_for 120 "A's agent connected" p31_connected a || true

  # 9. The agent puts its entry back after `tailscale serve reset`; a panel restart replaces its socket.
  on "$E2E_A" "tailscale serve reset" >>"$RES/$CUR.log" 2>&1 || bad "tailscale serve reset failed"
  t=$SECONDS
  if wait_for 150 "the panel's entry back" entry_ours; then
    good "after tailscale serve reset, the agent put the panel's entry back within $((SECONDS - t))s"
  else
    bad "the panel's entry did not come back after tailscale serve reset: $(serve_config | jq -c .)"
  fi
  on "$E2E_A" "docker restart \$(docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1) >/dev/null" || bad "restarting the panel container failed"
  wait_for 120 "the panel over the tailnet after its restart" tailnet_health || true
  expect "after a panel container restart the tailnet answers again (the stale socket was replaced)" tailnet_health

  # 10. Tailscale stops on the server: after 5 minutes (backdated) IP access reopens by itself.
  since=$(utc_ago 30)
  on "$E2E_A" "tailscale down" >>"$RES/$CUR.log" 2>&1 || bad "tailscale down failed"
  wait_for 120 "the agent to report Tailscale stopped" ts_state_is Stopped || bad "the agent did not report Tailscale stopped: $(ts_brief)"
  wait_for 120 "the panel to count the tailnet as failing" tailnet_down_since || true
  settings_json_set tailscaleSeen '$.downSince' "$(($(now_ms) - 360000))" || bad "could not backdate the tailnet's failing reports"
  t=$SECONDS
  if wait_for 240 "IP access to reopen by itself" pa_open; then
    good "with Tailscale stopped on A for 5 minutes (backdated), IP access reopened by itself after $((SECONDS - t))s"
  else
    bad "IP access did not reopen with Tailscale stopped: $(pa_brief)"
    return 1
  fi
  st=$(panel_access)
  echo "    settings.panelAccess after the reopen: $(echo "$st" | jq -c '{serveOnIp, openReason, actual, privatePaths}')" >>"$RES/$CUR.log"
  expect "the tailnet counts as not working and Serve on IP address stays off" \
    jq_ok "$st" '(.serveOnIp | not) and ([.privatePaths[] | select(.kind == "tailnet" and (.working | not))] | length == 1)'
  expect "a security_change alert says IP access reopened" security_alert "IP access reopened" "$since"
  on "$E2E_A" "$P40_UP" >>"$RES/$CUR.log" 2>&1 || bad "tailscale up on A again failed"
  wait_for 150 "the tailnet working again" tailnet_working || bad "the tailnet did not work again: $(ts_brief)"
  wait_for 120 "a time to close again" pa_recloses || true
  expect "with the tailnet back, IP access stays open for an hour first (reclosesAt $(panel_access | jq -r .reclosesAt))" pa_recloses
  settings_json_set panelIpAccessApplied '$.reopenedAt' "$(($(now_ms) - 3660000))" || bad "could not backdate the reopen"
  settings_json_set tailscaleSeen '$.workingSince' "$(($(now_ms) - 3660000))" || bad "could not backdate the tailnet's working time"
  t=$SECONDS
  if wait_for 240 "IP access to close again" pa_closed; then
    good "an hour (backdated) after the tailnet worked again, IP access closed again by itself after $((SECONDS - t))s"
  else
    bad "IP access did not close again: $(pa_brief)"
  fi

  # 11. The recovery commands on the server.
  out=$(on "$E2E_A" "systemctl stop $SLUG.service; $SLUG panel tailscale status 2>&1; rc=\$?; systemctl start $SLUG.service; exit \$rc") && s=0 || s=$?
  printf '%s\n' "$out" >>"$RES/$CUR.log"
  ev "seylo panel tailscale status with the agent stopped (exit $s): $(printf '%s' "$out" | tr -s ' \n' ' ' | head -c 400)"
  expect "seylo panel tailscale status works with the agent stopped" test "$s" = 0
  expect "it shows Tailscale running" grep -qE '^State[[:space:]]+Running' <<<"$out"
  expect "it shows the panel's entry ($(printf '%s' "$out" | grep '^Panel entry' | tr -s ' ' || true))" \
    grep -qE "^Panel entry[[:space:]]+http://$P40_DNS -> unix:.*/panel/tailnet\.sock" <<<"$out"
  wait_for 120 "A's agent connected" p31_connected a || true
  out=$(on "$E2E_A" "$SLUG panel ip-access on" 2>&1) || bad "seylo panel ip-access on failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  ev "seylo panel ip-access on: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  t=$SECONDS
  if wait_for 300 "IP access open again" pa_open; then
    good "seylo panel ip-access on opened http://$ip_a:$port again after $((SECONDS - t))s"
  else
    bad "seylo panel ip-access on did not open IP access: $(pa_brief)"
  fi
  expect "Serve on IP address is on again" jq_ok "$(panel_access)" '.serveOnIp and .onFailure == "reopen"'
  out=$(on "$E2E_A" "$SLUG panel tailscale off" 2>&1) || bad "seylo panel tailscale off failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  ev "seylo panel tailscale off: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  expect "seylo panel tailscale off removed the panel's entry" fails entry_ours
  wait_for 120 "the panel to see Tailscale off on the server" ts_disabled true || true
  expect "tailscale.get says it is off on the server (disabledOnServer)" ts_disabled true
  out=$(on "$E2E_A" "$SLUG panel status 2>&1" || true)
  expect "seylo panel status says the tailnet is off on this server" grep -qF 'Tailnet: off on this server' <<<"$out"
  reauth "$ipjar"
  expect "turning Serve on is refused while it is off on the server (disabledOnServer)" \
    refused_with disabledOnServer sess "$ipjar" "$(panel_url)" tailscale.setServe '{"serve":true}'
  out=$(on "$E2E_A" "$SLUG panel tailscale on" 2>&1) || bad "seylo panel tailscale on failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  t=$SECONDS
  if wait_for 150 "the panel's entry back" entry_ours; then
    good "seylo panel tailscale on: the agent put the panel's entry back after $((SECONDS - t))s"
  else
    bad "the panel's entry did not come back after seylo panel tailscale on: $(ts_brief)"
  fi
  wait_for 120 "Serve active" ts_serving || true
  expect "tailscale.get: Serve active again and not off on the server ($(ts_brief))" ts_serving_again
}

# p40_cleanup: Serve off, IP access open, the agent's no_tailnet gone,
# tailscaled gone from A and C, no Headscale nodes; works from any point
# check 40 stopped at.
p40_cleanup() {
  local s
  on_node c "rm -f $P40_JAR.jar $P40_JAR.key $P40_JAR.hdr /root/e2e-p40-loop.txt; systemctl stop e2e-p40-loop >/dev/null 2>&1; true" || true
  api_loop tailscale.setServe '{"serve":false,"reopenIpAccess":true}' >/dev/null 2>>"$RES/$CUR.log" || ev "cleanup: tailscale.setServe {serve: false} failed"
  ip_access_reset
  if on "$E2E_A" "grep -q '^no_tailnet:' $BRAND_DATA_DIR/config.yml" 2>/dev/null; then
    on "$E2E_A" "$SLUG panel tailscale on" >>"$RES/$CUR.log" 2>&1 || bad "cleanup: seylo panel tailscale on failed"
    wait_for 90 "A's agent back" p31_connected a || true
  fi
  if [ "$(state_get p40-ts-a)" = yes ]; then
    ts_remove a || bad "cleanup: could not remove tailscaled from A"
    rm -f "$E2E_STATE/p40-ts-a"
  fi
  if [ "$(state_get p40-ts-c)" = yes ]; then
    ts_remove c || bad "cleanup: could not remove tailscaled from C"
    rm -f "$E2E_STATE/p40-ts-c"
  fi
  if hs_running 2>/dev/null; then
    for s in $(hs nodes list -o json 2>/dev/null | jq -r '.[]?.id' 2>/dev/null); do hs nodes delete -i "$s" --force >/dev/null 2>&1 || true; done
  fi
  rm -f "$E2E_STATE/p40-ip-cookies" "$E2E_STATE/p40-ip-cookies.key"
  wait_for 120 "the panel to see no Tailscale" ts_detected false || true
  expect "cleanup: tailscale.get shows no Tailscale on the panel server ($(ts_brief))" ts_detected false
  expect "cleanup: Serve is off in the panel" jq_ok "$(ts_get)" '.serve.wanted | not'
  expect "cleanup: IP access is open (http://$(node_ip a):$E2E_PORT answers)" pa_open
  wait_for 120 "3 online nodes" online_ge 3 || true
  expect "cleanup: 3 nodes online" online_ge 3
}

# ---------------------------------------------------------------- main

# The whole file is read before main runs, so editing it during a run is safe.
# ---------------------------------------------------------------- 41 move the panel to another node

# Check 41 (0.2.8): the owner moves the panel from A to B in the browser
# (panelMove.start with a fresh sign-in). Everything comes along: the
# panel's database, master.key and the agents' TLS key (nodes keep their
# pin), the image registry, the API key and the owner's sign-in. Every node
# follows by itself to its staged address: A and C to https://B:<agents'
# port>, B to its own loopback. A failed move (C's agents' port held by
# something else) rolls back with the panel still on B. Then it moves back
# to A, and each old copy is deleted. Runs before the domain check, which
# needs the panel on A.

p41_url() { echo "http://$(node_ip "$1"):$E2E_PORT"; }
p41_version() { curl -fsS -m 5 "$(p41_url "$1")/api/health" 2>/dev/null | jq -r '.version // empty'; }
p41_answers() { [ -n "$(p41_version "$1")" ]; }
p41_gone() { ! curl -s -m 5 -o /dev/null "$(p41_url "$1")/api/health"; }
# p41_running <letter>: a running panel container on that VM.
p41_running() { [ -n "$(on_node "$1" "docker ps -q --filter label=$SLUG.service=panel00000000000 | head -1")" ]; }
p41_conn() { p31_conn "$1" | tr '\n' ' '; }
p41_keys() { on_node "$1" "sha256sum $BRAND_DATA_DIR/panel/master.key $BRAND_DATA_DIR/panel/agent-tls.key 2>/dev/null | cut -c1-64 | tr '\n' ' '"; }
p41_repos() { on_node "$1" "ls $BRAND_DATA_DIR/registry/docker/registry/v2/repositories 2>/dev/null | wc -l" | tr -d ' '; }
p41_panel_node() { api nodes.list | jq -r '.nodes[] | select(.isPanelNode) | .id'; }
p41_status() { sess_get "$E2E_STATE/cookies" "$(panel_url)" panelMove.status 2>/dev/null; }
p41_facts() { # counts that must survive the move
  printf '%s|%s|%s' "$(api projects.list | jq '[.projects[].serviceCount] | add')" \
    "$(api settings.telemetry | jq -r .installId)" "$(api nodes.list | jq '.nodes | length')"
}

# p41_move <from letter> <to letter>: the owner moves the panel; returns when the
# moved panel answers on <to> and the old one is gone, or fails.
p41_move() {
  local from=$1 to=$2 nto out st t
  nto=$(node_id "$to")
  owner_session || { bad "the owner could not sign in on $(panel_url)"; return 1; }
  out=$(sess_get "$E2E_STATE/cookies" "$(panel_url)" panelMove.check) || out='{}'
  ev "panelMove.check on $(panel_url): $(printf '%s' "$out" | jq -c '{blocks: [.blocks[]? | {code, nodeIds}], targets: [.targets[]? | {name, ready}], defaultAddress, nodesLeftBehind}' 2>/dev/null)"
  reauth "$E2E_STATE/cookies"
  out=$(session_op panelMove.start "$(jq -nc --arg n "$nto" '{targetNodeId: $n}')")
  ev "panelMove.start to $to: $(printf '%s' "$out" | head -c 400)"
  printf '%s' "$out" | jq -e '.state == "running"' >/dev/null || { bad "panelMove.start to $to did not start: $(printf '%s' "$out" | head -c 300)"; return 1; }
  t=$SECONDS
  while [ $((SECONDS - t)) -lt 900 ]; do
    st=$(p41_status | jq -r '.state // empty' 2>/dev/null)
    if [ "$st" = failed ]; then
      bad "the move to $to failed: $(p41_status | jq -c .error)"
      return 1
    fi
    if p41_answers "$to" && p41_gone "$from"; then break; fi
    sleep 3
  done
  p41_answers "$to" && p41_gone "$from" || { bad "the panel did not come up on $to within 15 minutes ($(p41_status | jq -c '{state, step, error}' 2>/dev/null))"; return 1; }
  good "the panel moved from $from to $to in $((SECONDS - t))s (version $(p41_version "$to"))"
  export E2E_PANEL_URL
  E2E_PANEL_URL=$(p41_url "$to")
  state_set p41-panel-on "$to"
}

# p41_followed <panel letter> <pin>: every node dials the moved panel with the same pin.
p41_followed() {
  local at=$1 pin=$2 l want
  for l in a b c; do
    if [ "$l" = "$at" ]; then want="https://127.0.0.1:$P41_TLS_PORT"; else want="https://$(node_ip "$at"):$P41_TLS_PORT"; fi
    p31_conn "$l" | grep -qx "panel_url: $want" && p31_conn "$l" | grep -qx "panel_pin: $pin" || return 1
  done
}

# p41_online_ge <n>: nodes online on the panel wherever it runs now (api_loop always asks A's loopback).
p41_online_ge() { [ "$(api nodes.list | jq '[.nodes[] | select(.status=="online")] | length')" -ge "$1" ] 2>/dev/null; }

p41_assert_moved() { # <from> <to> <facts before> <keys before> <repos before>
  local from=$1 to=$2 facts=$3 keys=$4 repos=$5
  wait_for 240 "3 nodes online on the moved panel" p41_online_ge 3 || true
  expect "3 nodes online on the panel on $to ($(api nodes.list | jq -c '[.nodes[] | {name, status}]'))" p41_online_ge 3
  expect "$to is the panel node" test "$(p41_panel_node)" = "$(node_id "$to")"
  expect "the panel on $from no longer answers" p41_gone "$from"
  expect "no panel container runs on $from" fails p41_running "$from"
  expect "the panel container on $to runs as the panel user with a private folder" panel_user_ok "$(vm_of "$to")"
  wait_for 120 "every node on the new address" p41_followed "$to" "$P41_PIN" || true
  expect "every node dials the moved panel with the same pin (a: $(p41_conn a); b: $(p41_conn b); c: $(p41_conn c))" p41_followed "$to" "$P41_PIN"
  expect "the API key, projects, services, nodes and the install id came along ($(p41_facts))" test "$(p41_facts)" = "$facts"
  expect "master.key and the agents' TLS key are the same files on $to" test "$(p41_keys "$to")" = "$keys"
  expect "the image registry came along ($(p41_repos "$to") repositories, $repos before)" test "$(p41_repos "$to")" -ge "$repos"
  expect "the owner signs in on the moved panel" owner_session
  expect "panelMove.status on the moved panel says done, from $from" jq_ok "$(p41_status)" --arg f "$(node_id "$from")" '.state == "done" and .fromNodeId == $f'
}

p41_cleanup() {
  local on
  on=$(state_get p41-panel-on)
  relay_stop "$E2E_C" e2e-p41-hold
  relay_stop "$E2E_C" e2e-p41-regc
  if [ -n "$on" ] && [ "$on" != a ]; then
    ev "cleanup: the panel is still on $on; moving it back to A"
    export E2E_PANEL_URL
    E2E_PANEL_URL=$(p41_url "$on")
    p41_move "$on" a || bad "cleanup: moving the panel back to A failed"
  fi
  unset E2E_PANEL_URL
  relay_stop "$E2E_B" e2e-p41-reg
  relay_stop "$E2E_A" e2e-p41-fwd
  rm -f "$E2E_STATE/p41-panel-on"
  wait_for 180 "3 nodes online" p41_online_ge 3 || bad "cleanup: not every node is back online"
}

check_41() {
  need_key || return 3
  local rc=0
  if [ -n "$(state_get p41-panel-on)" ]; then
    ev "an earlier run of this check stopped half way; putting things back first"
    p41_cleanup
  fi
  p41_run || rc=$?
  p41_cleanup
  return "$rc"
}

P41_TLS_PORT=
P41_PIN=
p41_run() {
  local facts keys repos out t
  [ -n "$(node_id b)" ] && [ -n "$(node_id c)" ] || { blocked "B and C are not joined (check 3)"; return 3; }
  [ -s "$E2E_STATE/owner" ] || { blocked "no owner credentials (check 2)"; return 3; }
  op_is_query panelMove.status || { blocked "this build has no panelMove ops"; return 3; }
  [ "$(api settings.general | jq -r .domain)" = null ] || { blocked "the panel has a domain; check $CUR starts from IP:port"; return 3; }
  ip_access_reset
  P41_TLS_PORT=$(p31_conn b | sed -n 's#^panel_url: https://[^/]*:\([0-9][0-9]*\).*#\1#p')
  P41_PIN=$(p31_conn b | sed -n 's#^panel_pin: ##p')
  [ -n "$P41_TLS_PORT" ] && [ -n "$P41_PIN" ] || { blocked "B does not dial the agents' TLS port with a pin ($(p41_conn b))"; return 3; }
  # B and C pull the panel image the e2e registry on A serves at 127.0.0.1:$E2E_REG_PORT.
  relay_start "$E2E_A" "$(node_ip a)" 15012 127.0.0.1 "$E2E_REG_PORT" e2e-p41-fwd || { bad "registry relay on A failed"; return 1; }
  relay_start "$E2E_B" 127.0.0.1 "$E2E_REG_PORT" "$(node_ip a)" 15012 e2e-p41-reg || { bad "registry relay on B failed"; return 1; }
  facts=$(p41_facts)
  keys=$(p41_keys a)
  repos=$(p41_repos a)
  ev "before: facts $facts, keys $keys, $repos registry repositories, a: $(p41_conn a); b: $(p41_conn b); c: $(p41_conn c)"

  # Refused without a browser session and the owner.
  expect "an API key cannot start a move" fails api panelMove.start "$(jq -nc --arg n "$(node_id b)" '{targetNodeId: $n}')"

  # A -> B.
  p41_move a b || return 1
  p41_assert_moved a b "$facts" "$keys" "$repos"
  out=$(api nodes.createJoinToken '{"name":"p41-check"}' 2>/dev/null || true)
  [ -z "$out" ] || expect "Add node's command now names B with the same pin" sh -c "printf '%s' '$out' | grep -q '$(node_ip b)' && printf '%s' '$out' | grep -q '$P41_PIN'"
  reauth "$E2E_STATE/cookies"
  out=$(session_op panelMove.removeOldCopy '{}')
  ev "panelMove.removeOldCopy: $(printf '%s' "$out" | head -c 300)"
  expect "the old copy on A is gone (no master.key, no panel container)" on "$E2E_A" "test ! -e $BRAND_DATA_DIR/panel/master.key && [ -z \"\$(docker ps -aq --filter label=$SLUG.service=panel00000000000)\" ]"

  # A failed move rolls back: something else holds C's agents' port.
  relay_start "$E2E_C" 127.0.0.1 "$E2E_REG_PORT" "$(node_ip a)" 15012 e2e-p41-regc || { bad "registry relay on C failed"; return 1; }
  relay_start "$E2E_C" 0.0.0.0 "$P41_TLS_PORT" 127.0.0.1 9 e2e-p41-hold || true
  owner_session
  reauth "$E2E_STATE/cookies"
  out=$(session_op panelMove.start "$(jq -nc --arg n "$(node_id c)" '{targetNodeId: $n}')")
  ev "panelMove.start to C with its port held: $(printf '%s' "$out" | head -c 300)"
  t=$SECONDS
  while [ $((SECONDS - t)) -lt 600 ]; do
    case $(p41_status | jq -r '.state // empty') in failed | idle) break ;; esac
    sleep 3
  done
  ev "status after the refused move: $(p41_status | jq -c '{state, step, error}')"
  expect "the move to C failed and rolled back" jq_ok "$(p41_status)" '.state == "failed" and .error != null'
  expect "it failed starting the panel on C (the held port), not pulling its image" jq_ok "$(p41_status)" '.error.step == "starting" and (.error.message | test("pull"; "i") | not)'
  expect "the panel still answers on B" p41_answers b
  expect "C holds no copy of the panel (no master.key)" fails on "$E2E_C" "test -e $BRAND_DATA_DIR/panel/master.key"
  expect "every node still dials B with the same pin" p41_followed b "$P41_PIN"
  expect "the panel on B takes changes again after the rollback" api settings.updateGeneral '{"name":"Seylo"}'
  relay_stop "$E2E_C" e2e-p41-hold

  # B -> A, and B's old copy goes.
  facts=$(p41_facts)
  keys=$(p41_keys b)
  repos=$(p41_repos b)
  relay_stop "$E2E_B" e2e-p41-reg
  p41_move b a || return 1
  p41_assert_moved b a "$facts" "$keys" "$repos"
  reauth "$E2E_STATE/cookies"
  out=$(session_op panelMove.removeOldCopy '{}')
  expect "the old copy on B is gone" on "$E2E_B" "test ! -e $BRAND_DATA_DIR/panel/master.key && [ -z \"\$(docker ps -aq --filter label=$SLUG.service=panel00000000000)\" ]"
  rm -f "$E2E_STATE/p41-panel-on"
}

main() {
  if [ "${1:-}" = report ]; then
    write_report
    return 0
  fi
  local list n
  vm_routes
  list=${*:-$(seq 1 "$LAST" | grep -vx "$DOMAIN_CHECK") $DOMAIN_CHECK}
  for n in $list; do
    run_check "$n"
    write_report 2>/dev/null
  done
  write_report
}
main "$@"; exit $?
