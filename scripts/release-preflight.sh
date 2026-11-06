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
#     agents and panels would refuse every file of the release);
#   - the GitHub repo <githubOrg>/<githubRepo> does not exist or the token
#     cannot push to it (the org is unclaimed or someone else's).
#
# Warns (does not fail) about the GitHub OAuth client id placeholder and a
# docs URL that does not answer.
#
# Needs the brand variables (the Makefile exports installer/brand.env),
# MINISIGN_SECRET_KEY, MINISIGN_PASSWORD (may be empty), minisign and gh.
set -euo pipefail
: "${BRAND_PLACEHOLDER_PREFIX:?run through the Makefile}" "${BRAND_MINISIGN_PUBLIC_KEY:?}" "${BRAND_GITHUB_ORG:?}" "${BRAND_GITHUB_REPO:?}"

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

if ! command -v gh >/dev/null 2>&1; then
  fail "gh is not installed (needed to check the GitHub repo and upload the manifest)"
else
  push=$(gh api "repos/$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO" --jq .permissions.push 2>/dev/null || true)
  if [ "$push" != true ]; then
    fail "github.com/$BRAND_GITHUB_ORG/$BRAND_GITHUB_REPO does not exist or this token cannot push to it; claim the org and set brand.json githubOrg before releasing"
  fi
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
