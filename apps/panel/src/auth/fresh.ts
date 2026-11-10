// "Fresh sign-in" (sudo mode): ops that add a way into an account (a
// passkey, a GitHub link, an authenticator app, an API key, a CLI approval,
// a first password) or change the email it signs in with need proof that
// the person is at the keyboard now, not only a session that may have been
// left open somewhere. So do the ops that hand lasting access to someone
// else (any invite, a grant that adds actions, a promotion to admin or
// owner, a node join token) when a browser session runs them. A session is
// fresh for 15 minutes after it signed in or after auth.reauth confirmed it.

import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { sessions } from "../db/schema";
import type { OpContext } from "../ops/implement";
import type { PrincipalUser } from "./principal";
import { requireSession } from "./sign-in";

/** How long a sign-in or a re-auth counts as fresh. */
export const freshSignInMs = 15 * 60 * 1000;

/** When the session stops being fresh, or null when it does not exist. */
export function freshUntil(db: PanelDb, sessionId: string): Date | null {
  const row = db
    .select({ createdAt: sessions.createdAt, reauthAt: sessions.reauthAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;
  const last = Math.max(row.createdAt.getTime(), row.reauthAt?.getTime() ?? 0);
  return new Date(last + freshSignInMs);
}

/**
 * A browser session that signed in or re-authenticated in the last 15
 * minutes. API keys get requireSession's refusal; a stale session gets
 * FORBIDDEN with details.reason "reauth", which the web turns into the
 * re-auth dialog and a retry.
 */
export function requireFreshSignIn(ctx: OpContext, now = new Date()): { userId: string; sessionId: string; user: PrincipalUser } {
  const session = requireSession(ctx);
  const until = freshUntil(ctx.db, session.sessionId);
  if (!until || until.getTime() <= now.getTime()) {
    throw new OpError("FORBIDDEN", "Confirm it's you to continue.", { reason: "reauth" });
  }
  return session;
}

/**
 * requireFreshSignIn for browser sessions; API keys pass. For ops that hand
 * lasting access to someone else (invites.create, grants.setOnProject and
 * setOnService when they add actions, users.updateRole up to admin or owner,
 * nodes.createJoinToken): admins also
 * run them from scripts, and every key was itself made under a fresh sign-in
 * (apiKeys.create, cliLogin.approve, the MCP consent), so the threat left is
 * a session left open.
 */
export function requireFreshIfSession(ctx: OpContext, now = new Date()): void {
  if (ctx.principal.type === "session") requireFreshSignIn(ctx, now);
}

/** Records a successful auth.reauth; returns the new end of the fresh window. */
export function markReauthenticated(db: PanelDb, sessionId: string, now = new Date()): Date {
  db.update(sessions).set({ reauthAt: now }).where(eq(sessions.id, sessionId)).run();
  return new Date(now.getTime() + freshSignInMs);
}
