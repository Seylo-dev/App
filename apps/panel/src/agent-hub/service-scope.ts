// Which services a node may report on. The threat model lets a compromised
// node lie about its own services only: crash reports, deploy and health
// events, cron runs, metrics and state for services it does not run would
// otherwise reach other projects' alerts, crash lists, cron history and
// service pages. A node runs a service when it has a placement there, or a
// deployment in flight targets it or moves the service away from it.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { deployments, servicePlacements } from "../db/schema";

export function servicesOnNode(db: PanelDb, nodeId: string): Set<string> {
  const placed = db.select({ id: servicePlacements.serviceId }).from(servicePlacements).where(eq(servicePlacements.nodeId, nodeId)).all();
  const moving = db
    .select({ id: deployments.serviceId })
    .from(deployments)
    .where(
      and(
        inArray(deployments.status, ["queued", "building", "deploying"]),
        or(
          eq(deployments.movedFromNodeId, nodeId),
          sql`exists (select 1 from json_each(${deployments.targetNodeIds}) where value = ${nodeId})`,
        ),
      ),
    )
    .all();
  return new Set([...placed, ...moving].map((r) => r.id));
}

export function nodeRunsService(db: PanelDb, nodeId: string, serviceId: string): boolean {
  return servicesOnNode(db, nodeId).has(serviceId);
}
