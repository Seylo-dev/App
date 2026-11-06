import { expect, test } from "bun:test";
import settingsActions from "../../i18n/en/settingsActions";
import { actionLabel, allActions, compactActions, expandActions, grantable, groupActions, humanize, readOnlyActions } from "./actions";

test("project grants include project and service actions, service grants only service ones", () => {
  const project = grantable("project").map((a) => a.action);
  const service = grantable("service").map((a) => a.action);
  expect(project).toContain("projects.view");
  expect(project).toContain("services.deploy");
  expect(service).toContain("services.deploy");
  expect(service).not.toContain("projects.view");
  // Global actions are never grantable.
  expect(project).not.toContain("users.manage");
  expect(project).not.toContain("settings.manage");
});

test("groups keep every action once, by area", () => {
  const groups = groupActions(allActions);
  expect(groups.flatMap((g) => g.actions).length).toBe(allActions.length);
  for (const group of groups) for (const info of group.actions) expect(info.action.startsWith(`${group.area}.`)).toBe(true);
});

test("compactActions turns a full pick into * and expandActions undoes it", () => {
  const available = grantable("service");
  const all = new Set(available.map((a) => a.action));
  expect(compactActions(all, available)).toEqual(["*"]);
  expect(expandActions(["*"], available)).toEqual(all);
  const some = new Set(["services.view", "logs.view"]);
  expect(compactActions(some, available)).toEqual(available.map((a) => a.action).filter((a) => some.has(a)));
  expect(compactActions(new Set(), available)).toEqual([]);
});

test("read-only actions are the query-only ones", () => {
  const ro = readOnlyActions(allActions);
  expect(ro).toContain("services.view");
  // projects.view guards a per-person mutation too, but it only ever lets someone look.
  expect(ro).toContain("projects.view");
  expect(ro).not.toContain("services.deploy");
});

test("labels come from the catalog, with a readable fallback", () => {
  expect(actionLabel("services.deploy")).toBe("Deploy");
  expect(actionLabel("future.doSomething")).toBe("Do something");
  expect(humanize("manage")).toBe("Manage");
});

test("every action in the contracts has a label in the catalog", () => {
  const missing = allActions
    .map((a) => a.action)
    .filter((action) => {
      const [area, verb] = action.split(".");
      return !(area && verb && hasLabel(area, verb));
    });
  expect(missing).toEqual([]);
});

function hasLabel(area: string, verb: string): boolean {
  const group = (settingsActions as unknown as Record<string, Record<string, unknown> | string>)[area];
  return typeof group === "object" && typeof group[verb] === "string";
}
