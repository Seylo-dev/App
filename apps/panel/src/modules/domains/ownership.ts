// Who may route a host name. Traefik on a node orders routers by rule
// length, so `Host(x) && PathPrefix(/api)` always beats `Host(x)`, and two
// identical rules win in turn on every reload. A host therefore belongs to
// the service that routes it: another service may add paths under it only
// when the caller may edit that service's domains (owners and admins may).
// Hosts that are not service domains are never available: the panel's own
// domain, a database's TLS host name, and the agents' tool hosts
// (<slug>-db-<id>.<wildcard>, <slug>-box-<id>.<wildcard>).

import { X509Certificate } from "node:crypto";
import { slug } from "@seylo/brand";
import { OpError } from "@seylo/ops";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Access } from "../../auth/access";
import type { PanelDb } from "../../db/client";
import { domains, nodes, serviceDatabases } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { getSetting } from "../../settings";

const toolLabel = new RegExp(`^${slug}-(db|box)-`);

/** True for the host names the agent's edge serves database UIs and Boxes on. */
export function isToolHost(host: string): boolean {
  return toolLabel.test(host.toLowerCase());
}

function panelDomain(db: PanelDb): string | null {
  return getSetting(db, "panelDomain")?.trim().toLowerCase() || null;
}

export interface HostCaller {
  db: PanelDb;
  access: Pick<Access, "can">;
  secrets?: SecretBox;
}

/** Why `host` cannot be routed by `serviceId`, or null when it can. */
export function hostConflict(caller: HostCaller, host: string, serviceId: string): { message: string; reason: string } | null {
  const name = host.trim().toLowerCase();
  if (name === panelDomain(caller.db)) return { message: `${name} is the panel's own domain.`, reason: "panelDomain" };
  if (isToolHost(name)) {
    return { message: `Host names starting with ${slug}-db- or ${slug}-box- are reserved for database UIs and Boxes.`, reason: "reserved" };
  }
  const database = caller.db
    .select({ serviceId: serviceDatabases.serviceId })
    .from(serviceDatabases)
    .where(and(sql`lower(${serviceDatabases.tlsHostname}) = ${name}`, ne(serviceDatabases.serviceId, serviceId)))
    .get();
  if (database) return { message: `${name} is the TLS host name of a database.`, reason: "databaseHost" };
  const owners = caller.db
    .selectDistinct({ serviceId: domains.serviceId })
    .from(domains)
    .where(and(sql`lower(${domains.host}) = ${name}`, ne(domains.serviceId, serviceId)))
    .all();
  for (const owner of owners) {
    if (!caller.access.can("domains.edit", { type: "service", id: owner.serviceId })) {
      return { message: `${name} is used by another service.`, reason: "hostTaken" };
    }
  }
  // A custom certificate on another service that names this host would be
  // served for it too (one TLS store per node).
  for (const cert of otherCertificates(caller, serviceId)) {
    if (
      certificateNames(cert.pem).some((san) => sanCovers(san, name)) &&
      !caller.access.can("domains.edit", { type: "service", id: cert.serviceId })
    ) {
      return { message: `A certificate on another service covers ${name}.`, reason: "hostTaken" };
    }
  }
  return null;
}

/** CONFLICT unless `serviceId` may route `host`. */
export function assertHostAvailable(caller: HostCaller, host: string, serviceId: string, field = "host"): void {
  const conflict = hostConflict(caller, host, serviceId);
  if (conflict) throw new OpError("CONFLICT", conflict.message, { field, reason: conflict.reason });
}

/**
 * CONFLICT when a host a database (or the panel) wants is a service domain,
 * the panel's domain, a tool host or another database's TLS host name.
 */
export function assertHostUnclaimed(db: PanelDb, host: string, options: { field: string; exceptDatabaseOf?: string; panel?: boolean }) {
  const name = host.trim().toLowerCase();
  const conflict = (message: string, reason: string) => new OpError("CONFLICT", message, { field: options.field, reason });
  if (isToolHost(name)) throw conflict(`Host names starting with ${slug}-db- or ${slug}-box- are reserved.`, "reserved");
  if (!options.panel && name === panelDomain(db)) throw conflict(`${name} is the panel's own domain.`, "panelDomain");
  const domain = db.select({ id: domains.id }).from(domains).where(sql`lower(${domains.host}) = ${name}`).get();
  if (domain) throw conflict(`${name} is a domain of a service.`, "hostTaken");
  const database = db
    .select({ serviceId: serviceDatabases.serviceId })
    .from(serviceDatabases)
    .where(
      and(
        sql`lower(${serviceDatabases.tlsHostname}) = ${name}`,
        options.exceptDatabaseOf ? ne(serviceDatabases.serviceId, options.exceptDatabaseOf) : undefined,
      ),
    )
    .get();
  if (database) throw conflict(`${name} is the TLS host name of a database.`, "databaseHost");
}

/** DNS names of a certificate: subject alternative names, else the common name. */
export function certificateNames(pem: string): string[] {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return [];
  }
  const sans = (cert.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter(Boolean);
  if (sans.length > 0) return sans;
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1]?.trim().toLowerCase();
  return cn ? [cn] : [];
}

/** Whether a certificate name ("shop.example.com" or "*.example.com") matches host. */
export function sanCovers(san: string, host: string): boolean {
  if (san === host) return true;
  if (!san.startsWith("*.")) return false;
  const dot = host.indexOf(".");
  return dot > 0 && host.slice(dot + 1) === san.slice(2);
}

/**
 * Refuses certificate names a service may not claim: the panel's domain,
 * tool hosts (a wildcard over a node's wildcard domain covers them),
 * database TLS host names and hosts of services the caller may not edit.
 */
export function assertCertificateNames(caller: HostCaller, pem: string, serviceId: string): void {
  const names = certificateNames(pem);
  const panel = panelDomain(caller.db);
  const wildcards = caller.db
    .select({ wildcard: nodes.wildcardDomain })
    .from(nodes)
    .where(isNotNull(nodes.wildcardDomain))
    .all()
    .map((n) => n.wildcard?.toLowerCase() ?? "");
  const refuse = (name: string, why: string) =>
    new OpError("BAD_REQUEST", `The certificate also names ${name}, which ${why}. Upload one that only names this service's hosts.`, {
      field: "certPem",
      name,
    });
  for (const name of names) {
    if (panel && sanCovers(name, panel)) throw refuse(name, "covers the panel's own domain");
    if (name.startsWith("*.") && wildcards.includes(name.slice(2))) throw refuse(name, "covers a node's tool hosts");
    if (!name.startsWith("*.")) {
      const conflict = hostConflict(caller, name, serviceId);
      if (conflict) throw refuse(name, "belongs elsewhere");
      continue;
    }
    // A wildcard: every routed host under it must be one this caller may edit.
    const zone = name.slice(2);
    const covered = caller.db
      .select({ serviceId: domains.serviceId, host: domains.host })
      .from(domains)
      .where(and(sql`lower(${domains.host}) like ${`%.${zone}`}`, ne(domains.serviceId, serviceId)))
      .all()
      .filter((d) => sanCovers(name, d.host.toLowerCase()));
    for (const d of covered) {
      if (!caller.access.can("domains.edit", { type: "service", id: d.serviceId }))
        throw refuse(name, `covers ${d.host} of another service`);
    }
    const database = caller.db
      .select({ host: serviceDatabases.tlsHostname })
      .from(serviceDatabases)
      .where(isNotNull(serviceDatabases.tlsHostname))
      .all()
      .find((d) => d.host && sanCovers(name, d.host.toLowerCase()));
    if (database?.host) throw refuse(name, `covers the database host ${database.host}`);
  }
}

function otherCertificates(caller: HostCaller, serviceId: string): { serviceId: string; pem: string }[] {
  if (!caller.secrets) return [];
  const rows = caller.db
    .select({ serviceId: domains.serviceId, sealed: domains.certificateSealed })
    .from(domains)
    .where(and(eq(domains.https, "custom"), isNotNull(domains.certificateSealed), ne(domains.serviceId, serviceId)))
    .all();
  const out: { serviceId: string; pem: string }[] = [];
  for (const row of rows) {
    if (!row.sealed) continue;
    try {
      const opened = caller.secrets.open(row.sealed, "domain.certificate");
      if (!opened) continue;
      const { certPem } = JSON.parse(opened) as { certPem: string };
      out.push({ serviceId: row.serviceId, pem: certPem });
    } catch {
      // A certificate that no longer opens cannot be served either.
    }
  }
  return out;
}
