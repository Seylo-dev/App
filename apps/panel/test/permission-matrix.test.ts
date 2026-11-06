// The permission matrix: every kind of caller against a representative set
// of ops, over HTTP through the real pipeline. Inputs are chosen so an
// allowed call fails after the gate (NOT_FOUND, BAD_REQUEST) or changes
// nothing, which keeps one panel for the whole table.
//
//   allow     passed the auth gate (any status but 401/403)
//   deny      403 FORBIDDEN
//   anon      401 UNAUTHENTICATED
//   approval  403 APPROVAL_REQUIRED (a model's destructive call)

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AnyOpContract, audit, auth, grants, apiKeys as keyOps, projects, setup, users } from "@seylo/ops";
import { apiKeys } from "../src/db/schema";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, seedProject, seedService } from "./people-helpers";

type Outcome = "allow" | "deny" | "anon" | "approval";

const missing = "zzzzzzzzzzzzzzzz";
let panel: TestPanel;
let callers: Record<string, { cookie?: string; bearer?: string }>;
let projectA: string;
let serviceA1: string;

function mcpToken(userId: string, readOnly: boolean) {
  const token = prefixedToken("mcp");
  panel.deps.db
    .insert(apiKeys)
    .values({ userId, kind: "mcp", name: "model", prefix: token.slice(0, 14), tokenHash: hashToken(token), actions: ["*"], readOnly })
    .run();
  return token;
}

beforeAll(async () => {
  panel = testPanel({ rateLimiter: noLimits });
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  const member = await createUser(panel, "member");
  const guest = await createUser(panel, "member");
  const nobody = await createUser(panel, "member");
  projectA = seedProject(panel).id;
  serviceA1 = seedService(panel, projectA).id;
  grant(panel, member.user.id, "project", projectA, ["*"]);
  grant(panel, guest.user.id, "service", serviceA1, ["services.view", "grants.view"]);
  callers = {
    anonymous: {},
    owner: { cookie: owner.cookie },
    admin: { cookie: admin.cookie },
    "member (project *)": { cookie: member.cookie },
    "guest (one service)": { cookie: guest.cookie },
    "member (no grants)": { cookie: nobody.cookie },
    "key *": { bearer: createApiKey(panel, owner.user.id) },
    "key users.view": { bearer: createApiKey(panel, owner.user.id, { actions: ["users.view"] }) },
    "key read-only": { bearer: createApiKey(panel, owner.user.id, { readOnly: true }) },
    "key project A": { bearer: projectKey(owner.user.id) },
    "mcp read-only": { bearer: mcpToken(owner.user.id, true) },
    "mcp writable": { bearer: mcpToken(owner.user.id, false) },
  };
});
afterAll(() => panel.close());

function projectKey(userId: string) {
  const token = prefixedToken("key");
  panel.deps.db
    .insert(apiKeys)
    .values({ userId, name: "a", prefix: token.slice(0, 14), tokenHash: hashToken(token), actions: ["*"], projectIds: [projectA] })
    .run();
  return token;
}

const ops: [string, AnyOpContract, () => Record<string, unknown>][] = [
  ["users.list", users.list, () => ({})],
  ["users.updateRole", users.updateRole, () => ({ userId: missing, role: "member" })],
  ["users.remove", users.remove, () => ({ userId: missing, confirmEmail: "x" })],
  ["projects.get A", projects.get, () => ({ projectId: projectA })],
  ["projects.delete A", projects.remove, () => ({ projectId: projectA, confirmName: "wrong name" })],
  ["grants.listByProject A", grants.listByProject, () => ({ projectId: projectA })],
  ["grants.listByService A1", grants.listByService, () => ({ serviceId: serviceA1 })],
  ["grants.setOnService A1", grants.setOnService, () => ({ serviceId: serviceA1, userId: missing, actions: ["services.view"] })],
  ["audit.list", audit.list, () => ({})],
  ["audit.export", audit.exportLog, () => ({ format: "csv" })],
  ["apiKeys.create", keyOps.create, () => ({ name: "matrix", actions: ["projects.view"] })],
  ["auth.listSessions", auth.listSessions, () => ({})],
  ["setup.finish", setup.finish, () => ({ skipped: [] })],
];

// Columns follow `ops` above: users.list, users.updateRole, users.remove,
// projects.get, projects.delete, grants.listByProject, grants.listByService,
// grants.setOnService, audit.list, audit.export, apiKeys.create,
// auth.listSessions, setup.finish.
const expected: Record<string, Outcome[]> = {
  anonymous: ["anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon", "anon"],
  owner: ["allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow"],
  admin: ["allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow"],
  "member (project *)": ["deny", "deny", "deny", "allow", "allow", "allow", "allow", "allow", "allow", "deny", "allow", "allow", "deny"],
  "guest (one service)": ["deny", "deny", "deny", "deny", "deny", "deny", "allow", "deny", "allow", "deny", "allow", "allow", "deny"],
  "member (no grants)": ["deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "allow", "deny", "allow", "allow", "deny"],
  "key *": ["allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "allow", "deny", "deny", "allow"],
  "key users.view": ["allow", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "allow", "deny", "deny", "deny", "deny"],
  "key read-only": ["allow", "deny", "deny", "allow", "deny", "allow", "allow", "deny", "allow", "allow", "deny", "deny", "deny"],
  "key project A": ["deny", "deny", "deny", "allow", "allow", "allow", "allow", "allow", "allow", "deny", "deny", "deny", "deny"],
  "mcp read-only": ["allow", "deny", "deny", "allow", "deny", "allow", "allow", "deny", "allow", "deny", "deny", "deny", "deny"],
  "mcp writable": ["allow", "deny", "deny", "allow", "approval", "allow", "allow", "deny", "allow", "deny", "deny", "deny", "deny"],
};

function outcome(status: number, code: string | undefined): Outcome {
  if (status === 401) return "anon";
  if (code === "APPROVAL_REQUIRED") return "approval";
  if (status === 403) return "deny";
  return "allow";
}

test("permission matrix", async () => {
  const actual: Record<string, Outcome[]> = {};
  for (const [name, credentials] of Object.entries(callers)) {
    const row: Outcome[] = [];
    for (const [, op, input] of ops) {
      const result = await call(panel, op, input() as never, credentials);
      row.push(outcome(result.status, result.body?.error?.code));
    }
    actual[name] = row;
  }
  // Compare per cell so a failure names the caller and the op.
  const diffs: string[] = [];
  for (const [name, row] of Object.entries(expected)) {
    row.forEach((want, i) => {
      const got = actual[name]?.[i];
      if (got !== want) diffs.push(`${name} x ${ops[i]?.[0]}: expected ${want}, got ${got}`);
    });
  }
  expect(diffs).toEqual([]);
});
