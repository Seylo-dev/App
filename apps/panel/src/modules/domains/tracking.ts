// Follows what agents report about routes (RouteStatus, route_id = domain
// id) and keeps the domain rows current: certificate state, DNS mismatch,
// and liveAt, the first time a route served. When the primary domain goes
// live, first-run IP:port access switches to redirect-then-close.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { domains as domainOps, exposures as exposureOps } from "@seylo/ops";
import { RouteState, type ServiceStatus } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { domains } from "../../db/schema";
import type { Deps } from "../../deps";
import { applyDomainLive } from "../exposures/logic";
import { invalidateService } from "./lookup";

/** Applies one service's route reports; returns true when a row changed. */
export function applyRouteStatus(deps: Pick<Deps, "db" | "agents" | "live" | "alerts">, status: ServiceStatus, now = new Date()): boolean {
  let changed = false;
  let primaryWentLive = false;
  for (const route of status.routes) {
    const row = deps.db
      .select()
      .from(domains)
      .where(and(eq(domains.id, route.routeId), eq(domains.serviceId, status.serviceId)))
      .get();
    if (!row) continue;
    const set: Partial<typeof domains.$inferInsert> = {};
    switch (route.state) {
      case RouteState.ACTIVE:
        if (row.https === "acme" && row.certStatus !== "valid") set.certStatus = "valid";
        if (row.certError) set.certError = null;
        if (row.https === "acme" && row.certStatus === "failed") deps.alerts.resolve(`certificate:${row.id}:`);
        if (!row.liveAt) {
          set.liveAt = now;
          if (row.isPrimary) primaryWentLive = true;
        }
        if (row.dnsStatus !== "ok" && row.dnsStatus !== "proxied") set.dnsStatus = "ok";
        break;
      case RouteState.CERTIFICATE_PENDING:
        if (row.https === "acme" && row.certStatus !== "pending") set.certStatus = "pending";
        break;
      case RouteState.CERTIFICATE_FAILED:
        if (row.https === "acme" && row.certStatus !== "failed") set.certStatus = "failed";
        if (row.https === "acme" && route.message && row.certError !== route.message) set.certError = route.message.slice(0, 1000);
        // One alert per failure streak; an ACTIVE report resolves it.
        if (row.https === "acme" && !deps.alerts.isOpen(`certificate:${row.id}:`)) {
          deps.alerts.raise({
            event: "certificate_failed",
            key: `certificate:${row.id}:${now.getTime()}`,
            title: `No certificate for ${row.host}`,
            message: route.message.slice(0, 300) || "Let's Encrypt could not issue a certificate. Check that DNS points at the node.",
            serviceId: status.serviceId,
          });
        }
        break;
      case RouteState.DNS_MISMATCH:
        if (row.dnsStatus === "ok" || row.dnsStatus === "unknown") set.dnsStatus = "wrongTarget";
        break;
      default:
        break;
    }
    // Certificate facts from agents that send them (ACME or custom, as served).
    if (row.https !== "off" && route.certificateExpiresAt) {
      const expires = timestampDate(route.certificateExpiresAt);
      if (row.certExpiresAt?.getTime() !== expires.getTime()) set.certExpiresAt = expires;
    }
    if (row.https === "acme" && route.certificateIssuer && row.certIssuer !== route.certificateIssuer)
      set.certIssuer = route.certificateIssuer;
    if (Object.keys(set).length > 0) {
      deps.db.update(domains).set(set).where(eq(domains.id, row.id)).run();
      changed = true;
    }
  }
  if (primaryWentLive && applyDomainLive(deps.db, status.serviceId, now)) {
    deps.agents.desired.markDirty({ serviceId: status.serviceId });
  }
  if (changed) invalidateService(deps, status.serviceId, [domainOps.list.id, exposureOps.get.id]);
  return changed;
}

/** Subscribes to node state; called from the domains module's start(). */
export function trackRoutes(deps: Deps): () => void {
  return deps.agents.state.onChange((nodeId, change) => {
    const view = deps.agents.state.get(nodeId);
    if (!view) return;
    const statuses =
      change.kind === "snapshot"
        ? [...view.services.values()]
        : change.kind === "service" && !change.removed
          ? [view.services.get(change.serviceId)].filter((s): s is ServiceStatus => !!s)
          : [];
    for (const status of statuses) {
      try {
        applyRouteStatus(deps, status);
      } catch (error) {
        deps.logger.warn({ err: error, nodeId, serviceId: status.serviceId }, "applying route status failed");
      }
    }
  });
}
