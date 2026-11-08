// Cloudflare's proxy addresses, for reading the visitor's address when the
// panel domain is proxied by Cloudflare ("orange cloud"). Traefik then sees
// Cloudflare's egress address as its peer and writes it into
// X-Forwarded-For; the visitor's own address is in CF-Connecting-IP, which
// Cloudflare sets on every request it forwards (a client cannot choose it
// through Cloudflare). Anyone can send that header straight to the node,
// so it is believed only when the address Traefik vouches for is one of
// Cloudflare's. DNS checks use the same list to tell a proxied record from
// one that points somewhere else (modules/domains/dns.ts).
//
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// (https://www.cloudflare.com/ips/), checked 2026-11-07. The list changes
// rarely; an address missing here only means the panel keys limits and the
// audit log on Cloudflare's address, as it did before.

import { type Cidr, inRanges, parseCidr } from "./ip-ranges";

const ranges: readonly Cidr[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
].map(parseCidr);

export function isCloudflareAddress(address: string): boolean {
  return inRanges(address, ranges);
}
