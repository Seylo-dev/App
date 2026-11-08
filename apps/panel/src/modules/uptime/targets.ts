// Uptime checks (and other panel-side requests to URLs people type) must
// not become a way into the panel's own network (SSRF): loopback, link
// local, cloud metadata endpoints and private ranges are refused, unless
// every such address is a node's address as an admin set it (never what an
// agent reports about itself) or an admin turned on
// "allow internal targets" in Settings > General. A domain row proves
// nothing about where its name resolves, so it is no exception. The check
// runs when a check is saved and again before every probe, and returns the
// address it vetted: the request goes to that address (http/pinned-fetch.ts),
// so DNS cannot answer one thing to the check and another to the request.
// Probes never follow redirects.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { inArray, sql } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /** Uptime checks may target loopback, link-local, metadata and private addresses. */
    uptimeAllowInternalTargets: boolean;
  }
}

export type BlockReason = "loopback" | "linkLocal" | "metadata" | "private" | "reserved" | "unresolvable";

/**
 * ok carries the vetted address to connect to. `byName` (address null) only
 * when internal targets are allowed: then the request may resolve the name
 * itself. A name that does not resolve is never ok, because the request
 * would ask DNS again and could get an internal answer the check never saw.
 */
export type TargetCheck =
  | { ok: true; address: string; byName: false }
  | { ok: true; address: null; byName: true }
  | {
      ok: false;
      reason: BlockReason;
      address: string;
      /** Only with reason unresolvable: DNS said the name does not exist (not a timeout or a failing server). */
      notFound?: boolean;
    };

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = defaultResolver;

/** Tests swap DNS for a fake. */
export function setTargetResolver(next: Resolver | null): void {
  resolver = next ?? defaultResolver;
}

const v4 = (a: number, b: number, c: number, d: number) => ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

// The same ranges as the agent's go/internal/netguard (rules), in the same
// order; go/internal/netguard/testdata/addresses.json is a table both test
// suites read, so the two lists cannot drift.

/** [network, prefix length, reason]; checked in order, so the metadata host wins over link-local. */
const v4Ranges: [number, number, BlockReason][] = [
  [v4(169, 254, 169, 254), 32, "metadata"],
  [v4(100, 100, 100, 200), 32, "metadata"],
  [v4(0, 0, 0, 0), 8, "reserved"],
  [v4(10, 0, 0, 0), 8, "private"],
  // Carrier-grade NAT.
  [v4(100, 64, 0, 0), 10, "private"],
  [v4(127, 0, 0, 0), 8, "loopback"],
  [v4(169, 254, 0, 0), 16, "linkLocal"],
  [v4(172, 16, 0, 0), 12, "private"],
  [v4(192, 0, 0, 0), 24, "reserved"],
  // Documentation (TEST-NET-1).
  [v4(192, 0, 2, 0), 24, "reserved"],
  [v4(192, 168, 0, 0), 16, "private"],
  // Benchmarking.
  [v4(198, 18, 0, 0), 15, "reserved"],
  // Documentation (TEST-NET-2, TEST-NET-3).
  [v4(198, 51, 100, 0), 24, "reserved"],
  [v4(203, 0, 113, 0), 24, "reserved"],
  // Multicast.
  [v4(224, 0, 0, 0), 4, "reserved"],
  [v4(240, 0, 0, 0), 4, "reserved"],
];

function parseV4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function parseV6(address: string): bigint | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:10.0.0.1) becomes two hex groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = parseV4(dotted[2] as string);
    if (n === null) return null;
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) + BigInt(Number.parseInt(g, 16));
  }
  return out;
}

/** [network, prefix length, reason], checked in order after unmapping (blockedReason). */
const v6Ranges: [bigint, number, BlockReason][] = (
  [
    ["fd00:ec2::254", 128, "metadata"],
    ["::", 128, "reserved"],
    ["::1", 128, "loopback"],
    // IPv4-compatible (deprecated): never a real internet host.
    ["::", 96, "reserved"],
    // Local-use NAT64 (RFC 8215): the IPv4 address it carries is a local one.
    ["64:ff9b:1::", 48, "reserved"],
    // Discard-only.
    ["100::", 64, "reserved"],
    // Documentation.
    ["2001:db8::", 32, "reserved"],
    // Unique-local.
    ["fc00::", 7, "private"],
    ["fe80::", 10, "linkLocal"],
    // Site-local (deprecated).
    ["fec0::", 10, "private"],
    // Multicast.
    ["ff00::", 8, "reserved"],
  ] as const
).map(([network, bits, reason]) => [parseV6(network) as bigint, bits, reason]);

const inV6 = (value: bigint, network: bigint, bits: number) => {
  const shift = BigInt(128 - bits);
  return value >> shift === network >> shift;
};

const mapped = parseV6("::ffff:0:0") as bigint;
const nat64 = parseV6("64:ff9b::") as bigint;
const sixToFour = parseV6("2002::") as bigint;

const dottedV4 = (n: number) => `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

/** Why this address is not a public internet address, or null when it is one. */
export function blockedReason(address: string): BlockReason | null {
  const kind = isIP(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (kind === 4) {
    const n = parseV4(address);
    if (n === null) return "reserved";
    for (const [network, bits, reason] of v4Ranges) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((n & mask) >>> 0 === network) return reason;
    }
    return null;
  }
  if (kind === 6) {
    const n = parseV6(address);
    if (n === null) return "reserved";
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address in their
    // last 32 bits, 6to4 (2002:aabb:ccdd::) right after the prefix: judged by that address.
    if (inV6(n, mapped, 96) || inV6(n, nat64, 96)) return blockedReason(dottedV4(Number(n & 0xffffffffn)));
    if (inV6(n, sixToFour, 16)) return blockedReason(dottedV4(Number((n >> 80n) & 0xffffffffn)));
    for (const [network, bits, reason] of v6Ranges) if (inV6(n, network, bits)) return reason;
    return null;
  }
  return "reserved";
}

/** Names that never belong on the internet; they are blocked without asking DNS. */
function blockedName(host: string): BlockReason | null {
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host === "metadata" || host === "metadata.google.internal" || host.endsWith(".internal")) return "metadata";
  return null;
}

/**
 * This panel's own targets: every address that is not public is a node's
 * address as an admin set it (nodes.public_address, for 1:1 NAT clouds and
 * the panel node). The addresses agents report (public_ipv4/public_ipv6)
 * never count here: a compromised agent could report a private address as
 * its public one and open the panel's network to uptime checks.
 */
function ownTarget(deps: Pick<Deps, "db">, addresses: readonly string[]): boolean {
  const internal = addresses.filter((a) => blockedReason(a) !== null).map((a) => a.toLowerCase());
  if (internal.length === 0) return false;
  const set = deps.db
    .select({ address: nodes.publicAddress })
    .from(nodes)
    .where(inArray(sql`lower(${nodes.publicAddress})`, internal))
    .all()
    .flatMap((r) => (r.address ? [r.address.toLowerCase()] : []));
  return internal.every((a) => set.includes(a));
}

/**
 * Decides whether an uptime check may request this URL. Hostnames are
 * resolved; every address must be public (or the panel's own).
 * `ownNodes: false` drops the "panel's own" exception: a node's address on
 * a private network then counts like any other internal address (git
 * sources, where such a host needs an admin's approval per project).
 */
export async function checkTarget(
  deps: Pick<Deps, "db">,
  url: string,
  options: { allowInternal?: boolean; ownNodes?: boolean } = {},
): Promise<TargetCheck> {
  if (options.allowInternal ?? getSetting(deps.db, "uptimeAllowInternalTargets") === true) return { ok: true, address: null, byName: true };
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return { ok: false, reason: "reserved", address: url };
  }
  const named = isIP(host) === 0 ? blockedName(host) : null;
  if (named) return { ok: false, reason: named, address: host };
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolver(host);
    } catch (error) {
      // NXDOMAIN, SERVFAIL or a timeout: the request would resolve the name again, and a
      // hostile name server could answer that one with an internal address.
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        reason: "unresolvable",
        address: host,
        ...(code === "ENOTFOUND" || code === "ENODATA" ? { notFound: true } : {}),
      };
    }
    if (addresses.length === 0) return { ok: false, reason: "unresolvable", address: host, notFound: true };
  }
  const blocked = addresses.map((address) => ({ address, reason: blockedReason(address) })).filter((a) => a.reason !== null);
  const pin = addresses[0] as string;
  if (blocked.length === 0) return { ok: true, address: pin, byName: false };
  // The metadata service is never one of ours, even on a node's own address.
  const first = blocked.find((b) => b.reason === "metadata") ?? (blocked[0] as { address: string; reason: BlockReason });
  if (first.reason !== "metadata" && options.ownNodes !== false && ownTarget(deps, addresses))
    return { ok: true, address: pin, byName: false };
  return { ok: false, reason: first.reason as BlockReason, address: first.address };
}

const reasonText: Record<BlockReason, string> = {
  loopback: "a loopback address",
  linkLocal: "a link-local address",
  metadata: "a cloud metadata endpoint",
  private: "a private network address",
  reserved: "a reserved address",
  unresolvable: "a name that does not resolve",
};

/** What a refused target is, for messages: "a private network address (10.0.0.7)". */
export function blockedTarget(check: Extract<TargetCheck, { ok: false }>): string {
  return `${reasonText[check.reason]} (${check.address})`;
}

/** Shown on the check and in BAD_REQUEST messages. */
export function blockedMessage(check: Extract<TargetCheck, { ok: false }>): string {
  if (check.reason === "unresolvable") return `The name ${check.address} did not resolve.`;
  return `The target is ${blockedTarget(check)}. Only an admin can allow internal targets, in Settings > General.`;
}

/**
 * True when a request to `url` may go out with this destination: to the
 * vetted address, or by name only when internal targets are allowed. A
 * hostname URL with neither is never requested (the name would be resolved
 * again, unchecked).
 */
export function mayRequest(url: string, destination: { address?: string | null; byName?: boolean }): boolean {
  if (destination.address || destination.byName) return true;
  try {
    return isIP(new URL(url).hostname.replace(/^\[|\]$/g, "")) !== 0;
  } catch {
    return false;
  }
}
