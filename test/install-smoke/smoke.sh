#!/usr/bin/env bash
# Sets up a freshly installed panel through its API and checks that it
# deploys: the owner from the setup link, an API key, a project, a
# traefik/whoami service from Docker Hub, live, answering on its IP:port.
# Needs curl and jq. The GitHub install smoke test
# (.github/workflows/install-smoke.yml) runs it on the runner after
# install.sh; test/e2e-colima/extra-installs.sh runs it from the Mac against
# its VMs.
#
# Usage: test/install-smoke/smoke.sh --panel-url URL [options]
#   --panel-url URL     the panel, for example http://127.0.0.1:3000
#   --token TOKEN       the setup token (the t= of the setup link)
#   --install-log FILE  read the setup link from the installer's output
#                       (without --token or --install-log, or when the log
#                       has no link: sudo seylo panel setup-link here)
#   --reach HOST        where to curl the service's port (default: the host
#                       the panel shows when it is an IP address, else the
#                       panel URL's host)
#   --no-reach          only print the address; the caller checks it
#
# Prints address=<host:port> and firewall_hint=<command or empty> on stdout
# at the end; progress goes to stderr. Exits 1 on the first failure.
set -euo pipefail

PANEL_URL=
TOKEN=
INSTALL_LOG=
REACH=
NO_REACH=
IMAGE=traefik/whoami:v1.10.3
SLUG=seylo
brand_env=$(cd "$(dirname "$0")/../.." && pwd)/installer/brand.env
if [ -f "$brand_env" ]; then
  SLUG=$(sed -n "s/^BRAND_SLUG='\(.*\)'$/\1/p" "$brand_env")
fi

while [ $# -gt 0 ]; do
  case $1 in
  --panel-url) PANEL_URL=${2%/}; shift ;;
  --token) TOKEN=$2; shift ;;
  --install-log) INSTALL_LOG=$2; shift ;;
  --reach) REACH=$2; shift ;;
  --no-reach) NO_REACH=1 ;;
  -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "smoke: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$PANEL_URL" ] || { echo "smoke: --panel-url is required" >&2; exit 2; }

step() { printf '\n==> %s\n' "$*" >&2; }
ok() { printf 'ok   %s\n' "$*" >&2; }
die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jar=$work/cookies
SESSION_KEY_HEADER=x-$SLUG-session-key

# wait_for <seconds> <command...>: retry every 3 seconds until it succeeds.
wait_for() {
  local end=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt "$end" ] || return 1
    sleep 3
  done
}

# session <op> <json>: an op as the browser session in the jar, with the
# session key the panel hands out next to the cookie.
session() {
  local key out code
  key=$(cat "$jar.key" 2>/dev/null || true)
  out=$work/out
  code=$(curl -sS -m 60 -c "$jar" -b "$jar" -D "$work/headers" -o "$out" -w '%{http_code}' \
    ${key:+-H "$SESSION_KEY_HEADER: $key"} -H 'content-type: application/json' -H "origin: $PANEL_URL" \
    -X POST --data "$2" "$PANEL_URL/api/v1/$1") || code=000
  key=$(tr -d '\r' <"$work/headers" | grep -i "^$SESSION_KEY_HEADER:" | tail -1 | sed 's/^[^:]*:[[:space:]]*//' || true)
  [ -z "$key" ] || printf '%s\n' "$key" >"$jar.key"
  if [ "${code:0:1}" != 2 ]; then
    printf '  %s -> %s %s\n' "$1" "$code" "$(head -c 400 "$out")" >&2
    return 1
  fi
  cat "$out"
}

# api <op> [json]: an op with the API key; a query (GET) takes its input as the query string.
api() {
  local op=$1 body=${2:-} out code
  out=$work/out
  if [ -z "$body" ]; then
    code=$(curl -sS -m 60 -o "$out" -w '%{http_code}' -H "authorization: Bearer $API_KEY" "$PANEL_URL/api/v1/$op") || code=000
  elif [ "${body:0:1}" = "?" ]; then
    code=$(curl -sS -m 60 -o "$out" -w '%{http_code}' -H "authorization: Bearer $API_KEY" "$PANEL_URL/api/v1/$op$body") || code=000
  else
    code=$(curl -sS -m 300 -o "$out" -w '%{http_code}' -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' \
      -X POST --data "$body" "$PANEL_URL/api/v1/$op") || code=000
  fi
  if [ "${code:0:1}" != 2 ]; then
    printf '  %s -> %s %s\n' "$op" "$code" "$(head -c 400 "$out")" >&2
    return 1
  fi
  cat "$out"
}

link_token() { grep -o 'https\?://[^ ]*/setup?t=[A-Za-z0-9_-]*' | head -1 | sed 's/.*?t=//'; }

step "Panel at $PANEL_URL"
wait_for 180 curl -fsS -m 5 -o /dev/null "$PANEL_URL/api/health" || die "$PANEL_URL/api/health does not answer"
ok "the panel answers: $(curl -fsS -m 5 "$PANEL_URL/api/health")"

if [ -z "$TOKEN" ] && [ -n "$INSTALL_LOG" ]; then
  TOKEN=$(link_token <"$INSTALL_LOG" || true)
  [ -z "$TOKEN" ] || ok "setup link read from the installer's output"
fi
if [ -z "$TOKEN" ]; then
  # A new link (the panel restarts to read it).
  TOKEN=$(sudo "$SLUG" panel setup-link 2>&1 | link_token || true)
  [ -n "$TOKEN" ] || die "no setup link in the installer's output, and sudo $SLUG panel setup-link printed none"
  ok "setup link from sudo $SLUG panel setup-link"
  wait_for 120 curl -fsS -m 5 -o /dev/null "$PANEL_URL/api/health" || die "the panel did not come back after setup-link"
fi

step "Owner and API key"
status=$(curl -fsS -m 30 "$PANEL_URL/api/v1/setup.status?token=$TOKEN") || die "setup.status failed"
[ "$(printf '%s' "$status" | jq -r '.link.valid')" = true ] || die "the setup link is not valid: $(printf '%s' "$status" | jq -c .)"
email=owner@smoke.test
password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
session setup.createOwner "$(jq -nc --arg t "$TOKEN" --arg e "$email" --arg p "$password" '{token: $t, email: $e, name: "Smoke Owner", password: $p}')" >/dev/null ||
  die "setup.createOwner failed"
ok "owner $email created"
session auth.reauth "$(jq -nc --arg p "$password" '{password: $p}')" >/dev/null 2>&1 || true
API_KEY=$(session apiKeys.create '{"kind":"api","name":"smoke","actions":["*"],"readOnly":false,"expiresInDays":1}' | jq -r .token) || die "apiKeys.create failed"
[ -n "$API_KEY" ] && [ "$API_KEY" != null ] || die "apiKeys.create returned no token"
ok "API key created"

step "The panel's node"
panel_node_online() { api nodes.list | jq -e '[.nodes[] | select(.isPanelNode and .status == "online")] | length == 1' >/dev/null; }
wait_for 180 panel_node_online || die "the panel's node is not online: $(api nodes.list | jq -c '[.nodes[] | {name, status}]')"
node=$(api nodes.list | jq -r '.nodes[] | select(.isPanelNode) | .id')
ok "node $(api nodes.list | jq -r '.nodes[] | select(.isPanelNode) | "\(.name), agent \(.agentVersion)"')"
api nodes.runHealthCheck "$(jq -nc --arg n "$node" '{nodeId: $n}')" | jq -r '.results[] | select(.status != "pass" and .status != "skipped") | "  health \(.id): \(.status) \(.detail)"' >&2 || true

step "A project and $IMAGE"
project=$(api projects.create '{"name":"smoke"}' | jq -r '.project.id // .id') || die "projects.create failed"
service=$(api services.create "$(jq -nc --arg p "$project" --arg n "$node" --arg i "$IMAGE" \
  '{projectId: $p, name: "whoami", kind: "app", nodeId: $n, source: {type: "image", image: $i, registryId: null}, ports: [{containerPort: 80, protocol: "tcp"}], deployNow: true}')" |
  jq -r '.service.id // .id') || die "services.create failed"
ok "service whoami ($service) in project smoke ($project)"
deployment=
latest_deployment() {
  deployment=$(api deployments.list "?serviceId=$service&limit=1" | jq -r '.deployments[0].id // empty')
  [ -n "$deployment" ]
}
wait_for 60 latest_deployment || die "no deployment for whoami"
deploy_done() {
  state=$(api deployments.get "?serviceId=$service&deploymentId=$deployment" | jq -r .deployment.status)
  case $state in live | failed | cancelled | superseded) return 0 ;; esac
  return 1
}
state=
wait_for 600 deploy_done || die "the deployment did not finish: $state"
[ "$state" = live ] || die "the deployment ended $state: $(api deployments.get "?serviceId=$service&deploymentId=$deployment" | jq -c '.deployment.error')"
ok "deployment $deployment is live"

step "Its IP:port"
address=
first_run() {
  local e
  e=$(api exposures.get "?serviceId=$service")
  address=$(printf '%s' "$e" | jq -r '.firstRun.address // empty')
  hint=$(printf '%s' "$e" | jq -r '.firstRun.firewallHint // empty')
  [ -n "$address" ]
}
hint=
wait_for 90 first_run || die "whoami has no IP:port address: $(api exposures.get "?serviceId=$service" | jq -c .firstRun)"
host=${address%:*}
port=${address##*:}
case $host in
*[!0-9.]*) [ -n "$REACH" ] || REACH=$(printf '%s' "$PANEL_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##') ;;
*) [ -n "$REACH" ] || REACH=$host ;;
esac
ok "the panel shows $address${hint:+ (firewall: $hint)}"
if [ -z "$NO_REACH" ]; then
  answers() { curl -fsS -m 5 "http://$REACH:$port/" | grep -q '^Hostname:'; }
  wait_for 90 answers || die "http://$REACH:$port/ does not answer like whoami"
  ok "http://$REACH:$port/ answers: $(curl -fsS -m 5 "http://$REACH:$port/" | grep -m1 '^Hostname:')"
fi
printf 'address=%s\nfirewall_hint=%s\n' "$address" "$hint"
