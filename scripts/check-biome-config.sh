#!/usr/bin/env bash
# One Biome config for the whole repository (make lint runs this before
# Biome). A nested biome.json that extends the root ("extends": "//")
# inherits its files.includes and Biome reads those patterns from the
# nested folder: "packages/**" under packages/env-analyzer matched nothing,
# so Biome checked none of that package's files and said nothing about it.
# One that does not extend it gets Biome's defaults instead of ours (tabs,
# 80 columns). Rules for one folder go in the root biome.json "overrides".
#
# Usage: scripts/check-biome-config.sh [repository root]
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
nested="$(git -C "$root" ls-files --cached --others --exclude-standard -- ':(glob)**/biome.json' ':(glob)**/biome.jsonc' |
  grep -v -x -e biome.json -e biome.jsonc || true)"
if [ -n "$nested" ]; then
  echo "check-biome-config: nested Biome config (Biome skips or misformats the files under it); move its rules into an override in the root biome.json:" >&2
  echo "$nested" >&2
  exit 1
fi
echo "check-biome-config: one Biome config"
