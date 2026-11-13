// Which DNS zone a host belongs in. The walk up the host's labels stops at
// its registrable domain (example.co.il for shop.example.co.il), from the
// ICANN section of the Public Suffix List (tldts-icann, pinned: the list
// ships inside the package, so nothing is fetched at run time). Before, it
// went on to the first name with NS records, so a host under a domain that
// does not exist landed in the public suffix: "Add this record where
// co.il's DNS is managed". Now a registrable domain without name servers
// (NXDOMAIN, or no delegation) is reported as such, and a deeper zone
// with its own NS records (sub.example.co.il) is still found first.
//
// NS answers are kept for a minute per lookup set, so the check of
// domains.add and the Domains row's own check right after it, or the row's
// check every minute and the re-check job, ask the resolvers once.

import { parse } from "tldts-icann";
import type { DnsLookups } from "./dns";

/** The registrable domain of a host and its public suffix (ICANN section); null for a public suffix itself, an IP or a name that is not a host. */
export function registrableDomain(host: string): { domain: string; suffix: string } | null {
  const name = lookupName(host);
  const parsed = parse(name, { extractHostname: false });
  if (!parsed.domain || !parsed.publicSuffix) return null;
  return { domain: parsed.domain, suffix: parsed.publicSuffix };
}

/** The name DNS is asked about: lower case, no trailing dot, a wildcard host's "*." left off. */
function lookupName(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\*\./, "");
}

/**
 * Top-level names kept for private networks: internal (reserved by ICANN
 * in 2024 for that) and the ones in common use that are not delegated.
 */
const privateTlds = new Set(["internal", "lan", "home", "corp", "intranet", "localdomain", "private"]);

/**
 * A name public DNS has no say about: the IANA special-use registry
 * (tldts' list: localhost, test, local, invalid, example, onion, alt,
 * home.arpa, ...) or a private network's top-level name (privateTlds).
 * The public resolvers find no name servers for it, which does not make
 * it a domain that "does not exist": it answers on its own network. The
 * ICANN build of tldts leaves isIcann unset outside .com, .org, .net,
 * .edu, .gov and .de, so "not an ICANN TLD" cannot be read from it.
 */
export function isPrivateName(host: string): boolean {
  const name = lookupName(host);
  if (parse(name, { extractHostname: false, detectSpecialUse: true }).isSpecialUse) return true;
  return privateTlds.has(name.slice(name.lastIndexOf(".") + 1));
}

export interface ZoneInfo {
  /** The closest name from the host up to its registrable domain with NS records; null when none has. */
  zone: string | null;
  /** The zone's name servers are Cloudflare's. */
  cloudflare: boolean;
  /** The host's registrable domain; null when the host is a public suffix (or not a host name). */
  registrable: string | null;
  /**
   * No name from the host up to the registrable domain has NS records, and
   * the registrable domain's own answer said so (NXDOMAIN or no records),
   * not a server failure such as a lame delegation. Never for a private
   * name (isPrivateName), which public resolvers cannot see.
   */
  registrableMissing: boolean;
}

/** NS answers kept this long per DnsLookups. */
export const nsCacheMs = 60_000;
const nsCacheMax = 1000;

type CachedNs = { at: number; answer: Promise<string[]> };
const nsCaches = new WeakMap<DnsLookups, Map<string, CachedNs>>();

/** NS records of a name, from the cache while it is fresh; a lookup that throws is not kept. */
function nameServers(dns: DnsLookups, name: string): Promise<string[]> {
  let cache = nsCaches.get(dns);
  if (!cache) {
    cache = new Map();
    nsCaches.set(dns, cache);
  }
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.at < nsCacheMs) return hit.answer;
  if (cache.size >= nsCacheMax) trim(cache, now);
  const answer = dns.resolveNs(name);
  const entry = { at: now, answer };
  cache.set(name, entry);
  answer.catch(() => {
    if (cache.get(name) === entry) cache.delete(name);
  });
  return answer;
}

function trim(cache: Map<string, CachedNs>, now: number): void {
  for (const [name, entry] of cache) if (now - entry.at >= nsCacheMs) cache.delete(name);
  // Still full: the oldest go first (a Map keeps insertion order).
  for (const name of cache.keys()) {
    if (cache.size < nsCacheMax) break;
    cache.delete(name);
  }
}

/** A resolver's SERVFAIL (publicDns throws it for NS lookups): the name's servers did not answer, which says nothing about whether it exists. */
export function isServerFailure(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ESERVFAIL";
}

/**
 * The zone a host is in and whether Cloudflare serves it. Asks for the NS
 * records of every name from the host up to its registrable domain at once
 * and takes the closest that has some; never a public suffix. A lookup
 * that fails (a resolver timeout) throws, as the walk did before; a
 * server failure counts as no records there, but leaves registrableMissing
 * false when it was the registrable domain's. A private name (internal,
 * localhost, ...) is never missing.
 */
export async function findZone(host: string, dns: DnsLookups): Promise<ZoneInfo> {
  const name = lookupName(host);
  const registrable = registrableDomain(name);
  if (!registrable) return { zone: null, cloudflare: false, registrable: null, registrableMissing: false };
  const labels = name.split(".");
  const depth = labels.length - registrable.domain.split(".").length;
  const names = Array.from({ length: depth + 1 }, (_, i) => labels.slice(i).join("."));
  const answers = await Promise.allSettled(names.map((candidate) => nameServers(dns, candidate)));
  let unsure = false;
  for (const [i, answer] of answers.entries()) {
    const candidate = names[i] as string;
    if (answer.status === "rejected") {
      if (!isServerFailure(answer.reason)) throw answer.reason;
      if (candidate === registrable.domain) unsure = true;
      continue;
    }
    if (answer.value.length > 0) {
      return {
        zone: candidate,
        cloudflare: answer.value.some((server) => server.toLowerCase().endsWith(".ns.cloudflare.com")),
        registrable: registrable.domain,
        registrableMissing: false,
      };
    }
  }
  return { zone: null, cloudflare: false, registrable: registrable.domain, registrableMissing: !unsure && !isPrivateName(name) };
}

/** What the panel says about a registrable domain without name servers. */
export function registrableMissingMessage(registrable: string): string {
  return `${registrable} does not exist: it is not registered, or has no name servers yet. Check the spelling.`;
}
