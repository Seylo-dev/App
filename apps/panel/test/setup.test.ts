// First run: the installer's setup token file, owner creation with a
// password or with GitHub, and burning the link.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth, setup } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { issueSetupToken, prepareSetupLink, setupTokenPath } from "../src/auth/setup-token";
import { githubAccounts, users } from "../src/db/schema";
import { silentLogger } from "../src/logger";
import { getSetting } from "../src/settings";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, mockGithub, noLimits, ok, waitForPoll } from "./people-helpers";

let panel: TestPanel;
let dataDir: string;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
  dataDir = mkdtempSync(join(tmpdir(), "seylo-setup-"));
  // Owner creation removes the token file from the data dir.
  (panel.deps.config as { dataDir: string }).dataDir = dataDir;
});
afterEach(() => {
  panel.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the panel imports the installer's token, or writes a fresh one", () => {
  const path = setupTokenPath(dataDir);
  writeFileSync(path, "seylo_setup_from-installer\n");
  prepareSetupLink(panel.deps.db, dataDir, silentLogger());
  expect(readFileSync(path, "utf8").trim()).toBe("seylo_setup_from-installer");

  // Expired: a new token replaces it in the file.
  prepareSetupLink(panel.deps.db, dataDir, silentLogger(), new Date(Date.now() + 2 * 3600_000));
  const fresh = readFileSync(path, "utf8").trim();
  expect(fresh).not.toBe("seylo_setup_from-installer");
  expect(fresh).toStartWith("seylo_setup_");

  rmSync(path);
  prepareSetupLink(panel.deps.db, dataDir, silentLogger());
  expect(existsSync(path)).toBe(true);
});

test("status reports the link, and createOwner burns it and signs in", async () => {
  const { token } = issueSetupToken(panel.deps.db);
  writeFileSync(setupTokenPath(dataDir), `${token}\n`);

  const before = await ok(panel, setup.status, { token });
  expect(before.body).toMatchObject({ ownerExists: false, completed: false, link: { valid: true }, githubAvailable: false });
  expect((await ok(panel, setup.status, { token: "wrong" })).body.link).toEqual({ valid: false, expiresAt: null });
  expect((await ok(panel, setup.status, {})).body.link).toBeNull();

  const short = await call(panel, setup.createOwner, { token, email: "o@example.com", password: "short" });
  expect(short.status).toBe(400);

  const created = await ok(panel, setup.createOwner, {
    token,
    email: "Owner@Example.com",
    name: "Owner",
    password: "a long enough password",
  });
  expect(created.body.viewer).toMatchObject({ email: "owner@example.com", role: "owner", name: "Owner" });
  const cookie = cookieFrom(created.headers) as string;
  expect((await ok(panel, auth.whoami, {}, { cookie })).body.viewer.role).toBe("owner");
  expect(existsSync(setupTokenPath(dataDir))).toBe(false);

  // The link is used up, and a second owner cannot be made with any link.
  expect((await call(panel, setup.createOwner, { token, email: "x@example.com", password: "a long enough password" })).status).toBe(409);
  const another = issueSetupToken(panel.deps.db).token;
  expect(
    (await call(panel, setup.createOwner, { token: another, email: "x@example.com", password: "a long enough password" })).status,
  ).toBe(409);
  expect((await ok(panel, setup.status, { token: another })).body).toMatchObject({ ownerExists: true, link: { valid: false } });

  await ok(panel, setup.finish, { skipped: ["wildcardDomain"] }, { cookie });
  expect(getSetting(panel.deps.db, "setupCompletedAt")).toBeString();
  expect((await ok(panel, setup.status, {})).body.completed).toBe(true);
});

test("expired links cannot create the owner", async () => {
  const { token } = issueSetupToken(panel.deps.db, new Date(Date.now() - 2 * 3600_000));
  const result = await call(panel, setup.createOwner, { token, email: "o@example.com", password: "a long enough password" });
  expect(result.status).toBe(403);
});

test("setup.finish needs an owner or admin", async () => {
  const { cookie } = await createUser(panel, "member");
  expect((await call(panel, setup.finish, { skipped: [] }, { cookie })).status).toBe(403);
});

test("GitHub owner sign-up: pending, then done creates the owner from the verified email", async () => {
  const github = mockGithub(panel, {
    pollAnswers: [{ error: "authorization_pending" }, { access_token: "gho_owner", scope: "read:user,user:email,repo" }],
  });
  const { token } = issueSetupToken(panel.deps.db);
  expect((await ok(panel, setup.status, {})).body.githubAvailable).toBe(true);

  const start = await ok(panel, setup.githubStart, { token, repoAccess: true });
  expect(start.body).toMatchObject({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", intervalSeconds: 1 });
  expect(JSON.stringify(start.body)).not.toContain("device-code-secret");
  expect(github.requests[0]?.body).toContain("scope=read%3Auser+user%3Aemail+repo");
  expect(github.requests[0]?.body).toContain("client_id=Iv1.testclient");

  // Too fast: answered without asking GitHub.
  const early = await ok(panel, setup.githubPoll, { token, ticket: start.body.ticket });
  expect(early.body.status).toBe("slowDown");
  await waitForPoll();
  expect((await ok(panel, setup.githubPoll, { token, ticket: start.body.ticket })).body.status).toBe("pending");
  await waitForPoll();
  const done = await ok(panel, setup.githubPoll, { token, ticket: start.body.ticket });
  expect(done.body).toMatchObject({ status: "done", viewer: { email: "octo@example.com", name: "Octo Cat", role: "owner" } });
  expect(cookieFrom(done.headers)).toBeString();

  const owner = panel.deps.db.select().from(users).where(eq(users.email, "octo@example.com")).get();
  expect(owner?.passwordHash).toBeNull();
  const link = panel.deps.db.select().from(githubAccounts).get();
  expect(link).toMatchObject({ login: "octo", githubUserId: 4242, scopes: ["read:user", "user:email", "repo"] });
  expect(link?.accessTokenSealed).not.toContain("gho_owner");
  expect(panel.deps.secrets.open(link?.accessTokenSealed as string, "github.account")).toBe("gho_owner");
  expect((await call(panel, setup.githubPoll, { token, ticket: start.body.ticket })).status).toBe(409);
});

test("GitHub owner sign-up refuses an account without a verified email", async () => {
  mockGithub(panel, { emails: [{ email: "x@example.com", primary: true, verified: false }] });
  const { token } = issueSetupToken(panel.deps.db);
  const start = await ok(panel, setup.githubStart, { token, repoAccess: false });
  await waitForPoll();
  const result = await call(panel, setup.githubPoll, { token, ticket: start.body.ticket });
  expect(result.status).toBe(400);
  expect(panel.deps.db.select().from(users).all()).toHaveLength(0);
});

test("GitHub is unavailable while the client id is a placeholder", async () => {
  const { token } = issueSetupToken(panel.deps.db);
  const result = await call(panel, setup.githubStart, { token, repoAccess: false });
  expect(result.status).toBe(503);
});
