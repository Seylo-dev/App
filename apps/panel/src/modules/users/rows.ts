// Turns users rows into the User shape screens show, with the counts that
// need other tables (2FA, passkeys, GitHub login, grants).

import { OpError } from "@seylo/ops";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { avatarField } from "../../auth/avatar";
import type { PanelDb } from "../../db/client";
import { githubAccounts, grants, passkeys, totpSecrets, users } from "../../db/schema";

export type UserRow = typeof users.$inferSelect;

export function toUsers(db: PanelDb, rows: UserRow[]) {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const twoFactor = new Set(
    db
      .select({ userId: totpSecrets.userId })
      .from(totpSecrets)
      .where(sql`${inArray(totpSecrets.userId, ids)} and ${isNotNull(totpSecrets.confirmedAt)}`)
      .all()
      .map((r) => r.userId),
  );
  const countBy = (table: typeof passkeys | typeof grants) =>
    new Map(
      db
        .select({ userId: table.userId, n: sql<number>`count(*)` })
        .from(table)
        .where(inArray(table.userId, ids))
        .groupBy(table.userId)
        .all()
        .map((r) => [r.userId, Number(r.n)]),
    );
  const passkeyCounts = countBy(passkeys);
  const grantCounts = countBy(grants);
  const logins = new Map(
    db
      .select({ userId: githubAccounts.userId, login: githubAccounts.login })
      .from(githubAccounts)
      .where(inArray(githubAccounts.userId, ids))
      .all()
      .map((r) => [r.userId, r.login]),
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    ...avatarField(row.id, row.avatar),
    role: row.role,
    status: row.disabledAt ? ("disabled" as const) : ("active" as const),
    twoFactor: twoFactor.has(row.id),
    passkeyCount: passkeyCounts.get(row.id) ?? 0,
    githubLogin: logins.get(row.id) ?? null,
    grantCount: row.role === "member" ? (grantCounts.get(row.id) ?? 0) : 0,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function toUser(db: PanelDb, row: UserRow) {
  return toUsers(db, [row])[0] as ReturnType<typeof toUsers>[number];
}

export function findUser(db: PanelDb, userId: string): UserRow {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That person does not exist.");
  return row;
}

export function activeOwnerCount(db: PanelDb): number {
  return db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.role, "owner"))
    .all()
    .filter((r) => !r.disabledAt).length;
}
