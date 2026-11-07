// The signed-in person's sign-in methods: password, authenticator app and
// recovery codes. Passkeys and GitHub have their own files.

import { displayName } from "@seylo/brand";
import { auth, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { requireFreshSignIn } from "../../auth/fresh";
import { githubAvailable } from "../../auth/github-device";
import { assertNotLocked, recordFailure, userKey } from "../../auth/lockout";
import { passkeyRp } from "../../auth/passkeys";
import {
  checkAnySecondFactor,
  checkTotpCode,
  confirmedTotp,
  issueRecoveryCodes,
  recoveryCodesLeft,
  removeSecondFactor,
} from "../../auth/second-factor";
import { rotateSession, sessionLifetimeMs } from "../../auth/sessions";
import { requireSession } from "../../auth/sign-in";
import { githubAccounts, passkeys, totpSecrets, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { hashPassword, verifyPassword } from "../../security/password";
import { newTotpSecret, otpauthUrl } from "../../security/totp";
import { getSetting } from "../../settings";
import { raiseSecurityChange } from "../alerts/security";
import { endUserSessions } from "./end-sessions";

export const security = implement(auth.security, (_input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const userId = ctx.principal.user.id;
  const user = ctx.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
  const totp = confirmedTotp(ctx.db, userId);
  const github = ctx.db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)).get();
  return {
    passwordSet: Boolean(user?.passwordHash),
    totp: { enabled: Boolean(totp), confirmedAt: totp?.confirmedAt?.toISOString() ?? null },
    recoveryCodesLeft: totp ? recoveryCodesLeft(ctx.db, userId) : 0,
    passkeys: ctx.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .all()
      .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null })),
    passkeysAvailable: passkeyRp(ctx.db) !== null,
    github: github ? { login: github.login, repoAccess: github.scopes.includes("repo"), linkedAt: github.createdAt.toISOString() } : null,
    githubAvailable: githubAvailable(ctx),
  };
});

/** After a security change: new token for this browser, so a copied cookie stops working. */
function rotateCurrent(ctx: OpContext, sessionId: string): void {
  const { token, key } = rotateSession(ctx.db, sessionId);
  ctx.http?.setSession({ token, key, maxAgeSeconds: sessionLifetimeMs / 1000 });
}

export const changePassword = implement(auth.changePassword, async (input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new OpError("NOT_FOUND", "This account no longer exists.");
  // No password to prove: a first password (a GitHub-only account) needs a fresh sign-in
  // or a re-auth, so a session left open on someone's laptop cannot add one.
  if (!user.passwordHash) requireFreshSignIn(ctx);
  if (user.passwordHash) {
    if (!input.currentPassword) {
      throw new OpError("BAD_REQUEST", "Enter your current password.", { field: "currentPassword" });
    }
    assertNotLocked(ctx.db, userKey(userId, ctx.ip));
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      recordFailure(ctx.db, userKey(userId, ctx.ip));
      throw new OpError("BAD_REQUEST", "The current password is wrong.", { field: "currentPassword" });
    }
  }
  ctx.db
    .update(users)
    .set({ passwordHash: await hashPassword(input.newPassword) })
    .where(eq(users.id, userId))
    .run();
  const revokedSessions = endUserSessions(ctx, userId, sessionId);
  rotateCurrent(ctx, sessionId);
  raiseSecurityChange(ctx, user, user.passwordHash ? "changed the password" : "set a password");
  return { revokedSessions };
});

export const totpEnroll = implement(auth.totpEnroll, (_input, ctx) => {
  // An authenticator app is a new way to pass sign-in: only right after a sign-in or a re-auth.
  const { userId, user } = requireFreshSignIn(ctx);
  if (confirmedTotp(ctx.db, userId)) throw new OpError("CONFLICT", "Two-factor sign-in is already on. Turn it off first.");
  const secret = newTotpSecret();
  const sealed = ctx.secrets.seal(secret, "totp.secret");
  ctx.db
    .insert(totpSecrets)
    .values({ userId, secretSealed: sealed })
    .onConflictDoUpdate({
      target: totpSecrets.userId,
      set: { secretSealed: sealed, confirmedAt: null, lastUsedStep: null, createdAt: new Date() },
    })
    .run();
  const issuer = getSetting(ctx.db, "panelName") || displayName;
  return { secret, otpauthUrl: otpauthUrl(secret, user.email, issuer) };
});

export const totpConfirm = implement(auth.totpConfirm, (input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  const row = ctx.db.select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (!row) throw new OpError("BAD_REQUEST", "Start setting up the authenticator app first.");
  if (row.confirmedAt) throw new OpError("CONFLICT", "Two-factor sign-in is already on.");
  if (!checkTotpCode(ctx.db, ctx.secrets, userId, input.code, new Date(), false)) {
    throw new OpError("BAD_REQUEST", "That code is wrong. Check the time on your phone and try again.", { field: "code" });
  }
  ctx.db.update(totpSecrets).set({ confirmedAt: new Date() }).where(eq(totpSecrets.userId, userId)).run();
  const recoveryCodes = issueRecoveryCodes(ctx.db, ctx.secrets, userId);
  // Sessions signed in with only a password should not outlive turning 2FA on.
  endUserSessions(ctx, userId, sessionId);
  rotateCurrent(ctx, sessionId);
  return { recoveryCodes };
});

export const totpDisable = implement(auth.totpDisable, (input, ctx) => {
  const { userId, sessionId, user } = requireSession(ctx);
  if (!confirmedTotp(ctx.db, userId)) throw new OpError("CONFLICT", "Two-factor sign-in is not on.");
  assertNotLocked(ctx.db, userKey(userId, ctx.ip));
  if (!checkAnySecondFactor(ctx.db, ctx.secrets, userId, input.code)) {
    recordFailure(ctx.db, userKey(userId, ctx.ip));
    throw new OpError("BAD_REQUEST", "That code is wrong.", { field: "code" });
  }
  removeSecondFactor(ctx.db, userId);
  rotateCurrent(ctx, sessionId);
  raiseSecurityChange(ctx, user, "turned off two-factor sign-in");
  return {};
});

export const regenerateRecoveryCodes = implement(auth.regenerateRecoveryCodes, (input, ctx) => {
  const { userId } = requireSession(ctx);
  if (!confirmedTotp(ctx.db, userId)) throw new OpError("CONFLICT", "Two-factor sign-in is not on.");
  assertNotLocked(ctx.db, userKey(userId, ctx.ip));
  if (!checkTotpCode(ctx.db, ctx.secrets, userId, input.code)) {
    recordFailure(ctx.db, userKey(userId, ctx.ip));
    throw new OpError("BAD_REQUEST", "That code is wrong.", { field: "code" });
  }
  return { recoveryCodes: issueRecoveryCodes(ctx.db, ctx.secrets, userId) };
});
