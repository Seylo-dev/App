#!/usr/bin/env bash
# Runs before `make release` publishes anything. Refuses a release that
# installs and updates could not verify, or that would go to a GitHub
# org the releaser does not control:
#
#   - brand.json minisignPublicKey is still the placeholder, or is the
#     committed TEST-ONLY e2e key (test/e2e-colima/keys);
#   - INSTALLER_TEST_PUBLIC_KEY is set (the release's install.sh would
#     trust that key instead of brand.json's);
#   - MINISIGN_SECRET_KEY does not sign for that public key (installers,
#     agents and panels would refuse every file of the release); skipped with
#     --no-secret-key, which the Draft release job of a tag release uses: it
#     never sees the key (the Sign job does, and scripts/release-sign.sh
#     verifies what it signs with brand.json's key);
#   - the GitHub repo <githubOrg>/<githubRepo> does not exist or the token
#     cannot push to it (the org is unclaimed or someone else's). In GitHub
#     Actions (.github/workflows/release.yml) the job's token can only write
#     to the repository the workflow runs in, so that repository must be
#     <githubOrg>/<githubRepo>;
#   - with a catalog key in brand.json (templatesMinisignPublicKey): the
#     template catalog the panel ships (templates/catalog.json) has no
#     signature, or the published catalog of <githubOrg>/<templatesRepo> has
#     a higher sequence ("run make sync-templates"). Without the key it only
#     warns: the release then ships its catalog unsigned.
#
# Warns (does not fail) about the GitHub OAuth client id placeholder and a
# docs URL that does not answer.
#
# Needs the brand variables (the Makefile exports installer/brand.env),
# MINISIGN_SECRET_KEY, MINISIGN_PASSWORD (may be empty) and minisign (not
# with --no-secret-key), and gh. GITHUB_ACTIONS and GITHUB_REPOSITORY come
# from the Actions runner.
#
# Usage: scripts/release-preflight.sh [--no-secret-key]
set -euo pipefail
: "${BRAND_PLACEHOLDER_PREFIX:?run through the Makefile}" "${BRAND_MINISIGN_PUBLIC_KEY:?}" "${BRAND_GITHUB_ORG:?}" "${BRAND_GITHUB_REPO:?}"
check_secret_key=1
case ${1:-} in
"") ;;
--no-secret-key) check_secret_key= ;;
*)
  echo "usage: scripts/release-preflight.sh [--no-secret-key]" >&2
  exit 2
  ;;
esac

failed=0
fail() {
  echo "release-preflight: $*" >&2
  failed=1
}
warn() { echo "release-preflight: warning: $*" >&2; }

placeholder() { [[ "$1" == "$BRAND_PLACEHOLDER_PREFIX"* ]]; }
e2e_pub="${BASH_SOURCE[0]%/*}/../test/e2e-colima/keys/e2e-test.pub"
e2e_key=
if [ -f "$e2e_pub" ]; then { read -r _ && read -r e2e_key; } <"$e2e_pub" || true; fi

if [ -n "${INSTALLER_TEST_PUBLIC_KEY:-}" ]; then
  fail "INSTALLER_TEST_PUBLIC_KEY is set: the release's install.sh would trust a test key; unset it"
fi
if [ -n "$e2e_key" ] && [ "$BRAND_MINISIGN_PUBLIC_KEY" = "$e2e_key" ]; then
  fail "brand.json minisignPublicKey is the TEST-ONLY e2e key, whose secret half is public"
elif placeholder "$BRAND_MINISIGN_PUBLIC_KEY"; then
  fail "brand.json minisignPublicKey is a placeholder; no installer, agent or panel could verify this release (CONTRIBUTING.md, Releases)"
elif [ -z "$check_secret_key" ]; then
  : # the Sign job checks the key against brand.json's (scripts/release-sign.sh)
elif [ -z "${MINISIGN_SECRET_KEY:-}" ] || [ ! -f "$MINISIGN_SECRET_KEY" ]; then
  fail "MINISIGN_SECRET_KEY must name the release key file"
elif ! command -v minisign >/dev/null 2>&1; then
  fail "minisign is not installed"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  printf 'release preflight\n' >"$tmp/probe"
  if ! printf '%s\n' "${MINISIGN_PASSWORD:-}" | minisign -S -s "$MINISIGN_SECRET_KEY" -m "$tmp/probe" -x "$tmp/probe.minisig" -t preflight >/dev/null 2>&1; then
    fail "could not sign with MINISIGN_SECRET_KEY (wrong password?)"
  elif ! minisign -Vqm "$tmp/probe" -x "$tmp/probe.minisig" -P "$BRAND_MINISIGN_PUBLIC_KEY" >/dev/null 2>&1; then
    fail "MINISIGN_SECRET_KEY does not match brand.json minisignPublicKey"
  fi
fi

lower() { printf %s "$1" | tr '[:upper:]' '[:lower:]'; }
if ! command -v gh >/dev/null 2>&1; then
  fail "gh is not installed (needed to check the GitHub repo and upload the manifest)"
elif [ "${GITHUB_ACTIONS:-}" = true ]; then
  # The Actions token has no .permissions to read, and it can only write to
  # the repository the workflow runs in.
  if [ "$(lower "${GITHUB_REPOSITORY:-}")" != "$(lower "$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO")" ]; then
    fail "this workflow runs in ${GITHUB_REPOSITORY:-an unknown repository}, but brand.json releases to $BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO; release from that repository"
  fi
else
  push=$(gh api "repos/$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO" --jq .permissions.push 2>/dev/null || true)
  if [ "$push" != true ]; then
    fail "github.com/$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO does not exist or this token cannot push to it; claim the org and set brand.json githubOrg before releasing"
  fi
fi

# The template catalog the panel ships (templates/catalog.json, vendored by
# `make sync-templates`) is signed and not older than the published one.
# PREFLIGHT_CATALOG_DIR stands in for templates/ in installer/test/run.sh.
catalog_dir=${PREFLIGHT_CATALOG_DIR:-${BASH_SOURCE[0]%/*}/../templates}
catalog_sequence() { sed -n 's/^  "sequence": \([0-9][0-9]*\),\{0,1\}$/\1/p' "$1" | head -n 1; }
if [ -z "${BRAND_TEMPLATES_MINISIGN_PUBLIC_KEY:-}" ] || placeholder "$BRAND_TEMPLATES_MINISIGN_PUBLIC_KEY"; then
  warn "brand.json templatesMinisignPublicKey is a placeholder: this release ships its template catalog unsigned and never downloads a newer one"
elif [ ! -f "$catalog_dir/catalog.json.minisig" ]; then
  fail "templates/catalog.json is not signed; run make sync-templates and commit the result"
else
  vendored=$(catalog_sequence "$catalog_dir/catalog.json")
  published_file=$(mktemp)
  if ! command -v curl >/dev/null 2>&1 ||
    ! curl -fsSL -m 30 -o "$published_file" "https://github.com/$BRAND_GITHUB_ORG/${BRAND_TEMPLATES_REPO:-Templates}/releases/download/catalog/catalog.json" 2>/dev/null; then
    warn "could not download the published template catalog to compare it with templates/catalog.json"
  else
    published=$(catalog_sequence "$published_file")
    if [ -z "$vendored" ] || [ -z "$published" ]; then
      fail "could not read the sequence of templates/catalog.json (${vendored:-none}) or of the published catalog (${published:-none})"
    elif [ "$published" -gt "$vendored" ]; then
      fail "the published template catalog (sequence $published) is newer than templates/catalog.json ($vendored); run make sync-templates and commit the result"
    fi
  fi
  rm -f "$published_file"
fi

if [ -n "${BRAND_OAUTH_CLIENT_ID:-}" ] && placeholder "$BRAND_OAUTH_CLIENT_ID"; then
  warn "brand.json oauthClientId is a placeholder: GitHub sign-in stays off in this release"
fi
if [ -n "${BRAND_DOCS_URL:-}" ] && command -v curl >/dev/null 2>&1 && ! curl -fsSL -o /dev/null -m 10 "$BRAND_DOCS_URL" 2>/dev/null; then
  warn "$BRAND_DOCS_URL does not answer; unit files, the installer and the CLI link to it"
fi

if [ "$failed" -ne 0 ]; then
  echo "release-preflight: not releasing" >&2
  exit 1
fi
echo "release-preflight: ok"
