import { afterEach, expect, test } from "bun:test";
import { auth, databases, OpError, projects } from "@seylo/ops";
import { runOpAs } from "../src/modules/approvals/run-as";
import { defineModule } from "../src/modules/module";
import { implement } from "../src/ops/implement";
import { type CallOptions, callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./seed-helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

test("invalid input is a 400 that names the field", async () => {
  panel = testPanel();
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, projects.create, { name: "" }, { cookie });
  expect(result.status).toBe(400);
  expect(result.body.error.details).toEqual({ field: "name" });
});

// These use auth.updateProfile with stand-in handlers, so they test the
// pipeline and not any real module.
const viewerOf = (input: { name: string }) => ({
  viewer: { id: "abcdefghijklmnop", email: "a@example.com", name: input.name, role: "owner" as const },
});

test("unknown input fields are dropped", async () => {
  let seen: unknown;
  const echo = implement(auth.updateProfile, (input) => {
    seen = input;
    return viewerOf(input);
  });
  panel = testPanel({ modules: [defineModule({ name: "auth", ops: [echo] })] });
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, auth.updateProfile, { name: "x", extra: true } as never, { cookie });
  expect(result.status).toBe(200);
  expect(seen).toEqual({ name: "x" });
});

test("an op without a handler answers NOT_IMPLEMENTED", async () => {
  panel = testPanel({ modules: [] });
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, projects.list, {}, { cookie });
  expect(result.status).toBe(501);
});

test("output fields the schema does not declare never reach the caller", async () => {
  const leaky = implement(auth.updateProfile, (input) => {
    const out = viewerOf(input);
    return { ...out, viewer: { ...out.viewer, passwordHash: "should not leak" }, sessionToken: "nor this" };
  });
  panel = testPanel({ modules: [defineModule({ name: "auth", ops: [leaky] })] });
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, auth.updateProfile, { name: "p" }, { cookie });
  expect(result.status).toBe(200);
  expect(result.body).toEqual(viewerOf({ name: "p" }));
});

test("a handler returning the wrong shape is an INTERNAL error, not bad data", async () => {
  const broken = implement(projects.list, () => ({ projects: [{ id: 1 }] }) as never);
  panel = testPanel({ modules: [defineModule({ name: "projects", ops: [broken] })] });
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, projects.list, {}, { cookie });
  expect(result.status).toBe(500);
  expect(result.body.error.code).toBe("INTERNAL");
});

test("unexpected exceptions do not leak their message", async () => {
  const throwing = implement(projects.list, () => {
    throw new Error("SQLITE_CORRUPT at /var/lib/secret/path");
  });
  panel = testPanel({ modules: [defineModule({ name: "projects", ops: [throwing] })] });
  const { cookie } = await createUser(panel, "owner");
  const result = await callOp(panel, projects.list, {}, { cookie });
  expect(result.body.error.message).not.toContain("SQLITE");
});

test("modelApproval \"conditional\": the handler's check decides for a model's call only, after the permission check", async () => {
  const asked: unknown[] = [];
  let waits = true;
  // A stand-in for databases.setExposure that "runs" by refusing with CONFLICT, so running and waiting differ.
  const standIn = implement(
    databases.setExposure,
    () => {
      throw new OpError("CONFLICT", "ran");
    },
    {
      modelApproval: (input) => {
        asked.push(input);
        return waits;
      },
    },
  );
  const p = testPanel({ modules: [defineModule({ name: "databases", ops: [standIn] })] });
  panel = p;
  const owner = await createUser(p, "owner");
  const service = seedService(p, { projectId: seedProject(p).id, name: "shop-db" });
  const input = { serviceId: service.id, enabled: true, allowPlain: true };
  const code = async (options: CallOptions) => (await callOp(p, databases.setExposure, input, options)).body.error.code;

  // A person's own calls run without asking it: the session, and a plain API key.
  expect(await code({ cookie: owner.cookie })).toBe("CONFLICT");
  expect(await code({ bearer: createApiKey(p, owner.user.id) })).toBe("CONFLICT");
  expect(asked).toEqual([]);

  // A model's call: the check decides, from the validated input.
  const mcp = createApiKey(p, owner.user.id, { kind: "mcp" });
  expect(await code({ bearer: mcp })).toBe("APPROVAL_REQUIRED");
  expect(asked).toEqual([input]);
  waits = false;
  expect(await code({ bearer: mcp })).toBe("CONFLICT");
  waits = true;
  const assistant = (autoMode: boolean) =>
    runOpAs(p.deps, { op: databases.setExposure, input, userId: owner.user.id, transport: "ai", autoMode });
  expect(await assistant(false)).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
  expect(asked).toHaveLength(3);
  // Auto mode runs it without asking, as it runs destructive ops.
  expect(await assistant(true)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(asked).toHaveLength(3);

  // A caller the permission refuses is refused before it is asked.
  const member = await createUser(p, "member");
  expect(await code({ bearer: createApiKey(p, member.user.id, { kind: "mcp" }) })).toBe("FORBIDDEN");
  expect(asked).toHaveLength(3);
});
