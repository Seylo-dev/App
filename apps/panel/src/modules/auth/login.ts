// Email and password sign-in, and the second step for accounts with an
// authenticator app.

import { auth, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deleteChallenge, failChallenge, findChallenge } from "../../auth/challenges";
import {
  assertNotLocked,
  beginPasswordCheck,
  emailKey,
  recordAccountFailure,
  recordFailure,
  rememberGoodAddress,
  softThrottle,
  userKey,
} from "../../auth/lockout";
import { checkTotpCode, recoveryCodesLeft, useRecoveryCode } from "../../auth/second-factor";
import { finishSignIn, startSession, toViewer } from "../../auth/sign-in";
import { users } from "../../db/schema";
import { implement } from "../../ops/implement";
import { verifyPassword } from "../../security/password";
import { raiseSecurityChange } from "../alerts/security";
import { checkSecondFactorCode } from "./code-check";

const wrongCredentials = () => new OpError("UNAUTHENTICATED", "The email or password is wrong.");

export const login = implement(auth.login, async (input, ctx) => {
  if (!ctx.http) throw new OpError("BAD_REQUEST", "Sign-in is only available in the browser.");

  const email = input.email.trim().toLowerCase();
  // The lock is per typed email and address, account or not, so its answer
  // says nothing about which emails exist (auth/lockout.ts).
  const lockKey = emailKey(email, ctx.ip);
  assertNotLocked(ctx.db, lockKey);
  // Many addresses guessing at one email: one check at a time, one every
  // few seconds, refused rather than queued (addresses that signed in
  // before skip it).
  const done = beginPasswordCheck(ctx.db, email, ctx.ip);
  const user = ctx.db.select().from(users).where(eq(users.email, email)).get();
  let passwordOk: boolean;
  try {
    // verifyPassword spends the same time when the user does not exist.
    passwordOk = await verifyPassword(input.password, user?.passwordHash);
  } finally {
    done();
  }
  if (passwordOk && user && !user.disabledAt) rememberGoodAddress(ctx.db, email, ctx.ip);
  if (!user || user.disabledAt || !passwordOk) {
    // Logged against the account, so its owner sees attempts on their password.
    if (user && !user.disabledAt) ctx.auditAs?.(user);
    recordFailure(ctx.db, lockKey);
    if (recordAccountFailure(ctx.db, email) && user && !user.disabledAt) {
      raiseSecurityChange(
        ctx,
        user,
        "many wrong passwords",
        `More than ${softThrottle.failures} sign-ins with a wrong password in 15 minutes, from several addresses; password checks for it are now limited to one every few seconds, except from addresses that signed in before.`,
      );
    }
    throw wrongCredentials();
  }
  // Wrong second-factor codes from this address lock the password step too,
  // so a known password does not buy endless code guesses.
  assertNotLocked(ctx.db, userKey(user.id, ctx.ip));
  return finishSignIn(ctx, user);
});

export const verifySecondFactor = implement(auth.verifySecondFactor, (input, ctx) => {
  const challenge = findChallenge(ctx.db, input.ticket, "secondFactor");
  const expired = () => new OpError("UNAUTHENTICATED", "This sign-in expired. Enter your email and password again.");
  if (!challenge?.userId) throw expired();
  const user = ctx.db.select().from(users).where(eq(users.id, challenge.userId)).get();
  if (!user || user.disabledAt) {
    deleteChallenge(ctx.db, challenge.id);
    throw expired();
  }
  ctx.auditAs?.(user);

  // Behind the per-address lock and the per-account brake: a known password
  // buys a fresh ticket from every address, so the ticket's own attempts
  // bound nothing on their own. A refused check spends no attempt.
  const ok = checkSecondFactorCode(ctx, user, input.method, () =>
    input.method === "totp"
      ? checkTotpCode(ctx.db, ctx.secrets, user.id, input.code.trim())
      : useRecoveryCode(ctx.db, ctx.secrets, user.id, input.code),
  );
  if (!ok) {
    const left = failChallenge(ctx.db, challenge);
    throw new OpError("UNAUTHENTICATED", left > 0 ? "That code is wrong." : "Too many wrong codes. Sign in again.", {
      attemptsLeft: String(left),
    });
  }
  deleteChallenge(ctx.db, challenge.id);
  startSession(ctx, user.id);
  return { viewer: toViewer(user), recoveryCodesLeft: recoveryCodesLeft(ctx.db, user.id) };
});
