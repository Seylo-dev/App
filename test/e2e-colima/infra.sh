#!/usr/bin/env bash
# Starts the e2e infrastructure containers on VM A, all unlabeled (so the
# cleanup check also proves they survive):
#
#   e2e-registry  registry for the panel images, 127.0.0.1:$E2E_REG_PORT on A
#   e2e-minio     S3 bucket for the backup checks, <A>:19000 (bucket e2e-backups)
#   e2e-pebble    ACME test CA for the stretch check, <A>:14000 (directory /dir)
#
# Usage: test/e2e-colima/infra.sh
source "$(dirname "$0")/lib.sh"

REGISTRY_IMAGE=${REGISTRY_IMAGE:-registry:2.8.3}
# The image the agent's backup tests use (minio/minio is no longer published); it ships mc.
MINIO_IMAGE=${MINIO_IMAGE:-pgsty/minio:RELEASE.2026-08-04T00-00-00Z}
PEBBLE_IMAGE=${PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:2.7.0}
MINIO_USER=e2eminio
MINIO_PASSWORD=e2e-minio-test-only

running() { on "$E2E_A" "docker inspect -f '{{.State.Running}}' $1 2>/dev/null | grep -q true"; }

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
    log "warning: Pebble did not start (only the stretch ACME check needs it)"
fi
wait_for 30 "the registry" on "$E2E_A" "curl -fsS -o /dev/null http://127.0.0.1:$E2E_REG_PORT/v2/" || fail "registry did not start"
state_set minio "http://$(vm_ip "$E2E_A"):19000 $MINIO_USER $MINIO_PASSWORD"
log "infra up on $E2E_A: registry 127.0.0.1:$E2E_REG_PORT, MinIO $(vm_ip "$E2E_A"):19000, Pebble $(vm_ip "$E2E_A"):14000"
