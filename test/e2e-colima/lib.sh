# shellcheck shell=bash
# Shared helpers for the three-VM end-to-end test. Sourced by the other
# scripts in this folder; not run on its own.
#
#   A  seylo-e2e-a  Colima VM with Docker: "panel + node here", can build,
#                   also hosts the e2e infrastructure containers (a registry
#                   for the panel images, MinIO, Pebble, Headscale), all unlabeled
#   B  seylo-e2e-b  Colima VM with Docker: joined node
#   C  seylo-e2e-c  plain Lima Ubuntu 24.04 VM WITHOUT Docker: install.sh
#                   installs Docker (systemd cgroup driver) when it joins
#
# All three sit on the macOS vzNAT network (192.168.64.0/24) and reach the
# Mac at its bridge address, where serve.sh runs the release server (binaries,
# install.sh, signed manifests in GitHub's release layout) and a dumb-HTTP
# git server with the test apps under apps/.
#
# These scripts create and delete their VMs, so they only take profiles named
# seylo-e2e-*: never point them at a VM you use for anything else (such as
# the dev VM seylo-a). extra-installs.sh adds two more plain Lima VMs for a
# while, named seylo-x-deb and seylo-x-ufw only.

set -euo pipefail

E2E_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
E2E_ROOT=$(git -C "$E2E_DIR" rev-parse --show-toplevel)
E2E_A=${E2E_A:-seylo-e2e-a}
E2E_B=${E2E_B:-seylo-e2e-b}
E2E_C=${E2E_C:-seylo-e2e-c}
E2E_PORT=${E2E_PORT:-3000}
# Release server on the Mac (python3 http.server on the vzNAT bridge).
E2E_REL_PORT=${E2E_REL_PORT:-18555}
# Registry for the panel images, a container on A (127.0.0.1 is trusted by Docker).
E2E_REG_PORT=${E2E_REG_PORT:-15000}
# Release versions, all built from the working tree: N is installed, N+1 is
# the update, N+2 has a broken panel. E2E_BASE is the released version the
# upgrade check (38) starts from, built from its git tag (build.sh base).
E2E_V1=${E2E_V1:-0.2.0}
E2E_V2=${E2E_V2:-0.2.1}
E2E_V3=${E2E_V3:-0.2.2}
E2E_BASE=${E2E_BASE:-0.1.1}
# Build output and state shared between the steps. Outside dist/, which
# goreleaser --clean wipes.
E2E_OUT=${E2E_OUT:-$HOME/.cache/seylo-e2e}
E2E_REL=$E2E_OUT/release
E2E_STATE=$E2E_OUT/state
E2E_KEYS=$E2E_DIR/keys
# Tailscale for check 40: the static release, which serve.sh fetches once
# from pkgs.tailscale.com, checks against these sha256 sums and serves at
# <release server>/e2e-tools/ (A and C install it from there).
E2E_TS_VERSION=${E2E_TS_VERSION:-1.104.5}
# Headscale for check 40 (infra.sh): HTTPS on <A>:$E2E_HS_PORT with a
# certificate from serve.sh's test CA, its own DERP and STUN on 3478/udp.
E2E_HS_PORT=${E2E_HS_PORT:-18443}
E2E_HS_DOMAIN=${E2E_HS_DOMAIN:-ts.e2e.test}

# shellcheck disable=SC1091
set -a && . "$E2E_ROOT/installer/brand.env" && set +a
SLUG=$BRAND_SLUG
# The Go module path (go/go.mod), for -X linker flags.
GO_MODULE=$(sed -n 's/^module //p' "$E2E_ROOT/go/go.mod")

for p in "$E2E_A" "$E2E_B" "$E2E_C"; do
  case $p in
  seylo-e2e-*) ;;
  *) echo "e2e: refusing to use the VM $p (e2e VMs are created and deleted here, so their names start with seylo-e2e-)" >&2; exit 2 ;;
  esac
done

log() { printf '\n[e2e %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
fail() { printf '\n[e2e] FAIL: %s\n' "$*" >&2; exit 1; }

# vm_arch prints the Go architecture of the VMs (the host's).
vm_arch() {
  case $(uname -m) in
  arm64 | aarch64) echo arm64 ;;
  *) echo amd64 ;;
  esac
}

# is_lima <vm>: a plain Lima VM (C, and extra-installs.sh's VMs), not Colima.
is_lima() {
  case $1 in
  "$E2E_C" | seylo-x-deb | seylo-x-ufw) return 0 ;;
  esac
  return 1
}

# e2e_ts_file: the Tailscale tarball for the VMs' architecture.
e2e_ts_file() { echo "tailscale_${E2E_TS_VERSION}_$(vm_arch).tgz"; }
# e2e_ts_sha256: its published sha256 (pkgs.tailscale.com/stable/<file>.sha256); empty for a version not listed here.
e2e_ts_sha256() {
  case $E2E_TS_VERSION-$(vm_arch) in
  1.104.5-arm64) echo e900b0e6e25023a1e504b2c237ce2a32ea0535e006f8c1a1097a490886493b6c ;;
  1.104.5-amd64) echo 720cbbccbfc03d8b55df72afc19e5a72e31b0f65934700aa6fa38074d4ad7bf7 ;;
  esac
}

# on <vm> <command...>: run a shell command as root in a VM (stdin passes through).
on() {
  local vm=$1
  shift
  if is_lima "$vm"; then
    limactl shell --workdir / "$vm" -- sudo bash -c "$*"
  else
    colima ssh -p "$vm" -- sudo bash -c "cd / && $*"
  fi
}

# vm_ip <vm>: the VM's address on the vzNAT network (cached in state/).
vm_ip() {
  local vm=$1 f=$E2E_STATE/ip-$1 ip
  if [ -s "$f" ]; then
    cat "$f"
    return
  fi
  if is_lima "$vm"; then
    ip=$(limactl shell --workdir / "$vm" -- ip -4 -o addr show 2>/dev/null |
      awk '{print $4}' | cut -d/ -f1 | grep '^192\.168\.64\.' | head -1 || true)
  else
    ip=$(colima ls -p "$vm" -j 2>/dev/null | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')
  fi
  [ -n "$ip" ] || return 1
  mkdir -p "$E2E_STATE"
  printf '%s\n' "$ip" >"$f"
  printf '%s\n' "$ip"
}

# host_ip: the Mac's address as the VMs see it (the vzNAT bridge).
host_ip() {
  local f=$E2E_STATE/ip-host ip
  if [ -s "$f" ]; then
    cat "$f"
    return
  fi
  ip=$(ifconfig 2>/dev/null | awk '/^[a-z]/{b=($1 ~ /^bridge/)} b && /inet 192\.168\.64\./{print $2; exit}')
  [ -n "$ip" ] || ip=192.168.64.1
  mkdir -p "$E2E_STATE"
  printf '%s\n' "$ip" >"$f"
  printf '%s\n' "$ip"
}

# vm_routes: re-adds the routes between the VMs (up.sh's e2e-routes) on each
# VM, in case a systemd-networkd restart dropped them on a VM up.sh set up
# before it kept them (networkd.conf.d/e2e-keep-routes.conf).
vm_routes() {
  local vm
  for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
    on "$vm" "[ ! -x /usr/local/sbin/e2e-routes ] || /usr/local/sbin/e2e-routes" >/dev/null 2>&1 || true
  done
}
release_base() { echo "http://$(host_ip):$E2E_REL_PORT"; }

# docker_a/docker_b: the Docker CLI against VM A/B (never the default context).
docker_a() { DOCKER_HOST="unix://$HOME/.colima/$E2E_A/docker.sock" docker "$@"; }
docker_b() { DOCKER_HOST="unix://$HOME/.colima/$E2E_B/docker.sock" docker "$@"; }

# panel_url: A's panel; E2E_PANEL_URL points api() at another one (check 38's panel on C).
panel_url() { echo "${E2E_PANEL_URL:-http://$(vm_ip "$E2E_A"):$E2E_PORT}"; }

# api <op> [json]: call a panel op with the e2e API key. Queries (GET) take
# a JSON object that becomes the query string. Prints the body; returns 1 on
# an HTTP error (op, status and body go to stderr). API_KEY overrides the key.
# While IP access is closed, api_loop (checks.sh) reaches the panel from A.
api() {
  local op=$1 body=${2:-'{}'} key=${API_KEY:-}
  [ -n "$key" ] || key=$(state_get api-key)
  local url out code
  url="$(panel_url)/api/v1/$op"
  out=$(mktemp)
  if op_is_query "$op"; then
    local qs
    qs=$(query_string "$body")
    code=$(curl -sS -m 120 -o "$out" -w '%{http_code}' -H "authorization: Bearer $key" "$url?$qs") || code=000
  else
    code=$(curl -sS -m 300 -o "$out" -w '%{http_code}' -H "authorization: Bearer $key" -H 'content-type: application/json' \
      -X POST --data "$body" "$url") || code=000
  fi
  if [ "${code:0:1}" != 2 ]; then
    printf '  api %s %s -> %s %s\n' "$op" "$(printf '%s' "$body" | head -c 300)" "$code" "$(head -c 800 "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

# panel_migrations: how many migrations this working tree's panel has (the
# drizzle journal), so as many rows as an up-to-date panel.db records in
# __drizzle_migrations (check 38 after the upgrade).
panel_migrations() { jq '.entries | length' "$E2E_ROOT/apps/panel/drizzle/panel/meta/_journal.json"; }

# op_is_query <op>: GET route in openapi.json.
op_is_query() {
  jq -e --arg p "/api/v1/$1" '.paths[$p].get != null' "$E2E_ROOT/openapi.json" >/dev/null
}

# query_string <json object>: the object as a query string, as GET op routes take it.
query_string() {
  printf '%s' "$1" | jq -r 'to_entries | map("\(.key|@uri)=\(.value|if type=="string" then . else tojson end|@uri)") | join("&")'
}

# A TCP relay as a transient systemd unit, for a VM that has to pull the
# panel images pinned as 127.0.0.1:$E2E_REG_PORT/... (the registry on A):
# one relay on A serves that registry on A's address, one on the VM serves
# it at the VM's own 127.0.0.1:$E2E_REG_PORT (Docker trusts plain HTTP on
# 127.0.0.0/8). Check 38 and extra-installs.sh use them.
fwd_py='import socket, sys, threading
lh, lp, rh, rp = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
def handle(c):
    try:
        r = socket.create_connection((rh, rp), timeout=10)
        r.settimeout(None)
    except OSError:
        c.close()
        return
    threading.Thread(target=pipe, args=(c, r), daemon=True).start()
    threading.Thread(target=pipe, args=(r, c), daemon=True).start()
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((lh, lp))
s.listen(64)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
'
E2E_FWD_PORT=${E2E_FWD_PORT:-15002}
relay_start() { # vm listen-host listen-port remote-host remote-port [unit]
  local unit=${6:-e2e-regfwd}
  printf '%s' "$fwd_py" | on "$1" "cat >/root/$unit.py && (systemctl stop $unit >/dev/null 2>&1; systemctl reset-failed $unit >/dev/null 2>&1; true) &&
    systemd-run --unit=$unit --collect python3 /root/$unit.py $2 $3 $4 $5 >/dev/null"
}
relay_stop() { # vm [unit]
  local unit=${2:-e2e-regfwd}
  on "$1" "systemctl stop $unit >/dev/null 2>&1; rm -f /root/$unit.py /root/e2e-fwd.py; true"
}

# wait_for <seconds> <description> <command...>: retry until it succeeds.
# Returns 1 (does not exit) on a timeout, so checks can record a FAIL.
wait_for() {
  local secs=$1 what=$2
  shift 2
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    if [ $SECONDS -ge $end ]; then
      printf '  timed out after %ss waiting for %s\n' "$secs" "$what" >&2
      return 1
    fi
    sleep 2
  done
}

state_get() { cat "$E2E_STATE/$1" 2>/dev/null || true; }
state_set() { mkdir -p "$E2E_STATE" && printf '%s\n' "$2" >"$E2E_STATE/$1"; }
