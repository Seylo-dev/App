#!/usr/bin/env bash
# Extra install checks, outside the 43 checks: install.sh from the e2e
# release server as a panel on two more systems, each a fresh plain Lima VM
# (vz, vzNAT) that is deleted afterwards:
#
#   seylo-x-deb  Debian 12 (template debian-12)
#   seylo-x-ufw  Ubuntu 24.04 with ufw on (deny incoming, ssh allowed)
#
# On each: install.sh --version <published release> --port $E2E_PORT, then
# test/install-smoke/smoke.sh from the Mac: the owner and an API key through
# the setup link, a traefik/whoami service live, its IP:port answering from
# the Mac. On the ufw VM the panel's own ports answer (the installer opens
# them in ufw) and the service's IP:port answers only after the ufw command
# the panel shows for it. The VMs pull the panel image pinned at
# 127.0.0.1:$E2E_REG_PORT through relays to A's registry, as check 38 does.
#
# Needs: up.sh (A running), serve.sh, infra.sh and build.sh done.
# Usage: test/e2e-colima/extra-installs.sh [deb] [ufw]    (default: both)
#        KEEP_X=1 keeps the VMs. Logs: ~/.cache/seylo-e2e/state/extra/<name>.log
source "$(dirname "$0")/lib.sh"

ORG=$BRAND_GITHUB_ORG
REPO=$BRAND_GITHUB_REPO
X_FWD_PORT=${X_FWD_PORT:-15003}
X_DIR=$E2E_STATE/extra
mkdir -p "$X_DIR"
version=$(state_get published)
[ -n "$version" ] || version=$E2E_V1

x_vm_of() {
  case $1 in
  deb) echo seylo-x-deb ;;
  ufw) echo seylo-x-ufw ;;
  *) fail "unknown extra install $1 (deb or ufw)" ;;
  esac
}
x_template() {
  case $1 in
  deb) echo debian-12 ;;
  ufw) echo ubuntu-24.04 ;;
  esac
}

# x_delete <vm>: deletes one of this script's VMs (never another one).
x_delete() {
  local vm=$1
  case $vm in
  seylo-x-deb | seylo-x-ufw) ;;
  *) fail "refusing to delete the VM $vm (this script only deletes seylo-x-deb and seylo-x-ufw)" ;;
  esac
  if limactl list -q 2>/dev/null | grep -qx "$vm"; then
    limactl delete -f "$vm" >/dev/null 2>&1 || log "could not delete $vm"
  fi
  rm -f "$E2E_STATE/ip-$vm"
}

X_FAILS=0
# x_ok / x_bad <name> <text>: one result line, also in the log.
x_ok() { printf '  ok   %s\n' "$2" | tee -a "$X_DIR/$1.log" >&2; }
x_bad() {
  printf '  FAIL %s\n' "$2" | tee -a "$X_DIR/$1.log" >&2
  X_FAILS=$((X_FAILS + 1))
}

# x_install <deb|ufw>: the whole run on one fresh VM.
x_install() {
  local name=$1 vm ip ip_a out token smoke address hint port rc fails_before=$X_FAILS
  vm=$(x_vm_of "$name")
  : >"$X_DIR/$name.log"
  ip_a=$(vm_ip "$E2E_A") || fail "no address for $E2E_A (up.sh)"
  x_delete "$vm"
  log "creating $vm ($(x_template "$name"), plain Lima, vz, vzNAT)"
  if ! limactl create --tty=false --name "$vm" --vm-type vz --network vzNAT --plain \
    --cpus 2 --memory 3 --disk 20 "template:$(x_template "$name")" >>"$X_DIR/$name.log" 2>&1 ||
    ! limactl start --tty=false "$vm" >>"$X_DIR/$name.log" 2>&1; then
    x_bad "$name" "could not create and start $vm (see $X_DIR/$name.log)"
    return 1
  fi
  ip=$(vm_ip "$vm") || { x_bad "$name" "$vm has no vzNAT address"; return 1; }
  x_ok "$name" "$vm at $ip: $(on "$vm" ". /etc/os-release && echo \"\$PRETTY_NAME\"")"

  # vzNAT keeps guests apart: the VM and A reach each other through the Mac (as up.sh does for the e2e VMs).
  on "$vm" "ip route replace $ip_a/32 via $(host_ip)" && on "$E2E_A" "ip route replace $ip/32 via $(host_ip)" ||
    { x_bad "$name" "could not route between $vm and $E2E_A"; return 1; }
  on "$vm" "command -v curl >/dev/null && command -v python3 >/dev/null ||
    (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl python3 ca-certificates >/dev/null)" >>"$X_DIR/$name.log" 2>&1 ||
    { x_bad "$name" "could not install curl and python3 on $vm"; return 1; }
  if [ "$name" = ufw ]; then
    out=$(on "$vm" "command -v ufw >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null)
      ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null && ufw allow 22/tcp >/dev/null &&
      ufw --force enable >/dev/null && ufw status | head -1" 2>&1) || { x_bad "$name" "could not turn ufw on: $out"; return 1; }
    x_ok "$name" "ufw on before the install: $out (deny incoming, 22/tcp allowed)"
  fi

  # The panel image is pinned at 127.0.0.1:$E2E_REG_PORT: the VM's own loopback -> A -> A's registry.
  relay_start "$E2E_A" "$ip_a" "$X_FWD_PORT" 127.0.0.1 "$E2E_REG_PORT" e2e-regfwd-x &&
    relay_start "$vm" 127.0.0.1 "$E2E_REG_PORT" "$ip_a" "$X_FWD_PORT" ||
    { x_bad "$name" "could not start the registry relays"; return 1; }
  wait_for 30 "the registry from $vm" on "$vm" "curl -fsS -m 5 -o /dev/null http://127.0.0.1:$E2E_REG_PORT/v2/" ||
    { x_bad "$name" "$vm cannot reach the panel image registry on A"; return 1; }

  # install.sh from the release server, as a panel.
  rc=0
  out=$(on "$vm" "curl -fsSL $(release_base)/$ORG/$REPO/releases/download/v$version/install.sh | sh -s -- \
    --release-url $(release_base)/$ORG/$REPO/releases --version $version --port $E2E_PORT" 2>&1) || rc=$?
  printf '%s\n' "$out" >>"$X_DIR/$name.log"
  [ "$rc" = 0 ] || { x_bad "$name" "install.sh $version failed (exit $rc): $(printf '%s' "$out" | grep -i 'error' | tail -2 | tr '\n' ' ')"; return 1; }
  printf '%s' "$out" | grep -q 'Docker is missing: installing it' &&
    x_ok "$name" "install.sh installed Docker by itself" || x_bad "$name" "install.sh did not say it installed Docker"
  token=$(printf '%s\n' "$out" | grep -o 'https\?://[^ ]*/setup?t=[A-Za-z0-9_-]*' | head -1 | sed 's/.*?t=//')
  [ -n "$token" ] || { x_bad "$name" "install.sh printed no setup link"; return 1; }
  x_ok "$name" "install.sh $version finished and printed the setup link"
  if [ "$name" = ufw ]; then
    out=$(on "$vm" "ufw status" 2>&1 | tr -s ' ' | tr '\n' ';')
    printf '%s' "$out" | grep -q "$E2E_PORT/tcp ALLOW" && x_ok "$name" "the installer opened the panel port in ufw: $out" ||
      x_bad "$name" "ufw does not allow the panel port $E2E_PORT: $out"
  fi

  # Setup, a whoami deploy and its IP:port, from the Mac.
  if [ "$name" = ufw ]; then
    smoke=$("$E2E_ROOT/test/install-smoke/smoke.sh" --panel-url "http://$ip:$E2E_PORT" --token "$token" --no-reach 2>>"$X_DIR/$name.log") ||
      { x_bad "$name" "setup or the whoami deploy failed (see $X_DIR/$name.log)"; return 1; }
  else
    smoke=$("$E2E_ROOT/test/install-smoke/smoke.sh" --panel-url "http://$ip:$E2E_PORT" --token "$token" --reach "$ip" 2>>"$X_DIR/$name.log") ||
      { x_bad "$name" "setup, the whoami deploy or its IP:port failed (see $X_DIR/$name.log)"; return 1; }
  fi
  address=$(printf '%s\n' "$smoke" | sed -n 's/^address=//p')
  hint=$(printf '%s\n' "$smoke" | sed -n 's/^firewall_hint=//p')
  port=${address##*:}
  x_ok "$name" "the owner, an API key, a project and whoami live through the API; the panel shows $address"
  if [ "$name" = ufw ]; then
    # The agent serves IP:port itself, so ufw applies until the port is opened.
    if curl -s -o /dev/null -m 5 "http://$ip:$port/"; then
      x_bad "$name" "http://$ip:$port answers although ufw does not allow $port"
    else
      x_ok "$name" "http://$ip:$port is closed by ufw at first"
    fi
    [ "$hint" = "ufw allow $port/tcp" ] && x_ok "$name" "the panel shows the command to open it: $hint" ||
      x_bad "$name" "the panel's firewall hint is '$hint', not 'ufw allow $port/tcp'"
    on "$vm" "ufw allow $port/tcp >/dev/null" || x_bad "$name" "ufw allow $port/tcp failed"
    if wait_for 60 "whoami through ufw" sh -c "curl -fsS -m 5 'http://$ip:$port/' | grep -q '^Hostname:'"; then
      x_ok "$name" "after ufw allow $port/tcp, http://$ip:$port answers like whoami"
    else
      x_bad "$name" "http://$ip:$port does not answer after ufw allow $port/tcp"
    fi
  else
    x_ok "$name" "http://$ip:$port answers like whoami from the Mac"
  fi
  [ "$X_FAILS" = "$fails_before" ]
}

# x_cleanup <deb|ufw>: relays and routes off, the VM deleted (kept with KEEP_X=1).
x_cleanup() {
  local name=$1 vm ip
  vm=$(x_vm_of "$name")
  ip=$(state_get "ip-$vm")
  relay_stop "$E2E_A" e2e-regfwd-x || true
  [ -z "$ip" ] || on "$E2E_A" "ip route del $ip/32 >/dev/null 2>&1; true" || true
  if [ -n "${KEEP_X:-}" ]; then
    log "KEEP_X=1: $vm stays (test/e2e-colima/extra-installs.sh deletes it on its next run)"
    return
  fi
  x_delete "$vm"
}

names=${*:-deb ufw}
results=
for name in $names; do
  x_vm_of "$name" >/dev/null
  log "extra install: $name"
  if x_install "$name"; then status=PASS; else status=FAIL; fi
  x_cleanup "$name"
  printf '%s\n' "$status" >"$X_DIR/$name.status"
  results="$results $name=$status"
done
log "extra installs:$results (logs in $X_DIR)"
case $results in *=FAIL*) exit 1 ;; esac
