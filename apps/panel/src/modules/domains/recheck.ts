// The DNS and origin check of one domain, for domains.checkDns and for the
// re-check of domains whose certificate waits for DNS (acme-hold.ts). The
// Domains tab checks a waiting domain every minute while it is open; this
// job covers the rest (a domain added through the API or MCP, a record
// fixed in Cloudflare with the tab closed), so the certificate starts once
// the record is right without anyone looking: every 2 minutes in the
// domain's first hour, every 15 minutes in its first day, then every 6
// hours. A check from the tab counts too (dns_checked_at).

import { domains as domainOps } from "@seylo/ops";
import { and, eq, isNull } from "drizzle-orm";
import { domains, type OriginStatus } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { acmeHeld, settleHold } from "./acme-hold";
import { checkHost, type DnsResult, dnsLookups } from "./dns";
import { invalidateService, serviceNodes } from "./lookup";
import { checkOrigin, originApplies, originProvable, saveOrigin } from "./origin";
import type { DomainRow } from "./rows";

/**
 * Looks the domain up now, runs the origin check where it applies, stores
 * both and settles the hold: a check that proves a waiting domain sends its
 * nodes the desired state that asks Let's Encrypt.
 */
export async function checkDomain(
  deps: Pick<Deps, "db" | "agents" | "live">,
  row: DomainRow,
): Promise<{ dns: DnsResult; origin: OriginStatus | null; checkedAt: Date }> {
  const dns = await checkHost(row.host, serviceNodes(deps.db, row.serviceId), dnsLookups());
  // Behind Cloudflare's proxy only the origin check tells whether the record there points at the node.
  const check = originApplies(row, dns.status) ? await checkOrigin(deps, row) : null;
  const origin = check?.origin ?? null;
  const checkedAt = new Date();
  deps.db.update(domains).set({ dnsStatus: dns.status, dnsCheckedAt: checkedAt }).where(eq(domains.id, row.id)).run();
  const originChanged = saveOrigin(deps, row, origin, checkedAt);
  if (dns.status !== row.dnsStatus && !originChanged) invalidateService(deps, row.serviceId, [domainOps.list.id]);
  settleHold(deps, row, { dnsStatus: dns.status, origin, provable: check?.provable ?? originProvable(deps, row.serviceId) }, checkedAt);
  return { dns, origin, checkedAt };
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
