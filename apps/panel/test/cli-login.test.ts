// Laptop CLI sign-in by browser approval: start -> approve on the web page
// -> one poll hands out a scoped, expiring key; deny, expiry, keys cannot
// approve, and a second poll gets nothing.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, cliLogin, projects as projectOps, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { alerts, apiKeys, auditLog, cliLoginRequests } from "../src/db/schema";
import { newUserCode } from "../src/modules/cliLogin";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

test("approve then poll returns a scoped, expiring key once", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const started = await ok(panel, cliLogin.start, { clientName: "laptop (darwin/arm64)" });
  const { userCode, deviceCode, verificationUrl } = started.body;
  expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(verificationUrl).toEndWith(`/cli/approve?code=${userCode}`);
  // The device code is stored hashed only.
  const row = panel.deps.db.select().from(cliLoginRequests).get();
  expect(JSON.stringify(row)).not.toContain(deviceCode);

  expect((await ok(panel, cliLogin.poll, { deviceCode })).body).toEqual({ status: "pending", intervalSeconds: 2 });
  const shown = await ok(panel, cliLogin.get, { userCode }, { cookie: owner.cookie });
  expect(shown.body.request).toMatchObject({ userCode, clientName: "laptop (darwin/arm64)", status: "pending" });
  // The approving browser's own address, to compare with where the CLI asked from.
  expect(shown.body).toHaveProperty("viewerAddress");

  // Lowercase codes are accepted too.
  await ok(
    panel,
    cliLogin.approve,
    { userCode, actions: ["projects.view"], projectIds: [project.id], expiresInDays: 7 },
    { cookie: owner.cookie },
  );
  const approvedEntry = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "cliLogin.approve")).all().at(-1);
  expect(approvedEntry?.input).toMatchObject({ clientName: "laptop (darwin/arm64)", requestedFrom: null, expiresInDays: 7 });
  // Every approval mints a key acting as this person, so it raises a security_change alert.
  const alert = panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all().at(-1);
  expect(alert?.title).toContain("approved a CLI sign-in for laptop (darwin/arm64)");
  expect(alert?.message).toContain("valid 7 days");
  const polled = await ok(panel, cliLogin.poll, { deviceCode });
  expect(polled.body.status).toBe("approved");
  const key = polled.body.key;
  if (!key) throw new Error("no key");
  expect(key.token).toStartWith("seylo_key_");
  expect(key.email).toBe(owner.user.email);
  expect(key.name).toBe("CLI on laptop (darwin/arm64)");
  const days = (Date.parse(key.expiresAt) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);
  const stored = panel.deps.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get();
  expect(stored).toMatchObject({ userId: owner.user.id, actions: ["projects.view"], projectIds: [project.id], readOnly: false });

  expect((await ok(panel, auth.whoami, {}, { bearer: key.token })).body.via).toBe("apiKey");
  expect((await call(panel, projectOps.get, { projectId: project.id }, { bearer: key.token })).status).toBe(200);
  expect((await call(panel, userOps.list, {}, { bearer: key.token })).status).toBe(403);

  // Only once.
  expect((await ok(panel, cliLogin.poll, { deviceCode })).body).toEqual({ status: "used", intervalSeconds: 2 });
  expect((await call(panel, cliLogin.approve, { userCode }, { cookie: owner.cookie })).status).toBe(409);
});

test("deny, expiry, unknown codes and API keys", async () => {
  const owner = await createUser(panel, "owner");
  const a = await ok(panel, cliLogin.start, { clientName: "a" });
  await ok(panel, cliLogin.deny, { userCode: a.body.userCode }, { cookie: owner.cookie });
  expect((await ok(panel, cliLogin.poll, { deviceCode: a.body.deviceCode })).body.status).toBe("denied");

  const b = await ok(panel, cliLogin.start, { clientName: "b" });
  panel.deps.db
    .update(cliLoginRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .run();
  expect((await ok(panel, cliLogin.poll, { deviceCode: b.body.deviceCode })).body.status).toBe("expired");
  const late = await call(panel, cliLogin.approve, { userCode: b.body.userCode }, { cookie: owner.cookie });
  expect(late.status).toBe(409);

  expect((await call(panel, cliLogin.get, { userCode: "ABCD-EFGH" }, { cookie: owner.cookie })).status).toBe(404);
  expect((await call(panel, cliLogin.poll, { deviceCode: "seylo_cli_nothing_like_this_exists" })).status).toBe(404);
  expect((await call(panel, cliLogin.get, { userCode: b.body.userCode })).status).toBe(401);

  // A key never approves another key.
  const c = await ok(panel, cliLogin.start, { clientName: "c" });
  const key = createApiKey(panel, owner.user.id);
  expect((await call(panel, cliLogin.approve, { userCode: c.body.userCode }, { bearer: key })).status).toBe(403);
  // Unknown actions are refused before anything changes.
  expect(
    (await call(panel, cliLogin.approve, { userCode: c.body.userCode, actions: ["nope.nope"] }, { cookie: owner.cookie })).status,
  ).toBe(400);
  expect((await ok(panel, cliLogin.poll, { deviceCode: c.body.deviceCode })).body.status).toBe("pending");
});

test("user codes use only unambiguous letters", () => {
  for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
});

test("one computer name cannot start sign-ins in a loop", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await call(panel, cliLogin.start, { clientName: "loop (linux/amd64)" })).status);
  expect(statuses).toContain(429);
});
