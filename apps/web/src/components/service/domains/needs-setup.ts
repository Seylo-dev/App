// Which of a service's domains still need the owner: the Domains tab shows
// their count in red, and its tooltip names them. A custom domain needs
// setup while its DNS record is missing or points elsewhere, while the
// panel's origin check finds another server answering (elsewhere), when
// its certificate failed, or behind Cloudflare's proxy when the checks have
// not reached the node for 30 minutes (originUnknownSince). A domain the
// panel has not checked yet, or is still checking, is not the owner's job:
// before 0.2.16 every proxied domain without the origin "node" counted, so
// one whose check had not run (or whose answer was lost) showed a red 1
// with nothing on the page saying why. Automatic domains (the node's
// wildcard record) and forwards never count, and a certificate on its way
// (pending) is not the owner's job. A domain with no route on the node
// counts when the domain itself is the problem (on a compose stack or a
// cron service, or a node that cannot write the routes), not while its
// service has not deployed yet: the deploy is what to fix, and its record
// may well be right. Every row that counts says why (domain-row.tsx).

import type { domains, OpOutput } from "@seylo/ops";

type Domain = OpOutput<typeof domains.list>["domains"][number];

/** How long the panel's checks through Cloudflare may not reach the node before the domain counts. */
export const originUnknownLongMs = 30 * 60_000;

/** Why a domain counts (the first that applies), for its row and tests. */
export type SetupReason = "noRoute" | "dnsMissing" | "dnsWrongTarget" | "originElsewhere" | "certificateFailed" | "originUnknown";

/** A custom domain whose origin the panel checks: not automatic, not a forward, with a route, behind the proxy. */
function checkedThroughCloudflare(d: Domain): boolean {
  return !d.auto && !d.forward && !d.noRoute && d.dnsStatus === "proxied";
}

/** Behind Cloudflare's proxy, and the panel's checks have not reached the node for 30 minutes. */
export function originUnknownLong(d: Domain, now = Date.now()): boolean {
  if (!checkedThroughCloudflare(d) || d.origin !== "unknown" || !d.originUnknownSince) return false;
  return now - Date.parse(d.originUnknownSince) >= originUnknownLongMs;
}

/**
 * Behind Cloudflare's proxy, and the panel does not know yet whether
 * requests reach the node: not checked yet, or unknown for under 30
 * minutes. It checks again on its own (recheck.ts), so nothing to do yet.
 */
export function originChecking(d: Domain, now = Date.now()): boolean {
  if (!checkedThroughCloudflare(d) || d.origin === "node" || d.origin === "elsewhere") return false;
  return !originUnknownLong(d, now);
}

export function setupReason(d: Domain, now = Date.now()): SetupReason | null {
  if (d.noRoute) return d.noRoute.reason !== "notDeployed" ? "noRoute" : null;
  if (d.auto || d.forward) return null;
  if (d.dnsStatus === "missing") return "dnsMissing";
  if (d.dnsStatus === "wrongTarget") return "dnsWrongTarget";
  if (d.origin === "elsewhere") return "originElsewhere";
  if (d.certificate.status === "failed") return "certificateFailed";
  if (originUnknownLong(d, now)) return "originUnknown";
  return null;
}

export function domainNeedsSetup(d: Domain, now = Date.now()): boolean {
  return setupReason(d, now) !== null;
}

/** The domains the Domains tab counts, in the list's order. */
export function domainsNeedingSetup(list: readonly Domain[] | undefined, now = Date.now()): Domain[] {
  return list ? list.filter((d) => domainNeedsSetup(d, now)) : [];
}
