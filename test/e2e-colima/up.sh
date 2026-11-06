#!/usr/bin/env bash
# Creates (or starts) the three e2e VMs and checks they reach each other and
# the Mac. Idempotent.
#
#   A, B: Colima (vz, --network-address = vzNAT, Docker), --activate=false
#   C:    plain Lima Ubuntu 24.04 (vz, vzNAT), no Docker, no mounts
#
# Usage: test/e2e-colima/up.sh
source "$(dirname "$0")/lib.sh"

E2E_CPUS_A=${E2E_CPUS_A:-4}
E2E_MEM_A=${E2E_MEM_A:-6}
E2E_CPUS_B=${E2E_CPUS_B:-2}
E2E_MEM_B=${E2E_MEM_B:-4}
E2E_CPUS_C=${E2E_CPUS_C:-2}
E2E_MEM_C=${E2E_MEM_C:-3}
mkdir -p "$E2E_OUT" "$E2E_STATE"

colima_up() { # profile cpus memory
  local vm=$1 status
  status=$(colima ls -p "$vm" -j 2>/dev/null | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' || true)
  case $status in
  Running) log "$vm is running" ;;
  Stopped)
    log "starting $vm"
    colima start -p "$vm" --activate=false
    ;;
  *)
    log "creating $vm"
    # Only the e2e output folder is shared (read-only), never the tree.
    colima start -p "$vm" --activate=false --vm-type vz --network-address \
      --cpu "$2" --memory "$3" --disk 40 --runtime docker --mount "$E2E_OUT"
    ;;
  esac
}

lima_up() {
  local vm=$E2E_C status
  status=$(limactl list --format '{{.Status}}' "$vm" 2>/dev/null || true)
  case $status in
  Running) log "$vm is running" ;;
  Stopped)
    log "starting $vm"
    limactl start --tty=false "$vm"
    ;;
  *)
    log "creating $vm (plain Ubuntu 24.04, no Docker)"
    limactl create --tty=false --name "$vm" --vm-type vz --network vzNAT --plain \
      --cpus "$E2E_CPUS_C" --memory "$E2E_MEM_C" --disk 30 template:ubuntu-24.04
    limactl start --tty=false "$vm"
    ;;
  esac
}

colima_up "$E2E_A" "$E2E_CPUS_A" "$E2E_MEM_A" &
pa=$!
colima_up "$E2E_B" "$E2E_CPUS_B" "$E2E_MEM_B" &
pb=$!
lima_up &
pc=$!
wait $pa || fail "could not start $E2E_A"
wait $pb || fail "could not start $E2E_B"
wait $pc || fail "could not start $E2E_C"

rm -f "$E2E_STATE"/ip-*
for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
  ip=$(vm_ip "$vm") || fail "$vm has no vzNAT address"
  log "$vm at $ip"
done
log "the Mac at $(host_ip)"

# macOS isolates vzNAT guests from each other (ARP between VMs fails), but
# the Mac forwards between them (net.inet.ip.forwarding=1). Each VM routes
# the other two through the Mac's bridge address; a oneshot unit re-adds the
# routes on boot.
ips="$(vm_ip "$E2E_A") $(vm_ip "$E2E_B") $(vm_ip "$E2E_C")"
for vm in "$E2E_A" "$E2E_B" "$E2E_C"; do
  self=$(vm_ip "$vm")
  routes=""
  for ip in $ips; do
    [ "$ip" = "$self" ] || routes="${routes}ip route replace $ip/32 via $(host_ip)
"
  done
  script="#!/bin/sh
# e2e test only: reach the other e2e VMs through the Mac (vzNAT isolates guests).
for i in 1 2 3 4 5 6 7 8 9 10; do ip route show | grep -q 'via $(host_ip)' && break; sleep 1; done
$routes"
  unit="[Unit]
Description=e2e test routes to the other VMs
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/e2e-routes
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target"
  printf '%s\n' "$script" | on "$vm" "cat >/usr/local/sbin/e2e-routes && chmod 0755 /usr/local/sbin/e2e-routes"
  printf '%s\n' "$unit" | on "$vm" "cat >/etc/systemd/system/e2e-routes.service && systemctl daemon-reload && systemctl enable -q e2e-routes.service && /usr/local/sbin/e2e-routes"
done

for from in "$E2E_A" "$E2E_B" "$E2E_C"; do
  for to in "$E2E_A" "$E2E_B" "$E2E_C"; do
    [ "$from" = "$to" ] && continue
    # Every VM runs sshd on 22 (Colima's VMs have no ping).
    on "$from" "timeout 5 bash -c '</dev/tcp/$(vm_ip "$to")/22'" || fail "$from cannot reach $to"
  done
done
log "all three VMs reach each other (serve.sh checks the Mac's release server from each)"

# C must stay without Docker until install.sh installs it.
if on "$E2E_C" "command -v docker >/dev/null"; then
  log "note: $E2E_C already has Docker (installed by an earlier join)"
fi
# Tools the checks use on the nodes.
on "$E2E_A" "command -v git >/dev/null && command -v jq >/dev/null || (apt-get update -qq && apt-get install -y -qq git jq >/dev/null)"
on "$E2E_B" "command -v jq >/dev/null || (apt-get update -qq && apt-get install -y -qq jq >/dev/null)"
on "$E2E_C" "command -v jq >/dev/null && command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq jq curl >/dev/null)"
