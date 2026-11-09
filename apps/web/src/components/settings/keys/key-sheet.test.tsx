import { expect, test } from "bun:test";
import { renderStatic } from "../../../test/render";
import { CreatedToken } from "./key-sheet";

const token = `sk_${"q".repeat(40)}`;

test("a new MCP token stays dots on screen; an API key shows, as its curl example does anyway", async () => {
  const mcp = await renderStatic(() => <CreatedToken kind="mcp" token={token} example="" />);
  expect(mcp).not.toContain(token);
  expect(mcp).toContain("••••••••");
  const api = await renderStatic(() => <CreatedToken kind="api" token={token} example={`curl -H "Authorization: Bearer ${token}"`} />);
  expect(api).toContain(token);
});
