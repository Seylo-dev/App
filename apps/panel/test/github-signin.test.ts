// GitHub device flow after setup: linking a login, signing in with it,
// denials, slow_down, and logins that belong to someone else.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { githubAccounts, totpSecrets, users } from "../src/db/schema";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, mockGithub, noLimits, ok, waitForPoll } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

async function link(cookie: string, repoAccess = false) {
  const start = await ok(panel, auth.githubLinkStart, { repoAccess }, { cookie });
  await waitForPoll();
  return ok(panel, auth.githubLinkPoll, { ticket: start.body.ticket }, { cookie });
}

test("link, then sign in with GitHub; unlinking needs another way in", async () => {
  const github = mockGithub(panel, {
    pollAnswers: [{ access_token: "gho_link", scope: "read:user,user:email,repo" }],
  });
  const { user, cookie } = await createUser(panel, "admin");
  const linked = await link(cookie, true);
  expect(linked.body).toMatchObject({ status: "done", login: "octo" });
  const security = await ok(panel, auth.security, {}, { cookie });
  expect(security.body.github).toMatchObject({ login: "octo", repoAccess: true });

  // Sign-in asks for fewer scopes; the broader stored token is kept.
  github.pollAnswers = [{ access_token: "gho_signin", scope: "read:user,user:email" }];
  const start = await ok(panel, auth.githubStart, {});
  await waitForPoll();
  const done = await ok(panel, auth.githubPoll, { ticket: start.body.ticket });
  expect(done.body.status).toBe("done");
  expect(done.body.result).toMatchObject({ status: "signedIn", viewer: { id: user.id } });
  expect(cookieFrom(done.headers)).toBeString();
  const account = panel.deps.db.select().from(githubAccounts).where(eq(githubAccounts.userId, user.id)).get();
  expect(panel.deps.secrets.open(account?.accessTokenSealed as string, "github.account")).toBe("gho_link");

  // createUser gave a password, so unlinking is fine.
  await ok(panel, auth.githubUnlink, {}, { cookie });
  expect((await ok(panel, auth.security, {}, { cookie })).body.github).toBeNull();
});

test("GitHub sign-in for a login nobody linked answers noAccount", async () => {
  mockGithub(panel);
  const start = await ok(panel, auth.githubStart, {});
  await waitForPoll();
  expect((await ok(panel, auth.githubPoll, { ticket: start.body.ticket })).body.status).toBe("noAccount");
  // The ticket is gone after a final answer.
  expect((await call(panel, auth.githubPoll, { ticket: start.body.ticket })).status).toBe(400);
});

test("GitHub sign-in respects 2FA", async () => {
  mockGithub(panel);
  const { user, cookie } = await createUser(panel, "member");
  await link(cookie);
  panel.deps.db
    .insert(totpSecrets)
    .values({ userId: user.id, secretSealed: panel.deps.secrets.seal("JBSWY3DPEHPK3PXP", "totp.secret"), confirmedAt: new Date() })
    .run();
  const start = await ok(panel, auth.githubStart, {});
  await waitForPoll();
  const done = await ok(panel, auth.githubPoll, { ticket: start.body.ticket });
  expect(done.body.result.status).toBe("secondFactor");
  expect(cookieFrom(done.headers)).toBeUndefined();
});

test("denied and slow_down answers", async () => {
  const github = mockGithub(panel, { pollAnswers: [{ error: "slow_down", interval: 7 }, { error: "access_denied" }] });
  const start = await ok(panel, auth.githubStart, {});
  await waitForPoll();
  const slow = await ok(panel, auth.githubPoll, { ticket: start.body.ticket });
  expect(slow.body).toEqual({ status: "slowDown", intervalSeconds: 7 });
  // The next poll is held back by the new interval without asking GitHub.
  const calls = github.requests.length;
  expect((await ok(panel, auth.githubPoll, { ticket: start.body.ticket })).body.status).toBe("slowDown");
  expect(github.requests.length).toBe(calls);
});

test("a GitHub login linked to someone else cannot be linked again", async () => {
  mockGithub(panel);
  const first = await createUser(panel, "member");
  await link(first.cookie);
  const second = await createUser(panel, "member");
  const start = await ok(panel, auth.githubLinkStart, { repoAccess: false }, { cookie: second.cookie });
  await waitForPoll();
  const result = await call(panel, auth.githubLinkPoll, { ticket: start.body.ticket }, { cookie: second.cookie });
  expect(result.status).toBe(409);
});

test("someone else's link ticket is useless", async () => {
  mockGithub(panel);
  const a = await createUser(panel, "member");
  const b = await createUser(panel, "member");
  const start = await ok(panel, auth.githubLinkStart, { repoAccess: false }, { cookie: a.cookie });
  await waitForPoll();
  expect((await call(panel, auth.githubLinkPoll, { ticket: start.body.ticket }, { cookie: b.cookie })).status).toBe(400);
});

test("unlinking the only way to sign in is refused", async () => {
  mockGithub(panel);
  const { user, cookie } = await createUser(panel, "member");
  await link(cookie);
  panel.deps.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id)).run();
  expect((await call(panel, auth.githubUnlink, {}, { cookie })).status).toBe(409);
});
