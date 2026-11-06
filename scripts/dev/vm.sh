#!/usr/bin/env bash
# Run a shell command as root inside the Linux test VM (Colima profile
# seylo-a, or $SEYLO_VM). The VM must mount the checkout at the same path
# (see CONTRIBUTING.md), so repo paths work as-is. Tested with Docker 29
# (cgroup v2, cgroupfs driver). Use a VM you keep for this only: the tests
# create and delete containers, networks and volumes in it.
#
# Usage: scripts/dev/vm.sh '<command>'
set -euo pipefail
vm="${SEYLO_VM:-seylo-a}"
exec colima ssh -p "$vm" -- sudo bash -c "cd '$PWD' 2>/dev/null || cd /; $*"
