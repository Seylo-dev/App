// Browser sessions: an opaque random token in an HttpOnly cookie plus a
// session key, both stored hashed. The key reaches the web app in a
// response header and lives in its origin's localStorage; the web app sends
// it back in a header on every call, and a token without its key signs
// nobody in. Cookies have no port, so on a plain-HTTP IP:port panel the
// browser hands the cookie to every other port of that address (a member's
// app); the key never leaves the panel's own origin (scheme, host and port),
// so that copy is useless. An HttpOnly cookie still keeps the token out of
// reach of scripts. Sessions slide: each use (at most once a minute) pushes
// the expiry out again, so active people stay signed in and idle ones do not.
// No session lives longer than maxSessionAgeMs, however active. Token and
// key are rotated when the account's security changes (rotateSession), so a
// copy made before a password change stops working.

import { timingSafeEqual } from "node:crypto";
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
  const key = randomToken();
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
  const row = db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      keyHash: hashToken(key),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
    })
    .returning({ id: sessions.id })
    .get();
  return { token, key, sessionId: row.id, expiresAt };
}

/**
 * The session's user, or undefined when the token is unknown or expired, the
 * key does not belong to it (or the session predates keys), or the user is
 * disabled.
 */
export function lookupSession(
  db: PanelDb,
  token: string,
  key: string,
  now = new Date(),
): { sessionId: string; user: PrincipalUser } | undefined {
  const row = db
    .select({
      sessionId: sessions.id,
      keyHash: sessions.keyHash,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      user: { id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get();
  if (!row || row.user.disabledAt || !sameHash(row.keyHash, hashToken(key))) return undefined;
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

/** Gives the session a new token and key (same id and expiry); the old ones stop working. */
export function rotateSession(db: PanelDb, sessionId: string): { token: string; key: string } {
  const token = randomToken();
  const key = randomToken();
  db.update(sessions)
    .set({ tokenHash: hashToken(token), keyHash: hashToken(key) })
    .where(eq(sessions.id, sessionId))
    .run();
  return { token, key };
}

function sameHash(stored: string | null, given: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
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
