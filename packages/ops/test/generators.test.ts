import { expect, test } from "bun:test";
import { allOps, auth, projects } from "../src";
import { buildAiTools, buildMcpTools, buildOpenApi } from "../src/generators";

const doc = buildOpenApi(allOps, { title: "Test", version: "0.0.0", sessionCookie: "sid" }) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

test("OpenAPI has one path per op with the right method", () => {
  expect(Object.keys(doc.paths).length).toBe(allOps.length);
  expect(doc.paths["/api/v1/projects.list"]?.get?.operationId).toBe("projects.list");
  expect(doc.paths["/api/v1/projects.create"]?.post?.operationId).toBe("projects.create");
});

test("public ops need no auth and others accept a session or API key", () => {
  expect(doc.paths["/api/v1/auth.login"]?.post?.security).toEqual([]);
  expect(doc.paths["/api/v1/projects.create"]?.post?.security).toEqual([{ session: [] }, { apiKey: [] }]);
});

test("OpenAPI is plain JSON", () => {
  expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
});

test("MCP tools cover only mcp ops and mark destructive ones", () => {
  const tools = buildMcpTools(allOps);
  expect(tools.map((t) => t.name)).not.toContain("auth_login");
  const del = tools.find((t) => t.name === "projects_delete");
  expect(del?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
});

test("AI tools need approval for everything except queries", () => {
  const tools = buildAiTools(allOps);
  expect(tools.find((t) => t.opId === projects.list.id)?.needsApproval).toBe(false);
  expect(tools.find((t) => t.opId === projects.create.id)?.needsApproval).toBe(true);
  expect(tools.some((t) => t.opId === auth.login.id)).toBe(false);
});
