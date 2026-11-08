#!/usr/bin/env bash
# Starts the e2e infrastructure containers on VM A, all unlabeled (so the
# cleanup check also proves they survive):
#
#   e2e-registry  registry for the panel images, 127.0.0.1:$E2E_REG_PORT on A
#   e2e-minio     S3 bucket for the backup checks, <A>:19000 (bucket e2e-backups)
#   e2e-pebble    ACME test CA for the stretch check, <A>:14000 (directory /dir)
#   e2e-headscale tailnet control server for check 40, https://<A>:$E2E_HS_PORT
#                 (a certificate from serve.sh's test CA, which the VMs trust),
#                 its own DERP and STUN on 3478/udp, MagicDNS under
#                 $E2E_HS_DOMAIN, no HTTPS certificates for machines. Needs
#                 serve.sh's CA; without it check 40 is BLOCKED.
#
# Usage: test/e2e-colima/infra.sh
source "$(dirname "$0")/lib.sh"

REGISTRY_IMAGE=${REGISTRY_IMAGE:-registry:2.8.3}
# The image the agent's backup tests use (minio/minio is no longer published); it ships mc.
MINIO_IMAGE=${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}
PEBBLE_IMAGE=${PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:2.7.0}
HEADSCALE_IMAGE=${HEADSCALE_IMAGE:-headscale/headscale:v0.29.7@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970}
MINIO_USER=e2eminio
MINIO_PASSWORD=e2e-minio-test-only

running() { on "$E2E_A" "docker inspect -f '{{.State.Running}}' $1 2>/dev/null | grep -q true"; }

# pull <image>: pulls on A, trying again on a network error (registries time out now and then).
pull() {
  local i
  for i in 1 2 3 4 5; do
    on "$E2E_A" "docker image inspect $1 >/dev/null 2>&1 || docker pull -q $1 >/dev/null" && return 0
    log "pulling $1 failed (try $i of 5)"
    sleep $((i * 5))
  done
  return 1
}
for image in "$REGISTRY_IMAGE" "$MINIO_IMAGE" "$PEBBLE_IMAGE"; do
  pull "$image" || fail "could not pull $image on $E2E_A"
done
hs_image=yes
pull "$HEADSCALE_IMAGE" || hs_image=

if ! running e2e-registry; then
  log "starting e2e-registry"
  on "$E2E_A" "docker rm -f e2e-registry >/dev/null 2>&1; docker run -d --name e2e-registry --restart unless-stopped \
    -p 127.0.0.1:$E2E_REG_PORT:5000 -v e2e-registry:/var/lib/registry $REGISTRY_IMAGE >/dev/null"
fi
if ! running e2e-minio; then
  log "starting e2e-minio"
  on "$E2E_A" "docker rm -f e2e-minio >/dev/null 2>&1; docker run -d --name e2e-minio --restart unless-stopped \
    -p 19000:9000 -e MINIO_ROOT_USER=$MINIO_USER -e MINIO_ROOT_PASSWORD=$MINIO_PASSWORD \
    -v e2e-minio:/data $MINIO_IMAGE server /data >/dev/null"
fi
wait_for 60 "MinIO" on "$E2E_A" "curl -fsS -o /dev/null http://127.0.0.1:19000/minio/health/live" || fail "MinIO did not start"
on "$E2E_A" "docker exec e2e-minio sh -c \
  'mc alias set e2e http://127.0.0.1:9000 $MINIO_USER $MINIO_PASSWORD >/dev/null && mc mb -p e2e/e2e-backups >/dev/null'"
if ! running e2e-pebble || ! on "$E2E_A" "test -f /root/e2e-pebble/config.json"; then
  log "starting e2e-pebble"
  # The image's config, with HTTP-01 validation on port 80 (it defaults to
  # 5002) so it reaches the nodes' Traefik. PEBBLE_VA_NOSLEEP: validate at
  # once; names resolve with the VM's DNS (sslip.io names work).
  on "$E2E_A" "mkdir -p /root/e2e-pebble && docker rm -f e2e-pebble >/dev/null 2>&1;
    cid=\$(docker create $PEBBLE_IMAGE) && docker cp \$cid:/test/config/pebble-config.json - | tar -xO >/root/e2e-pebble/config.json && docker rm \$cid >/dev/null &&
    sed -i 's/\"httpPort\": 5002/\"httpPort\": 80/' /root/e2e-pebble/config.json &&
    docker run -d --name e2e-pebble --restart unless-stopped -v /root/e2e-pebble:/e2e:ro \
      -p 14000:14000 -p 15001:15000 -e PEBBLE_VA_NOSLEEP=1 $PEBBLE_IMAGE -config /e2e/config.json >/dev/null" ||
    fail "Pebble did not start (checks 29 and 31 need it)"
fi
wait_for 30 "the registry" on "$E2E_A" "curl -fsS -o /dev/null http://127.0.0.1:$E2E_REG_PORT/v2/" || fail "registry did not start"
state_set minio "http://$(vm_ip "$E2E_A"):19000 $MINIO_USER $MINIO_PASSWORD"

# Headscale: the config, and a certificate for A's address from serve.sh's
# test CA (made again when the CA changed). Check 40 makes its user, keys
# and nodes, and deletes the nodes again.
headscale_config() {
  local ip=$1
  cat <<EOF
# e2e test only (check 40): a tailnet without the internet.
server_url: https://$ip:$E2E_HS_PORT
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: e2e
    region_name: e2e embedded DERP
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: $ip
  urls: []
  paths: []
  auto_update_enabled: false
  update_frequency: 24h
disable_check_updates: true
node:
  expiry: 0
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
tls_cert_path: /etc/headscale/tls.crt
tls_key_path: /etc/headscale/tls.key
log:
  level: info
  format: text
policy:
  mode: file
  path: ""
dns:
  magic_dns: true
  base_domain: $E2E_HS_DOMAIN
  override_local_dns: false
  nameservers:
    global: []
    split: {}
  search_domains: []
  extra_records: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
taildrop:
  enabled: false
EOF
}

tls=$E2E_STATE/tls
if [ -z "$hs_image" ]; then
  log "note: could not pull $HEADSCALE_IMAGE on $E2E_A, so e2e-headscale is not started and check 40 is BLOCKED"
elif [ ! -s "$tls/ca.key" ]; then
  log "note: no test CA yet (serve.sh makes it), so e2e-headscale is not started and check 40 is BLOCKED"
else
  ip_a=$(vm_ip "$E2E_A")
  if ! openssl verify -CAfile "$tls/ca.crt" "$tls/headscale.crt" >/dev/null 2>&1 ||
    ! openssl x509 -in "$tls/headscale.crt" -noout -text 2>/dev/null | grep -qE "IP Address:${ip_a//./\\.}([^0-9]|\$)"; then
    log "creating the Headscale certificate for $ip_a (test CA)"
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$ip_a" -keyout "$tls/headscale.key" -out "$tls/headscale.csr" 2>/dev/null
    printf 'subjectAltName=IP:%s\nextendedKeyUsage=serverAuth\n' "$ip_a" >"$tls/headscale-ext.cnf"
    openssl x509 -req -in "$tls/headscale.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
      -days 30 -extfile "$tls/headscale-ext.cnf" -out "$tls/headscale.crt" 2>/dev/null
  fi
  hs_dir=/root/e2e-headscale
  new_conf=$(headscale_config "$ip_a")
  # The files are read by the container (any user), test-only key included.
  on "$E2E_A" "mkdir -p $hs_dir && chmod 0755 $hs_dir"
  changed=
  for f in tls.crt tls.key config.yaml; do
    case $f in
    tls.crt) src=$(cat "$tls/headscale.crt") ;;
    tls.key) src=$(cat "$tls/headscale.key") ;;
    config.yaml) src=$new_conf ;;
    esac
    if [ "$(on "$E2E_A" "cat $hs_dir/$f 2>/dev/null" || true)" != "$src" ]; then
      printf '%s\n' "$src" | on "$E2E_A" "cat >$hs_dir/$f && chmod 0644 $hs_dir/$f"
      changed=1
    fi
  done
  if [ -n "$changed" ] || ! running e2e-headscale; then
    log "starting e2e-headscale"
    # Root in the container: the socket and the database live in volumes.
    on "$E2E_A" "docker rm -f e2e-headscale >/dev/null 2>&1; docker run -d --name e2e-headscale --restart unless-stopped --user 0:0 \
      -v $hs_dir:/etc/headscale:ro -v e2e-headscale:/var/lib/headscale -v e2e-headscale-run:/var/run/headscale \
      -p $E2E_HS_PORT:8080 -p 3478:3478/udp $HEADSCALE_IMAGE serve >/dev/null" || log "note: e2e-headscale did not start, so check 40 is BLOCKED"
  fi
  # Only check 40 needs it: the run goes on without it.
  wait_for 60 "Headscale" on "$E2E_A" "curl -fsS -o /dev/null https://$ip_a:$E2E_HS_PORT/health" ||
    log "note: Headscale does not answer on https://$ip_a:$E2E_HS_PORT/health (docker logs e2e-headscale on $E2E_A), so check 40 is BLOCKED"
fi
log "infra up on $E2E_A: registry 127.0.0.1:$E2E_REG_PORT, MinIO $(vm_ip "$E2E_A"):19000, Pebble $(vm_ip "$E2E_A"):14000, Headscale $(vm_ip "$E2E_A"):$E2E_HS_PORT"
