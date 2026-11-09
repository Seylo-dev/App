import { expect, test } from "bun:test";
import { allowedModes, pickMode } from "./access";

const service = { id: "svc-api", projectId: "prj-shop" };
const grant = (scopeType: "project" | "service", scopeId: string, actions: string[]) => ({ scopeType, scopeId, actions });

test("a member's modes come from grants on the service or its project, like the panel checks them", () => {
  expect(allowedModes([], service)).toEqual([]);
  // The "Deploy" share preset: console only.
  expect(allowedModes([grant("project", "prj-shop", ["services.view", "terminals.console"])], service)).toEqual(["console"]);
  expect(allowedModes([grant("service", "svc-api", ["terminals.shell"])], service)).toEqual(["shell"]);
  expect(allowedModes([grant("service", "svc-api", ["terminals.*"])], service)).toEqual(["console", "shell"]);
  expect(allowedModes([grant("project", "prj-shop", ["*"])], service)).toEqual(["console", "shell"]);
  // Grants elsewhere give nothing here.
  expect(allowedModes([grant("project", "prj-other", ["*"]), grant("service", "svc-db", ["terminals.*"])], service)).toEqual([]);
  // Two grants add up.
  expect(
    allowedModes([grant("project", "prj-shop", ["terminals.console"]), grant("service", "svc-api", ["terminals.shell"])], service),
  ).toEqual(["console", "shell"]);
});

test("the mode asked for wins when allowed, else the first allowed one", () => {
  expect(pickMode("shell", ["console", "shell"])).toBe("shell");
  expect(pickMode("shell", ["console"])).toBe("console");
  expect(pickMode("console", ["shell"])).toBe("shell");
  expect(pickMode("console", [])).toBeNull();
});
