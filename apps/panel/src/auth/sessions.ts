// Browser sessions: an opaque random token in an HttpOnly cookie, stored
// hashed. Sessions slide: each use (at most once a minute) pushes the
// expiry out again, so active people stay signed in and idle ones do not.
// No session lives longer than maxSessionAgeMs, however active. The token
// is rotated when the account's security changes (rotateSession), so a
// token copied before a password change stops working.

import { and, desc, eq, gt, lte, ne } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { hashToken, randomToken } from "../security/tokens";
import type { PrincipalUser } from "./principal";

export const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
/** Absolute cap from sign-in, after which the person signs in again. */
export const maxSessionAgeMs = 90 * 24 * 60 * 60 * 1000;
const touchIntervalMs = 60 * 1000;

export function createSession(db: PanelDb, userId: string, meta: { ip: string | null; userAgent: string | null }, now = new Date()) {
  // Sweep this person's dead sessions so the table does not grow forever.
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, now)))
    .run();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
  const row = db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
    })
    .returning({ id: sessions.id })
    .get();
  return { token, sessionId: row.id, expiresAt };
}

/** The session's user, or undefined when the token is unknown, expired or the user is disabled. */
export function lookupSession(db: PanelDb, token: string, now = new Date()): { sessionId: string; user: PrincipalUser } | undefined {
  const row = db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      user: { id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get();
  if (!row || row.user.disabledAt) return undefined;
  const hardExpiry = row.createdAt.getTime() + maxSessionAgeMs;
  if (now.getTime() >= hardExpiry) {
    deleteSession(db, row.sessionId);
    return undefined;
  }

  if (now.getTime() - row.lastSeenAt.getTime() > touchIntervalMs) {
    db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(Math.min(now.getTime() + sessionLifetimeMs, hardExpiry)) })
      .where(eq(sessions.id, row.sessionId))
      .run();
  }
  const { disabledAt: _, ...user } = row.user;
  return { sessionId: row.sessionId, user };
}

/** Gives the session a new token (same id and expiry); the old token stops working. */
export function rotateSession(db: PanelDb, sessionId: string): string {
  const token = randomToken();
  db.update(sessions)
    .set({ tokenHash: hashToken(token) })
    .where(eq(sessions.id, sessionId))
    .run();
  return token;
}

export function listSessions(db: PanelDb, userId: string, now = new Date()) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastSeenAt))
    .all();
}

export function deleteSession(db: PanelDb, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** Ends every session of a person except `keepSessionId`; returns how many ended. */
export function deleteUserSessions(db: PanelDb, userId: string, keepSessionId?: string): number {
  return deleteUserSessionIds(db, userId, keepSessionId).length;
}

/** Like deleteUserSessions, but returns the ids that ended (to close their live sockets). */
export function deleteUserSessionIds(db: PanelDb, userId: string, keepSessionId?: string): string[] {
  const where = keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId);
  return db
    .delete(sessions)
    .where(where)
    .returning({ id: sessions.id })
    .all()
    .map((r) => r.id);
}
