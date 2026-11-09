// Re-auth with GitHub: an account that signs in with GitHub (no password,
// code or passkey) confirms it's you through the device flow, and only the
// GitHub login linked to that account counts. Expired codes, other people's
// tickets and API keys get nothing; the fresh window is the same 15 minutes.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { freshSignInMs } from "../src/auth/fresh";
import { overrideGithubEndpoints } from "../src/auth/github-device";
import { auditLog, authChallenges, githubAccounts, sessions, users } from "../src/db/schema";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, mockGithub, noLimits, ok, waitForPoll } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

/** Makes every session of the user look signed in `ms` ago, with no re-auth since. */
function age(userId: string, ms: number) {
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - ms), reauthAt: null })
    .where(eq(sessions.userId, userId))
    .run();
}

/** A member who signs in only with GitHub: linked to the mock's login, no password, signed in an hour ago. */
async function githubOnlyUser() {
  const { user, cookie } = await createUser(panel, "member");
  const start = await ok(panel, auth.githubLinkStart, { repoAccess: false }, { cookie });
  await waitForPoll();
  expect((await ok(panel, auth.githubLinkPoll, { ticket: start.body.ticket }, { cookie })).body.status).toBe("done");
  panel.deps.db.update(users).set({ passwordHash: null }).where(eq(users.id, user.id)).run();
  age(user.id, 60 * 60 * 1000);
  return { user, cookie };
}

async function startAndWait(cookie: string) {
  const start = await ok(panel, auth.reauthGithubStart, {}, { cookie });
  await waitForPoll();
  return start.body.ticket as string;
}

const enroll = (cookie: string) => call(panel, auth.totpEnroll, {}, { cookie });

test("the linked GitHub login confirms it's you, and the session is fresh for 15 minutes", async () => {
  const github = mockGithub(panel);
  const { user, cookie } = await githubOnlyUser();
  expect((await enroll(cookie)).body.error.details.reason).toBe("reauth");

  const start = await ok(panel, auth.reauthGithubStart, {}, { cookie });
  expect(start.body).toMatchObject({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", intervalSeconds: 1 });
  // Sign-in scopes only: confirming never asks for repo access.
  const asked = new URLSearchParams(github.requests.find((r) => r.url.endsWith("/login/device/code"))?.body ?? "");
  expect(asked.get("scope")).toBe("read:user user:email");

  // Too early: held back without asking GitHub, and still not fresh.
  expect((await ok(panel, auth.reauthGithubPoll, { ticket: start.body.ticket }, { cookie })).body.status).toBe("slowDown");
  expect((await enroll(cookie)).status).toBe(403);

  github.pollAnswers = [{ error: "authorization_pending" }, { access_token: "gho_reauth", scope: "read:user,user:email" }];
  await waitForPoll();
  expect((await ok(panel, auth.reauthGithubPoll, { ticket: start.body.ticket }, { cookie })).body.status).toBe("pending");
  await waitForPoll();
  const done = await ok(panel, auth.reauthGithubPoll, { ticket: start.body.ticket }, { cookie });
  expect(done.body.status).toBe("done");
  const until = Date.parse(done.body.freshUntil as string);
  expect(until - Date.now()).toBeGreaterThan(freshSignInMs - 5_000);
  expect(until - Date.now()).toBeLessThanOrEqual(freshSignInMs);
  const session = panel.deps.db.select().from(sessions).where(eq(sessions.userId, user.id)).get();
  expect(session?.reauthAt?.getTime()).toBe(until - freshSignInMs);
  expect((await enroll(cookie)).status).toBe(200);

  // Single use: the ticket is gone after it confirmed.
  expect((await call(panel, auth.reauthGithubPoll, { ticket: start.body.ticket }, { cookie })).status).toBe(400);
  // The same token rules as a GitHub sign-in: the newer token with the same scopes is kept.
  const account = panel.deps.db.select().from(githubAccounts).where(eq(githubAccounts.userId, user.id)).get();
  expect(panel.deps.secrets.open(account?.accessTokenSealed as string, "github.account")).toBe("gho_reauth");

  // Audited, with the GitHub login that approved it; the ticket never lands in the log.
  const rows = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.opId, "auth.reauthGithubPoll"), eq(auditLog.outcome, "ok")))
    .all();
  expect(rows.at(-1)?.input).toMatchObject({ githubLogin: "octo" });
  expect(JSON.stringify(rows)).not.toContain(start.body.ticket);
  expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "auth.reauthGithubStart")).all()).toHaveLength(1);

  // A confirmation from 16 minutes ago is stale again.
  panel.deps.db
    .update(sessions)
    .set({ reauthAt: new Date(Date.now() - freshSignInMs - 60_000) })
    .where(eq(sessions.userId, user.id))
    .run();
  expect((await enroll(cookie)).body.error.details.reason).toBe("reauth");
});

test("approving as another GitHub login is refused, changes nothing and counts toward the lock", async () => {
  const github = mockGithub(panel);
  const { user, cookie } = await githubOnlyUser();
  github.user = { id: 9001, login: "someone-else", name: null };
  github.pollAnswers = [{ access_token: "gho_other", scope: "read:user,user:email" }];

  const refused = await call(panel, auth.reauthGithubPoll, { ticket: await startAndWait(cookie) }, { cookie });
  expect(refused.status).toBe(400);
  expect(refused.body.error.details.field).toBe("github");
  expect(refused.body.error.message).toContain("someone-else");
  expect(refused.body.error.message).toContain("octo");
  expect((await enroll(cookie)).body.error.details.reason).toBe("reauth");
  expect(panel.deps.db.select().from(sessions).where(eq(sessions.userId, user.id)).get()?.reauthAt).toBeNull();
  // The link and its token stay as they were.
  const account = panel.deps.db.select().from(githubAccounts).where(eq(githubAccounts.userId, user.id)).get();
  expect(account).toMatchObject({ githubUserId: 4242, login: "octo" });
  expect(panel.deps.secrets.open(account?.accessTokenSealed as string, "github.account")).toBe("gho_test");
  // The refusal is in the audit log with the login that tried.
  const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "auth.reauthGithubPoll")).all().at(-1);
  expect(row).toMatchObject({ outcome: "error", errorCode: "BAD_REQUEST", input: { githubLogin: "someone-else" } });

  // Five wrong answers in a row lock this account for this address, GitHub or not.
  for (let i = 0; i < 4; i++) {
    expect((await call(panel, auth.reauthGithubPoll, { ticket: await startAndWait(cookie) }, { cookie })).status).toBe(400);
  }
  expect((await call(panel, auth.reauthGithubStart, {}, { cookie })).status).toBe(429);
  expect((await call(panel, auth.reauth, { password: "correct horse battery" }, { cookie })).status).toBe(429);
}, 20_000);

test("an expired device code confirms nothing", async () => {
  const github = mockGithub(panel);
  const { cookie } = await githubOnlyUser();
  github.pollAnswers = [{ error: "expired_token" }];
  const ticket = await startAndWait(cookie);
  expect((await ok(panel, auth.reauthGithubPoll, { ticket }, { cookie })).body).toEqual({ status: "expired", intervalSeconds: 1 });
  // The ticket died with the code.
  const again = await call(panel, auth.reauthGithubPoll, { ticket }, { cookie });
  expect(again.status).toBe(400);
  expect(again.body.error.message).toBe("This GitHub check expired. Start again.");
  expect((await enroll(cookie)).body.error.details.reason).toBe("reauth");

  // A ticket past its own expiry is refused without asking GitHub, even if GitHub would say yes.
  github.pollAnswers = [{ access_token: "gho_late", scope: "read:user,user:email" }];
  const late = await startAndWait(cookie);
  panel.deps.db
    .update(authChallenges)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(authChallenges.purpose, "githubReauth"))
    .run();
  const asked = github.requests.length;
  expect((await call(panel, auth.reauthGithubPoll, { ticket: late }, { cookie })).status).toBe(400);
  expect(github.requests.length).toBe(asked);
  expect((await enroll(cookie)).status).toBe(403);
});

test("a denied approval confirms nothing", async () => {
  const github = mockGithub(panel);
  const { cookie } = await githubOnlyUser();
  github.pollAnswers = [{ error: "access_denied" }];
  const ticket = await startAndWait(cookie);
  expect((await ok(panel, auth.reauthGithubPoll, { ticket }, { cookie })).body.status).toBe("denied");
  expect((await call(panel, auth.reauthGithubPoll, { ticket }, { cookie })).status).toBe(400);
  expect((await enroll(cookie)).status).toBe(403);
});

test("only for a linked GitHub login, a browser session and the person who started it", async () => {
  mockGithub(panel);
  // No GitHub login linked: nothing to confirm with.
  const plain = await createUser(panel, "member");
  age(plain.user.id, 60 * 60 * 1000);
  const unlinked = await call(panel, auth.reauthGithubStart, {}, { cookie: plain.cookie });
  expect(unlinked.status).toBe(409);
  expect(panel.deps.db.select().from(authChallenges).where(eq(authChallenges.purpose, "githubReauth")).all()).toHaveLength(0);

  // Someone else's ticket is useless, even when GitHub approved it as their own login.
  const { cookie } = await githubOnlyUser();
  const ticket = await startAndWait(cookie);
  const stolen = await call(panel, auth.reauthGithubPoll, { ticket }, { cookie: plain.cookie });
  expect(stolen.status).toBe(400);
  expect((await enroll(plain.cookie)).body.error.details.reason).toBe("reauth");
  // The owner of the ticket can still use it.
  expect((await ok(panel, auth.reauthGithubPoll, { ticket }, { cookie })).body.status).toBe("done");

  // API keys get the session-only refusal, not a re-auth prompt.
  const bearer = createApiKey(panel, plain.user.id);
  for (const res of [
    await call(panel, auth.reauthGithubStart, {}, { bearer }),
    await call(panel, auth.reauthGithubPoll, { ticket }, { bearer }),
  ]) {
    expect(res.status).toBe(403);
    expect(res.body.error.details?.reason).toBeUndefined();
  }
});

test("without GitHub sign-in on the panel, starting answers UNAVAILABLE", async () => {
  mockGithub(panel);
  const { cookie } = await githubOnlyUser();
  overrideGithubEndpoints(panel.deps.db, { clientId: "" });
  const res = await call(panel, auth.reauthGithubStart, {}, { cookie });
  expect(res.body.error.code).toBe("UNAVAILABLE");
  expect((await ok(panel, auth.security, {}, { cookie })).body).toMatchObject({ githubAvailable: false, github: { login: "octo" } });
});
