#!/usr/bin/env bash
# Publishes a built release as "latest" on the local release server: copies
# its assets to /<org>/<repo>/releases/latest/download/, writes the GitHub API
# answer at /repos/<org>/<repo>/releases/latest and the root /install.sh.
#
# Usage: test/e2e-colima/publish.sh <version>
source "$(dirname "$0")/lib.sh"

v=${1:?usage: publish.sh <version>}
v=${v#v}
ORG=$BRAND_GITHUB_ORG
REPO=$BRAND_GITHUB_REPO
src=$E2E_REL/$ORG/$REPO/releases/download/v$v
[ -f "$src/manifest.json.minisig" ] || fail "release $v is not built (build.sh)"
latest=$E2E_REL/$ORG/$REPO/releases/latest/download
rm -rf "$latest"
mkdir -p "$latest" "$E2E_REL/repos/$ORG/$REPO/releases"
cp "$src"/* "$latest/"
cp "$src/install.sh" "$E2E_REL/install.sh"
base="$(release_base)/$ORG/$REPO/releases/download/v$v"
(cd "$src" && for f in *; do printf '%s\n' "$f"; done) |
  jq -R --arg base "$base" '{name: ., browser_download_url: "\($base)/\(.)"}' |
  jq -s --arg v "v$v" '{tag_name: $v, name: $v, draft: false, prerelease: false, assets: .}' \
    >"$E2E_REL/repos/$ORG/$REPO/releases/latest"
state_set published "$v"
log "published $v as latest"
