import { expect, test } from "bun:test";
import { emptyFilters, filtersToInput, opModules, opSentence } from "./audit";

test("MCP OAuth entries that are not ops get their own sentence", () => {
  expect(opSentence("mcp.registerClient")).toBe("Register an MCP client");
  expect(opSentence("mcp.authorizeClient")).toBe("Allow or deny an MCP client");
});

test("opSentence uses the contract summary, with a readable fallback", () => {
  expect(opSentence("projects.create")).toBe("Create a project");
  expect(opSentence("gone.doThing")).toBe("Gone: Do thing");
});

test("opModules lists each module once", () => {
  expect(opModules).toContain("services");
  expect(new Set(opModules).size).toBe(opModules.length);
});

test("filtersToInput only sends what is set and turns a module into a prefix", () => {
  expect(filtersToInput(emptyFilters)).toEqual({ limit: 50 });
  const input = filtersToInput({ ...emptyFilters, q: "  deploy ", module: "services", outcome: "error", actorType: "mcp" });
  expect(input).toEqual({ limit: 50, q: "deploy", opId: "services.", outcome: "error", actorType: "mcp" });
});

test("date filters cover whole days", () => {
  const input = filtersToInput({ ...emptyFilters, from: "2026-11-01", to: "2026-11-05" });
  expect(new Date(input.from ?? "").getHours()).toBe(0);
  const to = new Date(input.to ?? "");
  expect([to.getHours(), to.getMinutes()]).toEqual([23, 59]);
});
