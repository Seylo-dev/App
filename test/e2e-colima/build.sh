#!/usr/bin/env bash
# Builds every release the e2e serves and fills dist/e2e/release:
#
#   N   ($E2E_V1)  installed by the checks
#   N+1 ($E2E_V2)  the self-update target (check 22)
#   N+2 ($E2E_V3)  a deliberately broken panel image (the swap must roll back)
#
# For each version: the static agent binary for the VMs' architecture, the
# rendered install.sh (trusting the TEST-ONLY key in keys/), checksums.txt +
# .minisig, and manifest.json + .minisig signed with that key. The panel's TypeScript is built
# inside VM A (Linux, so no darwin .node files get in), packaged with
# deploy/panel.Dockerfile and pushed to the registry container on A
# (127.0.0.1:$E2E_REG_PORT, see infra.sh); the manifest pins its digest.
# Both the agents and the panel are TEST builds: linker flags (agent) and
# bun --define overrides (panel) point them at the local release server and
# the TEST-ONLY key.
# Finally the test apps under apps/ become HTTPS git repositories.
#
# E2E_BUILD_VERSIONS limits the versions built (refresh.sh builds one newer
# test release from the working tree that way).
#
# Usage: test/e2e-colima/build.sh [agents|installer|panel|release|git ...]   (default: all but installer, which agents covers)
source "$(dirname "$0")/lib.sh"

E2E_BUILD_VERSIONS=${E2E_BUILD_VERSIONS:-$E2E_V1 $E2E_V2 $E2E_V3}

arch=$(vm_arch)
ORG=$BRAND_GITHUB_ORG
REPO=$BRAND_GITHUB_REPO
REG=127.0.0.1:$E2E_REG_PORT
IMAGE_REPO=$REG/$SLUG
PUBKEY=$(sed -n 2p "$E2E_KEYS/e2e-test.pub")
mkdir -p "$E2E_OUT" "$E2E_REL" "$E2E_STATE"

rel_dir() { echo "$E2E_REL/$ORG/$REPO/releases/download/v$1"; }
rel_url() { echo "$(release_base)/$ORG/$REPO/releases/download/v$1"; }

# e2e builds trust the TEST-ONLY key and the local release server (the
# agent's test overrides; a binary built with them logs a "TEST BUILD"
# warning).
go_ldflags_extra() {
  printf -- '-X %s/internal/update.TestReleaseBaseURL=%s -X %s/internal/update.TestReleasePublicKey=%s' \
    "$GO_MODULE" "$(release_base)/$ORG/$REPO/releases" "$GO_MODULE" "$PUBKEY"
}

build_agents() {
  local v out
  for v in $E2E_BUILD_VERSIONS; do
    out=$(rel_dir "$v")
    mkdir -p "$out"
    log "agent $v for linux/$arch"
    # shellcheck disable=SC2046
    CGO_ENABLED=0 GOOS=linux GOARCH=$arch go -C "$E2E_ROOT/go" build -trimpath \
      -ldflags "-s -w -X $GO_MODULE/internal/version.Version=$v -X $GO_MODULE/internal/version.Commit=e2e $(go_ldflags_extra)" \
      -o "$out/${SLUG}_linux_$arch" ./cmd/seylo
    render_installer "$v" "$out/install.sh"
  done
}

# The installer of a test release trusts the TEST-ONLY key (it checks the
# release manifest's signature before it downloads anything else).
render_installer() {
  INSTALLER_TEST_PUBLIC_KEY=$PUBKEY "$E2E_ROOT/scripts/render-installer.sh" "$1" "$2" >/dev/null
}

# The tree as the working copy has it (tracked plus new files, no ignored ones).
tree_tar() {
  # Tracked files deleted in the working copy are still listed: skip them.
  (cd "$E2E_ROOT" && git ls-files -co --exclude-standard -z | grep -zv '^dist/' |
    while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done |
    COPYFILE_DISABLE=1 tar -c --no-xattrs --no-mac-metadata --null -T - -f -) || true
}

build_panel() {
  log "copying the tree into $E2E_A and building the panel and web app on Linux"
  tree_tar | on "$E2E_A" "rm -rf /root/e2e-src && mkdir -p /root/e2e-src && tar -x -C /root/e2e-src"
  on "$E2E_A" "docker run --rm -v /root/e2e-src:/src -v e2e-bun-cache:/root/.bun/install/cache -w /src oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d \
    bash -c 'bun install --frozen-lockfile >/tmp/install.log 2>&1 || { echo frozen lockfile out of date, plain install; bun install >/tmp/install.log 2>&1; } || { cat /tmp/install.log; exit 1; }; bun run build && \
      cd apps/panel && bun build src/main.ts --target bun --outdir dist --sourcemap=linked \
        --define __TEST_RELEASE_API_URL__=\\\"$(release_base)/repos/$ORG/$REPO/releases/latest\\\" \
        --define __TEST_RELEASE_PUBLIC_KEY__=\\\"$PUBKEY\\\" >/dev/null'" ||
    fail "the panel build failed in $E2E_A"
  on "$E2E_A" "find /root/e2e-src/apps/panel/dist -name '*.node' -exec file {} +" | sed 's/^/  /' >&2 || true

  local prefix v
  prefix=$(printf %s "$SLUG" | tr '[:lower:]-' '[:upper:]_')
  for v in $E2E_BUILD_VERSIONS; do
    [ "$v" != "$E2E_V3" ] || continue
    log "panel image $IMAGE_REPO:$v"
    on "$E2E_A" "cd /root/e2e-src && docker build -q -f deploy/panel.Dockerfile --build-arg VERSION=$v \
      --build-arg ENV_PREFIX=$prefix --build-arg DATA_DIR=$BRAND_DATA_DIR -t $IMAGE_REPO:$v . >/dev/null" ||
      fail "docker build $v"
    push_digest "$v"
  done
  case " $E2E_BUILD_VERSIONS " in *" $E2E_V3 "*) ;; *) return 0 ;; esac
  log "broken panel image $IMAGE_REPO:$E2E_V3 (exits at once, so the swap must roll back)"
  on "$E2E_A" "mkdir -p /root/e2e-broken && printf '%s\n' \
    'FROM $IMAGE_REPO:$E2E_V2' \
    'ENV ${prefix}_VERSION=$E2E_V3' \
    'CMD [\"sh\", \"-c\", \"echo broken e2e panel image; exit 1\"]' >/root/e2e-broken/Dockerfile && \
    docker build -q -t $IMAGE_REPO:$E2E_V3 /root/e2e-broken >/dev/null" || fail "broken image"
  push_digest "$E2E_V3"
}

push_digest() {
  local v=$1 digest
  digest=$(on "$E2E_A" "docker push $IMAGE_REPO:$v 2>&1 | sed -n 's/.*digest: \(sha256:[0-9a-f]*\).*/\1/p' | tail -1")
  [ -n "$digest" ] || fail "push of $IMAGE_REPO:$v reported no digest (is infra.sh's registry up?)"
  state_set "panel-digest-$v" "$digest"
  log "  $IMAGE_REPO:$v@$digest"
}

release_files() {
  local v out digest
  for v in $E2E_BUILD_VERSIONS; do
    out=$(rel_dir "$v")
    digest=$(state_get "panel-digest-$v")
    [ -n "$digest" ] || fail "no panel image digest for $v (run build.sh panel)"
    log "release $v: checksums, manifest, signatures"
    (cd "$out" && shasum -a 256 "${SLUG}_linux_$arch" install.sh >checksums.txt)
    rm -f "$out"/*.minisig
    minisign -S -s "$E2E_KEYS/e2e-test.key" -m "$out/checksums.txt" -x "$out/checksums.txt.minisig" \
      -t "$SLUG $v checksums.txt" </dev/null >/dev/null
    go -C "$E2E_ROOT/go" run ./internal/update/releasetool \
      -version "$v" -binaries "$out" -platforms "linux-$arch" -download-base "$(rel_url "$v")" \
      -image "$IMAGE_REPO:$v" -digest "$digest" -installer "$out/install.sh" \
      -changelog "$(release_base)/changelog-$v" -out "$out/manifest.json" >/dev/null
    minisign -S -s "$E2E_KEYS/e2e-test.key" -m "$out/manifest.json" -x "$out/manifest.json.minisig" \
      -t "$SLUG $v manifest.json" </dev/null >/dev/null
  done
  [ -e "$E2E_REL/$ORG/$REPO/releases/latest" ] || "$E2E_DIR/publish.sh" "$E2E_V1"
}

# git_repo <app>: (re)creates the bare repository for apps/<app> with one commit.
git_repo() {
  local app=$1 bare=$E2E_REL/git/$1.git work
  work=$(mktemp -d)
  rm -rf "$bare"
  mkdir -p "$E2E_REL/git"
  git init -q --bare -b main "$bare"
  cp -R "$E2E_DIR/apps/$app/." "$work/"
  git -C "$work" init -q -b main
  git -C "$work" -c user.name=e2e -c user.email=e2e@e2e.test add -A
  git -C "$work" -c user.name=e2e -c user.email=e2e@e2e.test commit -q -m "$app v1"
  git -C "$work" push -q "$bare" main
  git -C "$bare" update-server-info
  rm -rf "$work"
  log "git repo $(state_get git-base)/$app.git"
}

build_git() {
  git_repo node-app
  git_repo go-app
  # The upload check posts this archive.
  tar -C "$E2E_DIR/apps/upload-app" -czf "$E2E_OUT/upload-app.tar.gz" .
}

# installer: re-render install.sh for every version (then run "release").
build_installer() {
  local v
  for v in $E2E_BUILD_VERSIONS; do
    mkdir -p "$(rel_dir "$v")"
    render_installer "$v" "$(rel_dir "$v")/install.sh"
  done
}

steps=${*:-agents panel release git}
for s in $steps; do
  case $s in
  agents) build_agents ;;
  installer) build_installer ;;
  panel) build_panel ;;
  release) release_files ;;
  git) build_git ;;
  *) fail "unknown build step $s" ;;
  esac
done
