#!/usr/bin/env bash
# Build one Go package's tests for linux (with the "integration" build tag)
# and run them as root inside the test VM against its real Docker.
# SEYLO_IT=1 is set inside the VM, and every SEYLO_IT_* variable you set is
# passed through (SEYLO_IT_GUARD_BIN, SEYLO_IT_NIXPACKS, ...). go test flags
# are translated (-run X -v -count 1 -timeout 5m work as usual).
#
# Usage: scripts/dev/vm-gotest.sh ./internal/reconcile [-run TestRollout -v]
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
pkg="$1"
shift
arch="${SEYLO_VM_ARCH:-arm64}"
name=$(printf '%s' "$pkg" | tr '/.' '__')
mkdir -p "$root/.vmbin"
out="$root/.vmbin/$name.$$.test"
trap 'rm -f "$out"' EXIT
(cd "$root/go" && GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go test -c -tags integration -o "$out" "$pkg")
args=()
for a in "$@"; do
  case "$a" in
  -test.*) args+=("$a") ;;
  -[a-z]*) args+=("-test.${a#-}") ;;
  *) args+=("$a") ;;
  esac
done
envs=(SEYLO_IT=1)
while IFS='=' read -r k _; do
  case "$k" in SEYLO_IT_*) envs+=("$k=${!k}") ;; esac
done < <(env)
pkgdir="$root/go/${pkg#./}"
quoted=$(printf '%q ' "${args[@]+"${args[@]}"}")
colima ssh -p "${SEYLO_VM:-seylo-a}" -- sudo env "${envs[@]}" bash -c "cd '$pkgdir' && '$out' $quoted"
