import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { allOps, collectOps, defineOp, lintOp, opRoute, permission } from "../src";

describe("every registered op", () => {
  test("the registry is not empty", () => {
    expect(allOps.length).toBeGreaterThan(0);
  });

  for (const op of allOps) {
    test(`${op.id} follows the op rules (permission, description, audit redaction)`, () => {
      expect(lintOp(op)).toEqual([]);
    });
  }

  test("ids are unique", () => {
    expect(new Set(allOps.map((op) => op.id)).size).toBe(allOps.length);
  });
});

const base = {
  summary: "Do a thing",
  description: "Does a thing for the test suite.",
  output: Type.Object({}),
  mcp: false,
  audit: true,
} as const;

describe("lintOp", () => {
  test("flags secret-looking fields that are not marked sensitive", () => {
    const op = defineOp({
      ...base,
      id: "test.secret",
      kind: "mutation",
      input: Type.Object({ name: Type.String(), apiToken: Type.String(), nested: Type.Array(Type.Object({ password: Type.String() })) }),
      permission: permission.global("test.secret"),
    });
    expect(lintOp(op)).toEqual([
      'test.secret: input field "apiToken" looks secret; list it in sensitive.input so audit and model output redact it',
      'test.secret: input field "nested.*.password" looks secret; list it in sensitive.input so audit and model output redact it',
    ]);
  });

  test("accepts secrets covered by a parent or wildcard path", () => {
    const op = defineOp({
      ...base,
      id: "test.covered",
      kind: "mutation",
      input: Type.Object({ apiToken: Type.String(), nested: Type.Array(Type.Object({ password: Type.String() })) }),
      sensitive: { input: ["apiToken", "nested.*.password"] },
      permission: permission.global("test.covered"),
    });
    expect(lintOp(op)).toEqual([]);
  });

  test("flags sensitive paths that do not exist", () => {
    const op = defineOp({
      ...base,
      id: "test.typo",
      kind: "mutation",
      input: Type.Object({ password: Type.String() }),
      sensitive: { input: ["pasword"] },
      permission: permission.global("test.typo"),
    });
    expect(lintOp(op)).toContain('test.typo: sensitive input path "pasword" does not exist in the schema');
  });

  test("flags non-scalar query inputs and non-JSON types", () => {
    const op = defineOp({
      ...base,
      id: "test.query",
      kind: "query",
      audit: false,
      input: Type.Object({ tags: Type.Array(Type.String()) }),
      output: Type.Object({ at: Type.Date() }),
      permission: permission.signedIn(),
    });
    expect(lintOp(op)).toEqual([
      "test.query: output uses Type.Date, which has no JSON form; use a string format instead",
      'test.query: query input "tags" must be a scalar so it fits in the query string',
    ]);
  });

  test("flags a missing description", () => {
    const op = defineOp({
      ...base,
      id: "test.terse",
      kind: "query",
      audit: false,
      description: "",
      input: Type.Object({}),
      permission: permission.signedIn(),
    });
    expect(lintOp(op)).toContain("test.terse: description must say what the op does (20+ characters)");
  });
});

describe("defineOp", () => {
  test("rejects ids that are not module.action", () => {
    expect(() =>
      defineOp({ ...base, id: "Projects.Create", kind: "mutation", input: Type.Object({}), permission: permission.global("a.b") }),
    ).toThrow();
  });

  test("refuses unaudited mutations", () => {
    expect(() =>
      defineOp({ ...base, id: "test.quiet", kind: "mutation", audit: false, input: Type.Object({}), permission: permission.global("a.b") }),
    ).toThrow(/must set audit: true/);
  });
});

describe("collectOps", () => {
  const op = defineOp({ ...base, id: "alpha.run", kind: "mutation", input: Type.Object({}), permission: permission.global("alpha.run") });

  test("requires the id prefix to match the module", () => {
    expect(() => collectOps({ beta: { op } })).toThrow(/must start with "beta."/);
  });

  test("rejects duplicate ids", () => {
    expect(() => collectOps({ alpha: { op, again: { ...op } } })).toThrow(/defined twice/);
  });
});

test("queries are GETs and everything else POSTs", () => {
  expect(opRoute({ id: "projects.list", kind: "query" })).toEqual({ method: "GET", path: "/api/v1/projects.list" });
  expect(opRoute({ id: "projects.delete", kind: "destructive" })).toEqual({ method: "POST", path: "/api/v1/projects.delete" });
});
