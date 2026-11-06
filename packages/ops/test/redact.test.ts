import { expect, test } from "bun:test";
import { redact } from "../src";

test("redacts plain, nested and wildcard paths without touching the original", () => {
  const value = {
    email: "a@example.com",
    password: "hunter2",
    env: [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ],
    providers: { github: { token: "t1" }, gitlab: { token: "t2" } },
  };
  const out = redact(value, ["password", "env.*.value", "providers.*.token", "missing.path"]);
  expect(out).toEqual({
    email: "a@example.com",
    password: "[redacted]",
    env: [
      { key: "A", value: "[redacted]" },
      { key: "B", value: "[redacted]" },
    ],
    providers: { github: { token: "[redacted]" }, gitlab: { token: "[redacted]" } },
  });
  expect(value.password).toBe("hunter2");
});

test("does not invent missing optional fields", () => {
  expect(redact({ a: 1 }, ["password"])).toEqual({ a: 1 });
});
