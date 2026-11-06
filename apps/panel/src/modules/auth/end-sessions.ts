// Ends sessions and closes their live sockets right away, so a revoked
// browser stops getting updates now instead of at the next re-check.

import { deleteSession, deleteUserSessionIds } from "../../auth/sessions";
import type { OpContext } from "../../ops/implement";

export function endSession(ctx: Pick<OpContext, "db" | "live">, sessionId: string): void {
  deleteSession(ctx.db, sessionId);
  ctx.live.disconnect({ sessionId });
}

/** Ends every session of a person except `keepSessionId`; returns how many ended. */
export function endUserSessions(ctx: Pick<OpContext, "db" | "live">, userId: string, keepSessionId?: string): number {
  const ids = deleteUserSessionIds(ctx.db, userId, keepSessionId);
  if (keepSessionId) for (const sessionId of ids) ctx.live.disconnect({ sessionId });
  else ctx.live.disconnect({ userId });
  return ids.length;
}
