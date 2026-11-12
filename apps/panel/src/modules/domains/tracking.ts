// Follows what agents report about routes (RouteStatus, route_id = domain
// id) and keeps the domain rows current: certificate state, DNS mismatch,
// and liveAt, the first time a route served. When the primary domain goes
// live, first-run IP:port access switches to redirect-then-close. A domain
// whose certificate waits for DNS (acme-hold.ts) is served without one
// (plain HTTP, and Traefik's default certificate on HTTPS), so its reports
// count only when they name a certificate. A node that cannot write a
// service's route file says why (ServiceStatus.route_write_error): open
// Domains tabs show it on the domains it has no route for (no-route.ts),
// and once it writes the file the service's waiting domains are checked
// at once.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { domains as domainOps, exposures as exposureOps } from "@seylo/ops";
import { RouteState, type ServiceStatus } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { domains } from "../../db/schema";
import type { Deps } from "../../deps";
import { applyDomainLive } from "../exposures/logic";
import { acmeHeld } from "./acme-hold";
import { invalidateService } from "./lookup";
import { checkWaitingDomains } from "./no-route";

/** Applies one service's route reports; returns true when a row changed. */
export function applyRouteStatus(deps: Pick<Deps, "db" | "agents" | "live" | "alerts">, status: ServiceStatus, now = new Date()): boolean {
  let changed = false;
  let primaryWentLive = false;
  let holdChanged = false;
  for (const route of status.routes) {
    const row = deps.db
      .select()
      .from(domains)
      .where(and(eq(domains.id, route.routeId), eq(domains.serviceId, status.serviceId)))
      .get();
    if (!row) continue;
    const set: Partial<typeof domains.$inferInsert> = {};
    const held = acmeHeld(row);
    switch (route.state) {
      case RouteState.ACTIVE:
        // A held route asks the CA nothing (acme-hold.ts): that it serves says nothing about a
        // certificate, unless the report names one (from an ACME route the node had before).
        if (held && !route.certificateExpiresAt) break;
        if (row.https === "acme" && row.certStatus !== "valid") {
          set.certStatus = "valid";
          // Let's Encrypt reached a node of the service: an "elsewhere" from before is out of date (origin.ts).
          if (row.originStatus === "elsewhere") {
            set.originStatus = null;
            set.originCheckedAt = null;
          }
        }
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
        // Nothing asks Let's Encrypt while held: a failure of the route from before is no reason for an alert.
        if (held) break;
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
      // A certificate after all ends the hold; the node's DNS check saying elsewhere starts one.
      if (acmeHeld({ ...row, ...set }) !== held) holdChanged = true;
    }
  }
  if ((primaryWentLive && applyDomainLive(deps.db, status.serviceId, now)) || holdChanged) {
    deps.agents.desired.markDirty({ serviceId: status.serviceId });
  }
  if (changed) invalidateService(deps, status.serviceId, [domainOps.list.id, exposureOps.get.id]);
  return changed;
}

/**
 * Follows a node's route write error for a service: open screens learn when
 * it appears, changes or clears, and when it clears (the node wrote the
 * file, with the routes it lacked) the service's waiting domains are
 * checked. `failing` holds the last error by node and service.
 */
export function applyRouteWriteError(
  deps: Pick<Deps, "db" | "jobs" | "live">,
  failing: Map<string, string>,
  nodeId: string,
  serviceId: string,
  status: ServiceStatus | undefined,
): void {
  const key = `${nodeId}:${serviceId}`;
  const error = status?.routeWriteError?.message ?? "";
  const before = failing.get(key) ?? "";
  if (error === before) return;
  if (error) failing.set(key, error);
  else failing.delete(key);
  invalidateService(deps, serviceId, [domainOps.list.id]);
  if (!error && status) checkWaitingDomains(deps, serviceId);
}

/** Subscribes to node state; called from the domains module's start(). */
export function trackRoutes(deps: Deps): () => void {
  const failing = new Map<string, string>();
  return deps.agents.state.onChange((nodeId, change) => {
    const view = deps.agents.state.get(nodeId);
    if (!view) return;
    if (change.kind === "service" && change.removed) applyRouteWriteError(deps, failing, nodeId, change.serviceId, undefined);
    if (change.kind === "snapshot") {
      // A service the node no longer has takes its error with it.
      for (const key of [...failing.keys()]) {
        const [node, serviceId] = key.split(":") as [string, string];
        if (node === nodeId && !view.services.has(serviceId)) applyRouteWriteError(deps, failing, nodeId, serviceId, undefined);
      }
    }
    const statuses =
      change.kind === "snapshot"
        ? [...view.services.values()]
        : change.kind === "service" && !change.removed
          ? [view.services.get(change.serviceId)].filter((s): s is ServiceStatus => !!s)
          : [];
    for (const status of statuses) {
      try {
        applyRouteStatus(deps, status);
        applyRouteWriteError(deps, failing, nodeId, status.serviceId, status);
      } catch (error) {
        deps.logger.warn({ err: error, nodeId, serviceId: status.serviceId }, "applying route status failed");
      }
    }
  });
}
