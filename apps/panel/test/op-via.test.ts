// The op pipeline's via and viaLogin (added in 0.2.1): the tailnet listener
// marks its calls, handlers see it in the context, and every audit row of
// such a call records it, refused ones included. It never comes from a
// model's call, and the login is cut. Stand-in handlers, so this tests the
// pipeline and not a real module.

import { afterEach, expect, test } from "bun:test";
import { auth, projects } from "@seylo/ops";
import { desc } from "drizzle-orm";
import { createSession } from "../src/auth/sessions";
import { auditLog, users } from "../src/db/schema";
import { defineModule } from "../src/modules/module";
import { implement, maxViaLoginLength, type OpContext } from "../src/ops/implement";
import type { OpCall } from "../src/ops/pipeline";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

const seen: Pick<OpContext, "via" | "viaLogin">[] = [];

function setup() {
  seen.length = 0;
  const profile = implement(auth.updateProfile, (input, ctx) => {
    seen.push({ via: ctx.via, viaLogin: ctx.viaLogin });
    return { viewer: { id: "abcdefghijklmnop", email: "a@example.com", name: input.name, role: "owner" as const } };
  });
  const list = implement(projects.list, (_input, ctx) => {
    seen.push({ via: ctx.via, viaLogin: ctx.viaLogin });
    return { projects: [] };
  });
  panel = testPanel({ modules: [defineModule({ name: "auth", ops: [profile] }), defineModule({ name: "projects", ops: [list] })] });
  const user = panel.deps.db.insert(users).values({ email: "owner@example.com", name: "owner", role: "owner" }).returning().get();
  const { token, key } = createSession(panel.deps.db, user.id, { ip: null, userAgent: null });
  return { panel, credentials: { sessionToken: token, sessionKey: key } };
}

function call(p: TestPanel, credentials: OpCall["credentials"], extra: Partial<OpCall>): ReturnType<TestPanel["execute"]> {
  return p.execute({
    op: auth.updateProfile,
    rawInput: { name: "Owner" },
    credentials,
    transport: "http",
    coerce: false,
    ip: "100.64.0.7",
    userAgent: null,
    http: null,
    ...extra,
  });
}

const lastAudit = (p: TestPanel) => p.deps.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1).get();

test("a tailnet call carries via and viaLogin to the handler and the audit row", async () => {
  const { panel: p, credentials } = setup();
  const outcome = await call(p, credentials, { via: "tailnet", viaLogin: " owner@example.com " });
  expect(outcome.ok).toBe(true);
  expect(seen).toEqual([{ via: "tailnet", viaLogin: "owner@example.com" }]);
  expect(lastAudit(p)?.input).toEqual({ name: "Owner", via: "tailnet", viaLogin: "owner@example.com" });
});

test("a call on the main listener has neither", async () => {
  const { panel: p, credentials } = setup();
  await call(p, credentials, {});
  expect(seen).toEqual([{ via: null, viaLogin: null }]);
  expect(lastAudit(p)?.input).toEqual({ name: "Owner" });
});

test("a refused tailnet call still records via", async () => {
  const { panel: p, credentials } = setup();
  const outcome = await call(p, credentials, { rawInput: {}, via: "tailnet", viaLogin: null });
  expect(outcome.ok).toBe(false);
  expect(seen).toEqual([]);
  const row = lastAudit(p);
  expect(row?.outcome).toBe("error");
  expect(row?.input).toEqual({ via: "tailnet", viaLogin: null });
});

test("the login is cut, and an empty one is null", async () => {
  const { panel: p, credentials } = setup();
  await call(p, credentials, { via: "tailnet", viaLogin: "x".repeat(4096) });
  await call(p, credentials, { via: "tailnet", viaLogin: "  " });
  expect(seen.map((s) => s.viaLogin?.length ?? null)).toEqual([maxViaLoginLength, null]);
});

test("only HTTP calls come in on a listener", async () => {
  const { panel: p, credentials } = setup();
  const outcome = await p.execute({
    op: projects.list,
    rawInput: {},
    credentials,
    transport: "mcp",
    coerce: false,
    ip: null,
    userAgent: null,
    http: null,
    via: "tailnet",
    viaLogin: "owner@example.com",
  });
  expect(outcome.ok).toBe(true);
  expect(seen).toEqual([{ via: null, viaLogin: null }]);
});
