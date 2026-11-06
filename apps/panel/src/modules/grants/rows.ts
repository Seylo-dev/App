// Grant rows with the names screens show, and the checks every change to
// a grant or an invite's grant list goes through.

import { allOps, expandActionEntry, grantableActions, OpError, type ScopeKind } from "@seylo/ops";
import { and, eq, inArray } from "drizzle-orm";
import type { Access } from "../../auth/access";
import type { PanelDb } from "../../db/client";
import { grants, projects, services } from "../../db/schema";

export type GrantRow = typeof grants.$inferSelect;

const grantable = new Map<ScopeKind, string[]>();

/** Actions a grant on this kind of resource may hold, from the op registry. */
export function grantableOn(scope: ScopeKind): string[] {
  let list = grantable.get(scope);
  if (!list) {
    list = grantableActions(allOps, scope);
    grantable.set(scope, list);
  }
  return list;
}

/** Project and service names (and each service's project) for a set of grants. */
export function scopeNames(db: PanelDb, rows: readonly { scopeType: ScopeKind; scopeId: string }[]) {
  const projectIds = rows.filter((r) => r.scopeType === "project").map((r) => r.scopeId);
  const serviceIds = rows.filter((r) => r.scopeType === "service").map((r) => r.scopeId);
  const names = new Map<string, { name: string; projectId: string | null }>();
  if (projectIds.length) {
    for (const p of db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)).all()) {
      names.set(`project:${p.id}`, { name: p.name, projectId: null });
    }
  }
  if (serviceIds.length) {
    for (const s of db
      .select({ id: services.id, name: services.name, projectId: services.projectId })
      .from(services)
      .where(inArray(services.id, serviceIds))
      .all()) {
      names.set(`service:${s.id}`, { name: s.name, projectId: s.projectId });
    }
  }
  return (scopeType: ScopeKind, scopeId: string) => names.get(`${scopeType}:${scopeId}`);
}

export function toGrants(db: PanelDb, rows: GrantRow[]) {
  const nameOf = scopeNames(db, rows);
  return rows.map((row) => {
    const named = nameOf(row.scopeType, row.scopeId);
    return {
      id: row.id,
      userId: row.userId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      scopeName: named?.name ?? "",
      projectId: row.scopeType === "project" ? row.scopeId : (named?.projectId ?? null),
      actions: row.actions,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export function listGrantsOf(db: PanelDb, userId: string) {
  return toGrants(db, db.select().from(grants).where(eq(grants.userId, userId)).orderBy(grants.createdAt).all());
}

/** Throws NOT_FOUND unless the project or service exists; returns its project id. */
export function requireScope(db: PanelDb, scopeType: ScopeKind, scopeId: string): string {
  if (scopeType === "project") {
    if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, scopeId)).get()) {
      throw new OpError("NOT_FOUND", "That project does not exist.");
    }
    return scopeId;
  }
  const service = db.select({ projectId: services.projectId }).from(services).where(eq(services.id, scopeId)).get();
  if (!service) throw new OpError("NOT_FOUND", "That service does not exist.");
  return service.projectId;
}

/**
 * Checks an action list for a grant on one kind of resource: every entry
 * must be grantable there ("*", "<area>.*" or an exact action), and the
 * caller must hold every action it stands for on that resource, so nobody
 * hands out more than they have. Returns the list without duplicates.
 */
export function checkGrantActions(access: Access, scopeType: ScopeKind, scopeId: string, actions: readonly string[]): string[] {
  const known = grantableOn(scopeType);
  const unique = [...new Set(actions)];
  for (const entry of unique) {
    const expanded = expandActionEntry(entry, known);
    if (expanded.length === 0) {
      throw new OpError("BAD_REQUEST", `"${entry}" cannot be granted on a ${scopeType}.`, { field: "actions", action: entry });
    }
    const missing = expanded.find((action) => !access.can(action as `${string}.${string}`, { type: scopeType, id: scopeId }));
    if (missing) {
      throw new OpError("FORBIDDEN", `You can only share actions you hold yourself; you do not have ${missing} here.`, { action: missing });
    }
  }
  return unique;
}

export function findGrant(db: PanelDb, userId: string, scopeType: ScopeKind, scopeId: string): GrantRow | undefined {
  return db
    .select()
    .from(grants)
    .where(and(eq(grants.userId, userId), eq(grants.scopeType, scopeType), eq(grants.scopeId, scopeId)))
    .get();
}
