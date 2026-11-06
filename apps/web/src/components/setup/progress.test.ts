import { expect, test } from "bun:test";
import { parseProgress } from "./progress";

const steps = ["owner", "panelDomain", "wildcardDomain", "firstProject"];

test("restores a known step and its skipped list", () => {
  const raw = JSON.stringify({ step: "firstProject", skipped: ["panelDomain", "nope", 3] });
  expect(parseProgress(raw, steps)).toEqual({ step: "firstProject", skipped: ["panelDomain"] });
});

test("ignores the owner step, unknown steps and junk", () => {
  expect(parseProgress(JSON.stringify({ step: "owner", skipped: [] }), steps)).toBeNull();
  expect(parseProgress(JSON.stringify({ step: "billing" }), steps)).toBeNull();
  expect(parseProgress("{", steps)).toBeNull();
  expect(parseProgress(null, steps)).toBeNull();
});
