#!/usr/bin/env bash
# Tests for scripts/release-publish.sh, the Publish job of a tag release: fake
# draft releases behind a gh shim (the GitHub REST calls the script makes),
# ghcr.io answers (recorded from the real registry) behind a curl shim, and
# signatures made with a throwaway minisign key that the script trusts
# through RELEASE_PUBLISH_TEST_PUBLIC_KEY. Nothing here touches GitHub,
# ghcr.io or the network.
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
GH=$T/gh       # rel/<id>/: tag, created, assets/, draft and prerelease markers; latest holds the latest release's id
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
for t in awk bash cat chmod cksum cp cut dirname env grep head jq ls minisign mkdir mktemp mv rm sed sh sort tail touch tr wc \
  sha256sum shasum perl; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$tools/$t"
done

# ---- shims
shims=$T/shims
mkdir -p "$shims"
cat >"$shims/gh" <<'EOF'
#!/bin/sh
# gh api [-X METHOD] [--paginate] [-H header]... [-F|-f key=value]... <path>:
# the GitHub REST calls for the releases of $FAKE_REPO, each release under
# $FAKE_GH/rel/<id>/ (tag, created, assets/, draft and prerelease markers);
# $FAKE_GH/latest holds the id of the latest release. An asset's id changes
# with its content, as a file uploaded again gets a new id. $FAKE_GH_HOOK, when
# set, runs just before the second listing of the releases.
printf '%s\n' "$*" >>"$SHIM_LOG.gh"
[ "$1" = api ] || { echo "fake gh: only gh api is faked, not gh $*" >&2; exit 1; }
shift
method=GET path='' accept='' fields=''
while [ $# -gt 0 ]; do
  case $1 in
  -X | --method) method=$2; shift ;;
  -H | --header)
    case $2 in "Accept: "*) accept=${2#Accept: } ;; esac
    shift
    ;;
  -F | -f) fields="$fields $2"; shift ;;
  --paginate) ;;
  -*) echo "fake gh: api $1 is not faked" >&2; exit 1 ;;
  *) path=$1 ;;
  esac
  shift
done
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
asset_id() { printf '%s/%s/%s' "$1" "$2" "$3" | cksum | cut -d' ' -f1; }
not_found() {
  printf '{"message":"Not Found","status":"404"}'
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
}
release() { # <id>: the release as the REST API answers it
  d=$FAKE_GH/rel/$1
  draft=false pre=false
  [ ! -e "$d/draft" ] || draft=true
  [ ! -e "$d/prerelease" ] || pre=true
  for p in "$d"/assets/*; do
    [ -f "$p" ] || continue
    f=${p##*/}
    s=$(sha "$p")
    printf '{"id":%s,"name":"%s","size":%s,"state":"uploaded","digest":"sha256:%s","updated_at":"2026-11-07T10:00:00Z"}\n' \
      "$(asset_id "$1" "$f" "$s")" "$f" "$(wc -c <"$p" | tr -d ' ')" "$s"
  done | jq -s --argjson id "$1" --arg tag "$(cat "$d/tag")" --arg created "$(cat "$d/created")" \
    --argjson draft "$draft" --argjson pre "$pre" \
    '{id: $id, tag_name: $tag, draft: $draft, prerelease: $pre, created_at: $created, assets: .}'
}
releases=repos/$FAKE_REPO/releases
case $method:$path in
"GET:$releases?per_page=100")
  echo list >>"$SHIM_LOG.lists"
  if [ -n "${FAKE_GH_HOOK:-}" ] && [ "$(wc -l <"$SHIM_LOG.lists" | tr -d ' ')" -eq 2 ]; then sh -c "$FAKE_GH_HOOK"; fi
  for d in "$FAKE_GH"/rel/*/; do
    [ -d "$d" ] || continue
    d=${d%/}
    release "${d##*/}"
  done | jq -s .
  ;;
"GET:$releases/latest")
  id=$(cat "$FAKE_GH/latest" 2>/dev/null) && [ -d "$FAKE_GH/rel/$id" ] || not_found
  release "$id"
  ;;
"GET:$releases/assets/"*)
  [ "$accept" = application/octet-stream ] || { echo "fake gh: asset metadata is not faked" >&2; exit 1; }
  for d in "$FAKE_GH"/rel/*/; do
    [ -d "$d" ] || continue
    d=${d%/}
    for p in "$d"/assets/*; do
      [ -f "$p" ] || continue
      if [ "$(asset_id "${d##*/}" "${p##*/}" "$(sha "$p")")" = "${path##*/}" ]; then
        cat "$p"
        exit 0
      fi
    done
  done
  not_found
  ;;
"GET:$releases/"*)
  [ -d "$FAKE_GH/rel/${path##*/}" ] || not_found
  release "${path##*/}"
  ;;
"PATCH:$releases/"*)
  id=${path##*/}
  [ -d "$FAKE_GH/rel/$id" ] || not_found
  case " $fields " in *" draft=false "*) rm -f "$FAKE_GH/rel/$id/draft" ;; esac
  case " $fields " in *" make_latest=true "*) echo "$id" >"$FAKE_GH/latest" ;; esac
  release "$id"
  ;;
*) echo "fake gh: $method $path is not faked" >&2; exit 1 ;;
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

# new_release <tag>: an empty draft release with a new id; sets REL to its
# folder. GitHub lets several drafts carry the same tag.
new_release() {
  local n
  n=$(($(cat "$GH/next" 2>/dev/null || echo 100) + 1))
  echo "$n" >"$GH/next"
  REL=$GH/rel/$n
  mkdir -p "$REL/assets"
  echo "$1" >"$REL/tag"
  printf '2026-11-07T10:%02d:00Z\n' $((n % 60)) >"$REL/created"
  touch "$REL/draft"
}
drop_releases() { # <tag>: deletes every release with that tag
  local d
  for d in "$GH"/rel/*/; do
    [ -d "$d" ] && [ "$(cat "$d/tag")" = "$1" ] && rm -rf "${d:?}"
  done
  return 0
}

# make_release <version>: replaces the releases of v<version> with one draft
# as `make release` leaves it, signed with the test key, and its panel image
# (REG_ARCHES picks the platforms). Sets REL (its folder), ID and A (its
# files).
make_release() {
  local v=$1 src=$T/build-$1 t
  drop_releases "v$v"
  rm -rf "$src"
  mkdir -p "$src"
  for t in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64.exe windows_arm64.exe; do
    printf 'fake %s binary %s %s\n' "$SLUG" "$t" "$v" >"$src/${SLUG}_$t"
  done
  "$root/scripts/render-installer.sh" "$v" "$src/install.sh" >/dev/null
  printf '{"openapi":"3.1.0"}\n' >"$src/openapi.json"
  # As goreleaser writes it: the binaries and checksum.extra_files, by name.
  (cd "$src" && for f in install.sh openapi.json "${SLUG}"_*; do printf '%s  %s\n' "$(sha256 <"$f")" "$f"; done) >"$T/checksums.txt"
  mv "$T/checksums.txt" "$src/checksums.txt"
  sign "$src/checksums.txt" "$T/test.key" "$SLUG $v checksums.txt"
  # shellcheck disable=SC2086
  registry_image "$v" ${REG_ARCHES:-amd64 arm64}
  "$T/releasetool" -version "$v" -binaries "$src" -image "$BRAND_IMAGE:$v" -digest "$INDEX_DIGEST" \
    -installer "$src/install.sh" -out "$src/manifest.json" >/dev/null
  sign "$src/manifest.json" "$T/test.key" "$SLUG $v manifest.json"
  new_release "v$v"
  ID=${REL##*/}
  A=$REL/assets
  cp "$src"/* "$A/"
  case $v in *-*) touch "$REL/prerelease" ;; esac
}

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
  OUT=$(env -i PATH="$shims:$tools" HOME="$T" TMPDIR="$T" FAKE_GH="$GH" FAKE_REPO="$REPO" FAKE_HTTP="$HTTP" SHIM_LOG="$T/log" \
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
edits() { grep -e '-X PATCH' "$T/log.gh" 2>/dev/null || true; }
expect_untouched() { # name: nothing was published and the last made release is still a draft
  if [ -z "$(edits)" ] && [ -e "$REL/draft" ]; then pass "$1: the draft stays a draft"; else flunk "$1: the release was changed" "$(edits)"; fi
}
downloads() { grep -c "^api repos/$REPO/releases/assets/[0-9][0-9]* -H Accept: application/octet-stream\$" "$T/log.gh" 2>/dev/null || true; }

# ---- a good draft
make_release "$V"
publish "v$V"
expect_ok "a draft that passes every check is published" "release-publish: v$V: published, the latest release"
if [ "$(edits)" = "api -X PATCH repos/$REPO/releases/$ID -F draft=false -f make_latest=true" ] && [ ! -e "$REL/draft" ] &&
  [ ! -e "$REL/prerelease" ]; then
  pass "the checked release is published by its id, made the latest, the pre-release flag untouched"
else
  flunk "publish command" "$(edits)"
fi
if [ "$(downloads)" -eq 12 ] && ! grep -qv '^api ' "$T/log.gh"; then
  pass "the 12 files are downloaded by asset id; nothing is looked up by tag"
else
  flunk "downloads by asset id" "$(cat "$T/log.gh")"
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

# ---- one release per tag, acted on by id
make_release "$V"
first=$REL
new_release "v$V"
second=$REL
cp "$first"/assets/* "$second/assets/"
publish "v$V"
expect_fail "two drafts with the same tag are refused" "2 releases carry tag v$V, so none is published. Delete the stale draft"
if [ -z "$(edits)" ] && [ -e "$first/draft" ] && [ -e "$second/draft" ] && [ "$(downloads)" -eq 0 ]; then
  pass "two drafts with the same tag: neither is downloaded or published"
else
  flunk "two drafts with the same tag" "$(cat "$T/log.gh")"
fi
rm -rf "${second:?}"
REL=$first
publish "v$V"
expect_ok "once the stale draft is deleted, running Publish again publishes the one left" "published, the latest release"
if [ "$(edits)" = "api -X PATCH repos/$REPO/releases/${first##*/} -F draft=false -f make_latest=true" ]; then
  pass "the draft left is the one published"
else
  flunk "publish after deleting the stale draft" "$(edits)"
fi

make_release "$V"
publish FAKE_GH_HOOK="printf 'changed\n' >>'$A/openapi.json'" "v$V"
expect_fail "a release whose files change while it is checked is not published" "Release v$V changed while it was being checked"
expect_untouched "changed while checked"

make_release "$V"
late=$GH/rel/999
publish FAKE_GH_HOOK="mkdir -p '$late/assets' && echo v$V >'$late/tag' && echo 2026-11-07T11:00:00Z >'$late/created' && touch '$late/draft'" "v$V"
expect_fail "a second draft that appears while the first is checked stops the publish" "Another release with tag v$V appeared"
expect_untouched "second draft while checked"
rm -rf "${late:?}"

make_release "$V"
publish FAKE_GH_HOOK="mv '$REL' '$T/deleted-release'" "v$V"
expect_fail "a release deleted while it is checked is not published" "Release v$V was deleted while it was being checked"
if [ -z "$(edits)" ]; then pass "deleted while checked: nothing is published"; else flunk "deleted while checked" "$(edits)"; fi
rm -rf "${T:?}/deleted-release"

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
expect_untouched "checksums for another version"

make_release "$V"
"$T/releasetool" -version 0.0.9 -binaries "$T/build-$V" -image "$BRAND_IMAGE:0.0.9" -digest "$INDEX_DIGEST" \
  -installer "$A/install.sh" -out "$A/manifest.json" >/dev/null
sign "$A/manifest.json" "$T/test.key" "$SLUG $V manifest.json"
publish "v$V"
expect_fail "a signed manifest whose content names another version is refused" "FAIL manifest.json is for version $V (it says: 0.0.9)"
expect_untouched "manifest for another version"

make_release "$V"
"$T/releasetool" -version "$V" -binaries "$T/build-$V" -image "$BRAND_IMAGE:9.9.9" -digest "$INDEX_DIGEST" \
  -installer "$A/install.sh" -out "$A/manifest.json" >/dev/null
sign "$A/manifest.json" "$T/test.key" "$SLUG $V manifest.json"
publish "v$V"
expect_fail "a signed manifest that names another panel image is refused" \
  "FAIL manifest.json names the panel image $BRAND_IMAGE:$V (it says: $BRAND_IMAGE:9.9.9)"
expect_untouched "another panel image"

make_release "$V"
publish RELEASE_PUBLISH_TEST_PUBLIC_KEY= "v$V"
expect_fail "without the test override, brand.json's key is the one checked" "FAIL checksums.txt is signed by the release key"
expect_untouched "brand.json's key"
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
expect_untouched "listed but missing"

make_release "$V"
printf 'replaced\n' >"$A/${SLUG}_darwin_arm64"
publish "v$V"
expect_fail "a binary that does not match the signed checksums is refused" "(different: ${SLUG}_darwin_arm64)"
expect_untouched "replaced binary"

make_release "$V"
printf '{"openapi":"3.1.0","replaced":true}\n' >"$A/openapi.json"
publish "v$V"
expect_fail "an openapi.json that does not match the signed checksums is refused" "(different: openapi.json)"
expect_untouched "replaced openapi.json"

make_release "$V"
grep -v '  openapi.json$' "$A/checksums.txt" >"$T/c" && mv "$T/c" "$A/checksums.txt"
sign "$A/checksums.txt" "$T/test.key" "$SLUG $V checksums.txt"
publish "v$V"
expect_fail "a checksums.txt that does not cover openapi.json is refused" "FAIL checksums.txt lists openapi.json"
expect_untouched "openapi.json not in checksums.txt"

make_release "$V"
printf '\n# tampered\n' >>"$A/install.sh"
publish "v$V"
expect_fail "an install.sh changed after the manifest was signed is refused" "FAIL manifest.json has the sha256 of the attached install.sh"
expect_fail "an install.sh changed after signing does not match the signed checksums" "(different: install.sh)"
expect_untouched "tampered install.sh"

make_release "$V"
"$root/scripts/render-installer.sh" 0.0.9 "$A/install.sh" >/dev/null
publish "v$V"
expect_fail "an install.sh of another version is refused" "FAIL install.sh installs $V (it says: '0.0.9')"
expect_untouched "install.sh of another version"

make_release "$V"
INSTALLER_TEST_PUBLIC_KEY=$KEY "$root/scripts/render-installer.sh" "$V" "$A/install.sh" >/dev/null
publish "v$V"
expect_fail "a TEST BUILD install.sh is refused" "FAIL install.sh is not a TEST BUILD"
expect_untouched "TEST BUILD install.sh"

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
expect_untouched "manifest denied"
rm "$HTTP/$IMAGE_PATH/manifests/$V.code"

make_release "$V"
rm "$HTTP/$IMAGE_PATH/manifests/$V.body"
publish "v$V"
expect_fail "a panel image tag that is not on ghcr.io is refused" "$BRAND_IMAGE:$V does not exist on ghcr.io"
expect_untouched "image tag not on ghcr.io"

REG_ARCHES=amd64 make_release "$V"
publish "v$V"
expect_fail "an image index without linux/arm64 is refused" "has no linux/arm64 image"
expect_untouched "no arm64"

make_release "$V"
pinned=$INDEX_DIGEST
registry_image "$V" amd64 arm64 riscv64
publish "v$V"
expect_fail "an image tag pushed again after the manifest was signed is refused" "points at $INDEX_DIGEST, but the signed manifest pins $pinned"
expect_untouched "image tag pushed again"

make_release "$V"
child=$(jq -r '.manifests[] | select(.platform.architecture == "arm64") | .digest' "$HTTP/$IMAGE_PATH/manifests/$V.body")
rm "$HTTP/$IMAGE_PATH/manifests/sha256_${child#sha256:}.body"
publish "v$V"
expect_fail "a missing linux/arm64 image manifest is refused" "(linux/arm64) cannot be pulled anonymously"
expect_untouched "missing linux/arm64 manifest"

# ---- the release itself
publish v0.0.7
expect_fail "a missing draft fails clearly" "There is no release v0.0.7 in $REPO"
expect_untouched "missing release"
publish v1.2
expect_fail "a tag that is not a release version is refused" "is not a vMAJOR.MINOR.PATCH"

make_release 0.2.0-rc.1
publish v0.2.0-rc.1
expect_ok "a pre-release is published" "published, a pre-release, so not the latest release"
if [ "$(edits)" = "api -X PATCH repos/$REPO/releases/$ID -F draft=false" ] && ! grep -q 'releases/latest' "$T/log.gh"; then
  pass "a pre-release is published with no make_latest (GitHub never makes a pre-release the latest)"
else
  flunk "pre-release publish command" "$(cat "$T/log.gh")"
fi

make_release "$V"
touch "$REL/prerelease"
publish "v$V"
expect_fail "a stable tag whose release is marked pre-release is refused" \
  "Untick \"Set as a pre-release\" on the draft (Releases -> Edit, then Save draft)"
expect_untouched "wrong pre-release flag"
rm "$REL/draft"
publish "v$V"
expect_fail "a published stable release marked pre-release says to update the release" \
  "Untick \"Set as a pre-release\" on release v$V (Releases -> Edit, then Update release)"
if [ -z "$(edits)" ]; then pass "a published release with a wrong pre-release flag is not edited"; else flunk "published, wrong flag" "$(edits)"; fi

new_release v0.3.0
rm "$REL/draft"
newer=${REL##*/}
echo "$newer" >"$GH/latest"
make_release "$V"
publish "v$V"
expect_ok "an older stable version is published" "not made the latest release: v0.3.0 is newer and stays the latest"
if [ "$(edits)" = "api -X PATCH repos/$REPO/releases/$ID -F draft=false -f make_latest=false" ] && [ "$(cat "$GH/latest")" = "$newer" ]; then
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
