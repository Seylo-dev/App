#!/usr/bin/env bash
# Second half of a release build, after `goreleaser release`: write the
# release manifest (manifest.json) that the panel and the agents update from,
# attach it to the GitHub release, and gather every file the release attaches
# into dist/release/ under its release name (<slug>_linux_amd64, ...,
# checksums.txt, install.sh, openapi.json, manifest.json). Nothing here
# signs: scripts/release-sign.sh signs dist/release/checksums.txt and
# manifest.json (in a tag release, the Sign job, which gets dist/release/ as
# an artifact).
#
# Needs: the brand variables (the Makefile exports installer/brand.env), jq,
# docker buildx (to read the pushed image's digest) and gh (to upload).
# DRY_RUN=1 skips the upload; PANEL_DIGEST skips the registry lookup.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${BRAND_SLUG:?run through the Makefile}" "${BRAND_IMAGE:?}" "${BRAND_GITHUB_ORG:?}" "${BRAND_GITHUB_REPO:?}"

version=$(jq -r '.version // empty' dist/metadata.json)
[ -n "$version" ] || { echo "release-manifest: no version in dist/metadata.json" >&2; exit 1; }
image="$BRAND_IMAGE:$version"
digest=${PANEL_DIGEST:-$(docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}' | tr -d '"')}
[ -n "$digest" ] || { echo "release-manifest: could not read the digest of $image" >&2; exit 1; }

# goreleaser keeps the binaries in per-target folders and uploads them under
# <slug>_<os>_<arch> (dist/artifacts.json maps one to the other); gather them
# under those names (inside dist, which goreleaser cleans).
out=dist/release
rm -rf "$out"
mkdir -p "$out"
jq -r --arg prefix "${BRAND_SLUG}_" \
  '.[] | select(.type == "Binary" and (.name | startswith($prefix))) | [.name, .path] | @tsv' \
  dist/artifacts.json | while IFS=$'\t' read -r name path; do cp "$path" "$out/$name"; done
for arch in amd64 arm64; do
  [ -f "$out/${BRAND_SLUG}_linux_$arch" ] || { echo "release-manifest: no linux/$arch binary in dist/artifacts.json" >&2; exit 1; }
done
cp dist/checksums.txt build/install.sh openapi.json "$out/"

go -C go run ./internal/update/releasetool \
  -version "$version" -binaries "$PWD/$out" -image "$image" -digest "$digest" \
  -installer "$PWD/$out/install.sh" -min-agent "${MIN_AGENT:-}" -min-upgrade-from "${MIN_UPGRADE_FROM:-}" \
  -out "$PWD/dist/manifest.json"
cp dist/manifest.json "$out/"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: not uploading dist/manifest.json"
  exit 0
fi
gh release upload "v$version" dist/manifest.json --repo "$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO" --clobber
echo "uploaded the manifest for v$version; scripts/release-sign.sh signs it"
