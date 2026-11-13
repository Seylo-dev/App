// What follows a service to another node (services.move): its IP:port
// access, the port_exposures rows (a database's exposed port, timed
// exposes, the first-run port). Each row names the node whose portgate
// listens, and the desired state sends a row only to that node (a
// database's exposed port goes with the database's spec). Once the new
// node is live (deployments/engine.ts, in the transaction that removes the
// old placement) the rows move there, on the same port unless another
// service already has it on that node; then the port is 0 and the new
// node's agent picks one and reports it (exposures/logic.ts
// recordReportedPorts). Allowed IPs, allowPlain, TLS and timed ends stay.
// Before 0.2.16 the rows stayed on the old node: followPlacements moves
// those, once at start.

import { and, eq, ne } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { portExposures, servicePlacements } from "../../db/schema";
import { activeMove } from "./copies";

type Tx = Pick<PanelDb, "select" | "update">;

/** Moves the service's access rows on `from` to `to`; returns how many moved. */
export function moveAccessToNode(tx: Tx, serviceId: string, from: string, to: string): number {
  if (from === to) return 0;
  const rows = tx
    .select({ id: portExposures.id, listenPort: portExposures.listenPort })
    .from(portExposures)
    .where(and(eq(portExposures.serviceId, serviceId), eq(portExposures.nodeId, from)))
    .all();
  if (rows.length === 0) return 0;
  const taken = new Set(
    tx
      .select({ port: portExposures.listenPort })
      .from(portExposures)
      .where(and(eq(portExposures.nodeId, to), ne(portExposures.serviceId, serviceId)))
      .all()
      .map((r) => r.port)
      .filter((port) => port > 0),
  );
  for (const row of rows) {
    tx.update(portExposures)
      .set({ nodeId: to, listenPort: taken.has(row.listenPort) ? 0 : row.listenPort })
      .where(eq(portExposures.id, row.id))
      .run();
  }
  return rows.length;
}

/**
 * Access rows left on a node their service no longer runs on (moves before
 * 0.2.16), for services on exactly one node that are not moving: moved to
 * that node. Returns the services that changed.
 */
export function followPlacements(db: PanelDb): string[] {
  const rows = db.select({ serviceId: portExposures.serviceId, nodeId: portExposures.nodeId }).from(portExposures).all();
  const changed: string[] = [];
  for (const serviceId of new Set(rows.map((r) => r.serviceId))) {
    const placed = db
      .select({ nodeId: servicePlacements.nodeId })
      .from(servicePlacements)
      .where(eq(servicePlacements.serviceId, serviceId))
      .all();
    const to = placed.length === 1 ? placed[0]?.nodeId : undefined;
    if (!to || activeMove(db, serviceId)) continue;
    const stale = new Set(rows.filter((r) => r.serviceId === serviceId && r.nodeId !== to).map((r) => r.nodeId));
    if (stale.size === 0) continue;
    db.transaction((tx) => {
      for (const from of stale) moveAccessToNode(tx, serviceId, from, to);
    });
    changed.push(serviceId);
  }
  return changed;
}
