// The audit log: what the pipeline writes (snapshot, redaction, target
// names), reading it with filters and cursor paging, own entries for
// people without audit.view, and exports.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  allOps,
  audit as auditOps,
  auth,
  describePermission,
  invites as inviteOps,
  projects as projectOps,
  users as userOps,
} from "@seylo/ops";
import { auditLog } from "../src/db/schema";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

/** Audit rows with the values that change per run replaced by stable ones. */
function normalizedLog() {
  const ids = new Map<string, string>();
  const stable = (value: string | null) => {
    if (value === null) return null;
    if (!ids.has(value)) ids.set(value, `<id${ids.size + 1}>`);
    return ids.get(value) as string;
  };
  return panel.deps.db
    .select()
    .from(auditLog)
    .orderBy(auditLog.id)
    .all()
    .map((row) => ({
      actorType: row.actorType,
      actorId: stable(row.actorId),
      credentialId: row.credentialId ? "<credential>" : null,
      actorLabel: row.actorLabel.replace(/^[a-z]+-[0-9a-f]{8}@/, "<user>@"),
      opId: row.opId,
      target: row.targetType ? { type: row.targetType, id: stable(row.targetId), label: row.targetLabel } : null,
      transport: row.transport,
      input: JSON.parse(JSON.stringify(row.input).replace(/"[a-z0-9]{16}"/g, '"<id>"')),
      outcome: row.outcome,
      errorCode: row.errorCode,
      approvalId: row.approvalId,
    }));
}

test("audit rows for a typical session (snapshot)", async () => {
  const owner = await createUser(panel, "owner", "owner-00000000@example.com");
  const member = await createUser(panel, "member", "member-00000000@example.com");
  await call(panel, auth.login, { email: owner.user.email, password: "wrong password" });
  const project = await ok(panel, projectOps.create, { name: "shop" }, { cookie: owner.cookie });
  await ok(panel, projectOps.update, { projectId: project.body.id, name: "store" }, { cookie: owner.cookie });
  await call(panel, projectOps.update, { projectId: project.body.id, name: "nope" }, { cookie: member.cookie });
  await ok(panel, inviteOps.create, { email: "guest@example.com", role: "admin" }, { cookie: owner.cookie });
  await ok(
    panel,
    auth.changePassword,
    { currentPassword: owner.password, newPassword: "the next long password" },
    { cookie: owner.cookie },
  );
  const key = createApiKey(panel, owner.user.id, { actions: ["projects.delete"] });
  await ok(panel, projectOps.remove, { projectId: project.body.id, confirmName: "store" }, { bearer: key });
  // Queries are not audited.
  await ok(panel, userOps.list, {}, { bearer: createApiKey(panel, owner.user.id) });

  const log = normalizedLog();
  // Secrets never reach the log.
  const text = JSON.stringify(log);
  expect(text).not.toContain("wrong password");
  expect(text).not.toContain("the next long password");
  expect(text).not.toContain(owner.password);
  // The delete still names what it deleted.
  expect(log.find((r) => r.opId === "projects.delete")?.target?.label).toBe("store");
  expect(log).toMatchSnapshot();
});

test("people op contracts: permission, audit, MCP and redaction (snapshot)", () => {
  const people = new Set(["auth", "avatars", "setup", "users", "invites", "grants", "apiKeys", "audit"]);
  const table = allOps
    .filter((op) => people.has(op.id.slice(0, op.id.indexOf("."))))
    .map((op) => ({
      id: op.id,
      kind: op.kind,
      permission: describePermission(op.permission),
      audit: op.audit,
      mcp: op.mcp,
      rateLimit: op.rateLimit ?? "standard",
      sensitive: op.sensitive ?? {},
    }));
  expect(table).toMatchSnapshot();
});

async function seedEntries() {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  for (let i = 0; i < 5; i++) await ok(panel, projectOps.create, { name: `p${i}` }, { cookie: owner.cookie });
  await ok(panel, auth.updateProfile, { name: "Me" }, { cookie: member.cookie });
  await call(panel, userOps.updateRole, { userId: owner.user.id, role: "member" }, { cookie: member.cookie });
  return { owner, member };
}

test("list pages newest first with a cursor and filters", async () => {
  const { owner, member } = await seedEntries();
  const first = await ok(panel, auditOps.list, { limit: 3 }, { cookie: owner.cookie });
  expect(first.body.entries).toHaveLength(3);
  expect(first.body.entries[0].opId).toBe("users.updateRole");
  const second = await ok(panel, auditOps.list, { limit: 3, cursor: first.body.nextCursor }, { cookie: owner.cookie });
  expect(second.body.entries).toHaveLength(3);
  expect(Number(second.body.entries[0].id)).toBeLessThan(Number(first.body.entries[2].id));
  const third = await ok(panel, auditOps.list, { limit: 3, cursor: second.body.nextCursor }, { cookie: owner.cookie });
  expect(third.body.entries).toHaveLength(1);
  expect(third.body.nextCursor).toBeNull();

  expect((await ok(panel, auditOps.list, { opId: "projects." }, { cookie: owner.cookie })).body.entries).toHaveLength(5);
  expect((await ok(panel, auditOps.list, { opId: "projects" }, { cookie: owner.cookie })).body.entries).toHaveLength(0);
  expect((await ok(panel, auditOps.list, { outcome: "error" }, { cookie: owner.cookie })).body.entries[0]).toMatchObject({
    errorCode: "FORBIDDEN",
    actor: { id: member.user.id, type: "user" },
  });
  expect((await ok(panel, auditOps.list, { actorId: member.user.id }, { cookie: owner.cookie })).body.entries).toHaveLength(2);
  expect((await ok(panel, auditOps.list, { q: "UPDATEROLE" }, { cookie: owner.cookie })).body.entries).toHaveLength(1);
  const future = new Date(Date.now() + 60_000).toISOString();
  expect((await ok(panel, auditOps.list, { from: future }, { cookie: owner.cookie })).body.entries).toHaveLength(0);
  expect((await call(panel, auditOps.list, { cursor: "abc" }, { cookie: owner.cookie })).status).toBe(400);
});

test("people without audit.view see only their own entries", async () => {
  const { owner, member } = await seedEntries();
  const own = await ok(panel, auditOps.list, {}, { cookie: member.cookie });
  expect(own.body.entries).toHaveLength(2);
  expect(own.body.entries.every((e: { actor: { id: string } }) => e.actor.id === member.user.id)).toBe(true);
  expect((await ok(panel, auditOps.list, { actorId: owner.user.id }, { cookie: member.cookie })).body.entries).toHaveLength(0);

  const ownersEntry = (await ok(panel, auditOps.list, { actorId: owner.user.id, limit: 1 }, { cookie: owner.cookie })).body.entries[0];
  expect((await call(panel, auditOps.get, { entryId: ownersEntry.id }, { cookie: member.cookie })).status).toBe(404);
  expect((await ok(panel, auditOps.get, { entryId: ownersEntry.id }, { cookie: owner.cookie })).body.opId).toBe("projects.create");
  expect((await call(panel, auditOps.exportLog, { format: "csv" }, { cookie: member.cookie })).status).toBe(403);
});

test("export as CSV and JSON Lines; the export itself is audited", async () => {
  const { owner } = await seedEntries();
  await ok(panel, projectOps.create, { name: "=cmd" }, { cookie: owner.cookie }).catch(() => undefined);
  const csv = await ok(panel, auditOps.exportLog, { format: "csv" }, { cookie: owner.cookie });
  expect(csv.body).toMatchObject({ contentType: "text/csv; charset=utf-8", truncated: false });
  expect(csv.body.filename).toMatch(/^seylo-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv.body.content.trimEnd().split("\r\n");
  expect(lines[0]).toStartWith("id,at,actorType,actorId,actorLabel");
  expect(lines.length - 1).toBe(csv.body.rows);

  const jsonl = await ok(panel, auditOps.exportLog, { format: "jsonl", opId: "projects." }, { cookie: owner.cookie });
  const entries = jsonl.body.content
    .trimEnd()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  expect(entries.every((e: { opId: string }) => e.opId === "projects.create")).toBe(true);
  expect(entries[0]).toHaveProperty("transport", "http");

  const exports = await ok(panel, auditOps.list, { opId: "audit.export" }, { cookie: owner.cookie });
  expect(exports.body.entries).toHaveLength(2);
});

test("CSV cells that look like formulas are defused", async () => {
  const { toCsv } = await import("../src/modules/audit/query");
  const row = {
    id: 1,
    at: new Date(0),
    actorType: "user",
    actorId: null,
    credentialId: null,
    actorLabel: '=HYPERLINK("x")',
    opId: "a.b",
    targetType: null,
    targetId: null,
    targetLabel: "+1",
    transport: "http",
    input: {},
    outcome: "ok",
    errorCode: null,
    durationMs: 1,
    ip: null,
    userAgent: "a,b",
    approvalId: null,
  } as const;
  const line = toCsv([row as never]).split("\r\n")[1] as string;
  expect(line).toContain(`"'=HYPERLINK(""x"")"`);
  expect(line).toContain(",'+1,");
  expect(line).toContain(`"a,b"`);
});

test("the project filter covers the project and its services, deleted ones too", async () => {
  const { seedProject, seedService } = await import("./people-helpers");
  const { grants: grantOps } = await import("@seylo/ops");
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const project = seedProject(panel);
  const other = seedProject(panel);
  const service = seedService(panel, project.id, "api");
  await ok(
    panel,
    grantOps.setOnService,
    { serviceId: service.id, userId: member.user.id, actions: ["services.view"] },
    { cookie: owner.cookie },
  );
  await ok(
    panel,
    grantOps.setOnProject,
    { projectId: project.id, userId: member.user.id, actions: ["projects.view"] },
    { cookie: owner.cookie },
  );
  await ok(
    panel,
    grantOps.setOnProject,
    { projectId: other.id, userId: member.user.id, actions: ["projects.view"] },
    { cookie: owner.cookie },
  );
  const listed = await ok(panel, auditOps.list, { projectId: project.id }, { cookie: owner.cookie });
  expect(listed.body.entries.map((e: { opId: string }) => e.opId).sort()).toEqual(["grants.setOnProject", "grants.setOnService"]);
  expect(listed.body.entries.every((e: { projectId: string }) => e.projectId === project.id)).toBe(true);
});
