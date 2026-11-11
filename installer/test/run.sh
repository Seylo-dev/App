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
for t in awk base64 cat chmod cmp cp cut dd grep head id mkdir mktemp mv od rm sed sh sleep sort tail tr uname wc \
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
# The docker CLI has a folder of its own: NO_DOCKER_CLI=1 leaves it out of
# PATH (Docker is not installed).
docker_cli=$T/docker-cli
mkdir -p "$docker_cli"
cat >"$docker_cli/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$SHIM_LOG.docker"
case $1 in
info)
  # FAKE_DOCKER_DOWN: the CLI is there but no daemon answers (installed, not running).
  [ "$2" = --format ] || { [ -z "${FAKE_DOCKER_DOWN:-}" ] || exit 1; exit 0; }
  case $3 in
  *LiveRestoreEnabled*) echo "${FAKE_LIVE_RESTORE:-false}" ;;
  *DockerRootDir*) echo "${FAKE_DOCKER_ROOT:-/var/lib/docker}" ;;
  *Swarm*) echo "${FAKE_SWARM:-inactive}" ;;
  esac
  ;;
version) echo "${FAKE_DOCKER_VERSION:-27.3.1}" ;;
image) exit 1 ;;
ps)
  case "$*" in
  # The running panel's version (FAKE_PANEL_VERSION), read from its image label.
  *image.version*) [ -z "${FAKE_PANEL_VERSION:-}" ] || echo "$FAKE_PANEL_VERSION" ;;
  *) [ -z "${FAKE_OUR_PROXY:-}" ] || echo 0123456789ab ;;
  esac
  ;;
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
chmod +x "$shims"/* "$docker_cli/docker"

# ---- a fake release
# The fake's `status` prints FAKE_STATUS (default: connected) and exits
# FAKE_STATUS_EXIT, so a join's wait for the first connect ends at once.
fake_binary() {
  cat >"$1" <<EOF
#!/bin/sh
# fake $SLUG binary for installer tests
case " \$* " in
*" version "*) echo "$SLUG ${2:-$V} (test)" ;;
*" install-units "*) echo "units written" ;;
*" status "*) printf '%s\n' "\${FAKE_STATUS:-Panel:   https://panel.test (connected, version test)}"; exit "\${FAKE_STATUS_EXIT:-0}" ;;
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
# EXTRA_PATH adds tools (jq, python3). TEST_COLOR=1 makes the installer act
# as on a terminal (INSTALLER_TEST_COLOR); TEST_NO_COLOR, TEST_TERM and
# TEST_COLORTERM become NO_COLOR, TERM and COLORTERM (all empty otherwise,
# whatever this shell has).
run_installer() {
  local verifier=$1 installer=$2 mode=panel
  shift 2
  case ${1:-} in join | uninstall) mode=$1; shift ;; ask) mode=; shift ;; esac
  R=$T/root-$RANDOM$RANDOM
  mkdir -p "$R"
  [ -z "${PRESEED:-}" ] || cp -R "$PRESEED/." "$R/"
  rm -f "$T"/log.*
  local path=$shims:$tools${EXTRA_PATH:+:$EXTRA_PATH}
  [ -n "${NO_DOCKER_CLI:-}" ] || path=$path:$docker_cli
  case $verifier in
  minisign) path=$path:$with_minisign ;;
  openssl) path=$path:$with_openssl ;;
  none) ;;
  esac
  set +e
  OUT=$(env -i PATH="$path" HOME="$T" TMPDIR="$T" FAKE_RELEASE="$REL" SHIM_LOG="$T/log" \
    FAKE_LIVE_RESTORE="${FAKE_LIVE_RESTORE:-}" FAKE_DOCKER_ROOT="${FAKE_DOCKER_ROOT:-}" FAKE_SWARM="${FAKE_SWARM:-}" \
    FAKE_DOCKER_VERSION="${FAKE_DOCKER_VERSION:-}" FAKE_NO_DOCKER_UNIT="${FAKE_NO_DOCKER_UNIT:-}" FAKE_DOCKER_DOWN="${FAKE_DOCKER_DOWN:-}" \
    FAKE_DOCKERD_INVALID="${FAKE_DOCKERD_INVALID:-}" FAKE_OUR_PROXY="${FAKE_OUR_PROXY:-}" FAKE_PANEL_VERSION="${FAKE_PANEL_VERSION:-}" \
    FAKE_GETENT_passwd="${FAKE_GETENT_passwd:-}" FAKE_GETENT_group="${FAKE_GETENT_group:-}" \
    FAKE_SS_80="${FAKE_SS_80:-}" FAKE_SS_443="${FAKE_SS_443:-}" FAKE_SS_3000="${FAKE_SS_3000:-}" FAKE_SS_3443="${FAKE_SS_3443:-}" FAKE_UFW="${FAKE_UFW:-}" \
    FAKE_STATUS="${FAKE_STATUS:-}" FAKE_STATUS_EXIT="${FAKE_STATUS_EXIT:-}" INSTALLER_TEST_JOIN_WAIT="${INSTALLER_TEST_JOIN_WAIT:-}" \
    INSTALLER_TEST_KNOWN_WAIT="${INSTALLER_TEST_KNOWN_WAIT:-}" \
    INSTALLER_TEST_COLOR="${TEST_COLOR:-}" NO_COLOR="${TEST_NO_COLOR:-}" TERM="${TEST_TERM:-}" COLORTERM="${TEST_COLORTERM:-}" \
    DO_NOT_TRACK="${TEST_DO_NOT_TRACK:-}" SEYLO_TELEMETRY="${TEST_TELEMETRY:-}" SEYLO_TTY="${TEST_TTY:-}" \
    "$SH" "$installer" ${mode:+"$mode"} --root "$R" --release-url "$BASE" "$@" 2>&1)
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

# The menu (ask_mode): a run that names no mode, with a person at the
# terminal, asks what the server should do. TEST_TTY is the "terminal".
printf '2\n%s\n' "curl -fsSL https://install.example.dev | sudo sh -s -- join --panel 'http://panel.test:3000' --token 'tok-123' --version '$V' --insecure" >"$T/answers-paste"
TEST_TTY="$T/answers-paste" run_installer none "$PLACEHOLDER_INSTALLER" ask --binary "$T/local-binary"
expect_ok "the menu's Join takes a pasted join command: address, token, --insecure" \
  "What should this server do?" "Paste it here:" "Joining http://panel.test:3000"
has "Join token" && flunk "the pasted command's token was asked for again" "$OUT" || pass "the pasted command's token is used, not asked again"
printf '2\nhttps://192.0.2.10:3443\n  tok-456  \n' >"$T/answers-url"
TEST_TTY="$T/answers-url" run_installer none "$PLACEHOLDER_INSTALLER" ask --binary "$T/local-binary" --pin "sha256:$(printf '%064d' 1)"
expect_ok "the menu's Join takes a bare address, then asks for the token" "Join token (from Add node):" "Joining https://192.0.2.10:3443"
printf 'x\n1\n' >"$T/answers-panel"
TEST_TTY="$T/answers-panel" run_installer minisign "$INSTALLER" ask --version "$V"
expect_ok "the menu asks again on a wrong answer, and 1 sets up a panel" "Type 1 or 2." "+ docker pull $PANEL_REF"
run_installer minisign "$INSTALLER" ask --version "$V"
expect_ok "no terminal: no menu, a panel as before" "+ docker pull $PANEL_REF"
has "What should this server do?" && flunk "the menu showed without a terminal" "$OUT" || pass "the menu needs a terminal"
printf '2\n' >"$T/answers-short"
TEST_TTY="$T/answers-short" run_installer none "$PLACEHOLDER_INSTALLER" ask --binary "$T/local-binary"
expect_fail "an answer that ends early stops with how to join by hand" "join --panel <url> --token <token>"

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

# ---- re-runs never install an older release than the node runs
# The installer the install host serves is the latest stable release. On a
# node that runs a pre-release (or a release the panel updated it to) a
# re-run must stop before it changes anything, unless --downgrade.
version_cmp_of() { ( eval "$(sed -n '/^version_cmp() {/,/^}/p' "$INSTALLER")" && version_cmp "$1" "$2" ); }
cmp_bad=
for c in "0.1.1 0.2.0-rc.2 -1" "0.2.0-rc.2 0.1.1 1" "0.2.0-rc.2 0.2.0 -1" "0.2.0 0.2.0-rc.2 1" "0.2.0-rc.2 0.2.0-rc.10 -1" \
  "0.2.0-alpha 0.2.0-alpha.1 -1" "0.2.0-alpha.1 0.2.0-alpha.beta -1" "0.2.0-beta.11 0.2.0-rc.1 -1" "0.10.0 0.9.9 1" \
  "1.0.0+build.1 1.0.0 0" "0.2.0-rc.2 0.2.0-rc.2 0" "dev 0.1.0 " "latest 0.1.0 " "0.1 0.1.0 "; do
  set -- $c
  got=$(version_cmp_of "$1" "$2" 2>/dev/null || true)
  [ "$got" = "${3:-}" ] || cmp_bad="$cmp_bad $1/$2=$got(want ${3:-nothing})"
done
[ -z "$cmp_bad" ] && pass "version_cmp orders releases by semantic versioning" || flunk "version_cmp" "$cmp_bad"

# seed_node <dir> <agent version> [panel url]: a joined node whose installed agent reports that version.
seed_node() {
  rm -rf "$1"
  mkdir -p "$1/usr/local/bin" "$1$BRAND_DATA_DIR"
  fake_binary "$1/usr/local/bin/$SLUG" "$2"
  printf 'node_id: n1\npanel_url: %s\n' "${3:-http://127.0.0.1:3000}" >"$1$BRAND_DATA_DIR/config.yml"
}
installed() { "$R/usr/local/bin/$SLUG" version 2>/dev/null || true; }
NEWER=0.2.0-rc.2
seed_node "$T/seed-newer" "$NEWER"
RELEASE_INSTALLER=$T/install-v$V.sh
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" "$V" "$RELEASE_INSTALLER" >/dev/null
PRESEED=$T/seed-newer run_installer minisign "$RELEASE_INSTALLER"
expect_fail "re-running a release's installer on a node with a newer agent stops" \
  "this node's agent runs $BRAND_DISPLAY_NAME $NEWER, newer than $V, the release this installer would install, so nothing was changed"
has "re-run with --version $NEWER" && has "add --downgrade" && pass "the refusal says how to reinstall or go back" ||
  flunk "the refusal says how to reinstall or go back" "$OUT"
case $(installed) in
*" $NEWER "*) [ ! -e "$R/etc/docker/daemon.json" ] && ! curl_log | grep -q "/${SLUG}_linux_" &&
  pass "a refused downgrade changes nothing (binary, Docker settings) and downloads no binary" ||
  flunk "a refused downgrade changed something" "$(installed; curl_log)" ;;
*) flunk "a refused downgrade replaced the binary" "$(installed)" ;;
esac
PRESEED=$T/seed-newer run_installer minisign "$INSTALLER"
expect_fail "latest resolving to an older release than the agent stops" "this node's agent runs $BRAND_DISPLAY_NAME $NEWER, newer than $V"
PRESEED=$T/seed-newer run_installer minisign "$INSTALLER" --version "$V"
expect_fail "--version older than the agent stops too" "newer than $V"
PRESEED=$T/seed-newer run_installer minisign "$INSTALLER" --version "$V" --dry-run
expect_fail "--dry-run shows the refusal" "newer than $V"
PRESEED=$T/seed-newer run_installer minisign "$RELEASE_INSTALLER" --downgrade
expect_ok "--downgrade installs the older release" "warning: --downgrade: this node's agent runs $NEWER; installing the older $V" \
  "$SLUG $V (test) -> /usr/local/bin/$SLUG" "The agent was updated and restarted"
seed_node "$T/seed-newer-join" "$NEWER" https://192.0.2.10:3443
PRESEED=$T/seed-newer-join run_installer minisign "$RELEASE_INSTALLER" join --panel https://192.0.2.10:3443 --token t
expect_fail "re-running a join on a node with a newer agent stops" "this node's agent runs $BRAND_DISPLAY_NAME $NEWER, newer than $V"
case $(installed) in *" $NEWER "*) pass "a refused join downgrade keeps the agent" ;; *) flunk "a refused join downgrade replaced the agent" "$(installed)" ;; esac
PRESEED=$T/seed-newer-join run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a --binary is installed as given" "Already joined to https://192.0.2.10:3443"
# The same address answers as another panel (a reinstall there, the domain moved to a new panel):
# the token joins it again instead of "Already joined" with the old identity.
seed_node "$T/seed-other-panel" "$V" https://192.0.2.10:3443
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (rejected)
Error:   not the panel this node belongs to (retrying at 10:40:00)" INSTALLER_TEST_KNOWN_WAIT=0 INSTALLER_TEST_JOIN_WAIT=0 \
  PRESEED=$T/seed-other-panel run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
# (The fake status still says rejected after the new join, so the run ends as refused: the calls are what counts.)
if has "warning: the panel at https://192.0.2.10:3443 refuses this node's earlier join (not the panel this node belongs to" &&
  has "joining it again with the token" && has "==> Joining https://192.0.2.10:3443" && has "join https://192.0.2.10:3443 --token t --no-start --force"; then
  pass "a node another panel at its address refuses joins again with the token"
else
  flunk "a node another panel at its address refuses joins again with the token" "$OUT"
fi
# Not reached yet is no refusal: the earlier join stays, the token is not spent.
seed_node "$T/seed-unreached" "$V" https://192.0.2.10:3443
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (waiting)
Error:   dial panel: connect: connection refused (retrying at 10:40:00)" INSTALLER_TEST_KNOWN_WAIT=0 \
  PRESEED=$T/seed-unreached run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a joined node whose panel is only unreachable keeps its join" "Already joined to https://192.0.2.10:3443"
has "--token t --no-start" && flunk "an unreachable panel does not spend the token on a re-join" "$OUT" || pass "an unreachable panel does not spend the token on a re-join"
# The error quotes the issuer whoever answers at the address chose: "(rejected" in it, or a Panel line
# of its own after the real one, is no refusal (before: the installer matched the whole output and re-joined).
seed_node "$T/seed-forged" "$V" https://panel.example.com
FAKE_STATUS="Node:    n1 (n1)
Panel:   https://panel.example.com (waiting)
Error:   dial panel: tls: failed to verify certificate: x509: certificate signed by unknown authority. The certificate for panel.example.com says it was issued by \"(rejected\", an issuer this server does not trust (retrying at 10:40:00)
Panel:   https://panel.example.com (rejected)" INSTALLER_TEST_KNOWN_WAIT=0 \
  PRESEED=$T/seed-forged run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "an issuer that says (rejected is not a refusal: the earlier join stays" "Already joined to https://panel.example.com" \
  "| The agent was updated and restarted; the join token was not needed."
has "--token t --no-start" && flunk "a forged (rejected does not spend the token on a re-join" "$OUT" || pass "a forged (rejected does not spend the token on a re-join"

for agent in "$V" 0.0.9 "$V-rc.1" dev; do
  seed_node "$T/seed-$agent" "$agent"
  PRESEED=$T/seed-$agent run_installer minisign "$RELEASE_INSTALLER"
  expect_ok "a node whose agent runs $agent takes $V" "$SLUG $V (test) -> /usr/local/bin/$SLUG" "Already installed"
done

seed_node "$T/seed-panel" "$V"
PRESEED=$T/seed-panel FAKE_PANEL_VERSION=$NEWER run_installer minisign "$RELEASE_INSTALLER"
expect_fail "on the panel's node, a panel newer than the release stops the re-run" \
  "the panel on this node runs $BRAND_DISPLAY_NAME $NEWER, newer than $V"
grep -q "label=$SLUG.service=panel00000000000" "$T/log.docker" && pass "the panel's version is read from its own containers" ||
  flunk "the panel's version is read from its own containers" "$(cat "$T/log.docker")"
PRESEED=$T/seed-panel FAKE_PANEL_VERSION=$V run_installer minisign "$RELEASE_INSTALLER"
expect_ok "a panel on the release's version lets the re-run through" "Already installed"

# ---- the panel's uid (go/internal/docker PanelUID) belongs to no account
panel_uid=$(sed -n 's/^PANEL_UID=//p' "$INSTALLER")
nodes_uid=$(sed -n 's/^[[:space:]]*PanelUID[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$root/go/internal/docker/names.go")
[ -n "$panel_uid" ] && [ "$panel_uid" = "$nodes_uid" ] && pass "installer panel uid ($panel_uid) is docker.PanelUID ($nodes_uid)" ||
  flunk "installer panel uid '$panel_uid' differs from docker.PanelUID '$nodes_uid'"
panel_service=$(sed -n 's/^PANEL_SERVICE_ID=//p' "$INSTALLER")
nodes_service=$(sed -n 's/^[[:space:]]*PanelServiceID[[:space:]]*=[[:space:]]*"\([a-z0-9]*\)".*/\1/p' "$root/go/internal/docker/names.go")
[ -n "$panel_service" ] && [ "$panel_service" = "$nodes_service" ] &&
  pass "installer panel service id ($panel_service) is docker.PanelServiceID ($nodes_service)" ||
  flunk "installer panel service id '$panel_service' differs from docker.PanelServiceID '$nodes_service'"
with_getent=$T/with-getent
mkdir -p "$with_getent"
cat >"$with_getent/getent" <<'SHIM'
#!/bin/sh
# getent passwd|group <id>: FAKE_GETENT_<db> names the entry with that id.
case $1 in
passwd) [ -n "${FAKE_GETENT_passwd:-}" ] && echo "$FAKE_GETENT_passwd:x:$2:$2::/home/$FAKE_GETENT_passwd:/bin/bash" ;;
group) [ -n "${FAKE_GETENT_group:-}" ] && echo "$FAKE_GETENT_group:x:$2:" ;;
esac
SHIM
chmod +x "$with_getent/getent"
EXTRA_PATH=$with_getent run_installer minisign "$INSTALLER" --version "$V"
expect_ok "a panel install with the panel's uid free installs quietly" "panel bootstrap --image"
has "the panel's user" && flunk "a free panel uid got a warning" "$OUT" || pass "a free panel uid gets no warning"
FAKE_GETENT_passwd=olduser EXTRA_PATH=$with_getent run_installer minisign "$INSTALLER" --version "$V"
expect_ok "an account with the panel's uid gets a warning" "the passwd entry olduser on this server has id $panel_uid, the panel's user"
# A re-run on a panel that is already installed (an upgrade: the agent then
# moves the folder from uid 1000 to the panel's uid) checks too, and a
# joined node without a panel folder does not.
seed=$T/seed-joined-panel
mkdir -p "$seed/var/lib/$SLUG/panel"
printf 'panel_url: http://127.0.0.1:3000\nnode_id: n1\n' >"$seed/var/lib/$SLUG/config.yml"
FAKE_GETENT_group=oldgroup PRESEED=$seed EXTRA_PATH=$with_getent run_installer minisign "$INSTALLER" --version "$V"
expect_ok "re-running the panel installer warns about an account with the panel's id" "Already installed" \
  "the group entry oldgroup on this server has id $panel_uid, the panel's user"
PRESEED=$seed EXTRA_PATH=$with_getent run_installer minisign "$INSTALLER" --version "$V"
expect_ok "re-running the panel installer with the panel's id free" "Already installed"
has "the panel's user" && flunk "a free panel uid got a warning on a re-run" "$OUT" || pass "a re-run with a free panel uid gets no warning"
rm -rf "$seed/var/lib/$SLUG/panel"
FAKE_GETENT_passwd=olduser PRESEED=$seed EXTRA_PATH=$with_getent run_installer minisign "$INSTALLER" --version "$V"
expect_ok "re-running the installer on a node without a panel" "Already installed"
has "the panel's user" && flunk "a node without a panel got a panel uid warning" "$OUT" || pass "a node without a panel gets no panel uid warning"

# ---- telemetry: on by default; --no-telemetry, SEYLO_TELEMETRY=off or DO_NOT_TRACK=1 reach the panel's bootstrap
run_installer minisign "$INSTALLER" --version "$V"
if [ "$RC" -eq 0 ] && has "panel bootstrap --image $PANEL_REF" && ! has "--no-telemetry"; then
  pass "a plain install leaves telemetry to the setup page (no --no-telemetry)"
else
  flunk "a plain install passed --no-telemetry or failed" "$OUT"
fi
run_installer minisign "$INSTALLER" --version "$V" --no-telemetry
expect_ok "--no-telemetry reaches the panel's bootstrap" "--agent-tls-port 3443 --no-telemetry"
TEST_DO_NOT_TRACK=1 run_installer minisign "$INSTALLER" --version "$V"
expect_ok "DO_NOT_TRACK=1 is --no-telemetry" "--agent-tls-port 3443 --no-telemetry"
TEST_TELEMETRY=off run_installer minisign "$INSTALLER" --version "$V"
expect_ok "SEYLO_TELEMETRY=off is --no-telemetry" "--agent-tls-port 3443 --no-telemetry"
TEST_DO_NOT_TRACK=0 run_installer minisign "$INSTALLER" --version "$V"
if [ "$RC" -eq 0 ] && ! has "--no-telemetry"; then pass "DO_NOT_TRACK=0 changes nothing"; else flunk "DO_NOT_TRACK=0 turned telemetry off" "$OUT"; fi

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

# ---- a join waits for the agent's first connect (seylo status)
# Before: it printed "joins the panel; the node shows up there in a few
# seconds" and exit 0 also when the node could not reach the panel at all.
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a join that connects says so" "Waiting for the agent to connect to the panel" "Connected: the node shows up in the panel now." \
  "| This server is a node of the panel now." "| Next: find it under Nodes in the panel." "| Status: $SLUG status"
unreachable="Node:    n1 (n1)
Agent:   $V
Panel:   https://192.0.2.10:3443 (waiting)
Error:   dial panel 192.0.2.10:3443: connect: no route to host (retrying at 17:04:05)"
FAKE_STATUS=$unreachable INSTALLER_TEST_JOIN_WAIT=0 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a join whose agent cannot reach the panel exits 0 but says it is not connected, why, and what to check" \
  "warning: the agent has not connected to the panel at https://192.0.2.10:3443 after 0 seconds" \
  "Last error: dial panel 192.0.2.10:3443: connect: no route to host (retrying at 17:04:05)" \
  "| Check that this server can reach 192.0.2.10:3443: the panel's server must accept connections on port 3443" \
  "firewall or cloud security group" "| The agent keeps trying in the background. The join token works until it expires, an hour after it was made" \
  "| Check again with: $SLUG status" "| Installed, but not connected to the panel yet."
has "a node of the panel now" && flunk "a join that did not connect does not say it joined" "$OUT" || pass "a join that did not connect does not say it joined"
has "warning above" && flunk "the closing block does not count the not-connected warning it explains" "$OUT" ||
  pass "the closing block does not count the not-connected warning it explains"
has "Connected:" && flunk "a join that did not connect does not say Connected" "$OUT" || pass "a join that did not connect does not say Connected"
# Only the Panel line's state counts: an issuer that says "(connected" in the error, or a Panel line
# after the real one, does not make a join that never connected say it did.
FAKE_STATUS="Panel:   https://panel.example.com (waiting)
Error:   dial panel: x509: certificate signed by unknown authority. The certificate for panel.example.com says it was issued by \"(connected\", an issuer this server does not trust
Panel:   https://panel.example.com (connected, version 0.2.8)" INSTALLER_TEST_JOIN_WAIT=0 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "an issuer that says (connected is no connection" "warning: the agent has not connected to the panel at https://panel.example.com" \
  "| Installed, but not connected to the panel yet."
has "Connected:" && flunk "a forged (connected does not say Connected" "$OUT" || pass "a forged (connected does not say Connected"
# AGENT_TOO_OLD counts only at the start of the error, where the agent puts the rejection.
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (rejected)
Error:   panel rejected the agent: HELLO_REJECT_REASON_NODE_DISABLED: AGENT_TOO_OLD" INSTALLER_TEST_JOIN_WAIT=0 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
[ "$RC" -eq 3 ] && has "warning: the panel refused this node: panel rejected the agent: HELLO_REJECT_REASON_NODE_DISABLED" &&
  pass "AGENT_TOO_OLD later in the error is a refusal like any other" || flunk "AGENT_TOO_OLD later in the error (exit $RC)" "$OUT"
FAKE_STATUS="$SLUG: no agent socket at $BRAND_DATA_DIR/agent.sock: is the agent running? Try \`$SLUG start\`" FAKE_STATUS_EXIT=1 \
  INSTALLER_TEST_JOIN_WAIT=0 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "an agent that is not up yet is reported with what seylo status said, the domain on 443" \
  "Last error: no agent socket at $BRAND_DATA_DIR/agent.sock: is the agent running?" "Check that this server can reach panel.example.com:443"
FAKE_STATUS=$unreachable INSTALLER_TEST_JOIN_WAIT=0 run_installer none "$PLACEHOLDER_INSTALLER" join --panel 'https://[2001:db8::7]' --token t --binary "$T/local-binary"
expect_ok "an IPv6 panel without a port is reached on 443" "Check that this server can reach [2001:db8::7]:443"
# A firewall that decrypts HTTPS re-signs the panel's certificate: not a port problem.
inspected="Node:    n1 (n1)
Agent:   $V
Panel:   https://panel.example.com (waiting)
Error:   dial panel: failed to WebSocket dial: failed to send handshake request: Get \"https://panel.example.com/api/agent/connect\": tls: failed to verify certificate: x509: certificate signed by unknown authority. The certificate for panel.example.com was issued by Fortinet, FG800D5818800524, which this server does not trust. If that is not who issued the panel's certificate, a firewall or proxy on this server's network decrypts HTTPS (TLS inspection): exempt panel.example.com from it, or join with the panel's IP address and --pin (retrying at 10:32:36)"
FAKE_STATUS=$inspected INSTALLER_TEST_JOIN_WAIT=0 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "a certificate a firewall re-signed gets the TLS inspection hint, not the port one" \
  "issued by Fortinet, FG800D5818800524" "| This server did not get the panel's certificate for panel.example.com" \
  "TLS inspection) does this: exempt panel.example.com from it" "the second command in the panel's Add node dialog"
has "must accept connections on port" && flunk "the TLS inspection hint replaces the port hint" "$OUT" || pass "the TLS inspection hint replaces the port hint"
# A 0.2.7 agent says only x509: the same hint.
FAKE_STATUS="Panel:   https://panel.example.com (waiting)
Error:   dial panel: tls: failed to verify certificate: x509: certificate signed by unknown authority" INSTALLER_TEST_JOIN_WAIT=0 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "an x509 error alone gets the TLS inspection hint" "| This server did not get the panel's certificate for panel.example.com"
FAKE_STATUS="Panel:   https://panel.example.com (waiting)
Error:   dial panel: x509: certificate signed by unknown authority. panel.example.com answers with Traefik's own certificate: the panel's server has no certificate for that name yet (see the panel domain's status)" \
  INSTALLER_TEST_JOIN_WAIT=0 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://panel.example.com --token t --binary "$T/local-binary"
expect_ok "Traefik's own certificate points at the panel domain's status" "| panel.example.com has no certificate yet: open the panel's Settings > General"
started=$(date +%s)
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (rejected)
Error:   the panel refused the join: the token is unknown, used or expired" INSTALLER_TEST_JOIN_WAIT=30 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
# Before: exit 0, so cloud-init or Terraform reported a node that never connects as joined.
expect_fail "a refused join stops waiting and says to make a new join command" \
  "warning: the panel refused this node: the panel refused the join: the token is unknown, used or expired"
has "| Make a new join command in the panel's Add node dialog" && has "| Installed, but the panel refused this node." &&
  pass "a refused join says what to do and that the node is refused" || flunk "a refused join's closing block" "$OUT"
[ "$RC" -eq 3 ] && pass "a refused join exits 3" || flunk "a refused join exits 3 (exit $RC)" "$OUT"
has "keeps trying in the background" && flunk "a refused join does not say the agent keeps trying" "$OUT" ||
  pass "a refused join does not say the agent keeps trying"
[ $(($(date +%s) - started)) -lt 15 ] && pass "a refused join does not wait out the full time" || flunk "a refused join waited the full time"
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (rejected)
Error:   dial panel 192.0.2.10:3443: conn: panel certificate does not match the pinned key" INSTALLER_TEST_JOIN_WAIT=0 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
[ "$RC" -eq 3 ] && has "warning: the panel refused this node" && pass "a join refused for another reason (a wrong pin) exits 3 too" ||
  flunk "a join refused for another reason exits 3 (exit $RC)" "$OUT"
# A panel that only needs a newer agent: the agent updates itself, so the join waits and exits 0.
FAKE_STATUS="Panel:   https://192.0.2.10:3443 (rejected)
Error:   panel rejected the agent: HELLO_REJECT_REASON_AGENT_TOO_OLD: this panel needs agent 0.3.0 or newer (retrying at 17:04:05)" \
  INSTALLER_TEST_JOIN_WAIT=2 run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a panel that needs a newer agent is waited for like an unreachable one and exits 0" \
  "warning: the panel needs a newer agent than this one: panel rejected the agent: HELLO_REJECT_REASON_AGENT_TOO_OLD" \
  "| The agent updates itself to the panel's release and connects after that." "| Installed, but not connected to the panel yet."
has "the panel refused this node" && flunk "AGENT_TOO_OLD is not reported as refused" "$OUT" || pass "AGENT_TOO_OLD is not reported as refused"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary" --dry-run
expect_ok "a dry-run join only shows the wait" "+ $SLUG status (until the agent is connected, up to 60s)"

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

# ---- Docker missing: installed without a question (owner decision for 0.2.1)
# The installer asks nothing on the way: a join piped into sh over ssh, from
# cloud-init or in CI has nobody to answer, and it used to stop halfway with
# "Docker is missing". The one question is the menu (ask_mode, 0.2.6, owner
# request), only when no mode is named and a person is at a terminal.
outside_menu=$(awk '/^ask_mode\(\) \{/{inside=1} inside&&/^\}/{inside=0; next} !inside' "$INSTALLER")
if grep -qF -- '[y/N]' "$INSTALLER" || printf '%s\n' "$outside_menu" | grep -q -- '/dev/tty'; then
  flunk "the installer asks no questions outside the menu" "found [y/N] or /dev/tty outside ask_mode in $INSTALLER"
else
  pass "the installer asks no questions outside the menu"
fi
for mode in panel join; do
  args=(--version "$V")
  [ "$mode" = panel ] || args=(join --panel https://192.0.2.10:3443 --token t --pin "sha256:$(printf '%064d' 1)" --version "$V")
  NO_DOCKER_CLI=1 run_installer minisign "$INSTALLER" "${args[@]}"
  expect_ok "[$mode] Docker missing: installed from get.docker.com without asking" \
    "Docker is missing: installing it with the official script from get.docker.com" "+ sh " "+ systemctl enable --now docker"
  NO_DOCKER_CLI=1 run_installer minisign "$INSTALLER" "${args[@]}" --install-docker --yes
  expect_ok "[$mode] --install-docker and --yes still work (no-ops for a missing Docker)" "Docker is missing: installing it"
  NO_DOCKER_CLI=1 run_installer minisign "$INSTALLER" "${args[@]}" --no-docker-install
  expect_fail "[$mode] --no-docker-install stops instead" "--no-docker-install was given"

  # Installed but dockerd does not start (a bad daemon.json, a masked unit).
  # Before: "Docker is missing" and get.docker.com over it without asking,
  # which swaps docker.io, containerd and runc and still does not start.
  FAKE_DOCKER_DOWN=1 run_installer minisign "$INSTALLER" "${args[@]}"
  expect_fail "[$mode] an installed Docker that does not start stops the install" \
    "Docker is installed but not running, and systemctl start docker did not start it. See why with systemctl status docker and journalctl -u docker"
  if has "+ systemctl start docker" && ! has "+ sh " && ! has "Docker is missing" && [ ! -e "$R/usr/local/bin/$SLUG" ]; then
    pass "[$mode] it tries systemctl start docker, then installs nothing (no get.docker.com, no agent)"
  else
    flunk "[$mode] an installed Docker that does not start is left alone" "$OUT"
  fi
  FAKE_DOCKER_DOWN=1 run_installer minisign "$INSTALLER" "${args[@]}" --install-docker
  expect_ok "[$mode] --install-docker reinstalls a Docker that does not start" \
    "Docker is installed but does not start: reinstalling it with the official script from get.docker.com" "+ sh " "+ systemctl enable --now docker"
  FAKE_DOCKER_DOWN=1 run_installer minisign "$INSTALLER" "${args[@]}" --yes
  expect_ok "[$mode] --yes reinstalls it too, as before 0.2.1" "reinstalling it with the official script" "+ sh "
  FAKE_DOCKER_DOWN=1 run_installer minisign "$INSTALLER" "${args[@]}" --install-docker --no-docker-install
  expect_fail "[$mode] --no-docker-install wins over --install-docker" "Docker is installed but not running"
done
FAKE_DOCKER_DOWN=1 run_installer minisign "$INSTALLER" --version "$V" --dry-run
expect_ok "--dry-run with Docker installed but not running shows the start and goes on" \
  "+ systemctl start docker" "warning: Docker is installed but not running: the install starts it" "panel bootstrap --image"
has "+ sh " && flunk "--dry-run with Docker not running plans no get.docker.com" "$OUT" || pass "--dry-run with Docker not running plans no get.docker.com"
run_installer minisign "$INSTALLER" --version "$V"
has "installing it with the official script" && flunk "a running Docker is not installed again" "$OUT" || pass "a running Docker is not installed again"
"$SH" "$INSTALLER" --help >"$T/help.txt" 2>&1 || true
grep -q "installs Docker with the official script" "$T/help.txt" && grep -q -- "--no-docker-install" "$T/help.txt" &&
  pass "--help says Docker is installed when missing and how to opt out" || flunk "--help on installing Docker" "$(cat "$T/help.txt")"
grep -q -- "--install-docker     also reinstall Docker" "$T/help.txt" &&
  pass "--help says --install-docker reinstalls a Docker that does not start" || flunk "--help on --install-docker" "$(cat "$T/help.txt")"
grep -q "3 for a join the panel refused" "$T/help.txt" &&
  pass "--help gives the exit status of a refused join" || flunk "--help on the exit status" "$(cat "$T/help.txt")"

# ---- output: plain text off a terminal, colors and box lines on one
# Every run above is plain output, what logs, pipes and CI get: the same
# lines as before 0.2.1 plus a banner and a closing block, no escape code
# and only ASCII. INSTALLER_TEST_COLOR=1 (TEST_COLOR) stands in for a
# terminal; NO_COLOR and TERM=dumb take the colors away again.
E=$(printf '\033')
CHECK=$(printf '\342\234\223')
BAR=$(printf '\342\224\202')
has_esc() { printf '%s' "$OUT" | grep -q "$E"; }
non_ascii() { printf '%s' "$OUT" | LC_ALL=C tr -d '\000-\177' | wc -c | tr -d ' '; }
strip_esc() { printf '%s\n' "$OUT" | sed "s/$E\[[0-9;]*m//g"; }
rule=+$(printf '%72s' '' | tr ' ' -)
expect_plain() { # name
  if [ "$RC" -ne 0 ]; then flunk "$1 (exit $RC)" "$OUT"; return; fi
  if has_esc || [ "$(non_ascii)" != 0 ]; then flunk "$1: escape codes or non-ASCII in plain output" "$OUT"; return; fi
  pass "$1"
}

fresh_release
run_installer minisign "$INSTALLER" --version "$V"
expect_plain "a panel install off a terminal prints plain ASCII without escape codes"
first=$(printf '%s\n' "$OUT" | head -1)
[ "$first" = "$BRAND_DISPLAY_NAME $V installer - the panel and a node on this server" ] &&
  pass "the run starts with a one-line banner: product, release, what it does" || flunk "the banner" "$first"
# The end of a panel install: a framed block with the setup link on its own
# line, how long it works and the next step. --root writes a stand-in link.
cat >"$T/want-panel-end" <<EOF
$rule
| The panel is running. Open this link to create the owner account:
|
|   http://<server-ip>:3000/setup?t=<setup token>
|
| It works once, within an hour.
| With --root the panel did not start, so this link is a stand-in.
|
| Next: open it in a browser, create the owner account and follow the setup wizard.
| A new link when this one expires: $SLUG panel setup-link
| 1 warning above: read it before you go on.
| Docs: $BRAND_DOCS_URL
$rule
EOF
printf '%s\n' "$OUT" | tail -n "$(wc -l <"$T/want-panel-end")" >"$T/got-panel-end"
cmp -s "$T/want-panel-end" "$T/got-panel-end" &&
  pass "a panel install ends with the setup link framed, how long it works and the next step" ||
  flunk "the closing block of a panel install" "$(diff "$T/want-panel-end" "$T/got-panel-end" || true)"

TEST_COLOR=1 run_installer minisign "$INSTALLER" --version "$V"
if [ "$RC" -eq 0 ] && has_esc; then pass "INSTALLER_TEST_COLOR=1 turns colors on"; else flunk "INSTALLER_TEST_COLOR=1 turns colors on" "$OUT"; fi
for want in \
  "banner, product in bold brand blue|${E}[1m${E}[34m$BRAND_DISPLAY_NAME${E}[0m${E}[1m $V installer${E}[0m${E}[2m - the panel and a node on this server${E}[0m" \
  "step header in bold brand blue|${E}[1m${E}[34m==> Docker${E}[0m" \
  "success line with a green check|${E}[32m$CHECK ${E}[0mRelease signature verified" \
  "warning in yellow, the label bold|${E}[1m${E}[33mwarning:${E}[0m${E}[33m TEST BUILD" \
  "dim command trace|${E}[2m+ systemctl reload docker${E}[0m" \
  "the setup link underlined in cyan|${E}[4;36mhttp://<server-ip>:3000/setup?t=<setup token>${E}[0m" \
  "a command in cyan|${E}[36m$SLUG panel setup-link${E}[0m" \
  "a note in dim|${E}[2mWith --root the panel did not start" \
  "rounded box lines|$(printf '\342\225\255\342\224\200\342\224\200')" \
  "the box's bar|$BAR${E}[0m ${E}[1mThe panel is running."; do
  has "${want#*|}" && pass "colors: ${want%%|*}" || flunk "colors: ${want%%|*}" "$(printf '%s' "$OUT" | od -c | head -40)"
done
strip_esc | grep -qxF "$BAR   http://<server-ip>:3000/setup?t=<setup token>" &&
  pass "colors: the setup link is on its own line" || flunk "colors: the setup link is on its own line" "$(strip_esc)"
TEST_COLOR=1 TEST_TERM=xterm-256color run_installer minisign "$INSTALLER" --version "$V"
has "${E}[38;5;27m==>" && pass "colors: a 256-color terminal gets the nearest brand blue (27)" || flunk "colors: 256-color brand blue" "$OUT"
TEST_COLOR=1 TEST_TERM=xterm-256color TEST_COLORTERM=truecolor run_installer minisign "$INSTALLER" --version "$V"
has "${E}[38;2;37;99;235m==>" && pass "colors: a 24-bit terminal gets the brand blue itself" || flunk "colors: 24-bit brand blue" "$OUT"
TEST_COLOR=1 TEST_NO_COLOR=1 run_installer minisign "$INSTALLER" --version "$V"
if [ "$RC" -eq 0 ] && ! has_esc && has "$CHECK Release signature verified" && has "$BAR The panel is running."; then
  pass "NO_COLOR removes every escape code (the check mark and box lines stay)"
else
  flunk "NO_COLOR removes every escape code" "$OUT"
fi
TEST_COLOR=1 TEST_TERM=dumb run_installer minisign "$INSTALLER" --version "$V"
[ "$RC" -eq 0 ] && ! has_esc && pass "TERM=dumb gets no escape codes" || flunk "TERM=dumb gets no escape codes" "$OUT"
# The Linux console's fonts have no check mark or rounded corners: colors, ASCII lines.
TEST_COLOR=1 TEST_TERM=linux run_installer minisign "$INSTALLER" --version "$V"
if [ "$RC" -eq 0 ] && has_esc && [ "$(non_ascii)" = 0 ] && strip_esc | grep -qxF "$rule"; then
  pass "TERM=linux gets colors with ASCII box lines and no check mark"
else
  flunk "TERM=linux gets colors with ASCII box lines and no check mark" "$OUT"
fi
TEST_COLOR=1 run_installer minisign "$INSTALLER" --port nope
expect_fail "colors: an error still fails" "--port must be a number"
has "${E}[1m${E}[31merror:${E}[0m${E}[31m --port must be a number${E}[0m" && pass "colors: errors in red, the label bold" ||
  flunk "colors: errors in red" "$OUT"
TEST_COLOR=1 TEST_NO_COLOR=1 run_installer minisign "$INSTALLER" --port nope
[ "$RC" -ne 0 ] && ! has_esc && has "error: --port must be a number" && pass "NO_COLOR: errors without escape codes" ||
  flunk "NO_COLOR: errors without escape codes" "$OUT"

# On a terminal the closing block wraps at 72 columns (a link stays whole);
# plain output keeps each sentence on one line, so logs can be searched.
FAKE_STATUS=$unreachable INSTALLER_TEST_JOIN_WAIT=0 TEST_COLOR=1 \
  run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
long=$(strip_esc | LC_ALL=C awk -v bar="$BAR" 'index($0, bar) == 1 && length($0) > length(bar) + 73' || true)
joined=$(strip_esc | sed -n "s/^$BAR //p" | tr '\n' ' ')
if [ "$RC" -eq 0 ] && [ -z "$long" ] &&
  printf '%s' "$joined" | grep -qF "Check that this server can reach 192.0.2.10:3443: the panel's server must accept connections on port 3443"; then
  pass "on a terminal the closing block wraps its text at 72 columns"
else
  flunk "on a terminal the closing block wraps its text at 72 columns" "$long
$(strip_esc)"
fi
has "${E}[1m${E}[33mwarning:${E}[0m${E}[33m the agent has not connected" && has "${E}[1mInstalled, but not connected to the panel yet.${E}[0m" &&
  pass "colors: a join that did not connect" || flunk "colors: a join that did not connect" "$OUT"
run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_plain "a join off a terminal prints plain ASCII"
tail -n 1 <<<"$OUT" | grep -qxF "$rule" && pass "a join ends with its closing block" || flunk "a join ends with its closing block" "$OUT"
printf '%s\n' "$OUT" | head -1 | grep -qxF "$BRAND_DISPLAY_NAME installer (latest release) - add this server to the panel at https://192.0.2.10:3443" &&
  pass "a join's banner says what it joins" || flunk "a join's banner" "$OUT"

# Re-runs end with a block too; on a panel without an owner it points at a new setup link.
seed=$T/seed-no-owner
mkdir -p "$seed/var/lib/$SLUG/panel"
printf 'panel_url: http://127.0.0.1:3000\nnode_id: n1\n' >"$seed/var/lib/$SLUG/config.yml"
PRESEED=$seed run_installer minisign "$INSTALLER" --version "$V"
expect_ok "a re-run on the panel's node ends with a block" "| The agent was updated and restarted. The panel keeps its data." \
  "| Status: $SLUG status" "| Panel: $SLUG panel status"
has "No owner account yet" && flunk "a panel with an owner gets no setup link hint" "$OUT" || pass "a panel with an owner gets no setup link hint"
printf '%s\n' "${SLUG}_setup_x" >"$seed/var/lib/$SLUG/panel/setup-token"
PRESEED=$seed run_installer minisign "$INSTALLER" --version "$V"
expect_ok "a re-run on a panel without an owner says how to get a new setup link" \
  "| No owner account yet. A new setup link: $SLUG panel setup-link"
seed_node "$T/seed-rejoin" "$V" https://192.0.2.10:3443
PRESEED=$T/seed-rejoin run_installer none "$PLACEHOLDER_INSTALLER" join --panel https://192.0.2.10:3443 --token t --binary "$T/local-binary"
expect_ok "a re-run on a joined node ends with a block" "| The agent was updated and restarted; the join token was not needed." "| Status: $SLUG status"

run_installer minisign "$INSTALLER" --version "$V" --dry-run
expect_plain "a dry run prints plain ASCII"
has "(dry run: nothing changes)" && has "==> Dry run done: nothing was changed" && ! has "$rule" &&
  pass "a dry run says so at the start and the end, without a closing block" || flunk "a dry run's banner and end" "$OUT"
run_installer none "$PLACEHOLDER_INSTALLER" uninstall
expect_plain "an uninstall prints plain ASCII"
has "$BRAND_DISPLAY_NAME installer (latest release) - remove the agent from this server" && pass "an uninstall's banner" ||
  flunk "an uninstall's banner" "$OUT"
grep -q "NO_COLOR=1 turns the colors off" "$T/help.txt" && pass "--help says NO_COLOR turns the colors off" ||
  flunk "--help on NO_COLOR" "$(cat "$T/help.txt")"
grep -q -- "--link-file" "$INSTALLER" && grep -q '"link-file"' "$root/go/internal/cli/panel.go" &&
  pass "the installer passes bootstrap's --link-file, which panel.go defines" || flunk "--link-file in the installer and panel.go"

# on_exit: a run that fails after the panel started never reaches its
# closing block, so the exit trap prints the setup link; a run that ends
# well, or fails before there is a link, prints nothing more. --root never
# fails there, so the function runs on its own.
sed -n '/^on_exit() {$/,/^}$/p' "$INSTALLER" >"$T/on-exit.sh"
cat >>"$T/on-exit.sh" <<'EOF'
WORK=$3
LINK_FILE=$WORK/setup-link
mkdir -p "$WORK"
[ -z "$1" ] || printf '%s\nA note.\n' "$1" >"$LINK_FILE"
trap on_exit EXIT
exit "$2"
EOF
link="http://203.0.113.9:3000/setup?t=${SLUG}_setup_x"
set +e
lost=$("$SH" "$T/on-exit.sh" "$link" 1 "$T/exit-1" 2>&1)
lost_rc=$?
ended=$("$SH" "$T/on-exit.sh" "$link" 0 "$T/exit-2" 2>&1)
early=$("$SH" "$T/on-exit.sh" "" 1 "$T/exit-3" 2>&1)
early_rc=$?
set -e
if [ "$lost_rc" = 1 ] && printf '%s\n' "$lost" | grep -qxF "  $link" && ! printf '%s' "$lost" | grep -q "A note" && [ ! -e "$T/exit-1" ]; then
  pass "a run that fails after the panel started still prints the setup link, keeps its exit code and removes its folder"
else
  flunk "a run that fails after the panel started still prints the setup link" "rc $lost_rc: $lost"
fi
[ -z "$ended$early" ] && [ "$early_rc" = 1 ] && [ ! -e "$T/exit-2" ] && [ ! -e "$T/exit-3" ] &&
  pass "the exit trap prints nothing after the closing block or before the panel started" ||
  flunk "the exit trap prints nothing after the closing block or before the panel started" "$ended
$early"

if [ "$failures" -gt 0 ]; then
  echo "installer tests: $failures failed"
  exit 1
fi
echo "installer tests: all passed"
