// API keys and MCP tokens: shown once, hashed, scoped by actions, areas,
// projects, read-only and expiry, and revocable.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, apiKeys as keyOps, projects as projectOps, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { apiKeys } from "../src/db/schema";
import { hashToken } from "../src/security/tokens";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

test("create shows the token once and stores only its hash", async () => {
  const owner = await createUser(panel, "owner");
  const created = await ok(panel, keyOps.create, { name: "ci", actions: ["projects.view"], expiresInDays: 30 }, { cookie: owner.cookie });
  const { token, key } = created.body;
  expect(token).toStartWith("seylo_key_");
  expect(key).toMatchObject({ kind: "api", name: "ci", readOnly: false, projectIds: null, owner: { id: owner.user.id } });
  expect(token.startsWith(key.prefix)).toBe(true);
  expect(key.prefix.length).toBe("seylo_key_".length + 4);
  const row = panel.deps.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get();
  expect(row?.tokenHash).toBe(hashToken(token));
  expect(JSON.stringify(await ok(panel, keyOps.list, {}, { cookie: owner.cookie }))).not.toContain(token);

  expect((await ok(panel, auth.whoami, {}, { bearer: token })).body.via).toBe("apiKey");
  expect((await call(panel, projectOps.list, {}, { bearer: token })).status).toBe(200);
  expect((await call(panel, userOps.list, {}, { bearer: token })).status).toBe(403);
});

test("MCP tokens are read-only by default", async () => {
  const owner = await createUser(panel, "owner");
  const created = await ok(panel, keyOps.create, { kind: "mcp", name: "claude", actions: ["*"] }, { cookie: owner.cookie });
  expect(created.body.token).toStartWith("seylo_mcp_");
  expect(created.body.key.readOnly).toBe(true);
  expect((await call(panel, projectOps.list, {}, { bearer: created.body.token })).status).toBe(200);
  expect((await call(panel, projectOps.create, { name: "nope" }, { bearer: created.body.token })).status).toBe(403);
});

test("unknown actions and projects are refused; area wildcards are accepted", async () => {
  const owner = await createUser(panel, "owner");
  expect((await call(panel, keyOps.create, { name: "x", actions: ["nope.nope"] }, { cookie: owner.cookie })).status).toBe(400);
  expect(
    (await call(panel, keyOps.create, { name: "x", actions: ["*"], projectIds: ["zzzzzzzzzzzzzzzz"] }, { cookie: owner.cookie })).status,
  ).toBe(404);
  const area = await ok(panel, keyOps.create, { name: "projects", actions: ["projects.*"] }, { cookie: owner.cookie });
  expect((await call(panel, projectOps.create, { name: "made-by-key" }, { bearer: area.body.token })).status).toBe(200);
  expect((await call(panel, userOps.list, {}, { bearer: area.body.token })).status).toBe(403);
});

test("project-limited keys reach only their projects", async () => {
  const owner = await createUser(panel, "owner");
  const a = seedProject(panel);
  const b = seedProject(panel);
  const key = await ok(panel, keyOps.create, { name: "a only", actions: ["*"], projectIds: [a.id] }, { cookie: owner.cookie });
  expect((await call(panel, projectOps.get, { projectId: a.id }, { bearer: key.body.token })).status).toBe(200);
  expect((await call(panel, projectOps.get, { projectId: b.id }, { bearer: key.body.token })).status).toBe(403);
  // No panel-wide actions at all.
  expect((await call(panel, projectOps.create, { name: "x" }, { bearer: key.body.token })).status).toBe(403);
});

test("expired and revoked keys stop working; members cannot list everyone's", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const key = await ok(panel, keyOps.create, { name: "short", actions: ["*"] }, { cookie: member.cookie });
  panel.deps.db
    .update(apiKeys)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(apiKeys.id, key.body.key.id))
    .run();
  expect((await call(panel, auth.whoami, {}, { bearer: key.body.token })).status).toBe(401);

  const other = await ok(panel, keyOps.create, { name: "revoke me", actions: ["*"] }, { cookie: member.cookie });
  expect((await call(panel, keyOps.list, { all: true }, { cookie: member.cookie })).status).toBe(403);
  const all = await ok(panel, keyOps.list, { all: true }, { cookie: owner.cookie });
  expect(all.body.keys).toHaveLength(2);

  // A stranger cannot revoke it; the owner of the panel can.
  const stranger = await createUser(panel, "member");
  expect((await call(panel, keyOps.revoke, { keyId: other.body.key.id }, { cookie: stranger.cookie })).status).toBe(404);
  await ok(panel, keyOps.revoke, { keyId: other.body.key.id }, { cookie: owner.cookie });
  expect((await call(panel, auth.whoami, {}, { bearer: other.body.token })).status).toBe(401);
  expect((await ok(panel, keyOps.list, {}, { cookie: member.cookie })).body.keys).toHaveLength(1);
  expect((await ok(panel, keyOps.list, { includeRevoked: true }, { cookie: member.cookie })).body.keys).toHaveLength(2);
});

test("a key can revoke itself but no other key", async () => {
  const owner = await createUser(panel, "owner");
  const one = await ok(panel, keyOps.create, { name: "one", actions: ["*"] }, { cookie: owner.cookie });
  const two = await ok(panel, keyOps.create, { name: "two", actions: ["*"] }, { cookie: owner.cookie });
  expect((await call(panel, keyOps.revoke, { keyId: two.body.key.id }, { bearer: one.body.token })).status).toBe(404);
  await ok(panel, keyOps.revoke, { keyId: one.body.key.id }, { bearer: one.body.token });
  expect((await call(panel, auth.whoami, {}, { bearer: one.body.token })).status).toBe(401);
});
