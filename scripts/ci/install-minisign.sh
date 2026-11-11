#!/bin/sh
# minisign for the CI and release jobs, from its own GitHub release instead
# of apt. On 2026-11-11 Ubuntu's Azure mirror stopped resolving on GitHub's
# runners and two v0.2.9 release runs failed installing it; jq and dash come
# with the runner image (ubuntu-24.04), so minisign was the only package.
#
# The tarball is pinned by its sha256. When the pin was taken its .minisig
# verified against the minisign author's key
# (RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3).
set -eu

VERSION=0.11
SHA256=f0a0954413df8531befed169e447a66da6868d79052ed7e892e50a4291af7ae0
URL="https://github.com/jedisct1/minisign/releases/download/$VERSION/minisign-$VERSION-linux.tar.gz"

for tool in jq dash; do
  command -v "$tool" >/dev/null 2>&1 || { echo "install-minisign: $tool is missing from the runner image" >&2; exit 1; }
done

case $(uname -m) in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) echo "install-minisign: no minisign build for $(uname -m)" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o "$tmp/minisign.tar.gz" "$URL"
echo "$SHA256  $tmp/minisign.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/minisign.tar.gz" -C "$tmp"
sudo install -m 0755 "$tmp/minisign-linux/$arch/minisign" /usr/local/bin/minisign
minisign -v
