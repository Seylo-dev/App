// Uptime checks (and other panel-side requests to URLs people type) must
// not become a way into the panel's own network (SSRF): loopback, link
// local, cloud metadata endpoints and private ranges are refused, unless
// every address is a node's own public address or an admin turned on
// "allow internal targets" in Settings > General. A domain row proves
// nothing about where its name resolves, so it is no exception. The check
// runs when a check is saved and again before every probe, and returns the
// address it vetted: the request goes to that address (http/pinned-fetch.ts),
// so DNS cannot answer one thing to the check and another to the request.
// Probes never follow redirects.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { or, sql } from "drizzle-orm";
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
  | { ok: false; reason: BlockReason; address: string };

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
let resolver: Resolver = defaultResolver;

/** Tests swap DNS for a fake. */
export function setTargetResolver(next: Resolver | null): void {
  resolver = next ?? defaultResolver;
}

const v4 = (a: number, b: number, c: number, d: number) => ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

/** [network, prefix length, reason]; checked in order, so the metadata host wins over link-local. */
const v4Ranges: [number, number, BlockReason][] = [
  [v4(169, 254, 169, 254), 32, "metadata"],
  [v4(100, 100, 100, 200), 32, "metadata"],
  [v4(127, 0, 0, 0), 8, "loopback"],
  [v4(169, 254, 0, 0), 16, "linkLocal"],
  [v4(0, 0, 0, 0), 8, "reserved"],
  [v4(10, 0, 0, 0), 8, "private"],
  [v4(100, 64, 0, 0), 10, "private"],
  [v4(172, 16, 0, 0), 12, "private"],
  [v4(192, 0, 0, 0), 24, "reserved"],
  [v4(192, 168, 0, 0), 16, "private"],
  [v4(198, 18, 0, 0), 15, "reserved"],
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

const inV6 = (value: bigint, network: string, bits: number) => {
  const net = parseV6(network) as bigint;
  const shift = BigInt(128 - bits);
  return value >> shift === net >> shift;
};

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
    return n === 0xffffffff ? "reserved" : null;
  }
  if (kind === 6) {
    const n = parseV6(address);
    if (n === null) return "reserved";
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
    if (inV6(n, "::ffff:0:0", 96) || inV6(n, "64:ff9b::", 96)) {
      const embedded = Number(n & 0xffffffffn);
      return blockedReason(`${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`);
    }
    if (n === 0n) return "reserved";
    if (n === 1n) return "loopback";
    if (n === (parseV6("fd00:ec2::254") as bigint)) return "metadata";
    if (inV6(n, "fe80::", 10)) return "linkLocal";
    if (inV6(n, "fc00::", 7)) return "private";
    if (inV6(n, "ff00::", 8)) return "reserved";
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

/** This panel's own targets: every address is a node's own public address. */
function ownTarget(deps: Pick<Deps, "db">, addresses: readonly string[]): boolean {
  if (addresses.length === 0) return false;
  const rows = deps.db
    .select({ v4: nodes.publicIpv4, v6: nodes.publicIpv6 })
    .from(nodes)
    .where(or(...addresses.map((a) => sql`${nodes.publicIpv4} = ${a} or ${nodes.publicIpv6} = ${a}`)))
    .all();
  const known = new Set(rows.flatMap((r) => [r.v4, r.v6]).filter((a): a is string => !!a));
  return addresses.every((a) => known.has(a));
}

/**
 * Decides whether an uptime check may request this URL. Hostnames are
 * resolved; every address must be public (or the panel's own).
 */
export async function checkTarget(deps: Pick<Deps, "db">, url: string, options: { allowInternal?: boolean } = {}): Promise<TargetCheck> {
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
    } catch {
      // NXDOMAIN, SERVFAIL or a timeout: the request would resolve the name again, and a
      // hostile name server could answer that one with an internal address.
      return { ok: false, reason: "unresolvable", address: host };
    }
    if (addresses.length === 0) return { ok: false, reason: "unresolvable", address: host };
  }
  const blocked = addresses.map((address) => ({ address, reason: blockedReason(address) })).filter((a) => a.reason !== null);
  const pin = addresses[0] as string;
  if (blocked.length === 0) return { ok: true, address: pin, byName: false };
  // The metadata service is never one of ours, even on a node's own address.
  const first = blocked.find((b) => b.reason === "metadata") ?? (blocked[0] as { address: string; reason: BlockReason });
  if (first.reason !== "metadata" && ownTarget(deps, addresses)) return { ok: true, address: pin, byName: false };
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

/** Shown on the check and in BAD_REQUEST messages. */
export function blockedMessage(check: Extract<TargetCheck, { ok: false }>): string {
  if (check.reason === "unresolvable") return `The name ${check.address} did not resolve.`;
  return `The target is ${reasonText[check.reason]} (${check.address}). Only an admin can allow internal targets, in Settings > General.`;
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
