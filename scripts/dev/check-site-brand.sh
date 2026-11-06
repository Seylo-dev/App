#!/usr/bin/env bash
# Maintainer check: brand/brand.json and the brand file of the Website
# repo (brand/brand.json there, which the landing page, the docs app in
# apps/docs and the site API share) must name the same site, docs and
# install URLs and the same GitHub repo: the agent's unit files, the
# installer and the CLI link to what the site serves. By default it looks
# for a Website checkout in ../seylo-site and skips when there is none.
#
# Usage: scripts/dev/check-site-brand.sh [path to a brand.json]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
site="${1:-$root/../seylo-site/brand/brand.json}"
if [ ! -f "$site" ]; then
  echo "check-site-brand: SKIP (no $site)"
  exit 0
fi
python3 - "$root/brand/brand.json" "$site" <<'PY'
import json, sys
ours = json.load(open(sys.argv[1]))
site = json.load(open(sys.argv[2]))
urls = site.get("urls", {})
github = site.get("github", {})
pairs = [
    ("siteUrl", ours["siteUrl"], "urls.site", urls.get("site")),
    ("docsUrl", ours["docsUrl"], "urls.docs", urls.get("docs")),
    ("installUrl", ours["installUrl"], "urls.install", urls.get("install")),
    ("githubOrg", ours["githubOrg"], "github.org", github.get("org")),
    ("githubOrg/githubRepo", ours["githubOrg"] + "/" + ours["githubRepo"], "github.repo", github.get("repo")),
]
bad = [p for p in pairs if (p[1] or "").rstrip("/") != (p[3] or "").rstrip("/")]
for name, a, site_name, b in bad:
    print(f"check-site-brand: brand.json {name} = {a!r} but the site's {site_name} = {b!r}", file=sys.stderr)
if bad:
    sys.exit(1)
print("check-site-brand: ok")
PY
