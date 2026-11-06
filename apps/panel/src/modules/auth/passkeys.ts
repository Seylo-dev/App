// Passkeys: adding and removing them on the account, and signing in with
// one. Verification is @simplewebauthn/server; the WebAuthn challenge
// rides in an auth_challenges row so the browser only holds a ticket.

import { auth, OpError } from "@seylo/ops";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { type Challenge, createChallenge, deleteChallenge, failChallenge, findChallenge } from "../../auth/challenges";
import { requireFreshSignIn } from "../../auth/fresh";
import { type PasskeyRp, passkeyCeremonyTtlMs, passkeyRp } from "../../auth/passkeys";
import { finishSignIn, requireSession } from "../../auth/sign-in";
import type { PanelDb } from "../../db/client";
import { passkeys, users } from "../../db/schema";
import { implement } from "../../ops/implement";
import { raiseSecurityChange } from "../alerts/security";

export function requireRp(db: PanelDb): PasskeyRp {
  const rp = passkeyRp(db);
  if (!rp) throw new OpError("UNAVAILABLE", "Passkeys need a panel domain. Set one in Settings > General first.");
  return rp;
}

export const passkeyRegisterBegin = implement(auth.passkeyRegisterBegin, async (_input, ctx) => {
  // A new passkey is a new way in: only right after a sign-in or a re-auth.
  const { userId, user } = requireFreshSignIn(ctx);
  const rp = requireRp(ctx.db);
  const existing = ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userID: new TextEncoder().encode(userId),
    userDisplayName: user.name || user.email,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const { ticket } = createChallenge(ctx.db, {
    purpose: "passkeyRegister",
    userId,
    data: { challenge: options.challenge },
    ttlMs: passkeyCeremonyTtlMs,
  });
  return { ticket, options: options as unknown as Record<string, unknown> };
});

export const passkeyRegisterFinish = implement(auth.passkeyRegisterFinish, async (input, ctx) => {
  const { userId, user } = requireSession(ctx);
  const rp = requireRp(ctx.db);
  const challenge = findChallenge(ctx.db, input.ticket, "passkeyRegister");
  if (!challenge || challenge.userId !== userId) throw new OpError("BAD_REQUEST", "This passkey setup expired. Start again.");
  deleteChallenge(ctx.db, challenge.id);

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: String(challenge.data.challenge),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new OpError("BAD_REQUEST", "The passkey could not be verified. Try again.");
  }
  if (!verification.verified) throw new OpError("BAD_REQUEST", "The passkey could not be verified. Try again.");

  const { credential } = verification.registrationInfo;
  if (ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id)).get()) {
    throw new OpError("CONFLICT", "This passkey is already registered.");
  }
  const row = ctx.db
    .insert(passkeys)
    .values({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      signCount: credential.counter,
      transports: credential.transports ?? [],
      name: input.name.trim(),
    })
    .returning()
    .get();
  raiseSecurityChange(ctx, user, `added the passkey ${row.name}`);
  return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
});

export const passkeyRemove = implement(auth.passkeyRemove, (input, ctx) => {
  const { userId } = requireSession(ctx);
  const removed = ctx.db
    .delete(passkeys)
    .where(and(eq(passkeys.id, input.passkeyId), eq(passkeys.userId, userId)))
    .returning({ id: passkeys.id })
    .all();
  if (removed.length === 0) throw new OpError("NOT_FOUND", "That passkey does not exist.");
  return {};
});

export const passkeyLoginBegin = implement(auth.passkeyLoginBegin, async (_input, ctx) => {
  const rp = requireRp(ctx.db);
  // Discoverable credentials: the browser offers the passkeys it has for
  // this domain, so nobody types an email and nothing reveals accounts.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
  const { ticket } = createChallenge(ctx.db, {
    purpose: "passkeyLogin",
    data: { challenge: options.challenge },
    ttlMs: passkeyCeremonyTtlMs,
  });
  return { ticket, options: options as unknown as Record<string, unknown> };
});

/**
 * Checks a WebAuthn assertion against the challenge and a stored passkey of
 * `userId` (any user when undefined), then bumps its counter. Returns the
 * passkey's owner, or null when anything does not verify (the challenge
 * then counts one failed attempt).
 */
export async function verifyAssertion(
  db: PanelDb,
  rp: PasskeyRp,
  challenge: Challenge,
  response: AuthenticationResponseJSON,
  userId?: string,
): Promise<string | null> {
  const stored =
    typeof response.id === "string" ? db.select().from(passkeys).where(eq(passkeys.credentialId, response.id)).get() : undefined;
  if (!stored || (userId !== undefined && stored.userId !== userId)) {
    failChallenge(db, challenge);
    return null;
  }
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: String(challenge.data.challenge),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.signCount,
        transports: stored.transports as never,
      },
      requireUserVerification: true,
    });
  } catch {
    failChallenge(db, challenge);
    return null;
  }
  if (!verification.verified) {
    failChallenge(db, challenge);
    return null;
  }
  deleteChallenge(db, challenge.id);
  db.update(passkeys)
    .set({ signCount: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(passkeys.id, stored.id))
    .run();
  return stored.userId;
}

export const passkeyLoginFinish = implement(auth.passkeyLoginFinish, async (input, ctx) => {
  const rp = requireRp(ctx.db);
  const failed = () => new OpError("UNAUTHENTICATED", "That passkey did not work. Try again or use your password.");
  const challenge = findChallenge(ctx.db, input.ticket, "passkeyLogin");
  if (!challenge) throw new OpError("UNAUTHENTICATED", "This sign-in expired. Try again.");
  const userId = await verifyAssertion(ctx.db, rp, challenge, input.response as unknown as AuthenticationResponseJSON);
  if (!userId) throw failed();
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.disabledAt) throw failed();
  // A passkey with user verification is already two factors.
  return finishSignIn(ctx, user, { skipSecondFactor: true });
});
