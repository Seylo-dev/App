#!/usr/bin/env bash
# Tests for scripts/release-publish.sh, the Publish job of a tag release: a
# fake draft release behind a gh shim, ghcr.io answers (recorded from the real
# registry) behind a curl shim, and signatures made with a throwaway minisign
# key that the script trusts through RELEASE_PUBLISH_TEST_PUBLIC_KEY. Nothing
# here touches GitHub, ghcr.io or the network.
#
# Needs: minisign and jq (skips without them), Go (releasetool writes the real
# manifest; or RELEASETOOL=<prebuilt binary>).
#
# Usage: installer/test/release-publish.sh     (make test-release)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)

for t in minisign jq; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "release publish tests: SKIP ($t is not installed)"
    exit 0
  fi
done

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# shellcheck disable=SC1091
. "$root/installer/brand.env"
SLUG=$BRAND_SLUG
REPO=$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO
IMAGE_PATH=${BRAND_IMAGE#*/}
V=0.1.0
GH=$T/gh       # one folder per release tag: assets/, draft, prerelease; latest names the latest tag
HTTP=$T/ghcr   # <image path>/token.{body,code}, <image path>/manifests/<ref>.{body,code}
mkdir -p "$GH" "$HTTP"
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

failures=0
pass() { printf 'ok   %s\n' "$1"; }
flunk() {
  printf 'FAIL %s\n' "$1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/     | /'
  failures=$((failures + 1))
}

# ---- tools: an explicit PATH, so gh and curl are always the shims
tools=$T/tools
mkdir -p "$tools"
for t in awk bash cat chmod cp cut dirname env grep head jq ls minisign mkdir mktemp mv rm sed sh sort tail touch tr wc \
  sha256sum shasum perl; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$tools/$t"
done

# ---- shims
shims=$T/shims
mkdir -p "$shims"
cat >"$shims/gh" <<'EOF'
#!/bin/sh
# gh release view|download|edit <tag> --repo <r> ...: a fake GitHub release
# per tag under $FAKE_GH/<tag> (assets/, draft and prerelease markers);
# $FAKE_GH/latest names the latest release.
printf '%s\n' "$*" >>"$SHIM_LOG.gh"
[ "$1" = release ] || { echo "fake gh: $*" >&2; exit 1; }
cmd=$2
shift 2
tag= dir=. pats= jqf= flags=
while [ $# -gt 0 ]; do
  case $1 in
  --repo | -R | --json) shift ;;
  --jq) jqf=$2; shift ;;
  --dir | -D) dir=$2; shift ;;
  --pattern=*) pats="$pats ${1#--pattern=}" ;;
  --clobber) ;;
  --*) flags="$flags $1" ;;
  *) tag=$1 ;;
  esac
  shift
done
if [ -z "$tag" ] && [ "$cmd" = view ]; then
  [ -s "$FAKE_GH/latest" ] || { echo "release not found" >&2; exit 1; }
  tag=$(cat "$FAKE_GH/latest")
fi
rel=$FAKE_GH/$tag
[ -n "$tag" ] && [ -d "$rel" ] || { echo "release not found" >&2; exit 1; }
case $cmd in
view)
  draft=false pre=false
  [ ! -e "$rel/draft" ] || draft=true
  [ ! -e "$rel/prerelease" ] || pre=true
  out=$(ls "$rel/assets" | jq -R . | jq -s --arg tag "$tag" --argjson draft $draft --argjson pre $pre \
    '{tagName: $tag, isDraft: $draft, isPrerelease: $pre, assets: map({name: ., state: "uploaded"})}')
  if [ -n "$jqf" ]; then printf '%s\n' "$out" | jq -r "$jqf"; else printf '%s\n' "$out"; fi
  ;;
download)
  n=0
  for p in $pats; do
    [ -f "$rel/assets/$p" ] || continue
    cp "$rel/assets/$p" "$dir/$p"
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || { echo "no assets match the file pattern" >&2; exit 1; }
  ;;
edit)
  case " $flags " in *" --draft=false "*) rm -f "$rel/draft" ;; esac
  case " $flags " in *" --latest "*) echo "$tag" >"$FAKE_GH/latest" ;; esac
  ;;
*) echo "fake gh: release $cmd" >&2; exit 1 ;;
esac
EOF
cat >"$shims/curl" <<'EOF'
#!/bin/sh
# curl ... -o <file> -w '%{http_code}' [-H <header>]... <url>: answers ghcr.io
# token and manifest requests from $FAKE_HTTP/<image path>/ and logs each
# request with its headers. An image with no folder answers like a private or
# missing one on the real ghcr.io (403 DENIED for the anonymous token).
out=/dev/null url= auth= hdrs=
while [ $# -gt 0 ]; do
  case $1 in
  -o) out=$2; shift ;;
  -H)
    hdrs="$hdrs [$2]"
    case $2 in "Authorization: "*) auth=${2#Authorization: } ;; esac
    shift
    ;;
  -w | --max-time | --retry | --proto) shift ;;
  -*) ;;
  *) url=$1 ;;
  esac
  shift
done
printf '%s%s\n' "$url" "$hdrs" >>"$SHIM_LOG.curl"
answer() { # <code> <body file>
  cat "$2" >"$out"
  printf '%s' "$1"
}
errors() { printf '{"errors":[{"code":"%s","message":"%s"}]}\n' "$1" "$2" >"$out"; }
case $url in
https://ghcr.io/token?scope=repository:*:pull)
  path=${url#*repository:}
  d=$FAKE_HTTP/${path%:pull}
  if [ -f "$d/token.body" ]; then
    answer "$(cat "$d/token.code" 2>/dev/null || echo 200)" "$d/token.body"
  else
    errors DENIED "requested access to the resource is denied"
    printf 403
  fi
  ;;
https://ghcr.io/v2/*/manifests/*)
  rest=${url#https://ghcr.io/v2/}
  d=$FAKE_HTTP/${rest%/manifests/*}
  ref=$(printf '%s' "${rest##*/manifests/}" | tr : _)
  if [ "$auth" != "Bearer anon-token" ]; then
    errors UNAUTHORIZED "authentication required"
    printf 401
  elif [ -f "$d/manifests/$ref.body" ]; then
    answer "$(cat "$d/manifests/$ref.code" 2>/dev/null || echo 200)" "$d/manifests/$ref.body"
  else
    errors MANIFEST_UNKNOWN "manifest unknown"
    printf 404
  fi
  ;;
*)
  echo "curl: (6) Could not resolve host" >&2
  printf 000
  exit 6
  ;;
esac
EOF
chmod +x "$shims"/*

# ---- a fake release
minisign -G -W -p "$T/test.pub" -s "$T/test.key" >/dev/null
minisign -G -W -p "$T/other.pub" -s "$T/other.key" >/dev/null
KEY=$(sed -n 2p "$T/test.pub")
sign() { rm -f "$1.minisig"; minisign -S -s "$2" -m "$1" -x "$1.minisig" -t "$3" </dev/null >/dev/null; }

if [ -n "${RELEASETOOL:-}" ]; then
  cp "$RELEASETOOL" "$T/releasetool"
else
  go -C "$root/go" build -o "$T/releasetool" ./internal/update/releasetool
fi

# registry_image <version> [arch...]: the panel image index (with an
# attestation entry, as buildx pushes it) and its platform manifests on the
# fake ghcr.io, readable anonymously. Sets INDEX_DIGEST.
registry_image() {
  local v=$1 m=$HTTP/$IMAGE_PATH/manifests arch body digest entries='[]'
  shift
  mkdir -p "$m"
  printf '{"token":"anon-token"}\n' >"$HTTP/$IMAGE_PATH/token.body"
  for arch in "$@"; do
    body=$(printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","arch":"%s","v":"%s"}' "$arch" "$v")
    digest=sha256:$(printf '%s' "$body" | sha256)
    printf '%s' "$body" >"$m/sha256_${digest#sha256:}.body"
    entries=$(jq -c --arg d "$digest" --arg a "$arch" \
      '. + [{mediaType: "application/vnd.oci.image.manifest.v1+json", digest: $d, size: 100, platform: {architecture: $a, os: "linux"}}]' <<<"$entries")
  done
  body=$(jq -c '{schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: (. + [{mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:\("0" * 64)", size: 100,
      annotations: {"vnd.docker.reference.type": "attestation-manifest"}, platform: {architecture: "unknown", os: "unknown"}}])}' <<<"$entries")
  INDEX_DIGEST=sha256:$(printf '%s' "$body" | sha256)
  printf '%s' "$body" >"$m/$v.body"
  printf '%s' "$body" >"$m/sha256_${INDEX_DIGEST#sha256:}.body"
}

# make_release <version>: a draft release as `make release` leaves it, signed
# with the test key, and its panel image (REG_ARCHES picks the platforms).
make_release() {
  local v=$1 src=$T/build-$1 t
  rm -rf "$GH/v$v" "$src"
  mkdir -p "$GH/v$v/assets" "$src"
  for t in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64.exe windows_arm64.exe; do
    printf 'fake %s binary %s %s\n' "$SLUG" "$t" "$v" >"$src/${SLUG}_$t"
  done
  (cd "$src" && for f in "${SLUG}"_*; do printf '%s  %s\n' "$(sha256 <"$f")" "$f"; done) >"$T/checksums.txt"
  mv "$T/checksums.txt" "$src/checksums.txt"
  sign "$src/checksums.txt" "$T/test.key" "$SLUG $v checksums.txt"
  "$root/scripts/render-installer.sh" "$v" "$src/install.sh" >/dev/null
  printf '{"openapi":"3.1.0"}\n' >"$src/openapi.json"
  # shellcheck disable=SC2086
  registry_image "$v" ${REG_ARCHES:-amd64 arm64}
  "$T/releasetool" -version "$v" -binaries "$src" -image "$BRAND_IMAGE:$v" -digest "$INDEX_DIGEST" \
    -installer "$src/install.sh" -out "$src/manifest.json" >/dev/null
  sign "$src/manifest.json" "$T/test.key" "$SLUG $v manifest.json"
  cp "$src"/* "$GH/v$v/assets/"
  touch "$GH/v$v/draft"
  case $v in *-*) touch "$GH/v$v/prerelease" ;; esac
}
A=$GH/v$V/assets

# publish [VAR=value...] <args>: runs the script with the test key and the
# shims; sets OUT and RC.
publish() {
  local envs=()
  while [ $# -gt 0 ] && [[ "$1" == [A-Z]*=* ]]; do
    envs+=("$1")
    shift
  done
  rm -f "$T"/log.* "$T/summary.md"
  set +e
  OUT=$(env -i PATH="$shims:$tools" HOME="$T" TMPDIR="$T" FAKE_GH="$GH" FAKE_HTTP="$HTTP" SHIM_LOG="$T/log" \
    GH_TOKEN=gh-secret-token GITHUB_STEP_SUMMARY="$T/summary.md" RELEASE_PUBLISH_TEST_PUBLIC_KEY="$KEY" \
    ${envs[@]+"${envs[@]}"} bash "$root/scripts/release-publish.sh" "$@" 2>&1)
  RC=$?
  set -e
}
has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
expect_ok() { # name strings...: the run succeeded and printed every string
  local name=$1 s
  shift
  if [ "$RC" -ne 0 ]; then flunk "$name (exit $RC)" "$OUT"; return; fi
  for s in "$@"; do has "$s" || { flunk "$name: missing \"$s\"" "$OUT"; return; }; done
  pass "$name"
}
expect_fail() { # name string: the run failed and printed the string
  if [ "$RC" -eq 0 ]; then flunk "$1 (exit 0, expected a failure)" "$OUT"; return; fi
  has "$2" || { flunk "$1: missing \"$2\"" "$OUT"; return; }
  pass "$1"
}
edits() { grep '^release edit' "$T/log.gh" 2>/dev/null || true; }
expect_untouched() { # name: no gh release edit ran and v$V is still a draft
  if [ -z "$(edits)" ] && [ -e "$GH/v$V/draft" ]; then pass "$1: the draft stays a draft"; else flunk "$1: the release was changed" "$(edits)"; fi
}

# ---- a good draft
make_release "$V"
publish "v$V"
expect_ok "a draft that passes every check is published" "release-publish: v$V: published, the latest release"
if [ "$(edits)" = "release edit v$V --repo $REPO --draft=false --latest" ] && [ ! -e "$GH/v$V/draft" ]; then
  pass "it is published with --draft=false --latest and the pre-release flag untouched"
else
  flunk "publish command" "$(edits)"
fi
n=$(grep -c '^- \[x\]' "$T/summary.md" || true)
if [ "$n" -ge 10 ] && ! grep -q '^- \[ \]' "$T/summary.md" && grep -q "^### v$V: published" "$T/summary.md" &&
  grep -qF "checksums.txt is signed by the release key for $SLUG $V" "$T/summary.md" &&
  grep -qF "$BRAND_IMAGE:$V pulls anonymously" "$T/summary.md"; then
  pass "the run summary lists the $n checks"
else
  flunk "the run summary lists the checks" "$(cat "$T/summary.md")"
fi
if ! grep -qF gh-secret-token "$T/log.curl" && grep -qF "[Authorization: Bearer anon-token]" "$T/log.curl" &&
  [ "$(grep -c '^https://ghcr.io/token' "$T/log.curl")" -eq 1 ] && ! grep '^https://ghcr.io/token' "$T/log.curl" | grep -q Authorization; then
  pass "ghcr.io is asked anonymously: the GitHub token never reaches it"
else
  flunk "ghcr.io is asked anonymously" "$(cat "$T/log.curl")"
fi

publish "v$V"
expect_ok "an already published release passes the checks and exits 0" "release-publish: v$V: already published, nothing changed"
if [ -z "$(edits)" ]; then pass "an already published release is not edited"; else flunk "an already published release was edited" "$(edits)"; fi

# ---- signatures
make_release "$V"
sign "$A/checksums.txt" "$T/other.key" "$SLUG $V checksums.txt"
publish "v$V"
expect_fail "checksums.txt signed by another key is refused" "FAIL checksums.txt is signed by the release key"
expect_untouched "another key"
if has "do not publish it by hand"; then pass "the refusal says what to do"; else flunk "the refusal says what to do" "$OUT"; fi

make_release "$V"
jq '.minAgent = "0.0.1"' "$A/manifest.json" >"$T/m" && mv "$T/m" "$A/manifest.json"
publish "v$V"
expect_fail "a manifest.json changed after signing is refused" "FAIL manifest.json is signed by the release key"
expect_untouched "changed after signing"

make_release "$V"
sign "$A/manifest.json" "$T/test.key" "$SLUG 9.9.9 manifest.json"
publish "v$V"
expect_fail "a manifest signed for another version (trusted comment) is refused" \
  "FAIL manifest.json is signed for $SLUG $V (the signature says: $SLUG 9.9.9 manifest.json)"
expect_untouched "wrong trusted comment"

make_release "$V"
sign "$A/checksums.txt" "$T/test.key" "$SLUG 0.0.9 checksums.txt"
publish "v$V"
expect_fail "checksums signed for another version (trusted comment) are refused" "FAIL checksums.txt is signed for $SLUG $V"

make_release "$V"
"$T/releasetool" -version 0.0.9 -binaries "$T/build-$V" -image "$BRAND_IMAGE:0.0.9" -digest "$INDEX_DIGEST" \
  -installer "$A/install.sh" -out "$A/manifest.json" >/dev/null
sign "$A/manifest.json" "$T/test.key" "$SLUG $V manifest.json"
publish "v$V"
expect_fail "a signed manifest whose content names another version is refused" "FAIL manifest.json is for version $V (it says: 0.0.9)"

make_release "$V"
publish RELEASE_PUBLISH_TEST_PUBLIC_KEY= "v$V"
expect_fail "without the test override, brand.json's key is the one checked" "FAIL checksums.txt is signed by the release key"
publish GITHUB_ACTIONS=true "v$V"
expect_fail "the test key override is refused in GitHub Actions" "RELEASE_PUBLISH_TEST_PUBLIC_KEY is set"
expect_untouched "test key in Actions"

# ---- files
make_release "$V"
rm "$A/${SLUG}_windows_arm64.exe"
publish "v$V"
expect_fail "a draft without one of its files is refused" "missing: ${SLUG}_windows_arm64.exe"
expect_untouched "missing file"

make_release "$V"
printf '%s  %s\n' "$(printf extra | sha256)" "${SLUG}_freebsd_amd64" >>"$A/checksums.txt"
sign "$A/checksums.txt" "$T/test.key" "$SLUG $V checksums.txt"
publish "v$V"
expect_fail "a file checksums.txt lists but the draft lacks is refused" "every file checksums.txt lists is attached (missing: ${SLUG}_freebsd_amd64)"

make_release "$V"
printf 'replaced\n' >"$A/${SLUG}_darwin_arm64"
publish "v$V"
expect_fail "a binary that does not match the signed checksums is refused" "(different: ${SLUG}_darwin_arm64)"
expect_untouched "replaced binary"

make_release "$V"
"$root/scripts/render-installer.sh" 0.0.9 "$A/install.sh" >/dev/null
publish "v$V"
expect_fail "an install.sh of another version is refused" "FAIL install.sh installs $V (it says: '0.0.9')"

make_release "$V"
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" "$V" "$A/install.sh" >/dev/null
publish "v$V"
expect_fail "a TEST BUILD install.sh is refused" "FAIL install.sh is not a TEST BUILD"

# ---- the panel image
private="The $BRAND_IMAGE package is private. Make it public (github.com/orgs/$BRAND_GITHUB_ORG/packages -> ${BRAND_IMAGE##*/} -> Package settings -> Change visibility), then re-run the Publish job."
make_release "$V"
rm "$HTTP/$IMAGE_PATH/token.body"
publish "v$V"
expect_fail "a private panel image is refused with what to do" "$private"
expect_untouched "private image"
if grep -qxF "$private" "$T/summary.md"; then
  pass "the run summary says how to make the package public"
else
  flunk "summary of a private image" "$(cat "$T/summary.md")"
fi

printf '{"token":"anon-token"}\n' >"$HTTP/$IMAGE_PATH/token.body"
publish "v$V"
expect_ok "once the package is public, running Publish again publishes the draft" "published, the latest release"

make_release "$V"
printf '{"errors":[{"code":"DENIED","message":"requested access to the resource is denied"}]}\n' >"$HTTP/$IMAGE_PATH/manifests/$V.body"
echo 403 >"$HTTP/$IMAGE_PATH/manifests/$V.code"
publish "v$V"
expect_fail "a manifest denied to an anonymous token counts as private" "$private"
rm "$HTTP/$IMAGE_PATH/manifests/$V.code"

make_release "$V"
rm "$HTTP/$IMAGE_PATH/manifests/$V.body"
publish "v$V"
expect_fail "a panel image tag that is not on ghcr.io is refused" "$BRAND_IMAGE:$V does not exist on ghcr.io"

REG_ARCHES=amd64 make_release "$V"
publish "v$V"
expect_fail "an image index without linux/arm64 is refused" "has no linux/arm64 image"
expect_untouched "no arm64"

make_release "$V"
pinned=$INDEX_DIGEST
registry_image "$V" amd64 arm64 riscv64
publish "v$V"
expect_fail "an image tag pushed again after the manifest was signed is refused" "points at $INDEX_DIGEST, but the signed manifest pins $pinned"

make_release "$V"
child=$(jq -r '.manifests[] | select(.platform.architecture == "arm64") | .digest' "$HTTP/$IMAGE_PATH/manifests/$V.body")
rm "$HTTP/$IMAGE_PATH/manifests/sha256_${child#sha256:}.body"
publish "v$V"
expect_fail "a missing linux/arm64 image manifest is refused" "(linux/arm64) cannot be pulled anonymously"

# ---- the release itself
publish v0.0.7
expect_fail "a missing draft fails clearly" "There is no release v0.0.7 in $REPO"
publish v1.2
expect_fail "a tag that is not a release version is refused" "is not a vMAJOR.MINOR.PATCH"

make_release 0.2.0-rc.1
publish v0.2.0-rc.1
expect_ok "a pre-release is published" "published, a pre-release, so not the latest release"
if [ "$(edits)" = "release edit v0.2.0-rc.1 --repo $REPO --draft=false --latest=false" ]; then
  pass "a pre-release is never made the latest"
else
  flunk "pre-release publish command" "$(edits)"
fi

make_release "$V"
touch "$GH/v$V/prerelease"
publish "v$V"
expect_fail "a stable tag whose release is marked pre-release is refused" "Untick \"Set as a pre-release\" on the draft"
expect_untouched "wrong pre-release flag"

make_release "$V"
mkdir -p "$GH/v0.3.0/assets"
echo v0.3.0 >"$GH/latest"
publish "v$V"
expect_ok "an older stable version is published" "not made the latest release: v0.3.0 is newer and stays the latest"
if [ "$(edits)" = "release edit v$V --repo $REPO --draft=false --latest=false" ] && [ "$(cat "$GH/latest")" = v0.3.0 ]; then
  pass "an older stable version does not take latest from a newer one"
else
  flunk "older version publish command" "$(edits)"
fi

# ---- --check-image
make_release "$V"
publish --check-image "$BRAND_IMAGE:$V@$INDEX_DIGEST"
expect_ok "--check-image checks one image and its pinned digest" "pulls anonymously" "what $V points at"
if [ ! -e "$T/log.gh" ]; then pass "--check-image needs no gh"; else flunk "--check-image ran gh" "$(cat "$T/log.gh")"; fi
publish --check-image ghcr.io/nobody/nothing:1.0.0
expect_fail "--check-image on an image that is not public" "ghcr.io/nobody/nothing cannot be pulled anonymously: it is private or does not exist."

if [ "$failures" -gt 0 ]; then
  echo "release publish tests: $failures failed"
  exit 1
fi
echo "release publish tests: all passed"
