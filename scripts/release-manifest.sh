#!/usr/bin/env bash
# Second half of a release, after `goreleaser release`: write the signed
# release manifest (manifest.json + manifest.json.minisig) that the panel
# and the agents update from, and attach both to the GitHub release.
#
# Needs: the brand variables (the Makefile exports installer/brand.env),
# MINISIGN_SECRET_KEY (key file) and MINISIGN_PASSWORD, docker buildx (to read
# the pushed image's digest) and gh (to upload). DRY_RUN=1 skips the upload;
# PANEL_DIGEST skips the registry lookup.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${BRAND_SLUG:?run through the Makefile}" "${BRAND_IMAGE:?}" "${BRAND_GITHUB_ORG:?}" "${BRAND_GITHUB_REPO:?}"

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' dist/metadata.json | head -1)
[ -n "$version" ] || { echo "release-manifest: no version in dist/metadata.json" >&2; exit 1; }
image="$BRAND_IMAGE:$version"
digest=${PANEL_DIGEST:-$(docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}' | tr -d '"')}
[ -n "$digest" ] || { echo "release-manifest: could not read the digest of $image" >&2; exit 1; }

# goreleaser keeps raw binaries in per-target folders; gather them by name
# into dist/manifest-binaries (inside dist, which goreleaser cleans).
bins=dist/manifest-binaries
mkdir -p "$bins"
for arch in amd64 arm64; do
  src=$(find dist -path "$bins" -prune -o -type f -name "${BRAND_SLUG}_linux_${arch}" -print | head -1)
  [ -n "$src" ] || src=$(find dist -path "*linux_${arch}*" -type f -name "$BRAND_SLUG" | head -1)
  [ -n "$src" ] || { echo "release-manifest: no linux/$arch binary in dist/" >&2; exit 1; }
  cp "$src" "$bins/${BRAND_SLUG}_linux_${arch}"
done

go -C go run ./internal/update/releasetool \
  -version "$version" -binaries "$PWD/$bins" -image "$image" -digest "$digest" \
  -installer "$PWD/dist/install.sh" -min-agent "${MIN_AGENT:-}" -min-upgrade-from "${MIN_UPGRADE_FROM:-}" \
  -out "$PWD/dist/manifest.json"

printf '%s\n' "${MINISIGN_PASSWORD:-}" | minisign -S -s "${MINISIGN_SECRET_KEY:?}" -m dist/manifest.json -x dist/manifest.json.minisig \
  -t "$BRAND_SLUG $version manifest.json"
if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: not uploading dist/manifest.json"
  exit 0
fi
gh release upload "v$version" dist/manifest.json dist/manifest.json.minisig --repo "$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO" --clobber
echo "uploaded the signed manifest for v$version"
