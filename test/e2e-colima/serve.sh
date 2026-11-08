#!/usr/bin/env bash
# Starts (or restarts) the release and git servers on the Mac, on the vzNAT
# bridge address, both serving dist/e2e/release (build.sh fills it):
#
#   http://<mac>:18555   release server in GitHub's layout:
#     /<org>/<repo>/releases/download/v<version>/<asset>   binaries, checksums, install.sh, manifest
#     /<org>/<repo>/releases/latest/download/<asset>       the published "latest" (publish.sh)
#     /repos/<org>/<repo>/releases/latest                  GitHub API shape (assets[].browser_download_url)
#     /install.sh                                          latest installer
#   https://<mac>:18556  the same files over TLS; the panel takes only https://
#     git URLs, so the build checks clone /git/<app>.git (dumb HTTP) from here.
#     The certificate comes from a test-only CA that this script adds to each
#     VM's trust store.
#   /e2e-tools/tailscale_<version>_<arch>.tgz  Tailscale's static release for
#     check 40, fetched once from pkgs.tailscale.com and checked against the
#     sha256 in lib.sh.
#
# Usage: test/e2e-colima/serve.sh [stop]
source "$(dirname "$0")/lib.sh"

E2E_GIT_PORT=${E2E_GIT_PORT:-18556}
tls=$E2E_STATE/tls

stop_one() {
  local pidfile=$E2E_STATE/$1.pid
  if [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" || true
    sleep 0.5
  fi
  rm -f "$pidfile"
}
stop_one serve
stop_one serve-tls
[ "${1:-}" = stop ] && exit 0

mkdir -p "$E2E_REL" "$tls"
if [ ! -s "$tls/server.crt" ]; then
  log "creating the test-only CA and the git server certificate for $(host_ip)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=seylo e2e TEST-ONLY CA" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$(host_ip)" -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "$(host_ip)" >"$tls/ext.cnf"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
    -days 30 -extfile "$tls/ext.cnf" -out "$tls/server.crt" 2>/dev/null
fi

ts_file=$(e2e_ts_file)
if [ ! -s "$E2E_REL/e2e-tools/$ts_file" ]; then
  ts_sha=$(e2e_ts_sha256)
  if [ -z "$ts_sha" ]; then
    log "note: lib.sh has no sha256 for Tailscale $E2E_TS_VERSION, so it is not fetched and check 40 is BLOCKED"
  else
    log "fetching $ts_file for check 40"
    mkdir -p "$E2E_REL/e2e-tools"
    if curl -fsSL -o "$E2E_REL/e2e-tools/$ts_file.part" "https://pkgs.tailscale.com/stable/$ts_file" &&
      [ "$(shasum -a 256 "$E2E_REL/e2e-tools/$ts_file.part" | cut -d' ' -f1)" = "$ts_sha" ]; then
      mv "$E2E_REL/e2e-tools/$ts_file.part" "$E2E_REL/e2e-tools/$ts_file"
    else
      rm -f "$E2E_REL/e2e-tools/$ts_file.part"
      log "note: could not fetch $ts_file with sha256 $ts_sha, so check 40 is BLOCKED"
    fi
  fi
fi

nohup python3 -I -m http.server "$E2E_REL_PORT" --bind "$(host_ip)" --directory "$E2E_REL" \
  >"$E2E_STATE/serve.log" 2>&1 &
echo $! >"$E2E_STATE/serve.pid"
nohup python3 -I "$E2E_DIR/httpsd.py" "$(host_ip)" "$E2E_GIT_PORT" "$E2E_REL" "$tls/server.crt" "$tls/server.key" \
  >"$E2E_STATE/serve-tls.log" 2>&1 &
echo $! >"$E2E_STATE/serve-tls.pid"
wait_for 20 "the release server" curl -fsS -o /dev/null "$(release_base)/" || fail "release server did not start"
wait_for 20 "the git server" curl -fsS --cacert "$tls/ca.crt" -o /dev/null "https://$(host_ip):$E2E_GIT_PORT/" ||
  fail "git server did not start"

for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
  on "$vm" "cat >/usr/local/share/ca-certificates/seylo-e2e-test-ca.crt && update-ca-certificates >/dev/null 2>&1" <"$tls/ca.crt"
  on "$vm" "curl -fsS -m 5 -o /dev/null $(release_base)/ && curl -fsS -m 5 -o /dev/null https://$(host_ip):$E2E_GIT_PORT/" ||
    fail "$vm cannot reach the release or git server"
done
state_set git-base "https://$(host_ip):$E2E_GIT_PORT/git"
log "release server $(release_base), git server https://$(host_ip):$E2E_GIT_PORT/git: reachable from all VMs (CA trusted)"
