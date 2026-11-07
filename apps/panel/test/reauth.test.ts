// Re-auth: ops that add a way into an account need a sign-in or a re-auth
// from the last 15 minutes. A session left open gets FORBIDDEN with reason
// "reauth" until auth.reauth confirms it with the password, a code or a
// passkey; API keys keep the plain session-only refusal.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  auth,
  cliLogin,
  grants as grantOps,
  invites as inviteOps,
  apiKeys as keyOps,
  nodes as nodeOps,
  sessionCookie,
  users as userOps,
} from "@seylo/ops";
import { eq } from "drizzle-orm";
import { freshSignInMs } from "../src/auth/fresh";
import { issueRecoveryCodes } from "../src/auth/second-factor";
import { createSession } from "../src/auth/sessions";
import { sessions, totpSecrets, users } from "../src/db/schema";
import { base32Decode, hotp, totpStep } from "../src/security/totp";
import { setSetting } from "../src/settings";
import { createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, mockGithub, noLimits, ok, seedProject, seedService, VirtualAuthenticator } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

const totpSecret = "JBSWY3DPEHPK3PXP";

/** Makes every session of the user look signed in (and re-authed, if at all) `ms` ago. */
function age(userId: string, ms: number) {
  const at = new Date(Date.now() - ms);
  panel.deps.db.update(sessions).set({ createdAt: at, reauthAt: null }).where(eq(sessions.userId, userId)).run();
}

function enableTotp(userId: string) {
  panel.deps.db
    .insert(totpSecrets)
    .values({ userId, secretSealed: panel.deps.secrets.seal(totpSecret, "totp.secret"), confirmedAt: new Date() })
    .run();
}

const currentCode = () => hotp(base32Decode(totpSecret), totpStep(new Date()));

async function startCliLogin() {
  return (await ok(panel, cliLogin.start, { clientName: "laptop (linux/amd64)" })).body;
}

test("every op that adds a way in refuses a stale session with reason reauth, and works again after auth.reauth", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.test");
  mockGithub(panel);
  const { user, password, cookie } = await createUser(panel, "owner");
  age(user.id, 60 * 60 * 1000);

  const cli = await startCliLogin();
  const attempts = {
    passkeyRegisterBegin: () => call(panel, auth.passkeyRegisterBegin, {}, { cookie }),
    githubLinkStart: () => call(panel, auth.githubLinkStart, { repoAccess: false }, { cookie }),
    totpEnroll: () => call(panel, auth.totpEnroll, {}, { cookie }),
    apiKeysCreate: () => call(panel, keyOps.create, { kind: "api", name: "ci", actions: ["*"] }, { cookie }),
    cliLoginApprove: () => call(panel, cliLogin.approve, { userCode: cli.userCode, readOnly: true }, { cookie }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    const res = await attempt();
    expect({ name, status: res.status, reason: res.body.error?.details?.reason }).toEqual({ name, status: 403, reason: "reauth" });
  }
  // Nothing was created by the refused calls.
  expect((await ok(panel, keyOps.list, {}, { cookie })).body.keys).toHaveLength(0);

  const confirmed = await ok(panel, auth.reauth, { password }, { cookie });
  const until = Date.parse(confirmed.body.freshUntil);
  expect(until - Date.now()).toBeGreaterThan(freshSignInMs - 5_000);
  expect(until - Date.now()).toBeLessThanOrEqual(freshSignInMs);

  for (const [name, attempt] of Object.entries(attempts)) {
    const res = await attempt();
    expect({ name, status: res.status }).toEqual({ name, status: 200 });
  }
});

test("a fresh sign-in needs no re-auth, and the window closes after 15 minutes", async () => {
  const { user, password, cookie } = await createUser(panel, "member");
  expect((await call(panel, auth.totpEnroll, {}, { cookie })).status).toBe(200);
  age(user.id, freshSignInMs + 1_000);
  expect((await call(panel, auth.totpEnroll, {}, { cookie })).status).toBe(403);
  await ok(panel, auth.reauth, { password }, { cookie });
  expect((await call(panel, auth.totpEnroll, {}, { cookie })).status).toBe(200);
  // A re-auth from 16 minutes ago is stale again.
  panel.deps.db
    .update(sessions)
    .set({ reauthAt: new Date(Date.now() - freshSignInMs - 60_000) })
    .where(eq(sessions.userId, user.id))
    .run();
  expect((await call(panel, auth.totpEnroll, {}, { cookie })).body.error.details.reason).toBe("reauth");
});

test("a re-auth counts for its own session only", async () => {
  const first = await createUser(panel, "member");
  const other = `${sessionCookie}=${createSession(panel.deps.db, first.user.id, { ip: null, userAgent: null }).token}`;
  age(first.user.id, 60 * 60 * 1000);
  await ok(panel, auth.reauth, { password: first.password }, { cookie: first.cookie });
  expect((await call(panel, auth.totpEnroll, {}, { cookie: first.cookie })).status).toBe(200);
  expect((await call(panel, auth.totpEnroll, {}, { cookie: other })).status).toBe(403);
});

test("wrong answers name the field and lock the account for this address after five", async () => {
  const { user, cookie } = await createUser(panel, "member");
  age(user.id, 60 * 60 * 1000);
  const wrong = await call(panel, auth.reauth, { password: "not the password" }, { cookie });
  expect(wrong.status).toBe(400);
  expect(wrong.body.error.details.field).toBe("password");
  // No authenticator app: a code is simply wrong.
  const code = await call(panel, auth.reauth, { code: "123456" }, { cookie });
  expect(code.status).toBe(400);
  expect(code.body.error.details.field).toBe("code");
  for (let i = 0; i < 3; i++) await call(panel, auth.reauth, { password: "still wrong" }, { cookie });
  expect((await call(panel, auth.reauth, { password: "correct horse battery" }, { cookie })).status).toBe(429);
  expect((await call(panel, auth.totpEnroll, {}, { cookie })).status).toBe(403);
});

test("exactly one proof is needed", async () => {
  const { password, cookie } = await createUser(panel, "member");
  expect((await call(panel, auth.reauth, {}, { cookie })).status).toBe(400);
  expect((await call(panel, auth.reauth, { password, code: "123456" }, { cookie })).status).toBe(400);
});

test("an account without a password confirms with its authenticator or a recovery code", async () => {
  const created = await createUser(panel, "member");
  const { user } = created;
  let { cookie } = created;
  panel.deps.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id)).run();
  enableTotp(user.id);
  age(user.id, 60 * 60 * 1000);
  // A password is never right for an account without one.
  expect((await call(panel, auth.reauth, { password: "anything at all" }, { cookie })).body.error.details.field).toBe("password");
  // A first password needs a fresh session too.
  expect((await call(panel, auth.changePassword, { newPassword: "a brand new password" }, { cookie })).body.error.details.reason).toBe(
    "reauth",
  );
  await ok(panel, auth.reauth, { code: currentCode() }, { cookie });
  const changed = await call(panel, auth.changePassword, { newPassword: "a brand new password" }, { cookie });
  expect(changed.status).toBe(200);
  // The password change gave this browser a new session token.
  cookie = cookieFrom(changed.headers) as string;

  const [recovery] = issueRecoveryCodes(panel.deps.db, panel.deps.secrets, user.id);
  age(user.id, 60 * 60 * 1000);
  await ok(panel, auth.reauth, { code: recovery as string }, { cookie });
  // The recovery code is used up.
  age(user.id, 60 * 60 * 1000);
  expect((await call(panel, auth.reauth, { code: recovery as string }, { cookie })).status).toBe(400);
});

test("confirm with a passkey of your own, never someone else's", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.test");
  const owner = await createUser(panel, "owner");
  const device = new VirtualAuthenticator("panel.test", "https://panel.test");
  const begin = await ok(panel, auth.passkeyRegisterBegin, {}, { cookie: owner.cookie });
  await ok(
    panel,
    auth.passkeyRegisterFinish,
    { ticket: begin.body.ticket, name: "Laptop", response: device.register(begin.body.options) },
    { cookie: owner.cookie },
  );
  age(owner.user.id, 60 * 60 * 1000);

  const challenge = await ok(panel, auth.reauthPasskeyBegin, {}, { cookie: owner.cookie });
  const allowed = challenge.body.options.allowCredentials as { id: string }[];
  expect(allowed.map((c) => c.id)).toEqual([Buffer.from(device.credentialId).toString("base64url")]);
  await ok(
    panel,
    auth.reauth,
    { passkey: { ticket: challenge.body.ticket, response: device.assert(challenge.body.options) } },
    { cookie: owner.cookie },
  );
  expect((await call(panel, keyOps.create, { kind: "api", name: "after passkey", actions: ["*"] }, { cookie: owner.cookie })).status).toBe(
    200,
  );

  // Another person cannot use the owner's ticket, nor the owner's passkey on their own ticket.
  const member = await createUser(panel, "member");
  age(member.user.id, 60 * 60 * 1000);
  expect((await call(panel, auth.reauthPasskeyBegin, {}, { cookie: member.cookie })).status).toBe(409);
  const ownerTicket = await ok(panel, auth.reauthPasskeyBegin, {}, { cookie: owner.cookie });
  const stolen = await call(
    panel,
    auth.reauth,
    { passkey: { ticket: ownerTicket.body.ticket, response: device.assert(ownerTicket.body.options) } },
    { cookie: member.cookie },
  );
  expect(stolen.status).toBe(400);
  expect(stolen.body.error.details.field).toBe("passkey");
  expect((await call(panel, keyOps.create, { kind: "api", name: "nope", actions: ["*"] }, { cookie: member.cookie })).status).toBe(403);
});

test("API keys get the session-only refusal, not a re-auth prompt", async () => {
  const { user } = await createUser(panel, "owner");
  const bearer = createApiKey(panel, user.id);
  for (const res of [
    await call(panel, keyOps.create, { kind: "api", name: "from a key", actions: ["*"] }, { bearer }),
    await call(panel, auth.reauth, { password: "correct horse battery" }, { bearer }),
  ]) {
    expect(res.status).toBe(403);
    expect(res.body.error.details?.reason).toBeUndefined();
  }
});

test("cliLogin.approve without expiresInDays gives a 7-day key, like the approval page", async () => {
  const { cookie } = await createUser(panel, "owner");
  const cli = await startCliLogin();
  expect((await ok(panel, cliLogin.approve, { userCode: cli.userCode, readOnly: true }, { cookie })).body.expiresInDays).toBe(7);
  const polled = await ok(panel, cliLogin.poll, { deviceCode: cli.deviceCode });
  const days = (Date.parse(polled.body.key?.expiresAt as string) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);
});

test("ops that hand out lasting access need a fresh session; demotions, narrowing a grant and API keys do not", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const admin = await createUser(panel, "admin");
  const grantee = await createUser(panel, "member");
  const project = seedProject(panel);
  const service = seedService(panel, project.id);
  grant(panel, grantee.user.id, "project", project.id, ["services.view", "services.logs"]);
  age(owner.user.id, 60 * 60 * 1000);
  const { cookie } = owner;

  const guarded = {
    adminInvite: () => call(panel, inviteOps.create, { email: "new-admin@example.com", role: "admin", sendEmail: false }, { cookie }),
    memberInvite: () =>
      call(
        panel,
        inviteOps.create,
        {
          email: "guest@example.com",
          role: "member",
          grants: [{ scopeType: "project", scopeId: project.id, actions: ["*"] }],
          sendEmail: false,
        },
        { cookie },
      ),
    promoteToAdmin: () => call(panel, userOps.updateRole, { userId: member.user.id, role: "admin" }, { cookie }),
    joinToken: () => call(panel, nodeOps.createJoinToken, {}, { cookie }),
    widenGrant: () => call(panel, grantOps.setOnProject, { projectId: project.id, userId: grantee.user.id, actions: ["*"] }, { cookie }),
    newServiceGrant: () =>
      call(panel, grantOps.setOnService, { serviceId: service.id, userId: grantee.user.id, actions: ["services.view"] }, { cookie }),
  };
  for (const [name, attempt] of Object.entries(guarded)) {
    const res = await attempt();
    expect({ name, status: res.status, reason: res.body.error?.details?.reason }).toEqual({ name, status: 403, reason: "reauth" });
  }
  // Nothing was created or changed by the refused calls.
  expect((await ok(panel, inviteOps.list, {}, { cookie })).body.invites).toHaveLength(0);
  expect((await ok(panel, userOps.get, { userId: member.user.id }, { cookie })).body.user.role).toBe("member");
  expect((await ok(panel, nodeOps.listJoinTokens, {}, { cookie })).body.tokens).toHaveLength(0);
  const grantsNow = (await ok(panel, grantOps.listByUser, { userId: grantee.user.id }, { cookie })).body.grants;
  expect(grantsNow.map((g: { actions: string[] }) => g.actions)).toEqual([["services.view", "services.logs"]]);

  // Taking access away (or keeping it the same) hands out nothing new.
  expect((await call(panel, userOps.updateRole, { userId: admin.user.id, role: "member" }, { cookie })).status).toBe(200);
  const narrow = { projectId: project.id, userId: grantee.user.id, actions: ["services.view"] };
  expect((await call(panel, grantOps.setOnProject, narrow, { cookie })).status).toBe(200);
  expect((await call(panel, grantOps.setOnProject, narrow, { cookie })).status).toBe(200);
  expect((await call(panel, grantOps.removeFromProject, { projectId: project.id, userId: grantee.user.id }, { cookie })).status).toBe(200);

  await ok(panel, auth.reauth, { password: owner.password }, { cookie });
  for (const [name, attempt] of Object.entries(guarded)) {
    const res = await attempt();
    expect({ name, status: res.status }).toEqual({ name, status: 200 });
  }

  // Scripts with an API key run them without a re-auth.
  age(owner.user.id, 60 * 60 * 1000);
  const bearer = createApiKey(panel, owner.user.id);
  const invite = await call(panel, inviteOps.create, { email: "ci-admin@example.com", role: "admin", sendEmail: false }, { bearer });
  expect(invite.status).toBe(200);
  expect((await call(panel, userOps.updateRole, { userId: admin.user.id, role: "admin" }, { bearer })).status).toBe(200);
  expect((await call(panel, nodeOps.createJoinToken, {}, { bearer })).status).toBe(200);
  const viaKey = await call(panel, grantOps.setOnProject, { projectId: project.id, userId: grantee.user.id, actions: ["*"] }, { bearer });
  expect(viaKey.status).toBe(200);
});
