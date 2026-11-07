// Listing and ending the signed-in person's own browser sessions.

import { auth, OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { listSessions as listUserSessions } from "../../auth/sessions";
import { requireSession } from "../../auth/sign-in";
import { sessions } from "../../db/schema";
import { implement } from "../../ops/implement";
import { endSession, endUserSessions } from "./end-sessions";

export const listSessions = implement(auth.listSessions, (_input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  return {
    sessions: listUserSessions(ctx.db, userId).map((s) => ({
      id: s.id,
      current: s.id === sessionId,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
  };
});

export const revokeSession = implement(auth.revokeSession, (input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  const row = ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, userId)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "That session does not exist or already ended.");
  endSession(ctx, row.id);
  if (row.id === sessionId) ctx.http?.clearSession();
  return {};
});

export const revokeOtherSessions = implement(auth.revokeOtherSessions, (_input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  return { revoked: endUserSessions(ctx, userId, sessionId) };
});
