import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnyPermission } from "../src";
import { ActionName, actionAllowed, actionCatalog, allOps, defineOp, expandActionEntry, grantableActions, permission } from "../src";

const op = (id: string, kind: "query" | "mutation", p: AnyPermission) =>
  defineOp({
    id,
    kind,
    summary: id,
    description: "An op used only to test the action catalog.",
    input: Type.Object({ projectId: Type.String(), serviceId: Type.String() }),
    output: Type.Object({}),
    // Each sample reads a different field; the catalog never calls resource().
    permission: p as never,
    mcp: false,
    audit: true,
  });

const byProject = (input: { projectId: string }) => input.projectId;
const byService = (input: { serviceId: string }) => input.serviceId;

const sample = [
  op("projects.get", "query", permission.project("projects.view", byProject)),
  op("projects.create", "mutation", permission.global("projects.create")),
  op("services.deploy", "mutation", permission.service("services.deploy", byService)),
  op("services.logs", "query", permission.service("services.view", byService)),
  op("services.list", "query", permission.project("services.view", byProject)),
  op("auth.whoami", "query", permission.signedIn()),
];

test("the catalog lists every checked action with its scope and ops", () => {
  expect(actionCatalog(sample)).toEqual([
    { action: "projects.create", scope: "global", ops: ["projects.create"], readOnly: false },
    { action: "projects.view", scope: "project", ops: ["projects.get"], readOnly: true },
    { action: "services.deploy", scope: "service", ops: ["services.deploy"], readOnly: false },
    // Checked on projects and on services: grantable on either.
    { action: "services.view", scope: "service", ops: ["services.list", "services.logs"], readOnly: true },
  ]);
});

test("project grants take project and service actions, service grants service actions, nobody global ones", () => {
  expect(grantableActions(sample, "project")).toEqual(["projects.view", "services.deploy", "services.view"]);
  expect(grantableActions(sample, "service")).toEqual(["services.deploy", "services.view"]);
});

test("the real registry yields a catalog", () => {
  const catalog = actionCatalog(allOps);
  expect(catalog.some((a) => a.action === "users.manage" && a.scope === "global")).toBe(true);
  expect(catalog.some((a) => a.action === "grants.manage" && a.scope === "service")).toBe(true);
});

test("action lists match exact actions, area wildcards and *", () => {
  expect(actionAllowed(["services.deploy"], "services.deploy")).toBe(true);
  expect(actionAllowed(["services.deploy"], "services.view")).toBe(false);
  expect(actionAllowed(["services.*"], "services.view")).toBe(true);
  expect(actionAllowed(["services.*"], "servicesx.view")).toBe(false);
  expect(actionAllowed(["*"], "anything.goes")).toBe(true);
  expect(actionAllowed([], "services.view")).toBe(false);
});

test("entries expand against the known actions", () => {
  const known = ["logs.view", "services.deploy", "services.view"];
  expect(expandActionEntry("*", known)).toEqual(known);
  expect(expandActionEntry("services.*", known)).toEqual(["services.deploy", "services.view"]);
  expect(expandActionEntry("nope.*", known)).toEqual([]);
  expect(expandActionEntry("nope.view", known)).toEqual([]);
});

test("ActionName accepts *, area.* and area.verb only", () => {
  for (const ok of ["*", "services.*", "services.deploy", "apiKeys.create"]) expect(Value.Check(ActionName, ok)).toBe(true);
  for (const bad of ["services", "*.view", "Services.view", "a.b.c", "services.*x"]) expect(Value.Check(ActionName, bad)).toBe(false);
});
