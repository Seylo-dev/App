// IP:port access through the agent's portgate (port_exposures rows):
// first-run access that turns into a redirect and then closes once the
// primary domain is live, timed exposes, and the ports agents report back
// when they picked one themselves (listen port 0).

import type { exposures as exposureOps } from "@seylo/ops";
import type { ServiceStatus } from "@seylo/proto";
import type { Static } from "@sinclair/typebox";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { nodes, portExposures, serviceAccess } from "../../db/schema";
import type { Deps } from "../../deps";
import { getService, mainPort, nodeHost, serviceNodes } from "../domains/lookup";
import { domainUrl, primaryDomain } from "../domains/rows";

export type ExposureRow = typeof portExposures.$inferSelect;
export type FirstRunAccess = Static<typeof exposureOps.FirstRunAccess>;

/** How long IP:port keeps redirecting to the primary domain before it closes. */
export const firstRunRedirectMs = 24 * 60 * 60 * 1000;

export function accessSettings(
  db: PanelDb,
  serviceId: string,
): { closeWhenDomainLive: boolean; redirectToPrimary: boolean; known: boolean } {
  const row = db.select().from(serviceAccess).where(eq(serviceAccess.serviceId, serviceId)).get();
  return { closeWhenDomainLive: row?.closeWhenDomainLive ?? true, redirectToPrimary: row?.redirectToPrimary ?? true, known: !!row };
}

export function saveAccessSettings(
  db: PanelDb,
  serviceId: string,
  settings: { closeWhenDomainLive?: boolean; redirectToPrimary?: boolean },
) {
  const current = accessSettings(db, serviceId);
  const values = {
    closeWhenDomainLive: settings.closeWhenDomainLive ?? current.closeWhenDomainLive,
    redirectToPrimary: settings.redirectToPrimary ?? current.redirectToPrimary,
  };
  db.insert(serviceAccess)
    .values({ serviceId, ...values })
    .onConflictDoUpdate({ target: serviceAccess.serviceId, set: { ...values, updatedAt: new Date() } })
    .run();
}

export function firstRunRow(db: PanelDb, serviceId: string): ExposureRow | undefined {
  return db
    .select()
    .from(portExposures)
    .where(and(eq(portExposures.serviceId, serviceId), eq(portExposures.kind, "first_run")))
    .get();
}

/**
 * Opens first-run IP:port access on the service's first node and main
 * port; the agent picks the port. No-op when it is open already. Exported
 * for the services module to call when it creates an app with a port.
 * Returns false when the service has no TCP port or no node.
 */
export function openFirstRun(db: PanelDb, serviceId: string): boolean {
  const service = getService(db, serviceId);
  const port = mainPort(service);
  const node = serviceNodes(db, serviceId)[0];
  if (port === null || !node) return false;
  const existing = firstRunRow(db, serviceId);
  if (existing) {
    // Reopening a redirecting or closing port makes it forward again.
    db.update(portExposures).set({ mode: "forward", redirectUrl: null, closeAt: null }).where(eq(portExposures.id, existing.id)).run();
    return true;
  }
  db.insert(portExposures).values({ serviceId, nodeId: node.id, kind: "first_run", listenPort: 0, targetPort: port }).run();
  if (!accessSettings(db, serviceId).known) saveAccessSettings(db, serviceId, {});
  return true;
}

export function closeFirstRun(db: PanelDb, serviceId: string): void {
  db.delete(portExposures)
    .where(and(eq(portExposures.serviceId, serviceId), eq(portExposures.kind, "first_run")))
    .run();
  if (!accessSettings(db, serviceId).known) saveAccessSettings(db, serviceId, {});
}

export function firstRunAccess(db: PanelDb, serviceId: string, now = new Date()): FirstRunAccess {
  const service = getService(db, serviceId);
  const settings = accessSettings(db, serviceId);
  const primary = primaryDomain(db, serviceId);
  const row = firstRunRow(db, serviceId);
  const base = {
    domainLiveAt: primary?.liveAt?.toISOString() ?? null,
    closeWhenDomainLive: settings.closeWhenDomainLive,
    redirectToPrimary: settings.redirectToPrimary,
  };
  const closed = { ...base, address: null, redirectTo: null, closeAt: null, firewallHint: null };
  if (!row) {
    return { ...closed, status: settings.known && mainPort(service) !== null ? "closed" : "none" };
  }
  if (row.closeAt && row.closeAt <= now) return { ...closed, status: "closed" };
  const node = serviceNodes(db, serviceId).find((n) => n.id === row.nodeId);
  const address = node && row.listenPort > 0 ? `${nodeHost(node)}:${row.listenPort}` : null;
  return {
    ...base,
    status: row.mode === "redirect" ? "redirecting" : "open",
    address,
    redirectTo: row.mode === "redirect" ? row.redirectUrl : null,
    closeAt: row.closeAt?.toISOString() ?? null,
    firewallHint: firewallHint(db, row.nodeId, row.listenPort > 0 ? row.listenPort : null),
  };
}

/**
 * The primary domain is live (or a different live domain became primary):
 * an open first-run port starts redirecting to it and closes after the
 * grace period, or closes at once when redirects are off. Returns true when
 * something changed, so the caller marks the desired state dirty.
 */
export function applyDomainLive(db: PanelDb, serviceId: string, now = new Date()): boolean {
  const settings = accessSettings(db, serviceId);
  const row = firstRunRow(db, serviceId);
  const primary = primaryDomain(db, serviceId);
  if (!row || !primary?.liveAt || !settings.closeWhenDomainLive) return false;
  if (!settings.redirectToPrimary) {
    db.delete(portExposures).where(eq(portExposures.id, row.id)).run();
    return true;
  }
  const url = domainUrl(primary);
  if (row.mode === "redirect" && row.redirectUrl === url) return false;
  db.update(portExposures)
    .set({ mode: "redirect", redirectUrl: url, closeAt: row.closeAt ?? new Date(now.getTime() + firstRunRedirectMs) })
    .where(eq(portExposures.id, row.id))
    .run();
  return true;
}

/**
 * Stores ports the agent picked (listen port 0) from its ServiceStatus, so
 * the address shows and stays stable across later syncs. Matching is by
 * container port, plus the expiry for timed exposes.
 */
export function recordReportedPorts(db: PanelDb, nodeId: string, status: ServiceStatus): string[] {
  const rows = db
    .select()
    .from(portExposures)
    .where(and(eq(portExposures.serviceId, status.serviceId), eq(portExposures.nodeId, nodeId), eq(portExposures.listenPort, 0)))
    .all();
  const changed: string[] = [];
  for (const row of rows) {
    const match = status.openPorts.find((p) => {
      if (p.containerPort !== row.targetPort) return false;
      const expires = p.expiresAt ? Number(p.expiresAt.seconds) * 1000 : null;
      if (row.kind === "timed") return expires !== null && row.expiresAt !== null && Math.abs(expires - row.expiresAt.getTime()) < 1000;
      return expires === null;
    });
    if (match && match.hostPort > 0) {
      db.update(portExposures).set({ listenPort: match.hostPort }).where(eq(portExposures.id, row.id)).run();
      changed.push(row.id);
    }
  }
  return changed;
}

/** Deletes timed exposes past their end and first-run ports past closeAt; returns their service ids. */
export function sweepExpired(db: PanelDb, now = new Date()): string[] {
  const expired = db
    .select({ id: portExposures.id, serviceId: portExposures.serviceId })
    .from(portExposures)
    .where(
      or(
        and(eq(portExposures.kind, "timed"), lte(portExposures.expiresAt, now)),
        and(eq(portExposures.kind, "first_run"), lte(portExposures.closeAt, now)),
      ),
    )
    .all();
  if (expired.length > 0) {
    db.delete(portExposures)
      .where(
        inArray(
          portExposures.id,
          expired.map((e) => e.id),
        ),
      )
      .run();
  }
  return [...new Set(expired.map((e) => e.serviceId))];
}

/** The deps a sweep needs; used by the exposures.sweep job. */
export function sweepAndMark(deps: Pick<Deps, "db" | "agents" | "live">, now = new Date()): number {
  const services = sweepExpired(deps.db, now);
  for (const serviceId of services) deps.agents.desired.markDirty({ serviceId });
  return services.length;
}

/**
 * How to open `port` in the node's host firewall, from its last health
 * report: the firewall check says which one is active ("ufw is active ...",
 * "firewalld is active ..."). Null when none is, or the node was never
 * checked. The agent's IP:port listeners are subject to it (on purpose:
 * Docker-published ports would bypass ufw).
 */
export function firewallHint(db: PanelDb, nodeId: string, port: number | null): string | null {
  if (!port) return null;
  const report = db.select({ report: nodes.healthReport }).from(nodes).where(eq(nodes.id, nodeId)).get()?.report;
  const check = report?.results.find((r) => r.id === "network.firewall");
  const detail = check?.detail ?? "";
  if (detail.startsWith("ufw")) return `ufw allow ${port}/tcp`;
  if (detail.startsWith("firewalld")) return `firewall-cmd --permanent --add-port=${port}/tcp && firewall-cmd --reload`;
  return null;
}
