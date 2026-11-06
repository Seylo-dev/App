import { afterEach, expect, test } from "bun:test";
import { auth, projects } from "@seylo/ops";
import { defineModule } from "../src/modules/module";
import { implement } from "../src/ops/implement";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

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
