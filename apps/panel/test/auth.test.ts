import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, projects, sessionCookie } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog } from "../src/db/schema";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { cookieFrom } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("sign-in sets an HttpOnly session cookie that whoami accepts", async () => {
  const { user, password } = await createUser(panel, "owner", "Owner@Example.com".toLowerCase());
  const login = await callOp(panel, auth.login, { email: "OWNER@example.com", password });
  expect(login.status).toBe(200);
  expect(login.body.viewer).toEqual({ id: user.id, email: user.email, name: "owner", role: "owner" });

  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`${sessionCookie}=`);
  expect(setCookie.toLowerCase()).toContain("httponly");
  const cookie = cookieFrom(login.headers) as string;

  const me = await callOp(panel, auth.whoami, {}, { cookie });
  expect(me.body).toEqual({ viewer: login.body.viewer, via: "session" });

  await callOp(panel, auth.logout, {}, { cookie });
  expect((await callOp(panel, auth.whoami, {}, { cookie })).status).toBe(401);
});

test("a wrong password fails and the audit log never stores it", async () => {
  const { user } = await createUser(panel, "owner");
  const login = await callOp(panel, auth.login, { email: user.email, password: "wrong-password" });
  expect(login.status).toBe(401);

  const rows = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "auth.login")).all();
  expect(rows).toHaveLength(1);
  // Logged against the account whose password was tried.
  expect(rows[0]).toMatchObject({
    actorType: "user",
    actorId: user.id,
    actorLabel: user.email,
    outcome: "error",
    errorCode: "UNAUTHENTICATED",
    input: { email: user.email, password: "[redacted]" },
  });
});

test("sign-in is rate limited per IP", async () => {
  // Different (unknown) emails, so the per-account lock does not kick in first.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await callOp(panel, auth.login, { email: `nobody${i}@example.com`, password: "wrong" })).status);
  }
  expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
  expect(statuses.slice(10)).toEqual([429, 429]);
});

test("signed-in ops refuse anonymous callers", async () => {
  const result = await callOp(panel, projects.list, {});
  expect(result.status).toBe(401);
  expect(result.body.error.code).toBe("UNAUTHENTICATED");
});

test("API keys act as their owner within their actions", async () => {
  const { user } = await createUser(panel, "owner");
  const scoped = createApiKey(panel, user.id, { actions: ["projects.view"] });
  expect((await callOp(panel, projects.list, {}, { bearer: scoped })).status).toBe(200);
  expect((await callOp(panel, projects.create, { name: "x" }, { bearer: scoped })).body.error.code).toBe("FORBIDDEN");

  const readOnly = createApiKey(panel, user.id, { readOnly: true });
  const refused = await callOp(panel, projects.create, { name: "x" }, { bearer: readOnly });
  expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", message: "This key is read-only." });

  expect((await callOp(panel, projects.list, {}, { bearer: "not-a-real-token" })).status).toBe(401);
});

test("cookie-authenticated changes from another site are refused", async () => {
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, projects.create, { name: "csrf" }, { cookie, origin: "https://evil.example" });
  expect(result.status).toBe(403);
});
