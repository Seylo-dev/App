#!/usr/bin/env bash
# Deletes the three e2e VMs, stops the servers on the Mac and removes the
# e2e output (releases, state, results; RESULTS.md stays).
#
# Usage: test/e2e-colima/down.sh
source "$(dirname "$0")/lib.sh"

"$(dirname "$0")/serve.sh" stop || true
for vm in "$E2E_A" "$E2E_B"; do
  if colima ls -p "$vm" -j >/dev/null 2>&1; then
    log "deleting $vm"
    colima delete -p "$vm" --force --data
  fi
done
if limactl list -q 2>/dev/null | grep -qx "$E2E_C"; then
  log "deleting $E2E_C"
  limactl delete -f "$E2E_C"
fi
if [ -d "$E2E_OUT" ]; then
  find "$E2E_OUT" -mindepth 1 -delete
  rmdir "$E2E_OUT"
fi
