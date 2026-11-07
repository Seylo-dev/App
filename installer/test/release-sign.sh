#!/usr/bin/env bash
# Tests for scripts/release-sign.sh, the Sign job of a tag release: a release
# folder as the Draft release job hands it over (dist/release/), signed with a
# throwaway minisign key that stands in for brand.json's, and a fake draft
# release behind a gh shim for the upload. Nothing here touches GitHub or the
# network.
#
# Needs: minisign and jq (skips without them), Go (releasetool writes the real
# manifest; or RELEASETOOL=<prebuilt binary>).
#
# Usage: installer/test/release-sign.sh     (make test-release)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)

for t in minisign jq; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "release sign tests: SKIP ($t is not installed)"
    exit 0
  fi
done

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# shellcheck disable=SC1091
. "$root/installer/brand.env"
SLUG=$BRAND_SLUG
REPO=$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO
V=0.1.0
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
  printf 'FAIL %s\n' "$1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/     | /'
  failures=$((failures + 1))
}

# ---- tools: an explicit PATH, so gh is always the shim
tools=$T/tools
mkdir -p "$tools"
for t in awk bash cat cmp cp cut dirname env grep head jq ls minisign mkdir mktemp mv rm sed sort tail tr wc \
  sha256sum shasum perl; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$tools/$t"
done

shims=$T/shims
mkdir -p "$shims"
cat >"$shims/gh" <<'EOF'
#!/bin/sh
# gh api --paginate repos/<repo>/releases?per_page=100: $FAKE_GH/releases.json
# gh api repos/<repo>/releases/assets/<id> -H "Accept: application/octet-stream": $FAKE_GH/assets/<id>
# gh release upload <tag> <file>... --repo <repo> --clobber: copies into $FAKE_GH/uploaded/
printf '%s\n' "$*" >>"$FAKE_GH/log"
case "$1 $2" in
"api --paginate")
  [ "$3" = "repos/$FAKE_REPO/releases?per_page=100" ] || { echo "fake gh: api $3 is not faked" >&2; exit 1; }
  cat "$FAKE_GH/releases.json"
  ;;
"api repos/$FAKE_REPO/releases/assets/"*)
  [ "$3 $4" = "-H Accept: application/octet-stream" ] || { echo "fake gh: asset metadata is not faked" >&2; exit 1; }
  f=$FAKE_GH/assets/${2##*/}
  [ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  cat "$f"
  ;;
"release upload")
  shift 3
  mkdir -p "$FAKE_GH/uploaded"
  while [ $# -gt 0 ]; do
    case $1 in
    --repo) [ "$2" = "$FAKE_REPO" ] || { echo "fake gh: upload to $2" >&2; exit 1; }; shift ;;
    --clobber) ;;
    -*) echo "fake gh: release upload $1 is not faked" >&2; exit 1 ;;
    *) cp "$1" "$FAKE_GH/uploaded/" ;;
    esac
    shift
  done
  ;;
*) echo "fake gh: gh $* is not faked" >&2; exit 1 ;;
esac
EOF
chmod +x "$shims/gh"

# ---- keys: the release key has a password, as the real one does
printf 'release-pass\nrelease-pass\n' | minisign -G -p "$T/test.pub" -s "$T/test.key" >/dev/null 2>&1
minisign -G -W -p "$T/other.pub" -s "$T/other.key" >/dev/null
KEY=$(sed -n 2p "$T/test.pub")

if [ -n "${RELEASETOOL:-}" ]; then
  cp "$RELEASETOOL" "$T/releasetool"
else
  go -C "$root/go" build -o "$T/releasetool" ./internal/update/releasetool
fi

checksums() { # <dir>: checksums.txt as goreleaser writes it (the binaries and checksum.extra_files)
  (cd "$1" && for f in install.sh openapi.json "${SLUG}"_*; do printf '%s  %s\n' "$(sha256 <"$f")" "$f"; done) >"$T/checksums.txt"
  mv "$T/checksums.txt" "$1/checksums.txt"
}
manifest() { # <dir> <version>
  "$T/releasetool" -version "$2" -binaries "$1" -image "$BRAND_IMAGE:$2" -digest "sha256:$(printf index | sha256)" \
    -installer "$1/install.sh" -out "$1/manifest.json" >/dev/null
}
# make_dir [version]: D is a release folder as the Draft release job hands it
# over for <version> (default $V): binaries, install.sh, openapi.json,
# checksums.txt and manifest.json, nothing signed.
make_dir() {
  local v=${1:-$V} t
  D=$T/release
  rm -rf "$D"
  mkdir -p "$D"
  for t in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64.exe windows_arm64.exe; do
    printf 'fake %s binary %s %s\n' "$SLUG" "$t" "$v" >"$D/${SLUG}_$t"
  done
  "$root/scripts/render-installer.sh" "$v" "$D/install.sh" >/dev/null
  printf '{"openapi":"3.1.0"}\n' >"$D/openapi.json"
  checksums "$D"
  manifest "$D" "$v"
}

# run [VAR=value...] <args>: runs the script with the test key standing in
# for brand.json's and the gh shim; sets OUT and RC.
run() {
  local envs=()
  while [ $# -gt 0 ] && [[ "$1" == [A-Z]*=* ]]; do
    envs+=("$1")
    shift
  done
  rm -f "$FAKE_GH/log"
  set +e
  OUT=$(env -i PATH="$shims:$tools" HOME="$T" TMPDIR="$T" FAKE_GH="$FAKE_GH" FAKE_REPO="$REPO" GH_TOKEN=gh-token \
    BRAND_SLUG="$SLUG" BRAND_PLACEHOLDER_PREFIX="$BRAND_PLACEHOLDER_PREFIX" BRAND_GITHUB_ORG="$BRAND_GITHUB_ORG" \
    BRAND_GITHUB_REPO="$BRAND_GITHUB_REPO" BRAND_MINISIGN_PUBLIC_KEY="$KEY" \
    MINISIGN_SECRET_KEY="$T/test.key" MINISIGN_PASSWORD=release-pass \
    ${envs[@]+"${envs[@]}"} bash "$root/scripts/release-sign.sh" "$@" 2>&1)
  RC=$?
  set -e
}
has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
expect_ok() { # name strings...
  local name=$1 s
  shift
  if [ "$RC" -ne 0 ]; then flunk "$name (exit $RC)" "$OUT"; return; fi
  for s in "$@"; do has "$s" || { flunk "$name: missing \"$s\"" "$OUT"; return; }; done
  pass "$name"
}
expect_fail() { # name string: the run failed, printed the string and left no signature
  if [ "$RC" -eq 0 ]; then flunk "$1 (exit 0, expected a failure)" "$OUT"; return; fi
  has "$2" || { flunk "$1: missing \"$2\"" "$OUT"; return; }
  if ls "$D"/*.minisig >/dev/null 2>&1; then flunk "$1: a signature was left behind" "$(ls "$D")"; return; fi
  pass "$1"
}
FAKE_GH=$T/gh
mkdir -p "$FAKE_GH"

# ---- sign
make_dir
run sign "$V" "$D"
expect_ok "a complete release folder is signed" "release-sign: signed checksums.txt (8 files) and manifest.json for $SLUG $V"
for f in checksums.txt manifest.json; do
  if out=$(minisign -V -P "$KEY" -m "$D/$f" -x "$D/$f.minisig" 2>&1) && grep -qxF "Trusted comment: $SLUG $V $f" <<<"$out"; then
    pass "$f.minisig verifies with the release key and names $SLUG $V"
  else
    flunk "$f.minisig verifies with the release key" "$out"
  fi
done
# As SECURITY.md and the README tell users to check a download by hand.
sha256_check() { if command -v shasum >/dev/null; then shasum -a 256 -c -; else sha256sum -c -; fi; }
if (cd "$D" && minisign -Vqm checksums.txt -P "$KEY" &&
  awk -v n="${SLUG}_darwin_arm64" '$2 == n' checksums.txt | sha256_check >/dev/null); then
  pass "a download checks out by hand against the signed checksums.txt"
else
  flunk "a download checks out by hand against the signed checksums.txt"
fi
if (cd "$D" && awk -v n="${SLUG}_freebsd_amd64" '$2 == n' checksums.txt | sha256_check >/dev/null 2>&1); then
  flunk "checking a file checksums.txt does not list fails"
else
  pass "checking a file checksums.txt does not list fails"
fi

make_dir
run MINISIGN_PASSWORD=wrong sign "$V" "$D"
expect_fail "a wrong key password signs nothing" "could not sign checksums.txt with MINISIGN_SECRET_KEY (wrong password?)"
make_dir
run MINISIGN_SECRET_KEY="$T/other.key" MINISIGN_PASSWORD= sign "$V" "$D"
expect_fail "a secret key that is not brand.json's leaves no signature" "does not verify with brand.json minisignPublicKey"
make_dir
run MINISIGN_SECRET_KEY= sign "$V" "$D"
expect_fail "no secret key, no signature" "MINISIGN_SECRET_KEY must name the release key file"
make_dir
run BRAND_MINISIGN_PUBLIC_KEY="${BRAND_PLACEHOLDER_PREFIX}MINISIGN_PUBLIC_KEY" sign "$V" "$D"
expect_fail "the placeholder public key is refused" "minisignPublicKey is a placeholder"
make_dir
run BRAND_MINISIGN_PUBLIC_KEY="$(sed -n 2p "$root/test/e2e-colima/keys/e2e-test.pub")" sign "$V" "$D"
expect_fail "the committed e2e test key is refused" "TEST-ONLY e2e key"
make_dir
run sign "v$V" "$D"
expect_fail "sign takes a version, not a tag" "is not a MAJOR.MINOR.PATCH[-PRERELEASE] version"

make_dir
printf 'replaced\n' >"$D/${SLUG}_darwin_arm64"
run sign "$V" "$D"
expect_fail "a binary that does not match checksums.txt is not signed" "${SLUG}_darwin_arm64 does not match its sha256 in checksums.txt"
make_dir
grep -v ' install.sh$' "$D/checksums.txt" >"$T/c" && mv "$T/c" "$D/checksums.txt"
run sign "$V" "$D"
expect_fail "a checksums.txt without install.sh is not signed" "checksums.txt does not list install.sh"
make_dir
rm "$D/${SLUG}_windows_arm64.exe"
run sign "$V" "$D"
expect_fail "a listed file missing from the folder is refused" "checksums.txt lists ${SLUG}_windows_arm64.exe, but it is not in"
make_dir
mv "$D/openapi.json" "$T/openapi.json"
ln -s "$T/openapi.json" "$D/openapi.json"
run sign "$V" "$D"
expect_fail "a listed file that is a link out of the folder is refused" "checksums.txt lists openapi.json, but it is not in"
make_dir
printf '%s  ../%s\n' "$(printf x | sha256)" outside >>"$D/checksums.txt"
run sign "$V" "$D"
expect_fail "a checksums.txt line naming a path is refused" "checksums.txt line 9 is not"
make_dir
tail -1 "$D/checksums.txt" >"$T/last" && cat "$T/last" >>"$D/checksums.txt"
run sign "$V" "$D"
expect_fail "a file listed twice is refused" "lists ${SLUG}_windows_arm64.exe twice"

make_dir
manifest "$D" 0.0.9
run sign "$V" "$D"
expect_fail "a manifest for another version is not signed" "manifest.json is not for version $V"
make_dir
mkdir -p "$T/other-bins" && cp "$D/${SLUG}"_linux_* "$T/other-bins/" && printf 'other\n' >>"$T/other-bins/${SLUG}_linux_arm64"
"$T/releasetool" -version "$V" -binaries "$T/other-bins" -image "$BRAND_IMAGE:$V" -digest "sha256:$(printf index | sha256)" \
  -installer "$D/install.sh" -out "$D/manifest.json" >/dev/null
run sign "$V" "$D"
expect_fail "a manifest with another agent binary is not signed" "manifest.json does not have the sha256 of ${SLUG}_linux_arm64"
make_dir
jq '.panel.digest = "latest"' "$D/manifest.json" >"$T/m" && mv "$T/m" "$D/manifest.json"
run sign "$V" "$D"
expect_fail "a manifest that does not pin the panel image is not signed" "does not pin the panel image by digest"

make_dir
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" "$V" "$D/install.sh" >/dev/null 2>&1
checksums "$D"
manifest "$D" "$V"
run sign "$V" "$D"
expect_fail "a test-build install.sh is never signed" "install.sh is a TEST BUILD"
make_dir 0.0.9
manifest "$D" "$V"
run sign "$V" "$D"
expect_fail "an install.sh for another version is not signed" "install.sh does not install $V"

# ---- upload
# draft_with <dir> [draft|published]: the fake draft release v$V carrying the
# folder's files, as the Draft release job leaves it.
draft_with() {
  local state=${2:-draft} n=0 f assets='[]'
  rm -rf "$FAKE_GH/assets" "$FAKE_GH/uploaded"
  mkdir -p "$FAKE_GH/assets"
  for f in "$1"/*; do
    case $f in *.minisig) continue ;; esac
    n=$((n + 1))
    cp "$f" "$FAKE_GH/assets/$((500 + n))"
    assets=$(jq -c --arg name "${f##*/}" --argjson id $((500 + n)) '. + [{id: $id, name: $name, state: "uploaded"}]' <<<"$assets")
  done
  jq -n --arg tag "v$V" --argjson draft "$([ "$state" = draft ] && echo true || echo false)" --argjson assets "$assets" \
    '[{id: 7, tag_name: $tag, draft: $draft, assets: $assets}, {id: 6, tag_name: "v0.0.9", draft: false, assets: []}]' \
    >"$FAKE_GH/releases.json"
}
uploaded() { [ ! -d "$FAKE_GH/uploaded" ] || (cd "$FAKE_GH/uploaded" && printf '%s ' *); }

make_dir
draft_with "$D"
run sign "$V" "$D"
run upload "v$V" "$D"
expect_ok "the signatures are uploaded to the one draft with the tag" "uploaded checksums.txt.minisig and manifest.json.minisig to the draft v$V"
if [ "$(uploaded)" = "checksums.txt.minisig manifest.json.minisig " ] &&
  grep -qxF "release upload v$V $D/checksums.txt.minisig $D/manifest.json.minisig --repo $REPO --clobber" "$FAKE_GH/log" &&
  cmp -s "$FAKE_GH/uploaded/checksums.txt.minisig" "$D/checksums.txt.minisig"; then
  pass "only the two signatures are uploaded, nothing else"
else
  flunk "only the two signatures are uploaded" "$(uploaded); $(cat "$FAKE_GH/log")"
fi

run upload "$V" "$D"
if [ "$RC" -ne 0 ] && has "is not a vMAJOR.MINOR.PATCH[-PRERELEASE] tag"; then pass "upload takes a tag, not a version"; else flunk "upload takes a tag" "$OUT"; fi

draft_with "$D"
jq '. + [.[0] | .id = 8]' "$FAKE_GH/releases.json" >"$T/r" && mv "$T/r" "$FAKE_GH/releases.json"
run upload "v$V" "$D"
if [ "$RC" -ne 0 ] && has "2 releases carry tag v$V" && [ -z "$(uploaded)" ]; then
  pass "two drafts with the tag: nothing is uploaded"
else
  flunk "two drafts with the tag" "$OUT"
fi
draft_with "$D" published
run upload "v$V" "$D"
if [ "$RC" -ne 0 ] && has "is already published" && [ -z "$(uploaded)" ]; then
  pass "a published release is never signed again"
else
  flunk "a published release is never signed again" "$OUT"
fi
draft_with "$D"
printf '\n' >>"$FAKE_GH/assets/$(jq -r '.[0].assets[] | select(.name == "manifest.json") | .id' "$FAKE_GH/releases.json")"
run upload "v$V" "$D"
if [ "$RC" -ne 0 ] && has "the draft's manifest.json is not the file that was signed" && [ -z "$(uploaded)" ]; then
  pass "a draft whose manifest.json is not the signed one gets no signatures"
else
  flunk "a draft whose manifest.json differs" "$OUT"
fi
draft_with "$D"
rm "$D"/*.minisig
run upload "v$V" "$D"
if [ "$RC" -ne 0 ] && has "run scripts/release-sign.sh sign first" && [ -z "$(uploaded)" ]; then
  pass "upload without signatures uploads nothing"
else
  flunk "upload without signatures" "$OUT"
fi

if [ "$failures" -gt 0 ]; then
  echo "release sign tests: $failures failed"
  exit 1
fi
echo "release sign tests: all passed"
