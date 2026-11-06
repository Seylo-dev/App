// Sign-in flows end to end over HTTP: two-factor enrollment and sign-in,
// recovery codes, the account lock, sessions, password changes and the
// rule that API keys never touch account security.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, apiKeys as keyOps, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { sessions, totpSecrets, users } from "../src/db/schema";
import { base32Decode, hotp, totpStep } from "../src/security/totp";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, noLimits, ok } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

const code = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(new Date()) + offset);

async function signIn(email: string, password: string) {
  const result = await ok(panel, auth.login, { email, password });
  return { body: result.body, cookie: cookieFrom(result.headers) };
}

async function enableTotp(cookie: string) {
  const enroll = await ok(panel, auth.totpEnroll, {}, { cookie });
  const confirm = await ok(panel, auth.totpConfirm, { code: code(enroll.body.secret) }, { cookie });
  return {
    secret: enroll.body.secret as string,
    recoveryCodes: confirm.body.recoveryCodes as string[],
    cookie: cookieFrom(confirm.headers) as string,
  };
}

test("2FA: enroll, confirm, then sign-in asks for a code and a used code fails", async () => {
  const { user, password, cookie } = await createUser(panel, "owner");
  const enroll = await ok(panel, auth.totpEnroll, {}, { cookie });
  expect(enroll.body.otpauthUrl).toStartWith("otpauth://totp/");
  // Not enforced before confirmation.
  expect((await signIn(user.email, password)).body.status).toBe("signedIn");

  const wrong = await call(panel, auth.totpConfirm, { code: "000000" }, { cookie });
  expect(wrong.status).toBe(400);
  const confirm = await ok(panel, auth.totpConfirm, { code: code(enroll.body.secret) }, { cookie });
  expect(confirm.body.recoveryCodes).toHaveLength(10);
  // Turning 2FA on rotates this browser's token: the old cookie is dead.
  const rotated = cookieFrom(confirm.headers) as string;
  expect(rotated).not.toBe(cookie);
  expect((await call(panel, auth.whoami, {}, { cookie })).status).toBe(401);
  expect((await call(panel, auth.whoami, {}, { cookie: rotated })).status).toBe(200);

  const first = await signIn(user.email, password);
  expect(first.body.status).toBe("secondFactor");
  expect(first.cookie).toBeUndefined();
  expect(first.body.challenge.methods).toEqual(["totp", "recovery"]);

  const ticket = first.body.challenge.ticket;
  const bad = await call(panel, auth.verifySecondFactor, { ticket, method: "totp", code: "123456" });
  expect(bad.status).toBe(401);
  expect(bad.body.error.details.attemptsLeft).toBe("4");

  const good = await ok(panel, auth.verifySecondFactor, { ticket, method: "totp", code: code(enroll.body.secret, 1) });
  expect(good.body.viewer.id).toBe(user.id);
  expect(good.body.recoveryCodesLeft).toBe(10);
  const session = cookieFrom(good.headers) as string;
  expect((await ok(panel, auth.whoami, {}, { cookie: session })).body.via).toBe("session");

  // The ticket is single use, and the same code never works twice.
  expect((await call(panel, auth.verifySecondFactor, { ticket, method: "totp", code: code(enroll.body.secret, 1) })).status).toBe(401);
  const second = await signIn(user.email, password);
  const replay = await call(panel, auth.verifySecondFactor, {
    ticket: second.body.challenge.ticket,
    method: "totp",
    code: code(enroll.body.secret, 1),
  });
  expect(replay.status).toBe(401);
});

test("2FA: recovery codes work once, and disabling needs a code", async () => {
  const { user, password, cookie } = await createUser(panel, "admin");
  const { recoveryCodes, cookie: current } = await enableTotp(cookie);
  const [firstCode, secondCode] = recoveryCodes as [string, string];

  const challenge = (await signIn(user.email, password)).body.challenge.ticket;
  const viaRecovery = await ok(panel, auth.verifySecondFactor, { ticket: challenge, method: "recovery", code: firstCode.toUpperCase() });
  expect(viaRecovery.body.recoveryCodesLeft).toBe(9);

  const again = (await signIn(user.email, password)).body.challenge.ticket;
  expect((await call(panel, auth.verifySecondFactor, { ticket: again, method: "recovery", code: firstCode })).status).toBe(401);

  expect((await call(panel, auth.totpDisable, { code: "nope-nopex" }, { cookie: current })).status).toBe(400);
  const security = await ok(panel, auth.security, {}, { cookie: current });
  expect(security.body.totp.enabled).toBe(true);
  expect(security.body.recoveryCodesLeft).toBe(9);

  await ok(panel, auth.totpDisable, { code: secondCode }, { cookie: current });
  expect(panel.deps.db.select().from(totpSecrets).where(eq(totpSecrets.userId, user.id)).get()).toBeUndefined();
  expect((await signIn(user.email, password)).body.status).toBe("signedIn");
});

test("five wrong codes end the challenge; failures lock the account", async () => {
  const { user, password, cookie } = await createUser(panel, "member");
  await enableTotp(cookie);
  const ticket = (await signIn(user.email, password)).body.challenge.ticket;
  for (let i = 0; i < 5; i++) await call(panel, auth.verifySecondFactor, { ticket, method: "totp", code: "000000" });
  // Counted toward the lock too: the next password attempt is refused even when right.
  const locked = await call(panel, auth.login, { email: user.email, password });
  expect(locked.status).toBe(429);
  expect(locked.headers.get("retry-after")).not.toBeNull();
});

test("wrong passwords lock that email from this address; enabling the account unlocks it", async () => {
  const { user, password } = await createUser(panel, "owner");
  const admin = await createUser(panel, "owner");
  for (let i = 0; i < 5; i++) expect((await call(panel, auth.login, { email: user.email, password: "wrong-password" })).status).toBe(401);
  expect((await call(panel, auth.login, { email: user.email, password })).status).toBe(429);
  // An unknown email locks the same way, so the lock says nothing about which emails exist.
  for (let i = 0; i < 5; i++)
    expect((await call(panel, auth.login, { email: "nobody@example.com", password: "x".repeat(12) })).status).toBe(401);
  expect((await call(panel, auth.login, { email: "nobody@example.com", password: "x".repeat(12) })).status).toBe(429);

  await ok(panel, userOps.enable, { userId: user.id }, { cookie: admin.cookie });
  expect((await call(panel, auth.login, { email: user.email, password })).status).toBe(200);
});

test("sessions: list marks the current one, revoke one, revoke the others", async () => {
  const { user, password } = await createUser(panel, "member");
  const a = (await signIn(user.email, password)).cookie as string;
  const b = (await signIn(user.email, password)).cookie as string;
  const c = (await signIn(user.email, password)).cookie as string;
  const listed = await ok(panel, auth.listSessions, {}, { cookie: a });
  // createUser made one session too.
  expect(listed.body.sessions).toHaveLength(4);
  expect(listed.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

  const bId = (await ok(panel, auth.listSessions, {}, { cookie: b })).body.sessions.find((s: { current: boolean }) => s.current).id;
  await ok(panel, auth.revokeSession, { sessionId: bId }, { cookie: a });
  expect((await call(panel, auth.whoami, {}, { cookie: b })).status).toBe(401);

  const revoked = await ok(panel, auth.revokeOtherSessions, {}, { cookie: a });
  expect(revoked.body.revoked).toBe(2);
  expect((await call(panel, auth.whoami, {}, { cookie: c })).status).toBe(401);
  expect((await call(panel, auth.whoami, {}, { cookie: a })).status).toBe(200);

  // Someone else's session id is not yours to end.
  const other = await createUser(panel, "member");
  const otherId = panel.deps.db.select().from(sessions).where(eq(sessions.userId, other.user.id)).get()?.id as string;
  expect((await call(panel, auth.revokeSession, { sessionId: otherId }, { cookie: a })).status).toBe(404);
});

test("sessions older than 90 days end however active they are", async () => {
  const { user, cookie } = await createUser(panel, "member");
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) })
    .where(eq(sessions.userId, user.id))
    .run();
  expect((await call(panel, auth.whoami, {}, { cookie })).status).toBe(401);
});

test("changing the password checks the old one, ends other sessions and rotates this one", async () => {
  const { user, password, cookie } = await createUser(panel, "member");
  const other = (await signIn(user.email, password)).cookie as string;

  expect((await call(panel, auth.changePassword, { newPassword: "a brand new password" }, { cookie })).status).toBe(400);
  expect(
    (await call(panel, auth.changePassword, { currentPassword: "nope", newPassword: "a brand new password" }, { cookie })).status,
  ).toBe(400);
  const changed = await ok(panel, auth.changePassword, { currentPassword: password, newPassword: "a brand new password" }, { cookie });
  expect(changed.body.revokedSessions).toBe(1);
  expect((await call(panel, auth.whoami, {}, { cookie: other })).status).toBe(401);
  expect((await call(panel, auth.whoami, {}, { cookie })).status).toBe(401);
  expect((await call(panel, auth.whoami, {}, { cookie: cookieFrom(changed.headers) })).status).toBe(200);

  expect((await call(panel, auth.login, { email: user.email, password })).status).toBe(401);
  expect((await call(panel, auth.login, { email: user.email, password: "a brand new password" })).status).toBe(200);
});

test("profile and preferences", async () => {
  const { cookie } = await createUser(panel, "member");
  expect((await ok(panel, auth.updateProfile, { name: "  Dana  " }, { cookie })).body.viewer.name).toBe("Dana");
  await ok(panel, auth.updatePreferences, { preferences: { colorMode: "dark", collapsed: ["a"] } }, { cookie });
  const merged = await ok(panel, auth.updatePreferences, { preferences: { colorMode: null, sidebar: true } }, { cookie });
  expect(merged.body.preferences).toEqual({ collapsed: ["a"], sidebar: true });
  expect((await ok(panel, auth.preferences, {}, { cookie })).body.preferences).toEqual({ collapsed: ["a"], sidebar: true });
  const huge = await call(panel, auth.updatePreferences, { preferences: { blob: "x".repeat(20_000) } }, { cookie });
  expect(huge.status).toBe(400);
});

test("API keys cannot change account security or create keys", async () => {
  const { user } = await createUser(panel, "owner");
  const bearer = createApiKey(panel, user.id);
  for (const [op, input] of [
    [auth.changePassword, { newPassword: "another long password" }],
    [auth.totpEnroll, {}],
    [auth.listSessions, {}],
    [auth.passkeyRegisterBegin, {}],
    [auth.githubLinkStart, { repoAccess: false }],
    [auth.updateProfile, { name: "key" }],
    [keyOps.create, { name: "minted", actions: ["*"] }],
  ] as const) {
    const result = await call(panel, op, input as never, { bearer });
    expect(result.status).toBe(403);
  }
  // Reading your own security summary is fine.
  expect((await call(panel, auth.security, {}, { bearer })).status).toBe(200);
});

test("disabled accounts cannot sign in and lose their sessions", async () => {
  const { user, password, cookie } = await createUser(panel, "member");
  panel.deps.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id)).run();
  expect((await call(panel, auth.whoami, {}, { cookie })).status).toBe(401);
  expect((await call(panel, auth.login, { email: user.email, password })).status).toBe(401);
});

test("a GitHub-only account sets a first password only right after signing in", async () => {
  const { user, cookie } = await createUser(panel, "member");
  panel.deps.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id)).run();
  // A session signed in an hour ago (left open somewhere) cannot add a password.
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
    .where(eq(sessions.userId, user.id))
    .run();
  const stale = await call(panel, auth.changePassword, { newPassword: "a brand new password" }, { cookie });
  expect(stale.status).toBe(403);
  expect(stale.body.error.details.reason).toBe("reauth");
  panel.deps.db.update(sessions).set({ createdAt: new Date() }).where(eq(sessions.userId, user.id)).run();
  expect((await call(panel, auth.changePassword, { newPassword: "a brand new password" }, { cookie })).status).toBe(200);
});
