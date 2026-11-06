#!/usr/bin/env bash
# Git provider integration test against a real Gitea in the test VM
# (Colima profile seylo-a, or $SEYLO_VM). Starts gitea/gitea with HTTPS
# from a throwaway CA, makes a user and a token, then runs
#   1. the panel test apps/panel/test/gitea.integration.test.ts on this
#      machine (the panel listens on $PANEL_PORT, Gitea's webhooks reach it
#      through the VM's gateway), and
#   2. the agent's clone test (go/internal/build TestITGiteaPrivateClone)
#      in the VM: a private clone with the token and user name the panel
#      sends.
# Removes the container and the files afterwards. Containers are named
# gitproviders-*; never runs against the default Docker context.
#
# Usage: scripts/dev/it-gitea.sh        (PANEL_PORT=18811 GITEA_PORT=18813)
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
vm="${SEYLO_VM:-seylo-a}"
export DOCKER_HOST="unix://$HOME/.colima/$vm/docker.sock"
panel_port="${PANEL_PORT:-18811}"
gitea_port="${GITEA_PORT:-18813}"
image="gitea/gitea:1.24.6"
name="gitproviders-gitea"
vm_ip="$(colima list -j 2>/dev/null | jq -r --arg p "$vm" 'select(.name == $p) | .address')"
[ -n "$vm_ip" ] || { echo "it-gitea: $vm has no network address (colima start --network-address)" >&2; exit 1; }
# The address the VM (and its containers) reach this machine at.
panel_host="${PANEL_HOST:-$(colima ssh -p "$vm" -- getent hosts host.lima.internal | awk '{print $1}')}:$panel_port"
dir="$root/.vmbin/it-gitea"
rm -rf "$dir" && mkdir -p "$dir"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=gitproviders-it" \
  -addext "subjectAltName=IP:$vm_ip" -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null

docker rm -f "$name" >/dev/null 2>&1 || true
docker create --name "$name" -p "$gitea_port:3000" \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__server__PROTOCOL=https \
  -e GITEA__server__HTTP_PORT=3000 \
  -e "GITEA__server__ROOT_URL=https://$vm_ip:$gitea_port/" \
  -e GITEA__server__CERT_FILE=/data/certs/cert.pem \
  -e GITEA__server__KEY_FILE=/data/certs/key.pem \
  -e GITEA__webhook__ALLOWED_HOST_LIST='*' \
  -e GITEA__webhook__DELIVER_TIMEOUT=10 \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  -e GITEA__log__LEVEL=Warn \
  "$image" >/dev/null
# A throwaway key: readable by Gitea's own user inside the container.
mkdir -p "$dir/certs" && cp "$dir/cert.pem" "$dir/key.pem" "$dir/certs/" && chmod 0644 "$dir/certs/"*
docker cp "$dir/certs" "$name:/data/certs"
docker start "$name" >/dev/null

echo "it-gitea: waiting for Gitea at https://$vm_ip:$gitea_port"
for _ in $(seq 1 90); do
  if curl -fsS --cacert "$dir/cert.pem" "https://$vm_ip:$gitea_port/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --cacert "$dir/cert.pem" "https://$vm_ip:$gitea_port/api/healthz" >/dev/null

user="seylo-it"
docker exec -u git "$name" gitea admin user create --username "$user" --password "it-$(openssl rand -hex 12)" \
  --email "$user@example.com" --admin --must-change-password=false >/dev/null
token="$(docker exec -u git "$name" gitea admin user generate-access-token --username "$user" --token-name it --scopes all --raw)"

echo "it-gitea: panel test (Gitea posts to http://$panel_host)"
(cd "$root/apps/panel" && NODE_EXTRA_CA_CERTS="$dir/cert.pem" SEYLO_IT_GITEA_URL="https://$vm_ip:$gitea_port" \
  SEYLO_IT_GITEA_TOKEN="$token" SEYLO_IT_GITEA_USER="$user" SEYLO_IT_GITEA_CA="$dir/cert.pem" \
  SEYLO_IT_PANEL_HOST="$panel_host" SEYLO_IT_PANEL_PORT="$panel_port" SEYLO_IT_GITEA_OUT="$dir/out.json" \
  bun test test/gitea.integration.test.ts)

echo "it-gitea: agent clone test in $vm"
SEYLO_IT_GITEA_REPO="$(jq -r .repo "$dir/out.json")" SEYLO_IT_GITEA_HEAD="$(jq -r .head "$dir/out.json")" \
  SEYLO_IT_GITEA_TOKEN="$token" SEYLO_IT_GITEA_USER="$user" SEYLO_IT_GITEA_CA="$dir/cert.pem" \
  "$root/scripts/dev/vm-gotest.sh" ./internal/build -run TestITGiteaPrivateClone -v
echo "it-gitea: passed"
