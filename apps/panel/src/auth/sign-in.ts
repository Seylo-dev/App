// The last step of every way to sign in (password, passkey, GitHub, invite,
// setup): either start a session, or, when the account has an
// authenticator app, hand out a 5-minute second-factor ticket instead.
// The brute-force guard for passwords and codes is auth/lockout.ts.

import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { OpContext } from "../ops/implement";
import { createChallenge } from "./challenges";
import { clearFailures, emailKey, userKey } from "./lockout";
import type { PrincipalUser } from "./principal";
import { confirmedTotp } from "./second-factor";
import { createSession, sessionLifetimeMs } from "./sessions";

export const secondFactorTtlMs = 5 * 60 * 1000;

export type UserRow = typeof users.$inferSelect;

export function toViewer(user: PrincipalUser) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export interface LoginResult {
  status: "signedIn" | "secondFactor";
  viewer: ReturnType<typeof toViewer>;
  challenge?: { ticket: string; methods: ("totp" | "recovery")[]; expiresAt: string };
}

/**
 * Signs `user` in, or asks for the second factor. A passkey already is two
 * factors, so passkey sign-in passes skipSecondFactor.
 */
export function finishSignIn(ctx: OpContext, user: UserRow, options: { skipSecondFactor?: boolean } = {}): LoginResult {
  ctx.auditAs?.(user);
  if (user.disabledAt) throw new OpError("FORBIDDEN", "This account is disabled.");
  if (!options.skipSecondFactor && confirmedTotp(ctx.db, user.id)) {
    const { ticket, expiresAt } = createChallenge(ctx.db, { purpose: "secondFactor", userId: user.id, ttlMs: secondFactorTtlMs });
    return {
      status: "secondFactor",
      viewer: toViewer(user),
      challenge: { ticket, methods: ["totp", "recovery"], expiresAt: expiresAt.toISOString() },
    };
  }
  startSession(ctx, user.id);
  return { status: "signedIn", viewer: toViewer(user) };
}

/** Creates the session, sets the cookie and forgives this address's failure streaks. */
export function startSession(ctx: OpContext, userId: string): void {
  if (!ctx.http) throw new OpError("BAD_REQUEST", "Signing in is only available in the browser.");
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (user) ctx.auditAs?.(user);
  const session = createSession(ctx.db, userId, { ip: ctx.ip, userAgent: ctx.userAgent });
  ctx.db.update(users).set({ lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null }).where(eq(users.id, userId)).run();
  clearFailures(ctx.db, userKey(userId, ctx.ip));
  if (user) clearFailures(ctx.db, emailKey(user.email, ctx.ip));
  ctx.http.setSession({ token: session.token, key: session.key, maxAgeSeconds: sessionLifetimeMs / 1000 });
}

/** Account-security ops must come from a browser session, never from an API key or MCP token. */
export function requireSession(ctx: OpContext): { userId: string; sessionId: string; user: PrincipalUser } {
  if (ctx.principal.type !== "session") {
    throw new OpError("FORBIDDEN", "Only a signed-in browser session can do this, not an API key.");
  }
  return { userId: ctx.principal.user.id, sessionId: ctx.principal.sessionId, user: ctx.principal.user };
}
