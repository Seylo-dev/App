#!/usr/bin/env bash
# Fails when committed generated code differs from what the sources produce.
# CI runs it; run `make gen` locally to fix a failure.
set -euo pipefail
cd "$(dirname "$0")/.."

generated=(
  go/gen
  packages/proto/src/gen
  packages/brand/src
  installer/brand.env
  installer/install.sh
  packages/ops/src/ops/index.gen.ts
  apps/panel/src/modules/index.gen.ts
  apps/web/src/i18n/en/index.gen.ts
  apps/web/src/routeTree.gen.ts
  openapi.json
  apps/panel/drizzle
)

if [ -n "$(git status --porcelain -- "${generated[@]}")" ]; then
  echo "check-generated: commit or discard local changes to generated files first" >&2
  git status --short -- "${generated[@]}" >&2
  exit 1
fi

go -C tools/brandgen run . -root ../.. -check
make --no-print-directory gen >/dev/null
# A schema change without its migration shows up as a new file in apps/panel/drizzle.
(cd apps/panel && bun run db:generate >/dev/null)

if [ -n "$(git status --porcelain -- "${generated[@]}")" ]; then
  echo "check-generated: generated code is stale. Run \`make gen\` (and \`bun run db:generate\` in apps/panel after a schema change) and commit the result:" >&2
  git status --short -- "${generated[@]}" >&2
  exit 1
fi

# SECURITY.md and README.md print the release key for checking downloads by
# hand, so they follow brand.json when the key changes.
key=$(sed -n "s/^BRAND_MINISIGN_PUBLIC_KEY='\(.*\)'\$/\1/p" installer/brand.env)
prefix=$(sed -n "s/^BRAND_PLACEHOLDER_PREFIX='\(.*\)'\$/\1/p" installer/brand.env)
if [ -n "$key" ] && [[ "$key" != "$prefix"* ]]; then
  for f in SECURITY.md README.md; do
    if ! grep -qF -- "$key" "$f"; then
      echo "check-generated: $f does not show brand.json minisignPublicKey ($key); update its verification commands" >&2
      exit 1
    fi
  done
fi
echo "check-generated: up to date"
