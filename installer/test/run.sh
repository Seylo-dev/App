#!/usr/bin/env bash
# Installer tests: runs the rendered install.sh in --root mode (files land in
# a temporary folder, no system command runs) against a fake release served
# by a curl shim, with docker and systemctl shims. Nothing here touches Docker,
# systemd or the network.
#
# Needs: Go (releasetool writes the real manifest; or RELEASETOOL=<prebuilt
# binary>), minisign (signs the test
# release). Signatures are checked once with minisign and once with OpenSSL 3
# when one is found (openssl in PATH, or Homebrew's openssl@3). The installer
# runs under dash when it is installed (the /bin/sh of Debian and Ubuntu).
#
# Usage: installer/test/run.sh            (make test-installer)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)

if ! command -v minisign >/dev/null 2>&1; then
  echo "installer tests: SKIP (minisign is not installed)"
  exit 0
fi

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# shellcheck disable=SC1091
. "$root/installer/brand.env"
SLUG=$BRAND_SLUG
SH=$(command -v dash || command -v sh)
case $(uname -m) in arm64 | aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
V=0.1.0
REL=$T/release          # served as http://release.test/rel
BASE=http://release.test/rel
IMAGE_REPO=registry.test/$SLUG
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
DIGEST=sha256:$(printf 'panel image' | sha256)

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
  printf 'FAIL %s\n' "$1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/     | /'
  failures=$((failures + 1))
}

# ---- tools: an explicit PATH, so the test decides which verifier exists
find_openssl3() {
  local c
  for c in "$(command -v openssl || true)" /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    "$c" pkeyutl -help 2>&1 | grep -q -- -rawin || continue
    "$c" dgst -blake2b512 </dev/null >/dev/null 2>&1 || continue
    echo "$c"
    return
  done
}
OPENSSL3=$(find_openssl3 || true)

tools=$T/tools
mkdir -p "$tools"
for t in awk base64 cat chmod cmp cp cut dd grep head id mkdir mktemp mv od rm sed sh sort tail tr uname wc \
  sha256sum shasum perl dash bash env; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$tools/$t"
done
with_minisign=$T/with-minisign
with_openssl=$T/with-openssl
with_jq=$T/with-jq
with_python=$T/with-python
mkdir -p "$with_minisign" "$with_openssl" "$with_jq" "$with_python"
ln -sf "$(command -v minisign)" "$with_minisign/minisign"
[ -z "$OPENSSL3" ] || ln -sf "$OPENSSL3" "$with_openssl/openssl"
JQ=$(command -v jq || true)
PYTHON3=$(command -v python3 || true)
[ -z "$JQ" ] || ln -sf "$JQ" "$with_jq/jq"
[ -z "$PYTHON3" ] || ln -sf "$PYTHON3" "$with_python/python3"

# ---- shims
shims=$T/shims
mkdir -p "$shims"
cat >"$shims/curl" <<'EOF'
#!/bin/sh
# curl -fsSL [--retry n] -o <dest> <url>: serves http://release.test/rel/* from $FAKE_RELEASE.
out=
url=
while [ $# -gt 0 ]; do
  case $1 in
  -o) out=$2; shift ;;
  --retry) shift ;;
  -*) ;;
  *) url=$1 ;;
  esac
  shift
done
printf '%s\n' "$url" >>"$SHIM_LOG.curl"
case $url in
http://release.test/rel/*) src=$FAKE_RELEASE/${url#http://release.test/rel/} ;;
*) exit 6 ;;
esac
[ -f "$src" ] || exit 22
cp "$src" "$out"
EOF
cat >"$shims/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SHIM_LOG.docker"
case $1 in
info)
  [ "$2" = --format ] || exit 0
  case $3 in
  *LiveRestoreEnabled*) echo "${FAKE_LIVE_RESTORE:-false}" ;;
  *DockerRootDir*) echo "${FAKE_DOCKER_ROOT:-/var/lib/docker}" ;;
  *Swarm*) echo "${FAKE_SWARM:-inactive}" ;;
  esac
  ;;
version) echo "${FAKE_DOCKER_VERSION:-27.3.1}" ;;
image) exit 1 ;;
ps) [ -z "${FAKE_OUR_PROXY:-}" ] || echo 0123456789ab ;;
esac
exit 0
EOF
cat >"$shims/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SHIM_LOG.systemctl"
if [ "$1" = cat ] && [ "$2" = docker.service ] && [ -n "${FAKE_NO_DOCKER_UNIT:-}" ]; then exit 1; fi
exit 0
EOF
cat >"$shims/ss" <<'EOF'
#!/bin/sh
# ss -Hltnp "sport = :<port>": FAKE_SS_<port> names the program listening.
for a; do last=$a; done
port=${last##*:}
eval "holder=\${FAKE_SS_$port:-}"
[ -z "$holder" ] || echo "LISTEN 0 511 0.0.0.0:$port 0.0.0.0:* users:((\"$holder\",pid=42,fd=6))"
EOF
cat >"$shims/ufw" <<'EOF'
#!/bin/sh
# ufw status: active when FAKE_UFW is set.
printf '%s\n' "$*" >>"$SHIM_LOG.ufw"
[ "$1" = status ] && [ -n "${FAKE_UFW:-}" ] && echo "Status: active"
exit 0
EOF
cat >"$shims/dockerd" <<'EOF'
#!/bin/sh
# dockerd --validate --config-file <file>
[ -z "${FAKE_DOCKERD_INVALID:-}" ]
EOF
chmod +x "$shims"/*

# ---- a fake release
fake_binary() {
  cat >"$1" <<EOF
#!/bin/sh
# fake $SLUG binary for installer tests
case " \$* " in
*" version "*) echo "$SLUG ${2:-$V} (test)" ;;
*" install-units "*) echo "units written" ;;
*) echo "fake $SLUG: \$*" ;;
esac
EOF
  chmod +x "$1"
}

minisign -G -W -p "$T/test.pub" -s "$T/test.key" >/dev/null
minisign -G -W -p "$T/other.pub" -s "$T/other.key" >/dev/null
KEY=$(sed -n 2p "$T/test.pub")

# RELEASETOOL: a prebuilt releasetool (for runs in a container without Go).
if [ -n "${RELEASETOOL:-}" ]; then
  cp "$RELEASETOOL" "$T/releasetool"
else
  go -C "$root/go" build -o "$T/releasetool" ./internal/update/releasetool
fi

# make_release <version> <dir>: binaries, manifest.json + .minisig.
make_release() {
  local v=$1 dir=$2
  mkdir -p "$dir"
  fake_binary "$dir/${SLUG}_linux_amd64" "$v"
  fake_binary "$dir/${SLUG}_linux_arm64" "$v"
  "$T/releasetool" -version "$v" -binaries "$dir" -platforms linux-amd64,linux-arm64 \
    -download-base "$BASE/download/v$v" -image "$IMAGE_REPO:$v" -digest "$DIGEST" \
    -out "$dir/manifest.json" >/dev/null
  sign "$dir/manifest.json" "$T/test.key" "$SLUG $v manifest.json"
}
sign() { rm -f "$1.minisig"; minisign -S -s "$2" -m "$1" -x "$1.minisig" -t "$3" </dev/null >/dev/null; }

# fresh_release: a clean copy of the good release as both v$V and latest.
fresh_release() {
  rm -rf "$REL"
  make_release "$V" "$REL/download/v$V"
  mkdir -p "$REL/latest/download"
  cp "$REL/download/v$V"/* "$REL/latest/download/"
}

INSTALLER=$T/install.sh
PLACEHOLDER_INSTALLER=$T/install-release.sh
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" latest "$INSTALLER" >/dev/null
# A release installer from a build that has no signing key yet: the real
# render with brand.json's key swapped for the placeholder, so these cases do
# not depend on whether brand.json has a key.
"$root/scripts/render-installer.sh" latest "$T/install-release-keyed.sh" >/dev/null
sed "s|^BRAND_MINISIGN_PUBLIC_KEY=.*|BRAND_MINISIGN_PUBLIC_KEY='${BRAND_PLACEHOLDER_PREFIX}MINISIGN_PUBLIC_KEY'|" \
  "$T/install-release-keyed.sh" >"$PLACEHOLDER_INSTALLER"
grep -q "^BRAND_MINISIGN_PUBLIC_KEY='${BRAND_PLACEHOLDER_PREFIX}" "$PLACEHOLDER_INSTALLER" || { echo "installer tests: could not make the keyless installer" >&2; exit 1; }

# run_installer <verifier> <installer> [join|uninstall] <args...>: sets OUT, RC,
# R (the --root dir). PRESEED=<dir> is copied into the root first;
# EXTRA_PATH adds tools (jq, python3).
run_installer() {
  local verifier=$1 installer=$2 mode=panel
  shift 2
  case ${1:-} in join | uninstall) mode=$1; shift ;; esac
  R=$T/root-$RANDOM$RANDOM
  mkdir -p "$R"
  [ -z "${PRESEED:-}" ] || cp -R "$PRESEED/." "$R/"
  rm -f "$T"/log.*
  local path=$shims:$tools${EXTRA_PATH:+:$EXTRA_PATH}
  case $verifier in
  minisign) path=$path:$with_minisign ;;
  openssl) path=$path:$with_openssl ;;
  none) ;;
  esac
  set +e
  OUT=$(env -i PATH="$path" HOME="$T" TMPDIR="$T" FAKE_RELEASE="$REL" SHIM_LOG="$T/log" \
    FAKE_LIVE_RESTORE="${FAKE_LIVE_RESTORE:-}" FAKE_DOCKER_ROOT="${FAKE_DOCKER_ROOT:-}" FAKE_SWARM="${FAKE_SWARM:-}" \
    FAKE_DOCKER_VERSION="${FAKE_DOCKER_VERSION:-}" FAKE_NO_DOCKER_UNIT="${FAKE_NO_DOCKER_UNIT:-}" \
    FAKE_DOCKERD_INVALID="${FAKE_DOCKERD_INVALID:-}" FAKE_OUR_PROXY="${FAKE_OUR_PROXY:-}" \
    FAKE_SS_80="${FAKE_SS_80:-}" FAKE_SS_443="${FAKE_SS_443:-}" FAKE_SS_3000="${FAKE_SS_3000:-}" FAKE_SS_3443="${FAKE_SS_3443:-}" FAKE_UFW="${FAKE_UFW:-}" \
    "$SH" "$installer" "$mode" --root "$R" --release-url "$BASE" "$@" 2>&1)
  RC=$?
  set -e
}
has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
expect_ok() { # name: last run succeeded and printed every following string
  local name=$1 s
  shift
  if [ "$RC" -ne 0 ]; then flunk "$name (exit $RC)" "$OUT"; return; fi
  for s in "$@"; do has "$s" || { flunk "$name: missing \"$s\"" "$OUT"; return; }; done
  pass "$name"
}
expect_fail() { # name pattern: last run failed and printed pattern
  if [ "$RC" -eq 0 ]; then flunk "$1 (exit 0, expected a failure)" "$OUT"; return; fi
  has "$2" || { flunk "$1: missing \"$2\"" "$OUT"; return; }
  pass "$1"
}
curl_log() { cat "$T/log.curl" 2>/dev/null || true; }

verifiers=(minisign)
if [ -n "$OPENSSL3" ]; then verifiers+=(openssl); else echo "note: no OpenSSL 3 found; the openssl verifier is not tested"; fi
PANEL_REF="$IMAGE_REPO:$V@$DIGEST"

for vf in "${verifiers[@]}"; do
  fresh_release
  run_installer "$vf" "$INSTALLER" --version "$V" --port 3999
  expect_ok "[$vf] panel install verifies the manifest and pins the panel image by digest" \
    "TEST BUILD" "Release signature verified" "+ docker pull $PANEL_REF" "panel bootstrap --image $PANEL_REF --port 3999 --agent-tls-port 3443"
  [ -x "$R/usr/local/bin/$SLUG" ] && pass "[$vf] binary installed under --root" || flunk "[$vf] binary not installed" "$OUT"

  run_installer "$vf" "$INSTALLER"
  expect_ok "[$vf] latest resolves to the manifest's version" "$SLUG $V" "+ docker pull $PANEL_REF"
  curl_log | grep -q "/latest/download/manifest.json\$" && curl_log | grep -q "/download/v$V/${SLUG}_linux_$ARCH\$" &&
    pass "[$vf] latest: manifest from latest/, binary from v$V/" || flunk "[$vf] latest download paths" "$(curl_log)"

  # A re-pushed image: the digest in the manifest changes after signing.
  sed -i.bak "s/$DIGEST/sha256:$(printf '%064d' 0)/" "$REL/download/v$V/manifest.json"
  run_installer "$vf" "$INSTALLER" --version "$V"
  expect_fail "[$vf] a changed manifest is refused" "not signed by the"
  [ ! -e "$R/etc/docker/daemon.json" ] && [ ! -e "$R/usr/local/bin/$SLUG" ] &&
    pass "[$vf] a refused release changes nothing (Docker settings, binary)" || flunk "[$vf] a refused release changed files"

  fresh_release
  sed -i.bak 's/^trusted comment: .*/trusted comment: '"$SLUG"' 9.9.9 manifest.json/' "$REL/download/v$V/manifest.json.minisig"
  run_installer "$vf" "$INSTALLER" --version "$V"
  expect_fail "[$vf] a changed trusted comment is refused" "not signed by the"

  fresh_release
  sign "$REL/download/v$V/manifest.json" "$T/other.key" "$SLUG $V manifest.json"
  run_installer "$vf" "$INSTALLER" --version "$V"
  expect_fail "[$vf] a manifest signed by another key is refused" "not signed by the"

  fresh_release
  fake_binary "$REL/download/v$V/${SLUG}_linux_$ARCH" "6.6.6"
  run_installer "$vf" "$INSTALLER" --version "$V"
  expect_fail "[$vf] a replaced binary is refused" "does not match the sha256 in the signed release manifest"
done

fresh_release
rm "$REL/download/v$V/manifest.json.minisig"
run_installer minisign "$INSTALLER" --version "$V"
expect_fail "a release without a signature is refused" "could not download the release signature"

fresh_release
mkdir -p "$REL/download/v0.0.9"
cp "$REL/download/v$V"/* "$REL/download/v0.0.9/"
run_installer minisign "$INSTALLER" --version 0.0.9
expect_fail "an older signed manifest served for another version is refused" "asked for 0.0.9 but the release manifest is for $V"

fresh_release
run_installer none "$INSTALLER" --version "$V"
expect_fail "no minisign and no OpenSSL 3: stops instead of skipping the check" "cannot check the release signature"

run_installer minisign "$PLACEHOLDER_INSTALLER" --version "$V"
expect_fail "an installer without a release key refuses to download" "no release signing key"
has "TEST BUILD" && flunk "a release installer must not say TEST BUILD" "$OUT" || pass "a release installer does not say TEST BUILD"

run_installer none "$PLACEHOLDER_INSTALLER" --version "$V" --allow-unsigned
expect_ok "--allow-unsigned installs without a signature check, image still pinned" \
  "the release signature is NOT checked" "+ docker pull $PANEL_REF"

run_installer minisign "$INSTALLER" --version "$V" --image my.registry/panel:dev
expect_ok "--image is used as given" "+ docker pull my.registry/panel:dev"

fake_binary "$T/local-binary"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel http://panel.test:3000 --token t --binary "$T/local-binary" --insecure
expect_ok "join with --binary needs no release download" "Joining http://panel.test:3000"
[ -z "$(curl_log)" ] && pass "join with --binary downloaded nothing" || flunk "join with --binary downloaded" "$(curl_log)"

# ufw: a joining node allows load balancing (5757) from the panel's address
# when that is an IP, and every install says the agent's IP:port addresses
# need their own allow rule.
FAKE_UFW=1 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --pin "sha256:$(printf '%064d' 1)" --binary "$T/local-binary"
expect_ok "a join behind ufw allows 5757 from the panel's IPv4 address" \
  "+ ufw allow from 192.0.2.10 to any port 5757 proto tcp" "ufw allow <port>/tcp"
FAKE_UFW=1 run_installer none "$PLACEHOLDER_INSTALLER" join --panel 'https://[2001:db8::7]:3443' --token t --binary "$T/local-binary"
expect_ok "a join behind ufw allows 5757 from the panel's IPv6 address" "+ ufw allow from 2001:db8::7 to any port 5757 proto tcp"
FAKE_UFW=1 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
if [ "$RC" -eq 0 ] && ! has "port 5757 proto tcp" && has "+ ufw allow 443/tcp"; then
  pass "a join to a panel domain leaves 5757 to the owner"
else
  flunk "a join to a panel domain leaves 5757 to the owner" "$OUT"
fi

run_installer minisign "$INSTALLER" --version "$V" --dry-run
expect_ok "--dry-run prints the plan" "+ download $BASE/download/v$V/manifest.json and check its signature" "panel bootstrap --image"
[ -z "$(curl_log)" ] && [ -z "$(find "$R" -type f)" ] && pass "--dry-run downloads and writes nothing" ||
  flunk "--dry-run changed something" "$(curl_log; find "$R" -type f)"

# ---- Docker preflight (the same minimum as go/internal/nodecheck)
fresh_release
min=$(sed -n 's/^MIN_DOCKER_MAJOR=//p' "$INSTALLER")
rec=$(sed -n 's/^RECOMMENDED_DOCKER_MAJOR=//p' "$INSTALLER")
nodecheck_min=$(sed -n 's/^[[:space:]]*minDockerMajor[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$root/go/internal/nodecheck/checks.go")
[ -n "$min" ] && [ "$min" = "$nodecheck_min" ] && pass "installer minimum Docker ($min) is nodecheck's ($nodecheck_min)" ||
  flunk "installer minimum Docker '$min' differs from nodecheck's '$nodecheck_min'"

FAKE_DOCKER_VERSION=20.10.24+dfsg1 run_installer minisign "$INSTALLER" --version "$V"
expect_fail "Debian's docker.io 20.10 is refused" "Docker 20.10.24+dfsg1 is too old"
FAKE_DOCKER_VERSION=$min.0.1 run_installer minisign "$INSTALLER" --version "$V"
if [ "$min" -lt "$rec" ]; then
  expect_ok "Docker $min installs with a warning" "$rec or newer is recommended"
else
  expect_ok "Docker $min installs" "Docker $min.0.1 is running"
fi
FAKE_DOCKER_VERSION=29.0.0 run_installer minisign "$INSTALLER" --version "$V"
expect_ok "a current Docker installs quietly" "Docker 29.0.0 is running"
has "is recommended" && flunk "a current Docker got the recommended-version warning" "$OUT" || pass "a current Docker gets no version warning"
FAKE_DOCKER_ROOT=/var/snap/docker/common/var-lib-docker run_installer minisign "$INSTALLER" --version "$V"
expect_fail "snap Docker (root dir under /var/snap) is refused" "Docker from snap is not supported"
FAKE_NO_DOCKER_UNIT=1 run_installer minisign "$INSTALLER" --version "$V"
expect_fail "Docker without a docker.service unit is refused" "without a docker.service systemd unit"

# ---- Docker live-restore
daemon() { cat "$R/etc/docker/daemon.json" 2>/dev/null || true; }
run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: a new daemon.json and a reload" "Turning on Docker live-restore" "+ systemctl reload docker"
daemon | grep -q '"live-restore": true' && pass "live-restore: daemon.json written" || flunk "live-restore: daemon.json" "$(daemon)"

seed=$T/seed-daemon
mkdir -p "$seed/etc/docker"
printf '{\n  "exec-opts": ["native.cgroupdriver=cgroupfs"],\n  "features": {"buildkit": true}\n}\n' >"$seed/etc/docker/daemon.json"
for merger in jq python; do
  case $merger in
  jq) [ -n "$JQ" ] || { echo "note: no jq, the jq merge is not tested"; continue; }; extra=$with_jq ;;
  python) [ -n "$PYTHON3" ] || { echo "note: no python3, the python merge is not tested"; continue; }; extra=$with_python ;;
  esac
  PRESEED=$seed EXTRA_PATH=$extra run_installer minisign "$INSTALLER" --version "$V"
  expect_ok "live-restore: merged into an existing daemon.json with $merger" "+ systemctl reload docker"
  daemon | tr -d ' \n' | grep -q '"live-restore":true' && daemon | grep -q 'native.cgroupdriver=cgroupfs' && daemon | grep -q buildkit &&
    pass "live-restore ($merger): other settings kept" || flunk "live-restore ($merger): merge" "$(daemon)"
  [ -f "$R/etc/docker/daemon.json.before-$SLUG" ] && pass "live-restore ($merger): the old file is kept aside" ||
    flunk "live-restore ($merger): no copy of the old daemon.json"
done
PRESEED=$seed run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: without jq or python3 the install goes on" "could not update"
daemon | grep -q live-restore && flunk "live-restore: daemon.json changed without a JSON tool" "$(daemon)" ||
  pass "live-restore: daemon.json untouched without a JSON tool"

seed=$T/seed-false
mkdir -p "$seed/etc/docker"
printf '{ "live-restore": false }\n' >"$seed/etc/docker/daemon.json"
PRESEED=$seed EXTRA_PATH=$with_python:$with_jq run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: an explicit false is respected" '"live-restore": false, left as is'
daemon | grep -q '"live-restore": false' && pass "live-restore: explicit false kept" || flunk "live-restore: explicit false changed" "$(daemon)"

FAKE_LIVE_RESTORE=true run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: already on"
[ ! -e "$R/etc/docker/daemon.json" ] && ! has "reload docker" && pass "live-restore: no write and no reload when it is on" ||
  flunk "live-restore: changed a Docker that already had it" "$OUT"

FAKE_SWARM=active run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: swarm mode is left alone" "swarm mode"
[ ! -e "$R/etc/docker/daemon.json" ] && pass "live-restore: no daemon.json in swarm mode" || flunk "live-restore: wrote daemon.json in swarm mode"

seed=$T/seed-wings
mkdir -p "$seed/etc/pelican"
: >"$seed/etc/pelican/config.yml"
PRESEED=$seed run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: Wings nodes are left alone" "Wings runs on this server"
[ ! -e "$R/etc/docker/daemon.json" ] && pass "live-restore: no daemon.json on a Wings node" || flunk "live-restore: wrote daemon.json on a Wings node"

FAKE_DOCKERD_INVALID=1 run_installer minisign "$INSTALLER" --version "$V"
expect_ok "live-restore: a config dockerd refuses is not written" "Docker refuses"
[ ! -e "$R/etc/docker/daemon.json" ] && pass "live-restore: nothing written when dockerd refuses it" || flunk "live-restore: wrote a refused config"

# ---- ports 80/443 and the panel port
FAKE_SS_80=nginx run_installer minisign "$INSTALLER" --version "$V"
expect_fail "panel install stops when nginx holds port 80" "port 80 is used by nginx"
[ -z "$(curl_log)" ] && [ ! -e "$R/usr/local/bin/$SLUG" ] && pass "the port check runs before anything is downloaded or installed" ||
  flunk "the port check ran too late" "$(curl_log)"
FAKE_SS_443=apache2 run_installer minisign "$INSTALLER" --version "$V" --force
expect_ok "--force installs although apache2 holds 443" "port 443 is used by apache2" "panel bootstrap --image"
FAKE_SS_80=docker-proxy FAKE_SS_443=docker-proxy FAKE_OUR_PROXY=1 run_installer minisign "$INSTALLER" --version "$V"
expect_ok "our own Traefik from an earlier install may hold 80/443" "panel bootstrap --image"
has "is used by" && flunk "our own Traefik was reported as a foreign program" "$OUT" || pass "our own Traefik is not reported"
FAKE_SS_80=docker-proxy run_installer minisign "$INSTALLER" --version "$V"
expect_fail "another container publishing 80 stops the panel install" "port 80 is used by docker-proxy"
PRESEED=$T/seed-wings FAKE_SS_80=docker-proxy FAKE_SS_443=docker-proxy run_installer minisign "$INSTALLER" --version "$V"
expect_ok "on a Wings server the panel shares Wings' Traefik" "shares Wings' Traefik" "panel bootstrap --image"
FAKE_SS_3000=node run_installer minisign "$INSTALLER" --version "$V"
expect_fail "panel install stops when the panel port is taken" "port 3000 (the panel's address until it has a domain) is used by node"
FAKE_SS_80=nginx run_installer none "$PLACEHOLDER_INSTALLER" join --panel http://panel.test:3000 --token t --binary "$T/local-binary" --insecure
expect_ok "a join only warns about port 80" "warning: port 80 is used by nginx" "Joining http://panel.test:3000"
FAKE_SS_3443=node run_installer minisign "$INSTALLER" --version "$V"
expect_fail "panel install stops when the agents' TLS port is taken" "port 3443 (where other nodes' agents reach the panel over TLS) is used by node"

# ---- joins install the release of the installer they came from
# The panel's join command pipes its own release's install.sh into sh
# (apps/panel/src/modules/nodes/join-command.ts). That installer defaults
# to its own version, so the node gets that release's agent even when
# "latest" (what the install host serves) is another release.
VN=0.1.5
fresh_release
make_release "$VN" "$REL/download/v$VN"
rm -rf "$REL/latest/download" && mkdir -p "$REL/latest/download" && cp "$REL/download/v$VN"/* "$REL/latest/download/"
RELEASE_INSTALLER=$T/install-v$V.sh
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" "$V" "$RELEASE_INSTALLER" >/dev/null
run_installer minisign "$RELEASE_INSTALLER" join --panel https://192.0.2.10:3443 --token t --pin "sha256:$(printf '%064d' 1)"
expect_ok "a release's installer joins with that release's agent, not latest" "$SLUG $V (test) -> /usr/local/bin/$SLUG" "join https://192.0.2.10:3443 --token t --no-start --pin sha256:"
curl_log | grep -q "/download/v$V/${SLUG}_linux_$ARCH\$" && ! curl_log | grep -q "/latest/" &&
  pass "a release's installer downloads only from its own release" || flunk "a release's installer download paths" "$(curl_log)"
# The latest installer with --version (install.sh.tmpl join mode) installs that version too.
run_installer minisign "$INSTALLER" join --panel https://192.0.2.10:3443 --token t --version "v$V"
expect_ok "join --version installs that release's agent" "$SLUG $V (test) -> /usr/local/bin/$SLUG" "Joining https://192.0.2.10:3443"
curl_log | grep -q "/download/v$V/manifest.json\$" && ! curl_log | grep -q "/latest/" &&
  pass "join --version reads that release's manifest" || flunk "join --version download paths" "$(curl_log)"
run_installer minisign "$INSTALLER" join --panel https://192.0.2.10:3443 --token t
expect_ok "join without --version from the latest installer follows latest" "$SLUG $VN (test) -> /usr/local/bin/$SLUG"
fresh_release

# ---- the agents' TLS port and plain-HTTP joins
FAKE_UFW=1 run_installer minisign "$INSTALLER" --version "$V"
expect_ok "a panel install publishes and opens the agents' TLS port" \
  "panel bootstrap --image $PANEL_REF --port 3000 --agent-tls-port 3443" "+ ufw allow 3000/tcp" "+ ufw allow 3443/tcp"
run_installer minisign "$INSTALLER" --version "$V" --port 3443
expect_ok "--port 3443 moves the agents' TLS port to 3444" "--port 3443 --agent-tls-port 3444"
run_installer minisign "$INSTALLER" --version "$V" --agent-tls-port 3000
expect_fail "the agents' TLS port cannot be the panel's port" "must differ from --port"
FAKE_UFW=1 run_installer minisign "$INSTALLER" --version "$V" --agent-tls-port 0
if [ "$RC" -eq 0 ] && has "--agent-tls-port 0" && ! has "+ ufw allow 0/tcp"; then
  pass "--agent-tls-port 0 turns it off"
else
  flunk "--agent-tls-port 0 turns it off" "$OUT"
fi
run_installer none "$PLACEHOLDER_INSTALLER" join --panel http://192.0.2.10:3000 --token t --binary "$T/local-binary"
expect_fail "a plain-HTTP join to another server needs --insecure" "add --insecure to join over plain HTTP anyway"
[ ! -e "$R/usr/local/bin/$SLUG" ] && pass "a refused plain-HTTP join installs nothing" || flunk "a refused plain-HTTP join installed the binary" "$OUT"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel http://192.0.2.10:3000 --token t --binary "$T/local-binary" --insecure
expect_ok "--insecure reaches the agent's join" "join http://192.0.2.10:3000 --token t --no-start --insecure"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel 'http://[::1]:3000' --token t --binary "$T/local-binary"
expect_ok "a loopback panel URL needs no --insecure" "Joining http://[::1]:3000"

# ---- can_build on a join: given, refused, or left to what config.yml says
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary" --can-build
expect_ok "--can-build reaches the agent's join" "join https://panel.example.com --token t --no-start --can-build=true"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary" --no-can-build --force
expect_ok "--no-can-build turns builds off on a re-join" "join https://panel.example.com --token t --no-start --can-build=false --force"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary" --force
if [ "$RC" -eq 0 ] && has "join https://panel.example.com --token t --no-start --force" && ! has "can-build"; then
  pass "a re-join without either flag leaves can_build to config.yml"
else
  flunk "a re-join without either flag leaves can_build to config.yml" "$OUT"
fi

# ---- scripts/release-preflight.sh (what `make release` checks before it publishes)
cat >"$shims/gh" <<'EOF'
#!/bin/sh
# gh api repos/<org>/<repo> --jq .permissions.push
echo "${FAKE_GH_PUSH:-true}"
EOF
chmod +x "$shims/gh"
preflight() { # [--no-secret-key] [VAR=value...]: runs the preflight with the test release key unless overridden
  local args=()
  if [ "${1:-}" = --no-secret-key ]; then
    args+=("$1")
    shift
  fi
  set +e
  OUT=$(env -i PATH="$shims:$tools:$with_minisign" HOME="$T" TMPDIR="$T" \
    BRAND_PLACEHOLDER_PREFIX="$BRAND_PLACEHOLDER_PREFIX" BRAND_GITHUB_ORG=test-org BRAND_GITHUB_REPO=test-repo \
    BRAND_MINISIGN_PUBLIC_KEY="$KEY" BRAND_OAUTH_CLIENT_ID=client MINISIGN_SECRET_KEY="$T/test.key" MINISIGN_PASSWORD= \
    "$@" bash "$root/scripts/release-preflight.sh" ${args[@]+"${args[@]}"} 2>&1)
  RC=$?
  set -e
}
preflight
expect_ok "release preflight passes with a matching key and a pushable repo" "release-preflight: ok"
preflight BRAND_MINISIGN_PUBLIC_KEY="${BRAND_PLACEHOLDER_PREFIX}MINISIGN_PUBLIC_KEY"
expect_fail "release preflight refuses the placeholder signing key" "minisignPublicKey is a placeholder"
preflight MINISIGN_SECRET_KEY="$T/other.key"
expect_fail "release preflight refuses a secret key that does not match brand.json" "does not match brand.json minisignPublicKey"
preflight FAKE_GH_PUSH=false
expect_fail "release preflight refuses a GitHub repo the releaser cannot push to" "cannot push to it"
preflight INSTALLER_TEST_PUBLIC_KEY="$KEY"
expect_fail "release preflight refuses a run that would render a test-key installer" "INSTALLER_TEST_PUBLIC_KEY is set"
preflight BRAND_MINISIGN_PUBLIC_KEY="$(sed -n 2p "$root/test/e2e-colima/keys/e2e-test.pub")"
expect_fail "release preflight refuses the committed e2e test key" "TEST-ONLY e2e key"
# The Draft release job of a tag release never sees the secret key: the Sign
# job holds it (scripts/release-sign.sh).
preflight --no-secret-key MINISIGN_SECRET_KEY=
expect_ok "release preflight --no-secret-key passes without a secret key" "release-preflight: ok"
preflight --no-secret-key MINISIGN_SECRET_KEY="$T/other.key"
expect_ok "release preflight --no-secret-key does not check the secret key" "release-preflight: ok"
preflight --no-secret-key BRAND_MINISIGN_PUBLIC_KEY="${BRAND_PLACEHOLDER_PREFIX}MINISIGN_PUBLIC_KEY"
expect_fail "release preflight --no-secret-key still refuses the placeholder signing key" "minisignPublicKey is a placeholder"
preflight --no-secret-key BRAND_MINISIGN_PUBLIC_KEY="$(sed -n 2p "$root/test/e2e-colima/keys/e2e-test.pub")"
expect_fail "release preflight --no-secret-key still refuses the committed e2e test key" "TEST-ONLY e2e key"
preflight --no-secret-key FAKE_GH_PUSH=false
expect_fail "release preflight --no-secret-key still refuses a GitHub repo the releaser cannot push to" "cannot push to it"

# Prompting needs a terminal that really opens. With no controlling terminal
# (cloud-init, CI, ssh without -t) /dev/tty still reads as mode 666, so the old
# -r/-w test said yes and the open killed the script under dash. A directory is
# the same kind of trap: readable and writable, but it cannot be opened for writing.
can_prompt_with() { # device: runs the installer's own can_prompt against it
  ( INSTALLER_TEST_TTY=$1 && eval "$(sed -n '/^TTY_DEVICE=/p;/^can_prompt() {/,/^}/p' "$INSTALLER")" && can_prompt )
}
mkdir -p "$T/not-a-terminal"
if can_prompt_with "$T/not-a-terminal"; then flunk "no terminal is detected as no terminal" "can_prompt said yes for an unopenable device"; else pass "no terminal is detected as no terminal"; fi
: >"$T/a-terminal"
if can_prompt_with "$T/a-terminal"; then pass "an openable terminal can be asked on"; else flunk "an openable terminal can be asked on" "can_prompt said no for a writable device"; fi
if grep -q -- '-r /dev/tty' "$INSTALLER"; then flunk "the installer no longer trusts -r/-w on /dev/tty" "found -r /dev/tty"; else pass "the installer no longer trusts -r/-w on /dev/tty"; fi

if [ "$failures" -gt 0 ]; then
  echo "installer tests: $failures failed"
  exit 1
fi
echo "installer tests: all passed"
