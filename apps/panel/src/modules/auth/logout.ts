import { auth, OpError, sessionCookie } from "@seylo/ops";
import { implement } from "../../ops/implement";
import { endSession } from "./end-sessions";

export const logout = implement(auth.logout, (_input, ctx) => {
  if (ctx.principal.type !== "session") {
    throw new OpError("BAD_REQUEST", "API keys cannot sign out. Revoke the key instead.");
  }
  endSession(ctx, ctx.principal.sessionId);
  ctx.http?.clearCookie(sessionCookie);
  return {};
});
