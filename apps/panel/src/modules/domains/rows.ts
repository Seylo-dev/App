// Domain rows to the Domain shape of the contract, and the reads other
// modules use: a service's domains in display order and its primary URL.

import type { domains as domainOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { domains } from "../../db/schema";
import { acmeHeld } from "./acme-hold";
import { lastOriginReason, originApplies } from "./origin";

export type DomainRow = typeof domains.$inferSelect;
export type Domain = Static<typeof domainOps.Domain>;

/** https://host/path, or http:// when HTTPS is off. The path is left out for "/". */
export function domainUrl(row: Pick<DomainRow, "host" | "pathPrefix" | "https">): string {
  const scheme = row.https === "off" ? "http" : "https";
  const path = row.pathPrefix === "/" ? "" : row.pathPrefix.replace(/\/$/, "");
  return `${scheme}://${row.host}${path}`;
}

/**
 * Agents send the issuer's common name; Let's Encrypt's intermediates (R10,
 * E6, YR1 and the staging "(STAGING) ..." ones) read better as its name.
 */
export function issuerName(raw: string): string {
  if (/^(Y?[RE]\d{1,2})$/.test(raw)) return `Let's Encrypt (${raw})`;
  if (raw.startsWith("(STAGING)")) return `Let's Encrypt staging`;
  return raw;
}

/** originReason of the domain's last origin check, when it gave one (origin.ts keeps it in memory). */
function originReasonOf(domainId: string): Pick<Domain, "originReason"> {
  const reason = lastOriginReason(domainId);
  return reason ? { originReason: reason } : {};
}

export function toDomain(row: DomainRow): Domain {
  const m = row.middlewares ?? {};
  const issuer = row.certIssuer ? issuerName(row.certIssuer) : row.https === "acme" && row.certStatus === "valid" ? "Let's Encrypt" : null;
  return {
    id: row.id,
    serviceId: row.serviceId,
    host: row.host,
    pathPrefix: row.pathPrefix,
    stripPrefix: row.stripPrefix,
    targetPort: row.targetPort,
    https: row.https,
    redirectToHttps: row.redirectToHttps,
    auto: row.auto,
    primary: row.isPrimary,
    forward: row.forward ?? null,
    middlewares: {
      basicAuth: m.basicAuth && m.basicAuth.users.length > 0 ? { usernames: m.basicAuth.users.map((u) => u.username) } : null,
      ipAllowList: m.ipAllowList ?? [],
      rateLimit: m.rateLimit ? { periodSeconds: 1, ...m.rateLimit } : null,
      redirects: m.redirects ?? [],
    },
    dnsStatus: row.dnsStatus,
    dnsCheckedAt: row.dnsCheckedAt?.toISOString() ?? null,
    // Said only while it can be true: a record that moved since (missing, wrong target) makes it stale.
    ...(row.originStatus && row.originCheckedAt && originApplies(row, row.dnsStatus)
      ? { origin: row.originStatus, originCheckedAt: row.originCheckedAt.toISOString(), ...originReasonOf(row.id) }
      : {}),
    certificate: {
      status: row.https === "off" ? "none" : row.certStatus,
      expiresAt: row.certExpiresAt?.toISOString() ?? null,
      issuer,
      error: row.https !== "off" && row.certStatus === "failed" ? (row.certError ?? null) : null,
      ...(acmeHeld(row) ? { waitingForDns: true } : {}),
    },
    liveAt: row.liveAt?.toISOString() ?? null,
    url: domainUrl(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Primary first, then oldest first. */
export function serviceDomains(db: PanelDb, serviceId: string): DomainRow[] {
  return db.select().from(domains).where(eq(domains.serviceId, serviceId)).orderBy(desc(domains.isPrimary), asc(domains.createdAt)).all();
}

export function primaryDomain(db: PanelDb, serviceId: string): DomainRow | undefined {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.serviceId, serviceId), eq(domains.isPrimary, true)))
    .get();
}

export function getDomain(db: PanelDb, serviceId: string, domainId: string): DomainRow | undefined {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.serviceId, serviceId)))
    .get();
}
