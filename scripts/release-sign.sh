#!/usr/bin/env bash
# Signs a release. In a tag release (.github/workflows/release.yml) this runs
# in the Sign job, the only job that sees the release key: it gets the files
# the Draft release job built as an artifact, runs nothing from them (it only
# hashes, compares and signs), and runs no npm, bun or goreleaser code.
#
#   scripts/release-sign.sh sign <version> <dir>
#     <dir> holds the files a release attaches, under their release names.
#     Refuses to sign unless:
#       - checksums.txt has only "<sha256>  <file>" lines, lists the
#         binaries, install.sh and openapi.json, and every file it lists is
#         in <dir> and matches its sha256;
#       - manifest.json is for <version> and has the sha256 of the linux
#         binaries and install.sh that checksums.txt has;
#       - install.sh installs <version> and is not a test build.
#     Then signs checksums.txt and manifest.json (trusted comment
#     "<slug> <version> <file>") into <file>.minisig and verifies both
#     signatures with BRAND_MINISIGN_PUBLIC_KEY.
#
#   scripts/release-sign.sh upload <tag> <dir>
#     Attaches <dir>/checksums.txt.minisig and manifest.json.minisig to the
#     draft release <tag>, once exactly one release carries the tag, it is a
#     draft, and its checksums.txt and manifest.json are the files that were
#     signed. The Publish job checks the whole release again afterwards.
#
# Needs the brand variables (export installer/brand.env; the Makefile does).
# sign: MINISIGN_SECRET_KEY (the key file), MINISIGN_PASSWORD (may be empty),
# minisign and jq. BRAND_MINISIGN_PUBLIC_KEY is the key the signatures must
# verify with: brand.json's, or the dry run's throwaway key standing in for
# it. upload: gh (GH_TOKEN) and jq; it never needs the key.
set -euo pipefail
: "${BRAND_SLUG:?export installer/brand.env first}" "${BRAND_PLACEHOLDER_PREFIX:?}" "${BRAND_MINISIGN_PUBLIC_KEY:?}" \
  "${BRAND_GITHUB_ORG:?}" "${BRAND_GITHUB_REPO:?}"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  echo "usage: scripts/release-sign.sh sign <version> <dir> | upload <tag> <dir>" >&2
  exit 2
}
die() {
  echo "release-sign: $*" >&2
  [ "${GITHUB_ACTIONS:-}" != true ] || echo "::error title=Not signed::$*"
  exit 1
}

[ $# -eq 3 ] || usage
cmd=$1 dir=$3
case $cmd in
sign) version=$2 ;;
upload) tag=$2 version=${2#v} ;;
*) usage ;;
esac
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  die "$2 is not a MAJOR.MINOR.PATCH[-PRERELEASE] version"
fi
if [ "$cmd" = upload ] && [ "$tag" != "v$version" ]; then
  die "$tag is not a vMAJOR.MINOR.PATCH[-PRERELEASE] tag"
fi
[ -d "$dir" ] || die "$dir is not a folder"

for t in jq $([ "$cmd" = sign ] && echo minisign || echo gh); do
  command -v "$t" >/dev/null 2>&1 || die "$t is not installed"
done

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# file <name>: <dir>/<name> is a regular file (not a link out of the folder).
file() { [ -f "$dir/$1" ] && [ ! -L "$dir/$1" ]; }
signed=(checksums.txt manifest.json)

upload() {
  local repo=$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO f aid count
  for f in "${signed[@]}"; do
    if ! file "$f" || ! file "$f.minisig"; then die "$dir has no $f and $f.minisig; run scripts/release-sign.sh sign first"; fi
  done
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  gh api --paginate "repos/$repo/releases?per_page=100" >"$tmp/releases.json" 2>"$tmp/gh.err" ||
    die "gh could not list the releases of $repo: $(tr '\n' ' ' <"$tmp/gh.err" | head -c 300)"
  jq -s --arg tag "$tag" '[(add // [])[] | select(.tag_name == $tag)]' "$tmp/releases.json" >"$tmp/matching.json" ||
    die "gh listed the releases of $repo as something that is not a list of releases"
  count=$(jq length "$tmp/matching.json")
  [ "$count" -eq 1 ] || die "$count releases carry tag $tag, want exactly one draft (delete the stale draft, then re-run the Sign job)"
  [ "$(jq -r '.[0].draft' "$tmp/matching.json")" = true ] || die "release $tag is already published; a published release is never signed again"
  # The draft's own copies must be the signed files, or every signature
  # uploaded here would fail in the Publish job.
  for f in "${signed[@]}"; do
    aid=$(jq -r --arg n "$f" '[.[0].assets[] | select(.name == $n and .state == "uploaded") | .id][0] // empty' "$tmp/matching.json")
    [[ "$aid" =~ ^[0-9]+$ ]] || die "the draft $tag has no $f"
    gh api "repos/$repo/releases/assets/$aid" -H "Accept: application/octet-stream" >"$tmp/$f" 2>"$tmp/gh.err" ||
      die "gh could not download $f from the draft $tag: $(tr '\n' ' ' <"$tmp/gh.err" | head -c 300)"
    cmp -s "$tmp/$f" "$dir/$f" || die "the draft's $f is not the file that was signed (the Draft release job uploaded another one)"
  done
  gh release upload "$tag" "$dir/checksums.txt.minisig" "$dir/manifest.json.minisig" --repo "$repo" --clobber ||
    die "gh could not upload the signatures to the draft $tag"
  echo "release-sign: uploaded checksums.txt.minisig and manifest.json.minisig to the draft $tag"
}

if [ "$cmd" = upload ]; then
  upload
  exit 0
fi

# ---- sign: the key

key=$BRAND_MINISIGN_PUBLIC_KEY
e2e_key=
if [ -f "$root/test/e2e-colima/keys/e2e-test.pub" ]; then e2e_key=$(sed -n 2p "$root/test/e2e-colima/keys/e2e-test.pub"); fi
case $key in
"$BRAND_PLACEHOLDER_PREFIX"*) die "brand.json minisignPublicKey is a placeholder; nothing could verify this release (CONTRIBUTING.md, Releases)" ;;
"$e2e_key") die "brand.json minisignPublicKey is the TEST-ONLY e2e key, whose secret half is public" ;;
esac
[ -n "${MINISIGN_SECRET_KEY:-}" ] && [ -f "$MINISIGN_SECRET_KEY" ] || die "MINISIGN_SECRET_KEY must name the release key file"

# ---- sign: what is signed

file checksums.txt || die "$dir has no checksums.txt"
line_re='^[0-9a-f]{64} [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$'
listed=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  [ -n "$line" ] || continue
  [[ "$line" =~ $line_re ]] || die "checksums.txt line $n is not \"<sha256>  <file>\""
  for f in ${listed[@]+"${listed[@]}"}; do
    [ "$f" != "${BASH_REMATCH[1]}" ] || die "checksums.txt lists ${BASH_REMATCH[1]} twice"
  done
  listed+=("${BASH_REMATCH[1]}")
done <"$dir/checksums.txt"
[ ${#listed[@]} -gt 0 ] || die "checksums.txt lists no files"
listed_sum() { awk -v n="$1" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1; exit }' "$dir/checksums.txt"; }

binaries=("${BRAND_SLUG}_linux_amd64" "${BRAND_SLUG}_linux_arm64" "${BRAND_SLUG}_darwin_amd64" "${BRAND_SLUG}_darwin_arm64"
  "${BRAND_SLUG}_windows_amd64.exe" "${BRAND_SLUG}_windows_arm64.exe")
for f in "${binaries[@]}" install.sh openapi.json; do
  [ -n "$(listed_sum "$f")" ] || die "checksums.txt does not list $f"
done
for f in "${listed[@]}"; do
  file "$f" || die "checksums.txt lists $f, but it is not in $dir"
  [ "$(sha256_of "$dir/$f")" = "$(listed_sum "$f")" ] || die "$f does not match its sha256 in checksums.txt"
done

file manifest.json || die "$dir has no manifest.json"
mf() { jq -r "$1 // empty" "$dir/manifest.json" 2>/dev/null || true; }
[ "$(mf .version)" = "$version" ] || die "manifest.json is not for version $version"
for arch in amd64 arm64; do
  [ "$(mf ".agents[\"linux-$arch\"].sha256")" = "$(listed_sum "${BRAND_SLUG}_linux_$arch")" ] ||
    die "manifest.json does not have the sha256 of ${BRAND_SLUG}_linux_$arch that checksums.txt has"
done
[ "$(mf .installer.sha256)" = "$(listed_sum install.sh)" ] || die "manifest.json does not have the sha256 of install.sh that checksums.txt has"
[[ "$(mf .panel.digest)" =~ ^sha256:[0-9a-f]{64}$ ]] || die "manifest.json does not pin the panel image by digest"

grep -qxF "INSTALLER_VERSION='$version'" "$dir/install.sh" || die "install.sh does not install $version"
grep -qxF "TEST_RELEASE_PUBLIC_KEY=''" "$dir/install.sh" || die "install.sh is a TEST BUILD (it trusts a test release key)"

# ---- sign, then verify with the public key

for f in "${signed[@]}"; do
  rm -f "$dir/$f.minisig"
  printf '%s\n' "${MINISIGN_PASSWORD:-}" |
    minisign -S -s "$MINISIGN_SECRET_KEY" -m "$dir/$f" -x "$dir/$f.minisig" -t "$BRAND_SLUG $version $f" >/dev/null 2>&1 ||
    die "could not sign $f with MINISIGN_SECRET_KEY (wrong password?)"
done
for f in "${signed[@]}"; do
  out=$(minisign -V -P "$key" -m "$dir/$f" -x "$dir/$f.minisig" 2>&1) ||
    { rm -f "$dir"/*.minisig; die "the signature of $f does not verify with brand.json minisignPublicKey (MINISIGN_SECRET_KEY is another key)"; }
  grep -qxF "Trusted comment: $BRAND_SLUG $version $f" <<<"$out" || { rm -f "$dir"/*.minisig; die "the signature of $f does not name $BRAND_SLUG $version"; }
done
echo "release-sign: signed checksums.txt (${#listed[@]} files) and manifest.json for $BRAND_SLUG $version"
