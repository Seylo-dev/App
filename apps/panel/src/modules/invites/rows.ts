// Invite rows as screens show them, and the link they travel as.

import { eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type invites, users } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { scopeNames } from "../grants/rows";

export type InviteRow = typeof invites.$inferSelect;
export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

export function inviteStatus(row: InviteRow, now = new Date()): InviteStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "pending";
}

export function inviteGrants(db: PanelDb, row: InviteRow) {
  const nameOf = scopeNames(db, row.grants);
  return row.grants.map((g) => ({
    scopeType: g.scopeType,
    scopeId: g.scopeId,
    scopeName: nameOf(g.scopeType, g.scopeId)?.name ?? "",
    actions: g.actions,
  }));
}

export function toInvites(db: PanelDb, rows: InviteRow[], now = new Date()) {
  const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((id): id is string => id !== null))];
  const inviters = new Map(
    inviterIds.length
      ? db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(inArray(users.id, inviterIds))
          .all()
          .map((u) => [u.id, u])
      : [],
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    grants: inviteGrants(db, row),
    status: inviteStatus(row, now),
    invitedBy: (row.invitedBy && inviters.get(row.invitedBy)) || null,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function inviterLabel(db: PanelDb, row: InviteRow): string | null {
  if (!row.invitedBy) return null;
  const inviter = db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, row.invitedBy)).get();
  return inviter ? inviter.name || inviter.email : null;
}

/**
 * The accept link: on the panel domain when one is set, else on the origin
 * the request came in on, else a path the web app completes with its own
 * origin.
 */
export function inviteLink(ctx: OpContext, token: string): string {
  const domain = getSetting(ctx.db, "panelDomain");
  const base = domain ? `https://${domain}` : (ctx.origin ?? "");
  return `${base}/invite?t=${encodeURIComponent(token)}`;
}
