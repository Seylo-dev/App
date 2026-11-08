// Every second-factor code a person types (the sign-in step, re-auth,
// turning two-factor sign-in off, new recovery codes) goes through here:
// the per-address lock, the per-account brake on authenticator codes and
// its alert (auth/lockout.ts).

import { assertNotLocked, beginCodeCheck, codeThrottle, recordCodeFailure, recordFailure, userKey } from "../../auth/lockout";
import type { PrincipalUser } from "../../auth/principal";
import type { OpContext } from "../../ops/implement";
import { raiseSecurityChange } from "../alerts/security";

export type CodeMethod = "totp" | "recovery";

/** Which kind of code `code` is, the way checkAnySecondFactor decides it. */
export function codeMethod(code: string): CodeMethod {
  return /^\d{6}$/.test(code.trim()) ? "totp" : "recovery";
}

/**
 * Runs `check` for `user` behind the locks. Throws RATE_LIMITED while this
 * address is locked or the account's code brake holds the check back;
 * returns whether the code was right, counting a wrong one everywhere.
 */
export function checkSecondFactorCode(
  ctx: Pick<OpContext, "db" | "ip" | "alerts">,
  user: Pick<PrincipalUser, "id" | "email" | "name">,
  method: CodeMethod,
  check: () => boolean,
): boolean {
  const key = userKey(user.id, ctx.ip);
  assertNotLocked(ctx.db, key);
  if (method === "totp") beginCodeCheck(ctx.db, user.id, ctx.ip);
  if (check()) return true;
  recordFailure(ctx.db, key);
  if (recordCodeFailure(ctx.db, user.id)) {
    raiseSecurityChange(
      ctx,
      user,
      "many wrong authenticator codes",
      `${codeThrottle.failures} wrong two-factor codes in 15 minutes. A code is only asked for after the right password or in a signed-in session, so the password may be known. Authenticator codes for this account are now checked at most once every few seconds, except from addresses it signed in from before.`,
    );
  }
  return false;
}
