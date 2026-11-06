// Undoing a move to another project whose switch failed or was cancelled
// (deployments engine, finish()). It only touches rows, so the engine can
// call it inside its transaction without importing the services ops.

import { and, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type deployments, grants, invites, projects, services, users } from "../../db/schema";
import { nameKey } from "./rows";

type Tx = Pick<PanelDb, "select" | "insert" | "update" | "delete">;
type DeploymentRow = typeof deployments.$inferSelect;

/**
 * Puts the service back in the project it left, with the grants and invite
 * entries the move removed. Returns the project it is in afterwards: the
 * old one, or the new one when going back is impossible (the old project
 * is gone or got a service with the same name meanwhile).
 */
export function restoreProjectMove(tx: Tx, d: Pick<DeploymentRow, "serviceId" | "projectMove">): string | null {
  const move = d.projectMove;
  if (!move) return null;
  const svc = tx.select().from(services).where(eq(services.id, d.serviceId)).get();
  if (!svc) return null;
  const back = tx.select({ id: projects.id }).from(projects).where(eq(projects.id, move.fromProjectId)).get();
  const clash = tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, move.fromProjectId), eq(services.nameKey, nameKey(svc.name))))
    .get();
  if (!back || (clash && clash.id !== svc.id)) return svc.projectId;
  tx.update(services).set({ projectId: move.fromProjectId, updatedAt: new Date() }).where(eq(services.id, svc.id)).run();
  for (const g of move.removedGrants) {
    // People removed meanwhile keep nothing.
    if (!tx.select({ id: users.id }).from(users).where(eq(users.id, g.userId)).get()) continue;
    const createdBy = g.createdBy && tx.select({ id: users.id }).from(users).where(eq(users.id, g.createdBy)).get() ? g.createdBy : null;
    tx.insert(grants)
      .values({ userId: g.userId, scopeType: "service", scopeId: svc.id, actions: g.actions, createdBy })
      .onConflictDoNothing()
      .run();
  }
  for (const entry of move.removedInviteGrants) {
    const row = tx.select().from(invites).where(eq(invites.id, entry.inviteId)).get();
    if (!row || row.grants.some((g) => g.scopeType === "service" && g.scopeId === svc.id)) continue;
    tx.update(invites)
      .set({ grants: [...row.grants, { scopeType: "service", scopeId: svc.id, actions: entry.actions }] })
      .where(eq(invites.id, row.id))
      .run();
  }
  return move.fromProjectId;
}
