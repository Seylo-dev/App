// The DNS half of custom domains: what a host's records mean for the nodes
// a service runs on, which zone the host belongs in, and whether Cloudflare
// serves it. Lookups go through public resolvers (1.1.1.1, 8.8.8.8) so the
// answer matches what visitors see, not a split-horizon view of the panel's
// host. Ported from an earlier in-house implementation by the same authors,
// plus IPv6, CNAMEs, the records to create and the Cloudflare DNS link.

import { Resolver } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { isCloudflareAddress } from "../../http/cloudflare";

/** An address in Cloudflare's published proxy ranges (one list, http/cloudflare.ts): a record there means the orange cloud is on. */
export function isCloudflareIp(ip: string): boolean {
  return isCloudflareAddress(ip);
}

export type DnsStatus = "ok" | "missing" | "wrongTarget" | "proxied";

/** What a set of A/AAAA answers means for a host that should point at nodeIps. */
export function classifyRecords(addresses: readonly string[], nodeIps: ReadonlySet<string>): DnsStatus {
  if (addresses.some((ip) => nodeIps.has(normalizeIp(ip)))) return "ok";
  if (addresses.length === 0) return "missing";
  if (addresses.every(isCloudflareIp)) return "proxied";
  return "wrongTarget";
}

function normalizeIp(ip: string): string {
  return ip.toLowerCase();
}

export interface DnsLookups {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  resolveNs(name: string): Promise<string[]>;
}

const notFound = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ESERVFAIL", "ENONAME"]);

/** Lookups through public resolvers; "no such record" answers are empty lists, real failures throw. */
export function publicDns(): DnsLookups {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const quiet = async (lookup: () => Promise<string[]>) => {
    try {
      return await lookup();
    } catch (error) {
      if (notFound.has((error as { code?: string }).code ?? "")) return [];
      throw error;
    }
  };
  return {
    resolve4: (name) => quiet(() => resolver.resolve4(name)),
    resolve6: (name) => quiet(() => resolver.resolve6(name)),
    resolveCname: (name) => quiet(() => resolver.resolveCname(name)),
    resolveNs: (name) => quiet(() => resolver.resolveNs(name)),
  };
}

let lookups: DnsLookups | null = null;

/** The lookups DNS checks use; tests swap in a fake. */
export function dnsLookups(): DnsLookups {
  lookups ??= publicDns();
  return lookups;
}

export function setDnsLookups(next: DnsLookups | null): void {
  lookups = next;
}

/** The zone a host is in (closest name up the tree with NS records) and whether Cloudflare serves it. */
export async function findZone(host: string, dns: DnsLookups): Promise<{ zone: string; cloudflare: boolean } | null> {
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const ns = await dns.resolveNs(name);
    if (ns.length > 0) return { zone: name, cloudflare: ns.some((server) => server.toLowerCase().endsWith(".ns.cloudflare.com")) };
  }
  return null;
}

/** Record name as typed in a DNS panel: "admin" for admin.example.com in example.com, "@" for the apex. */
export function relativeName(host: string, zone: string | null): string {
  if (!zone || host === zone) return zone ? "@" : host;
  return host.endsWith(`.${zone}`) ? host.slice(0, -(zone.length + 1)) : host;
}

/** Deep link to the zone's DNS records page; Cloudflare asks which account when there are several. */
export function cloudflareDnsUrl(zone: string): string {
  return `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(zone)}/dns/records`;
}

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME";
  name: string;
  value: string;
}

export interface DnsResult {
  status: DnsStatus | "unknown";
  message: string;
  expected: DnsRecord[];
  found: DnsRecord[];
  zone: string | null;
  cloudflareManaged: boolean;
  cloudflareDnsUrl: string | null;
}

/**
 * Looks a host up and classifies it against the nodes it should point at.
 * A failed lookup (resolver timeout) is "unknown", never an exception.
 */
export async function checkHost(
  host: string,
  nodes: readonly { ipv4: string | null; ipv6: string | null; publicAddress?: string | null }[],
  dns: DnsLookups,
): Promise<DnsResult> {
  // The owner's public address (1:1 NAT clouds) is what a record points at when it is an IP.
  const addressesOf = (n: (typeof nodes)[number]) => {
    const own = n.publicAddress ?? null;
    return {
      ipv4: own && isIPv4(own) ? own : n.ipv4,
      ipv6: own && isIPv6(own) ? own : n.ipv6,
    };
  };
  const nodeIps = new Set(
    nodes
      .flatMap((n) => [n.ipv4, n.ipv6, addressesOf(n).ipv4, addressesOf(n).ipv6])
      .filter((ip): ip is string => !!ip)
      .map(normalizeIp),
  );
  try {
    const [v4, v6, cname, zoneInfo] = await Promise.all([
      dns.resolve4(host),
      dns.resolve6(host),
      dns.resolveCname(host),
      findZone(host, dns),
    ]);
    const zone = zoneInfo?.zone ?? null;
    const name = relativeName(host, zone);
    const expected: DnsRecord[] = [];
    for (const node of nodes.map(addressesOf)) {
      if (node.ipv4) expected.push({ type: "A", name, value: node.ipv4 });
      if (node.ipv6) expected.push({ type: "AAAA", name, value: node.ipv6 });
    }
    const found: DnsRecord[] = [
      ...cname.map((value) => ({ type: "CNAME" as const, name, value })),
      ...v4.map((value) => ({ type: "A" as const, name, value })),
      ...v6.map((value) => ({ type: "AAAA" as const, name, value })),
    ];
    const status = nodeIps.size === 0 ? "unknown" : classifyRecords([...v4, ...v6], nodeIps);
    return {
      status,
      message: dnsMessage(status, host, expected),
      expected,
      found,
      zone,
      cloudflareManaged: zoneInfo?.cloudflare ?? false,
      cloudflareDnsUrl: zoneInfo?.cloudflare && zone ? cloudflareDnsUrl(zone) : null,
    };
  } catch {
    return {
      status: "unknown",
      message: `The DNS lookup for ${host} failed. Try again in a moment.`,
      expected: [],
      found: [],
      zone: null,
      cloudflareManaged: false,
      cloudflareDnsUrl: null,
    };
  }
}

function dnsMessage(status: DnsStatus | "unknown", host: string, expected: DnsRecord[]): string {
  const target = expected.map((r) => r.value).join(" or ") || "the node";
  switch (status) {
    case "ok":
      return `${host} points at the node.`;
    case "missing":
      return `No A record for ${host} yet. Create one pointing at ${target}.`;
    case "proxied":
      // Let's Encrypt checks over plain HTTP: Always Use HTTPS sends it to port 443, where the challenge is not answered.
      return `${host} is proxied by Cloudflare, so the panel cannot see where it points. In Cloudflare, point it at ${target}, set SSL/TLS to Full (strict) and turn off Always Use HTTPS so Let's Encrypt can reach the node. Turn the proxy off (DNS only) to check the record here.`;
    case "wrongTarget":
      return `${host} points somewhere else. Change its A record to ${target}.`;
    case "unknown":
      return `The node's public address is not known yet, so ${host} cannot be checked.`;
  }
}
