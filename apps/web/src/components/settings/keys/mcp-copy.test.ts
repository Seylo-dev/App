import { expect, test } from "bun:test";
import { allOps } from "@seylo/ops";
import { t } from "../../../i18n/t";

// The panel holds only kind "destructive" ops from MCP tokens for a
// person's approval (apps/panel/src/ops/pipeline.ts); every other change a
// read-and-change token asks for runs right away. The words where an owner
// decides to hand out such a token must say that.
test("the MCP token and server copy say that only deleting waits for approval", () => {
  const runsRightAway = allOps.filter((op) => op.mcp && op.kind === "mutation").map((op) => op.id);
  expect(runsRightAway).toEqual(expect.arrayContaining(["env.set", "deployments.deploy", "domains.add", "files.write"]));
  const waits = allOps.filter((op) => op.mcp && op.kind === "destructive").map((op) => op.id);
  expect(waits).toEqual(expect.arrayContaining(["services.delete", "backups.restore"]));

  const writes = t("settingsKeys.create.mcpWrites");
  expect(writes).toContain("run right away");
  expect(writes).toContain("Deleting something");
  expect(writes).not.toMatch(/^Changes .* wait/);

  const safety = t("settingsKeys.mcp.safety");
  expect(safety).not.toContain("changes or deletes something waits");
  expect(safety).toContain("deletes something or changes it for good waits");
});
