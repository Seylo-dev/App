// Why a domain has no route on its service's nodes (Domain.noRoute), so
// requests to it cannot reach the service and its certificate is never
// asked for. Before, the Domains tab only said the certificate waited for
// DNS ("Cloudflare proxy -> <node IP>" from the placement, which looks
// fine), and the origin check and the re-check of waiting domains kept
// trying for as long as it lasted. The panel knows three reasons itself:
//
//   notDeployed   the service has no deployment to run yet (its first
//                 build queued, building or failed, its first rollout
//                 failed, or a target without an image): nothing of it
//                 goes to its nodes, routes included (services/desired.ts
//                 specMissing);
//   stackParent   a compose stack runs no container of its own; its
//                 members do, and the domain belongs on one of them;
//   cronService   a cron service runs on its schedule and serves no
//                 requests: the agent never routes it.
//
// The fourth comes from the node: routeWriteFailed, its agent could not
// write the service's route file (ServiceStatus.route_write_error, agents
// from 0.2.13), so it serves the routes of the file it wrote last, and a
// domain missing from the routes it reports has none there.
//
// domains.add, addAuto and update refuse a stack or a cron service, and
// domains.retryCertificate a domain with one of the panel's own reasons.
// The origin check (origin.ts) and the re-check of waiting domains
// (recheck.ts) skip those domains, since they could only fail; once a
// deployment of the service goes live, or a node writes the route file it
// could not, checkWaitingDomains() checks the service's waiting domains at once.

import { type domains as domainOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { deployments, domains, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { specMissing } from "../services/desired";
import { acmeHeld } from "./acme-hold";
import { type ServiceRow, serviceNodes } from "./lookup";
import { enqueueOriginCheck, originApplies } from "./origin";
import type { DomainRow } from "./rows";

export type NoRoute = Static<typeof domainOps.NoRoute>;

/** The reasons the panel knows itself: the service's nodes cannot have a route for any of its domains. */
export function unroutable(db: PanelDb, service: Pick<ServiceRow, "id" | "kind" | "stopped" | "targetDeploymentId">): NoRoute | null {
  if (service.kind === "cron") return { reason: "cronService" };
  const target = service.targetDeploymentId
    ? db.select({ imageRef: deployments.imageRef }).from(deployments).where(eq(deployments.id, service.targetDeploymentId)).get()
    : undefined;
  switch (specMissing(service, target)) {
    case "stack":
      return { reason: "stackParent" };
    case "notDeployed": {
      const next = db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ["queued", "building", "deploying"])))
        .orderBy(desc(deployments.createdAt))
        .get();
      return next ? { reason: "notDeployed", deploymentId: next.id } : { reason: "notDeployed" };
    }
    default:
      return null;
  }
}

/** unroutable for the domain's service; null when the service is gone. */
export function unroutableDomain(db: PanelDb, row: Pick<DomainRow, "serviceId">): NoRoute | null {
  const service = db.select().from(services).where(eq(services.id, row.serviceId)).get();
  return service ? unroutable(db, service) : null;
}

/**
 * Every domain of the service that has no route on its nodes, by domain id:
 * the panel's own reason for all of them, else, for a domain missing from
 * the routes an online node reports, that node's route write error.
 */
export function noRoutes(deps: Pick<Deps, "db" | "agents">, service: ServiceRow, rows: readonly DomainRow[]): Map<string, NoRoute> {
  const out = new Map<string, NoRoute>();
  const own = unroutable(deps.db, service);
  if (own) {
    for (const row of rows) out.set(row.id, own);
    return out;
  }
  for (const node of serviceNodes(deps.db, service.id)) {
    if (!deps.agents.isOnline(node.id)) continue;
    const status = deps.agents.state.get(node.id)?.services.get(service.id);
    const error = status?.routeWriteError?.message;
    if (!status || !error) continue;
    const routed = new Set(status.routes.map((r) => r.routeId));
    for (const row of rows) {
      if (out.has(row.id) || routed.has(row.id)) continue;
      out.set(row.id, { reason: "routeWriteFailed", nodeId: node.id, nodeName: node.name, error });
    }
  }
  return out;
}

/** What the panel's own reasons mean, for the ops that refuse them. */
export function noRouteMessage(service: Pick<ServiceRow, "name">, reason: NoRoute["reason"]): string {
  switch (reason) {
    case "notDeployed":
      return `${service.name} has not deployed yet: its domains go live, and their certificates are asked for, once a deployment goes live.`;
    case "stackParent":
      return `${service.name} is a compose stack, which runs no container of its own, so a domain on it routes nowhere. Put the domain on the stack member that serves it, on that member's Domains tab.`;
    case "cronService":
      return `${service.name} is a cron service: it runs on its schedule and serves no requests, so a domain cannot reach it.`;
    case "routeWriteFailed":
      return `A node of ${service.name} could not write its routes.`;
  }
}

/** domains.add, addAuto and update: a compose stack and a cron service take no domains. */
export function assertTakesDomains(service: ServiceRow): void {
  const reason = service.kind === "compose" ? "stackParent" : service.kind === "cron" ? "cronService" : null;
  if (reason) throw new OpError("BAD_REQUEST", noRouteMessage(service, reason), { reason });
}

/**
 * The service's nodes can route its domains now (its deployment went live,
 * or a node wrote the route file it could not): the origin check of each
 * custom domain whose certificate waits for it runs at once, a few seconds
 * from now, instead of at the re-check's pace for its age. The check waits
 * for the nodes to report the route (origin.ts).
 */
export function checkWaitingDomains(deps: Pick<Deps, "db" | "jobs">, serviceId: string, now = Date.now()): void {
  if (unroutableDomain(deps.db, { serviceId }) !== null) return;
  const rows = deps.db.select().from(domains).where(eq(domains.serviceId, serviceId)).all();
  for (const row of rows) {
    if (acmeHeld(row) && originApplies(row, row.dnsStatus)) enqueueOriginCheck(deps, row.id, now);
  }
}
