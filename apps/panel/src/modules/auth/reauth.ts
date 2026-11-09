// Re-auth ("confirm it's you"): the signed-in person proves they are at the
// keyboard with their password, an authenticator or recovery code, a
// passkey, or the GitHub login linked to their account (device flow), and
// the session counts as freshly signed in for 15 minutes (auth/fresh.ts).
// Ops that add a way in check that window.

import { auth, OpError } from "@seylo/ops";
import { type AuthenticationResponseJSON, generateAuthenticationOptions } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { createChallenge, deleteChallenge, findChallenge } from "../../auth/challenges";
import { markReauthenticated } from "../../auth/fresh";
import { saveGithubAccount } from "../../auth/github-accounts";
import { githubUser, pollDeviceFlow, startDeviceFlow } from "../../auth/github-device";
import { assertNotLocked, clearFailures, recordFailure, userKey } from "../../auth/lockout";
import { passkeyCeremonyTtlMs } from "../../auth/passkeys";
import { checkAnySecondFactor, confirmedTotp } from "../../auth/second-factor";
import { requireSession } from "../../auth/sign-in";
import { githubAccounts, passkeys, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { verifyPassword } from "../../security/password";
import { checkSecondFactorCode, codeMethod } from "./code-check";
import { requireRp, verifyAssertion } from "./passkeys";

export const reauthPasskeyBegin = implement(auth.reauthPasskeyBegin, async (_input, ctx) => {
  const { userId } = requireSession(ctx);
  const rp = requireRp(ctx.db);
  const own = ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  if (own.length === 0) throw new OpError("CONFLICT", "This account has no passkey. Use your password or authenticator app.");
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
    allowCredentials: own.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
  });
  const { ticket } = createChallenge(ctx.db, {
    purpose: "passkeyReauth",
    userId,
    data: { challenge: options.challenge },
    ttlMs: passkeyCeremonyTtlMs,
  });
  return { ticket, options: options as unknown as Record<string, unknown> };
});

/** A wrong answer: counts toward the account's per-address lock and marks the field. */
function wrong(ctx: OpContext, userId: string, field: "password" | "code" | "passkey" | "github", message: string): OpError {
  recordFailure(ctx.db, userKey(userId, ctx.ip));
  return new OpError("BAD_REQUEST", message, { field });
}

export const reauth = implement(auth.reauth, async (input, ctx) => {
  const { userId, sessionId, user: person } = requireSession(ctx);
  const given = [input.password !== undefined, input.code !== undefined, input.passkey !== undefined].filter(Boolean).length;
  if (given !== 1) throw new OpError("BAD_REQUEST", "Confirm with exactly one of: your password, a code or a passkey.");
  const key = userKey(userId, ctx.ip);
  assertNotLocked(ctx.db, key);

  if (input.password !== undefined) {
    const user = ctx.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
    // An account without a password gets the same answer as a wrong one.
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw wrong(ctx, userId, "password", "The password is wrong.");
    }
  } else if (input.code !== undefined) {
    const code = input.code;
    if (!confirmedTotp(ctx.db, userId)) throw wrong(ctx, userId, "code", "That code is wrong.");
    // Counts toward the lock and the account's code brake itself.
    if (!checkSecondFactorCode(ctx, person, codeMethod(code), () => checkAnySecondFactor(ctx.db, ctx.secrets, userId, code))) {
      throw new OpError("BAD_REQUEST", "That code is wrong.", { field: "code" });
    }
  } else if (input.passkey) {
    const rp = requireRp(ctx.db);
    const challenge = findChallenge(ctx.db, input.passkey.ticket, "passkeyReauth");
    if (!challenge || challenge.userId !== userId) {
      throw new OpError("BAD_REQUEST", "This passkey check expired. Try again.", { field: "passkey" });
    }
    const owner = await verifyAssertion(ctx.db, rp, challenge, input.passkey.response as unknown as AuthenticationResponseJSON, userId);
    if (owner !== userId) throw wrong(ctx, userId, "passkey", "That passkey did not work. Try again.");
  }

  clearFailures(ctx.db, key);
  return { freshUntil: markReauthenticated(ctx.db, sessionId).toISOString() };
});

// GitHub: for people who sign in with GitHub and have no password, code or
// passkey to confirm with. The same device flow as GitHub sign-in, but only
// the GitHub login linked to this account counts.

function linkedGithub(ctx: OpContext, userId: string) {
  return ctx.db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)).get();
}

export const reauthGithubStart = implement(auth.reauthGithubStart, (_input, ctx) => {
  const { userId } = requireSession(ctx);
  assertNotLocked(ctx.db, userKey(userId, ctx.ip));
  if (!linkedGithub(ctx, userId)) {
    throw new OpError("CONFLICT", "This account has no linked GitHub login. Use your password, a code or a passkey.");
  }
  return startDeviceFlow(ctx, "githubReauth", { userId, repoAccess: false });
});

export const reauthGithubPoll = implement(auth.reauthGithubPoll, async (input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  const challenge = findChallenge(ctx.db, input.ticket, "githubReauth");
  if (!challenge || challenge.userId !== userId) {
    throw new OpError("BAD_REQUEST", "This GitHub check expired. Start again.", { field: "github" });
  }
  const key = userKey(userId, ctx.ip);
  assertNotLocked(ctx.db, key);
  const poll = await pollDeviceFlow(ctx, challenge);
  if (poll.status !== "done") return { status: poll.status, intervalSeconds: poll.intervalSeconds };

  deleteChallenge(ctx.db, challenge.id);
  const github = await githubUser(ctx, poll.accessToken);
  ctx.auditDetails?.({ githubLogin: github.login });
  const linked = linkedGithub(ctx, userId);
  if (!linked) throw new OpError("CONFLICT", "This account has no linked GitHub login anymore. Use your password, a code or a passkey.");
  if (linked.githubUserId !== github.id) {
    throw wrong(
      ctx,
      userId,
      "github",
      `GitHub approved this as ${github.login}, but this account is linked to ${linked.login}. Switch to ${linked.login} on GitHub and try again.`,
    );
  }
  // As after a GitHub sign-in: the new token replaces the stored one unless that one has more
  // scopes, so GitHub's cap on tokens per scope never revokes the token the panel keeps.
  saveGithubAccount(ctx.db, ctx.secrets, userId, github, poll.accessToken, poll.scopes, { keepBroaderToken: true });
  clearFailures(ctx.db, key);
  return {
    status: "done" as const,
    intervalSeconds: poll.intervalSeconds,
    freshUntil: markReauthenticated(ctx.db, sessionId).toISOString(),
  };
});
