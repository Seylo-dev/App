// The people contracts: every op is routed with the right auth gate, API
// keys narrowed to projects stay inside them, and destructive ops from
// models wait for an approval. Detailed flows are in the other people tests
// (auth-flows, setup, users, invites, grants, api-keys, audit, matrix).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { allOps, apiKeys as apiKeyOps, audit, auth, defineOp, grants, invites, OpError, permission, setup, users } from "@seylo/ops";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { createAccess } from "../src/auth/access";
import type { Principal } from "../src/auth/principal";
import { apiKeys, auditLog } from "../src/db/schema";
import { modules } from "../src/modules/index.gen";
import { defineModule } from "../src/modules/module";
import { implement } from "../src/ops/implement";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { callOp, createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

const peopleModules = ["auth", "setup", "users", "invites", "grants", "apiKeys", "audit"];

test("every people op has a handler in its module", () => {
  const handled = new Set(modules.flatMap((m) => (peopleModules.includes(m.name) ? m.ops.map((h) => h.contract.id) : [])));
  const contracts = allOps.filter((op) => peopleModules.includes(op.id.slice(0, op.id.indexOf(".")))).map((op) => op.id);
  expect(contracts.length).toBeGreaterThan(50);
  expect([...handled].sort()).toEqual(contracts);
});

test("people ops are built and answer after the auth gate", async () => {
  // Anonymous callers are refused before anything else.
  expect((await callOp(panel, users.list, {})).status).toBe(401);

  const { cookie } = await createUser(panel, "owner");
  for (const [op, input] of [
    [users.list, {}],
    [invites.list, {}],
    [grants.mine, {}],
    [apiKeyOps.list, {}],
    [audit.list, {}],
    [auth.security, {}],
  ] as const) {
    const result = await callOp(panel, op, input as never, { cookie });
    expect(result.status).toBe(200);
  }
  // Public ones too.
  const status = await callOp(panel, setup.status, {});
  expect(status.body.ownerExists).toBe(true);
});

test("members are refused panel-wide people ops", async () => {
  const { cookie } = await createUser(panel, "member");
  const result = await callOp(panel, users.list, {}, { cookie });
  expect(result.status).toBe(403);
});

test("password sign-in reports status signedIn", async () => {
  const { user, password } = await createUser(panel, "owner");
  const login = await callOp(panel, auth.login, { email: user.email, password });
  expect(login.status).toBe(200);
  expect(login.body.status).toBe("signedIn");
  expect(login.body.challenge).toBeUndefined();
});

test("a key limited to projects only reaches those projects and loses panel-wide actions", async () => {
  const { user } = await createUser(panel, "owner");
  const principal: Principal = {
    type: "apiKey",
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    keyId: "k",
    keyName: "ci",
    keyKind: "api",
    actions: ["*"],
    projectIds: ["aaaaaaaaaaaaaaaa"],
    readOnly: false,
  };
  const access = createAccess(panel.deps.db, principal);
  expect(access.can("services.deploy", { type: "project", id: "aaaaaaaaaaaaaaaa" })).toBe(true);
  expect(access.can("services.deploy", { type: "project", id: "bbbbbbbbbbbbbbbb" })).toBe(false);
  expect(access.can("projects.create")).toBe(false);
  // A service that does not exist belongs to no allowed project.
  expect(access.can("services.deploy", { type: "service", id: "cccccccccccccccc" })).toBe(false);

  const unlimited = createAccess(panel.deps.db, { ...principal, projectIds: null });
  expect(unlimited.can("projects.create")).toBe(true);
});

const wipe = defineOp({
  id: "testWipe.run",
  kind: "destructive",
  summary: "Wipe",
  description: "A destructive op used only by this test file.",
  input: Type.Object({}),
  output: Type.Object({ done: Type.Boolean() }),
  permission: permission.global("testWipe.run"),
  mcp: true,
  audit: true,
});

function mcpToken(userId: string) {
  const token = prefixedToken("mcp");
  panel.deps.db
    .insert(apiKeys)
    .values({ userId, kind: "mcp", name: "claude", prefix: token.slice(0, 12), tokenHash: hashToken(token), actions: ["*"] })
    .run();
  return token;
}

test("destructive ops from models need an approval and are audited with their transport", async () => {
  panel.close();
  panel = testPanel({ modules: [...modules, defineModule({ name: "testWipe", ops: [implement(wipe, () => ({ done: true }))] })] });
  const { user } = await createUser(panel, "owner");
  const token = mcpToken(user.id);
  // Test-only contracts are not in allOps, so they get no HTTP route; call the executor the transports share.
  const call = (credentials: { bearerToken?: string; sessionToken?: string }, transport: "http" | "mcp", approvalId?: string) =>
    panel.execute({ op: wipe, rawInput: {}, credentials, transport, coerce: false, ip: null, userAgent: null, http: null, approvalId });

  const viaMcpToken = await call({ bearerToken: token }, "http");
  expect(viaMcpToken.ok).toBe(false);
  if (!viaMcpToken.ok) expect(viaMcpToken.error.code).toBe("APPROVAL_REQUIRED");

  const viaMcpTransport = await call({ bearerToken: token }, "mcp");
  expect(viaMcpTransport.ok).toBe(false);

  const approved = await call({ bearerToken: token }, "mcp", "approval0000001");
  expect(approved).toEqual({ ok: true, output: { done: true } });

  const rows = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "testWipe.run")).all();
  expect(rows.map((r) => [r.actorType, r.outcome, r.errorCode, r.transport, r.approvalId])).toEqual([
    ["mcp", "error", "APPROVAL_REQUIRED", "http", null],
    ["mcp", "error", "APPROVAL_REQUIRED", "mcp", null],
    ["mcp", "ok", null, "mcp", "approval0000001"],
  ]);
});

test("people sessions run destructive ops without an approval", async () => {
  panel.close();
  panel = testPanel({ modules: [...modules, defineModule({ name: "testWipe", ops: [implement(wipe, () => ({ done: true }))] })] });
  const { cookie } = await createUser(panel, "owner");
  const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
  const result = await panel.execute({
    op: wipe,
    rawInput: {},
    credentials: { sessionToken, sessionKey: sessionKeyOf(cookie) },
    transport: "http",
    coerce: false,
    ip: null,
    userAgent: null,
    http: null,
  });
  expect(result).toEqual({ ok: true, output: { done: true } });
});

test("APPROVAL_REQUIRED is a 403 error code", () => {
  expect(new OpError("APPROVAL_REQUIRED", "x").status).toBe(403);
});
