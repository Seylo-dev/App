#!/usr/bin/env bash
# Nothing is released yet, so the panel keeps ONE migration per database
# (0000_init). This rebuilds both from the current schema files in the
# working tree. Run it after a schema change, then commit apps/panel/drizzle
# with the change. Delete any old scratch panel.db afterwards, since the
# migration hash changes.
#
# Usage: scripts/dev/regen-migrations.sh
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root/apps/panel"
rm -rf drizzle/panel drizzle/metrics
bunx drizzle-kit generate --name init --config drizzle.config.ts
bunx drizzle-kit generate --name init --config drizzle.metrics.config.ts
