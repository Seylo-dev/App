// The DNS and origin check of one domain, for domains.checkDns and for the
// re-check of domains whose certificate waits for DNS (acme-hold.ts). The
// Domains tab checks a waiting domain every minute while it is open; this
// job covers the rest (a domain added through the API or MCP, a record
// fixed in Cloudflare with the tab closed), so the certificate starts once
// the record is right without anyone looking: every 2 minutes in the
// domain's first hour, every 15 minutes in its first day, then every 6
// hours. A check from the tab counts too (dns_checked_at), and so does one
// whose lookup failed, which leaves the domain waiting. A domain whose
// service's nodes cannot have a route for it (not deployed yet, a compose
// stack, a cron service: no-route.ts) waits for that first: it is not
// re-checked, and checkDns runs no origin check for it. Once the service
// deploys it is due again at once, its last check being long ago.

import { domains as domainOps } from "@seylo/ops";
import { and, eq, isNull } from "drizzle-orm";
import { domains, type OriginStatus } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { acmeHeld, keepsLastAnswer, settleHold } from "./acme-hold";
import { checkHost, type DnsResult, dnsLookups } from "./dns";
import { invalidateService, serviceNodes } from "./lookup";
import { unroutableDomain } from "./no-route";
import { checkOrigin, type OriginReason, originApplies, originProvable, saveOrigin } from "./origin";
import type { DomainRow } from "./rows";

/**
 * Looks the domain up now, runs the origin check where it applies, stores
 * both and settles the hold: a check that proves a waiting domain sends its
 * nodes the desired state that asks Let's Encrypt.
 */
export async function checkDomain(
  deps: Pick<Deps, "db" | "agents" | "live">,
  row: DomainRow,
): Promise<{ dns: DnsResult; origin: OriginStatus | null; reason?: OriginReason; checkedAt: Date }> {
  const dns = await checkHost(row.host, serviceNodes(deps.db, row.serviceId), dnsLookups());
  if (keepsLastAnswer(row, dns.status)) {
    // The lookup failed: the last answer stands, and only the time moves on, for the re-check's pacing.
    const checkedAt = new Date();
    deps.db.update(domains).set({ dnsCheckedAt: checkedAt }).where(eq(domains.id, row.id)).run();
    return { dns, origin: null, checkedAt };
  }
  // Behind Cloudflare's proxy only the origin check tells whether the record there points at the node; with no
  // route on the service's nodes (not deployed yet) nothing there could answer it.
  const check = originApplies(row, dns.status) && !unroutableDomain(deps.db, row) ? await checkOrigin(deps, row) : null;
  const origin = check?.origin ?? null;
  const checkedAt = new Date();
  deps.db.update(domains).set({ dnsStatus: dns.status, dnsCheckedAt: checkedAt }).where(eq(domains.id, row.id)).run();
  const originChanged = saveOrigin(deps, row, origin, checkedAt, check?.reason);
  if (dns.status !== row.dnsStatus && !originChanged) invalidateService(deps, row.serviceId, [domainOps.list.id]);
  settleHold(deps, row, { dnsStatus: dns.status, origin, provable: check?.provable ?? originProvable(deps, row.serviceId) }, checkedAt);
  return { dns, origin, ...(check?.reason ? { reason: check.reason } : {}), checkedAt };
}

/** How long a waiting domain of this age goes between checks. */
export function recheckEveryMs(ageMs: number): number {
  if (ageMs < 3_600_000) return 2 * 60_000;
  if (ageMs < 86_400_000) return 15 * 60_000;
  return 6 * 3_600_000;
}

/** Checks per run, oldest check first: the lookups and requests stay few however many domains wait. */
export const recheckPerRun = 20;

export const recheckJobType = "domains.recheckWaiting";

export const recheckJob = defineJob({
  type: recheckJobType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    const now = Date.now();
    const due = ctx.db
      .select()
      .from(domains)
      .where(and(eq(domains.https, "acme"), eq(domains.auto, false), isNull(domains.acmeReleasedAt), isNull(domains.liveAt)))
      .all()
      .filter((row) => acmeHeld(row) && now - (row.dnsCheckedAt?.getTime() ?? 0) >= recheckEveryMs(now - row.createdAt.getTime()))
      // Waiting for its service to deploy first: a check could not change anything.
      .filter((row) => !unroutableDomain(ctx.db, row))
      .sort((a, b) => (a.dnsCheckedAt?.getTime() ?? 0) - (b.dnsCheckedAt?.getTime() ?? 0))
      .slice(0, recheckPerRun);
    for (const row of due) {
      try {
        await checkDomain(ctx, row);
      } catch (error) {
        ctx.logger.warn({ err: error, domainId: row.id }, "re-checking a domain that waits for DNS failed");
      }
    }
  },
});
