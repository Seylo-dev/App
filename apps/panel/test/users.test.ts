// People management and its role rules.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { apiKeys, grants, users } from "../src/db/schema";
import { createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

test("list sorts owners first, filters, and counts grants", async () => {
  const owner = await createUser(panel, "owner", "zed@example.com");
  await createUser(panel, "admin", "amy@example.com");
  const member = await createUser(panel, "member", "bob@example.com");
  const project = seedProject(panel);
  grant(panel, member.user.id, "project", project.id, ["services.view"]);

  const all = await ok(panel, userOps.list, {}, { cookie: owner.cookie });
  expect(all.body.users.map((u: { email: string }) => u.email)).toEqual(["zed@example.com", "amy@example.com", "bob@example.com"]);
  expect(all.body.users[2]).toMatchObject({ role: "member", status: "active", grantCount: 1, twoFactor: false, githubLogin: null });
  expect((await ok(panel, userOps.list, { q: "AMY" }, { cookie: owner.cookie })).body.users).toHaveLength(1);
  expect((await ok(panel, userOps.list, { role: "member" }, { cookie: owner.cookie })).body.users).toHaveLength(1);
  // LIKE wildcards in q are literal.
  expect((await ok(panel, userOps.list, { q: "%" }, { cookie: owner.cookie })).body.users).toHaveLength(0);

  const got = await ok(panel, userOps.get, { userId: member.user.id }, { cookie: owner.cookie });
  expect(got.body.grants[0]).toMatchObject({ scopeType: "project", scopeId: project.id, scopeName: project.name, projectId: project.id });
});

test("role rules: only owners touch owners, nobody changes their own role, the last owner stays", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  const member = await createUser(panel, "member");

  expect((await call(panel, userOps.updateRole, { userId: owner.user.id, role: "member" }, { cookie: admin.cookie })).status).toBe(403);
  expect((await call(panel, userOps.updateRole, { userId: member.user.id, role: "owner" }, { cookie: admin.cookie })).status).toBe(403);
  expect((await call(panel, userOps.updateRole, { userId: admin.user.id, role: "member" }, { cookie: admin.cookie })).status).toBe(403);
  expect((await ok(panel, userOps.updateRole, { userId: member.user.id, role: "admin" }, { cookie: admin.cookie })).body.role).toBe(
    "admin",
  );

  // The last active owner can be neither demoted nor disabled, even by another owner-to-be.
  expect((await ok(panel, userOps.updateRole, { userId: member.user.id, role: "owner" }, { cookie: owner.cookie })).body.role).toBe(
    "owner",
  );
  expect((await ok(panel, userOps.updateRole, { userId: owner.user.id, role: "admin" }, { cookie: member.cookie })).body.role).toBe(
    "admin",
  );
  const lastOwnerDemote = await call(panel, userOps.disable, { userId: member.user.id }, { cookie: admin.cookie });
  expect(lastOwnerDemote.status).toBe(403);
});

test("the last active owner cannot be demoted", async () => {
  const a = await createUser(panel, "owner");
  const b = await createUser(panel, "owner");
  await ok(panel, userOps.disable, { userId: b.user.id }, { cookie: a.cookie });
  // b is disabled, so a is the last active owner; c (another owner) cannot demote a.
  const c = await createUser(panel, "owner");
  await ok(panel, userOps.updateRole, { userId: c.user.id, role: "admin" }, { cookie: a.cookie });
  const d = await createUser(panel, "owner");
  await ok(panel, userOps.disable, { userId: d.user.id }, { cookie: a.cookie });
  expect((await call(panel, userOps.updateRole, { userId: a.user.id, role: "admin" }, { cookie: a.cookie })).status).toBe(403);
});

test("disable ends sessions and revokes keys; enable lets them sign in again", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  createApiKey(panel, member.user.id);
  const disabled = await ok(panel, userOps.disable, { userId: member.user.id }, { cookie: owner.cookie });
  expect(disabled.body.status).toBe("disabled");
  expect((await call(panel, auth.whoami, {}, { cookie: member.cookie })).status).toBe(401);
  expect(panel.deps.db.select().from(apiKeys).where(eq(apiKeys.userId, member.user.id)).get()?.revokedAt).not.toBeNull();
  expect((await call(panel, auth.login, { email: member.user.email, password: member.password })).status).toBe(401);

  await ok(panel, userOps.enable, { userId: member.user.id }, { cookie: owner.cookie });
  expect((await call(panel, auth.login, { email: member.user.email, password: member.password })).status).toBe(200);
});

test("update changes name and email, refusing taken emails", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const other = await createUser(panel, "member");
  const updated = await ok(
    panel,
    userOps.update,
    { userId: member.user.id, name: "New", email: "NEW@example.com" },
    { cookie: owner.cookie },
  );
  expect(updated.body).toMatchObject({ name: "New", email: "new@example.com" });
  expect((await call(panel, userOps.update, { userId: member.user.id, email: other.user.email }, { cookie: owner.cookie })).status).toBe(
    409,
  );
});

test("remove needs the email typed back and takes grants with it", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "project", seedProject(panel).id, ["*"]);
  expect((await call(panel, userOps.remove, { userId: member.user.id, confirmEmail: "nope" }, { cookie: owner.cookie })).status).toBe(400);
  expect(
    (await call(panel, userOps.remove, { userId: owner.user.id, confirmEmail: owner.user.email }, { cookie: owner.cookie })).status,
  ).toBe(403);
  await ok(panel, userOps.remove, { userId: member.user.id, confirmEmail: member.user.email.toUpperCase() }, { cookie: owner.cookie });
  expect(panel.deps.db.select().from(users).where(eq(users.id, member.user.id)).get()).toBeUndefined();
  expect(panel.deps.db.select().from(grants).all()).toHaveLength(0);
});
