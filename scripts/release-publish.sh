#!/usr/bin/env bash
# Last step of a tag release (.github/workflows/release.yml, job Publish):
# checks the draft GitHub release that `make release` made, without trusting
# the job that made it, and publishes it only when every check passes:
#
#   - checksums.txt and manifest.json carry minisign signatures by brand.json's
#     minisignPublicKey (from installer/brand.env, never from the release),
#     with trusted comments naming this version;
#   - exactly one release carries the tag (GitHub lets several drafts share
#     one); every download and the publish go to that release by its id,
#     never by the tag;
#   - every file a release needs is attached; checksums.txt lists the
#     binaries, install.sh and openapi.json, and every file it lists matches
#     its signed sha256;
#   - the signed manifest is for this version and names this release's linux
#     binaries, install.sh and panel image; install.sh is this version's
#     release build (brand.json's key, not a test build);
#   - the release is a pre-release exactly when the tag is (vX.Y.Z-<pre>);
#   - the panel image <image>:<version>, and the digest the manifest pins,
#     pull anonymously from ghcr.io (as installs and updates pull them), and
#     the image index has linux/amd64 and linux/arm64.
#
# Then, if the release still has the files and flags that were checked, it
# is published by id (PATCH draft=false), keeping the pre-release flag
# goreleaser set: a stable version becomes the latest release unless a newer
# one already is; a pre-release is never made the latest. On a release that
# is already published it runs the same checks and changes nothing. When a
# check fails the draft stays, and the output (and GITHUB_STEP_SUMMARY in
# Actions) says what to do.
#
# Usage: scripts/release-publish.sh vX.Y.Z[-PRE]
#        scripts/release-publish.sh --check-image <image>:<tag>[@<digest>]
#          only the anonymous pull check, for any ghcr.io image
#
# Needs gh (GH_TOKEN, or a gh login, that can write to the repository),
# minisign, jq and curl. Only gh gets the token; ghcr.io is asked
# anonymously. Tests only: RELEASE_PUBLISH_TEST_PUBLIC_KEY verifies with a
# throwaway key instead of brand.json's (refused in GitHub Actions); see
# installer/test/release-publish.sh.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
. "$root/installer/brand.env"
repo=$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO

usage() {
  echo "usage: scripts/release-publish.sh vX.Y.Z[-PRE] | --check-image <image>:<tag>[@<digest>]" >&2
  exit 2
}

tag=
check_only=
case ${1:-} in
--check-image)
  [ $# -eq 2 ] || usage
  check_only=$2
  ;;
v*)
  [ $# -eq 1 ] || usage
  tag=$1
  if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "release-publish: $tag is not a vMAJOR.MINOR.PATCH[-PRERELEASE] tag" >&2
    exit 2
  fi
  ;;
*) usage ;;
esac
version=${tag#v}

summary=${GITHUB_STEP_SUMMARY:-/dev/null}
checks=()
failed=0
todo=
ok() {
  echo "release-publish: ok   $*"
  checks+=("- [x] $*")
}
fail() {
  echo "release-publish: FAIL $*" >&2
  checks+=("- [ ] FAILED: $*")
  failed=$((failed + 1))
}
print_checks() { [ ${#checks[@]} -eq 0 ] || printf '%s\n' "${checks[@]}"; }

# stop <what to do>: ends the run with the draft left as it is.
stop() {
  local title="not published" heading="Not published"
  [ -z "$check_only" ] || title="cannot be pulled anonymously" heading="Not pullable anonymously"
  {
    echo "### ${tag:-$check_only}: $title"
    echo
    print_checks
    echo
    echo "$1"
  } >>"$summary"
  [ "${GITHUB_ACTIONS:-}" != true ] || echo "::error title=$heading::$1"
  echo "release-publish: $title: $1" >&2
  exit 1
}

need=(curl jq)
[ -n "$check_only" ] || need+=(gh minisign)
for t in "${need[@]}"; do
  command -v "$t" >/dev/null 2>&1 || stop "$t is not installed."
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# ---- the panel image, as an anonymous client pulls it

accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

# http_get <url> <out> [bearer token]: prints the HTTP status, 000 when the
# request failed. -q first: no .curlrc adds headers or credentials, so only
# the anonymous registry token is ever sent.
http_get() {
  local code args=(-q -sS --max-time 30 --retry 2 --proto "=https" -o "$2" -w '%{http_code}' -H "Accept: $accept")
  [ -z "${3:-}" ] || args+=(-H "Authorization: Bearer $3")
  code=$(curl "${args[@]}" "$1" 2>"$tmp/curl.err") || code=000
  echo "$code"
}

private_message() {
  if [ "$1" = "$BRAND_IMAGE" ]; then
    echo "The $BRAND_IMAGE package is private. Make it public (github.com/orgs/$BRAND_GITHUB_ORG/packages -> ${BRAND_IMAGE##*/} -> Package settings -> Change visibility), then re-run the Publish job."
  else
    echo "$1 cannot be pulled anonymously: it is private or does not exist."
  fi
}

# registry_error <http status> <what>: sets todo for an answer that is not a
# manifest.
registry_error() {
  case $1 in
  401 | 403) todo=$(private_message "$image") ;;
  404)
    todo="$2 does not exist on ghcr.io."
    [ "$image" != "$BRAND_IMAGE" ] ||
      todo="$todo The Draft release job pushes it: delete the draft release and the tag, then tag again (CONTRIBUTING.md, Releases)."
    ;;
  *) todo="ghcr.io answered HTTP $1 for $2 ($(tr '\n' ' ' <"$tmp/curl.err" | head -c 200)). Re-run the Publish job." ;;
  esac
  fail "$2 cannot be pulled anonymously (HTTP $1)"
}

# check_image <image> <tag> [pinned index digest]: an anonymous token, the
# index by tag (and by the pinned digest, which must be what the tag points
# at), linux/amd64 and linux/arm64 in it, and both platform manifests.
check_image() {
  image=$1
  local ref=$2 pin=${3:-} host=${1%%/*} path=${1#*/} code token digest platforms arch child
  if [ "$host" != ghcr.io ]; then
    todo="Only ghcr.io images are checked; $image is on $host."
    fail "$image is not on ghcr.io"
    return 1
  fi
  code=$(http_get "https://ghcr.io/token?scope=repository:$path:pull" "$tmp/token.json")
  token=
  [ "$code" != 200 ] || token=$(jq -r '.token // empty' "$tmp/token.json" 2>/dev/null || true)
  if [ -z "$token" ]; then
    [ "$code" != 200 ] || code="200 without a token"
    registry_error "$code" "$image"
    return 1
  fi
  code=$(http_get "https://ghcr.io/v2/$path/manifests/$ref" "$tmp/index.json" "$token")
  [ "$code" = 200 ] || { registry_error "$code" "$image:$ref"; return 1; }
  digest=sha256:$(sha256_of "$tmp/index.json")
  if ! platforms=$(jq -r '[.manifests[]? | select(.platform.os == "linux") | .platform | "linux/" + .architecture + (if .variant then "/" + .variant else "" end)] | join(" ")' "$tmp/index.json" 2>/dev/null); then
    todo="$image:$ref is not an image index. Delete the draft release and the tag, then tag again (CONTRIBUTING.md, Releases)."
    fail "$image:$ref answered something that is not an image manifest"
    return 1
  fi
  for arch in amd64 arm64; do
    if ! [[ " $platforms " == *" linux/$arch "* || " $platforms " == *" linux/$arch/"* ]]; then
      todo="$image:$ref has no linux/$arch image. Delete the draft release and the tag, then tag again (CONTRIBUTING.md, Releases)."
      fail "$image:$ref has no linux/$arch image (it has: ${platforms:-none})"
      return 1
    fi
  done
  ok "$image:$ref pulls anonymously ($digest: $platforms)"
  if [ -n "$pin" ]; then
    if [ "$digest" != "$pin" ]; then
      todo="The image tag was pushed again after the manifest was signed. Delete the draft release and the tag, then tag again (CONTRIBUTING.md, Releases)."
      fail "$image:$ref points at $digest, but the signed manifest pins $pin"
      return 1
    fi
    code=$(http_get "https://ghcr.io/v2/$path/manifests/$pin" "$tmp/pinned.json" "$token")
    [ "$code" = 200 ] || { registry_error "$code" "$image@$pin"; return 1; }
    if [ "sha256:$(sha256_of "$tmp/pinned.json")" != "$pin" ]; then
      todo="ghcr.io served other content for $image@$pin. Re-run the Publish job."
      fail "$image@$pin answered content with another digest"
      return 1
    fi
    ok "the digest the signed manifest pins, $pin, pulls anonymously and is what $ref points at"
  fi
  for arch in amd64 arm64; do
    child=$(jq -r --arg a "$arch" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a) | .digest][0] // empty' "$tmp/index.json")
    code=$(http_get "https://ghcr.io/v2/$path/manifests/$child" "$tmp/child.json" "$token")
    [ "$code" = 200 ] || { registry_error "$code" "$image@$child (linux/$arch)"; return 1; }
  done
  ok "the linux/amd64 and linux/arm64 image manifests pull anonymously"
}

if [ -n "$check_only" ]; then
  # <image>[:<tag>][@<digest>]; with a digest, the tag must point at it.
  spec=$check_only pin=
  case $spec in *@*) pin=${spec##*@} spec=${spec%@*} ;; esac
  last=${spec##*/}
  case $last in
  *:*) image=${spec%:*} ref=${last##*:} ;;
  *) image=$spec ref=${pin:-latest} ;;
  esac
  check_image "$image" "$ref" "$pin" || stop "$todo"
  echo "release-publish: $check_only can be pulled anonymously"
  exit 0
fi

# ---- the trusted key: brand.json's, never one from the release

key=$BRAND_MINISIGN_PUBLIC_KEY
if [ -n "${RELEASE_PUBLISH_TEST_PUBLIC_KEY:-}" ]; then
  [ "${GITHUB_ACTIONS:-}" != true ] ||
    stop "RELEASE_PUBLISH_TEST_PUBLIC_KEY is set. It is for the tests only; releases are checked against brand.json's minisignPublicKey."
  echo "release-publish: TEST: verifying with RELEASE_PUBLISH_TEST_PUBLIC_KEY, not brand.json's minisignPublicKey" >&2
  key=$RELEASE_PUBLISH_TEST_PUBLIC_KEY
fi
e2e_key=
if [ -f "$root/test/e2e-colima/keys/e2e-test.pub" ]; then e2e_key=$(sed -n 2p "$root/test/e2e-colima/keys/e2e-test.pub"); fi
case $key in
"$BRAND_PLACEHOLDER_PREFIX"*) stop "brand.json minisignPublicKey is a placeholder, so nothing can verify this release (CONTRIBUTING.md, Releases)." ;;
"$e2e_key") stop "brand.json minisignPublicKey is the TEST-ONLY e2e key, whose secret half is public." ;;
esac

verify_todo="The draft stays unpublished; do not publish it by hand. Fix the cause shown above on main, delete the draft release and the tag, then tag again (CONTRIBUTING.md, Releases)."

# ---- the release, resolved once to its id
#
# GitHub lets several drafts carry the same tag_name, and releases/tags/<tag>
# never answers with a draft, so gh looks a draft up by tag as "the first
# draft in the list with that tag". The tag is only used to find the release
# here; every download and the publish go to its id, and it is published only
# if it still matches what was checked.

gh_err() { tr '\n' ' ' <"$tmp/gh.err" | head -c 300; }

# releases_for_tag <out>: every release of $repo, drafts too, whose tag is
# $tag, as a JSON array.
releases_for_tag() {
  gh api --paginate "repos/$repo/releases?per_page=100" >"$tmp/releases.json" 2>"$tmp/gh.err" ||
    stop "gh could not list the releases of $repo: $(gh_err). Re-run the Publish job."
  jq -s --arg tag "$tag" '[(add // [])[] | select(.tag_name == $tag)]' "$tmp/releases.json" >"$1" 2>/dev/null ||
    stop "gh listed the releases of $repo as something that is not a list of releases. Re-run the Publish job."
}
# describe <releases json>: one line naming each release.
describe() {
  jq -r '[.[] | "release \(.id) (\(if .draft then "draft" else "published" end), made \(.created_at), \(.assets | length) files)"] | join(", ")' "$1"
}
stale_todo="Delete the stale draft under Releases (the one an earlier Draft release run left, usually the older), then re-run the Publish job: it checks the one that is left."

releases_for_tag "$tmp/matching.json"
count=$(jq length "$tmp/matching.json")
if [ "$count" -eq 0 ]; then
  fail "$repo has a release $tag"
  stop "There is no release $tag in $repo. The Draft release job makes it: re-run all jobs of this workflow run."
fi
if [ "$count" -gt 1 ]; then
  fail "one release carries tag $tag ($count do: $(describe "$tmp/matching.json"))"
  stop "$count releases carry tag $tag, so none is published. $stale_todo"
fi
jq '.[0]' "$tmp/matching.json" >"$tmp/release.json"
id=$(jq -r .id "$tmp/release.json")
[[ "$id" =~ ^[0-9]+$ ]] || stop "gh listed release $tag without a numeric id ($id). Re-run the Publish job."
draft=$(jq -r .draft "$tmp/release.json")
prerelease=$(jq -r .prerelease "$tmp/release.json")
state=published
[ "$draft" != true ] || state=draft
ok "$repo has one release with tag $tag: $id ($state)"

attached=$(jq -r '.assets[] | select(.state == "uploaded") | .name' "$tmp/release.json")
is_attached() { grep -qxF "$1" <<<"$attached"; }
asset_id() { jq -r --arg n "$1" '[.assets[] | select(.name == $n and .state == "uploaded") | .id][0] // empty' "$tmp/release.json"; }

binaries=("${BRAND_SLUG}_linux_amd64" "${BRAND_SLUG}_linux_arm64" "${BRAND_SLUG}_darwin_amd64" "${BRAND_SLUG}_darwin_arm64"
  "${BRAND_SLUG}_windows_amd64.exe" "${BRAND_SLUG}_windows_arm64.exe")
signed=(checksums.txt checksums.txt.minisig manifest.json manifest.json.minisig install.sh)
required=("${binaries[@]}" openapi.json "${signed[@]}")
missing=()
for f in "${required[@]}"; do is_attached "$f" || missing+=("$f"); done
if [ ${#missing[@]} -gt 0 ]; then
  fail "the release has every file a release needs (missing: ${missing[*]})"
  stop "$verify_todo"
fi
ok "the release has every file a release needs (${#required[@]} files)"

dl=$tmp/files
mkdir "$dl"
download() { # <name>...: those files of release $id into $dl, by asset id
  local f aid
  for f; do
    aid=$(asset_id "$f")
    [[ "$aid" =~ ^[0-9]+$ ]] || stop "release $tag lists $f without a numeric asset id ($aid). Re-run the Publish job."
    gh api "repos/$repo/releases/assets/$aid" -H "Accept: application/octet-stream" >"$dl/$f" 2>"$tmp/gh.err" ||
      stop "gh could not download $f (asset $aid) from release $tag: $(gh_err). Re-run the Publish job."
    [ -s "$dl/$f" ] || stop "gh downloaded an empty $f (asset $aid) from release $tag. Re-run the Publish job."
  done
}
download "${signed[@]}"

# ---- signatures

for f in checksums.txt manifest.json; do
  if ! out=$(minisign -V -P "$key" -m "$dl/$f" -x "$dl/$f.minisig" 2>&1); then
    fail "$f is signed by the release key (brand.json minisignPublicKey): $(tr '\n' ' ' <<<"$out")"
  elif ! grep -qxF "Trusted comment: $BRAND_SLUG $version $f" <<<"$out"; then
    fail "$f is signed for $BRAND_SLUG $version (the signature says: $(sed -n 's/^Trusted comment: //p' <<<"$out"))"
  else
    ok "$f is signed by the release key for $BRAND_SLUG $version"
  fi
done
[ "$failed" -eq 0 ] || stop "$verify_todo"

# ---- every file checksums.txt lists is attached and matches it

listed=()
line_re='^[0-9a-f]{64} [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$'
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  if [[ "$line" =~ $line_re ]]; then
    listed+=("${BASH_REMATCH[1]}")
  else
    fail "checksums.txt has only <sha256>  <file> lines (not: ${line:0:120})"
  fi
done <"$dl/checksums.txt"
[ ${#listed[@]} -gt 0 ] || fail "checksums.txt lists files"
[ "$failed" -eq 0 ] || stop "$verify_todo"
listed_sum() { awk -v n="$1" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1; exit }' "$dl/checksums.txt"; }

missing=()
fetch=()
for f in "${listed[@]}"; do
  if ! is_attached "$f"; then missing+=("$f")
  elif [ ! -e "$dl/$f" ]; then fetch+=("$f")
  fi
done
# goreleaser's checksum.extra_files adds install.sh and openapi.json, so
# every attached file is covered by a signature.
for f in "${binaries[@]}" install.sh openapi.json; do
  [ -n "$(listed_sum "$f")" ] || fail "checksums.txt lists $f"
done
if [ ${#missing[@]} -gt 0 ]; then
  fail "every file checksums.txt lists is attached (missing: ${missing[*]})"
  stop "$verify_todo"
fi
[ ${#fetch[@]} -eq 0 ] || download "${fetch[@]}"
bad=()
for f in "${listed[@]}"; do
  [ "$(sha256_of "$dl/$f")" = "$(listed_sum "$f")" ] || bad+=("$f")
done
if [ ${#bad[@]} -gt 0 ]; then
  fail "the attached files match their sha256 in checksums.txt (different: ${bad[*]})"
else
  ok "the ${#listed[@]} files checksums.txt lists are attached and match their signed sha256"
fi

# ---- the signed manifest and install.sh

m=$dl/manifest.json
mf() { jq -r "$1 // empty" "$m" 2>/dev/null || true; }
base="https://github.com/$repo/releases/download/$tag"
before=$failed
[ "$(mf .version)" = "$version" ] || fail "manifest.json is for version $version (it says: $(mf .version))"
[ "$(mf .panel.image)" = "$BRAND_IMAGE:$version" ] || fail "manifest.json names the panel image $BRAND_IMAGE:$version (it says: $(mf .panel.image))"
pin=$(mf .panel.digest)
[[ "$pin" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "manifest.json pins the panel image by digest (it says: $pin)"
for arch in amd64 arm64; do
  f=${BRAND_SLUG}_linux_$arch
  [ "$(mf ".agents[\"linux-$arch\"].sha256")" = "$(listed_sum "$f")" ] || fail "manifest.json has the sha256 of $f that checksums.txt has"
  [ "$(mf ".agents[\"linux-$arch\"].url")" = "$base/$f" ] || fail "manifest.json downloads $f from $base/$f (it says: $(mf ".agents[\"linux-$arch\"].url"))"
done
[ "$(mf .installer.sha256)" = "$(sha256_of "$dl/install.sh")" ] || fail "manifest.json has the sha256 of the attached install.sh"
[ "$(mf .installer.url)" = "$base/install.sh" ] || fail "manifest.json downloads install.sh from $base/install.sh (it says: $(mf .installer.url))"
[ "$failed" -ne "$before" ] || ok "manifest.json is for $version: the linux binaries and install.sh of this release, panel image $BRAND_IMAGE:$version@$pin"

before=$failed
grep -qxF "INSTALLER_VERSION='$version'" "$dl/install.sh" ||
  fail "install.sh installs $version (it says: $(sed -n "s/^INSTALLER_VERSION=//p" "$dl/install.sh" | head -1))"
grep -qxF "TEST_RELEASE_PUBLIC_KEY=''" "$dl/install.sh" || fail "install.sh is not a TEST BUILD (it trusts a test release key)"
grep -qxF "BRAND_MINISIGN_PUBLIC_KEY='$BRAND_MINISIGN_PUBLIC_KEY'" "$dl/install.sh" || fail "install.sh trusts brand.json minisignPublicKey"
[ "$failed" -ne "$before" ] || ok "install.sh is the release build of $version"

want_prerelease=false
[[ "$version" != *-* ]] || want_prerelease=true
pre_todo=
if [ "$prerelease" = "$want_prerelease" ]; then
  if [ "$want_prerelease" = true ]; then ok "the release is a pre-release, like the tag"; else ok "the release is not a pre-release, like the tag"; fi
else
  fail "the release has prerelease=$prerelease, the tag $tag needs $want_prerelease"
  if [ "$want_prerelease" = true ]; then pre_todo="Tick"; else pre_todo="Untick"; fi
  if [ "$draft" = true ]; then
    pre_todo="$pre_todo \"Set as a pre-release\" on the draft (Releases -> Edit, then Save draft), then re-run the Publish job."
  else
    pre_todo="$pre_todo \"Set as a pre-release\" on release $tag (Releases -> Edit, then Update release), then re-run the Publish job."
  fi
fi
if [ "$failed" -gt 0 ]; then
  # A wrong pre-release flag alone has its own fix; anything else is the
  # draft's content.
  [ "$failed" -ne 1 ] || [ -z "$pre_todo" ] || stop "$pre_todo"
  stop "$verify_todo"
fi

# ---- the panel image

check_image "$BRAND_IMAGE" "$version" "$pin" || stop "$todo"

# ---- publish

finish() { # <outcome>
  {
    echo "### $tag: $1"
    echo
    print_checks
  } >>"$summary"
  echo "release-publish: $tag: $1"
}

if [ "$draft" != true ]; then
  finish "already published, nothing changed"
  exit 0
fi

# version_ge <a> <b>: a >= b, both MAJOR.MINOR.PATCH.
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]; }
# A pre-release gets no make_latest: GitHub never makes one the latest.
make_latest=
note="a pre-release, so not the latest release: installs and updates do not follow it"
if [ "$want_prerelease" = false ]; then
  current=
  if gh api "repos/$repo/releases/latest" >"$tmp/latest.json" 2>"$tmp/gh.err"; then
    current=$(jq -r '.tag_name // empty' "$tmp/latest.json" 2>/dev/null || true)
  elif ! grep -qF "(HTTP 404)" "$tmp/gh.err"; then
    stop "gh could not read the latest release of $repo: $(gh_err). Re-run the Publish job."
  fi
  current=${current#v}
  if [[ ! "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || version_ge "$version" "$current"; then
    make_latest=true
    note="the latest release: installs and updates follow it"
  else
    make_latest=false
    note="not made the latest release: v$current is newer and stays the latest"
  fi
fi

# The release must still be the only one with this tag, with the files and
# flags that were checked: a re-run Draft release job or an edit while this
# ran would otherwise publish files nobody checked.
fingerprint() { # <release json>
  jq -cS '{id, tag_name, draft, prerelease, assets: ([.assets[] | {id, name, size, state, digest, updated_at}] | sort_by(.id))}' "$1"
}
releases_for_tag "$tmp/now.json"
count=$(jq length "$tmp/now.json")
if [ "$count" -eq 0 ]; then
  fail "release $tag ($id) still exists"
  stop "Release $tag was deleted while it was being checked, so nothing was published."
fi
if [ "$count" -gt 1 ]; then
  fail "one release carries tag $tag ($count do now: $(describe "$tmp/now.json"))"
  stop "Another release with tag $tag appeared while this one was being checked, so none is published. $stale_todo"
fi
jq '.[0]' "$tmp/now.json" >"$tmp/release-now.json"
if [ "$(fingerprint "$tmp/release.json")" != "$(fingerprint "$tmp/release-now.json")" ]; then
  fail "release $tag ($id) still has the files and flags that were checked"
  stop "Release $tag changed while it was being checked (its files, tag or flags), so it was not published. Re-run the Publish job to check it again."
fi
ok "release $tag ($id) still has the files and flags that were checked"

publish=(-X PATCH "repos/$repo/releases/$id" -F draft=false)
[ -z "$make_latest" ] || publish+=(-f "make_latest=$make_latest")
if ! gh api "${publish[@]}" >"$tmp/published.json" 2>"$tmp/gh.err"; then
  stop "gh could not publish release $tag ($id): $(gh_err). Re-run the Publish job."
fi
[ "$(jq -r .draft "$tmp/published.json" 2>/dev/null || true)" = false ] ||
  stop "gh published release $tag ($id), but it still reads as a draft. Check it under Releases, then re-run the Publish job."
finish "published, $note"
