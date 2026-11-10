import { expect, test } from "bun:test";
import { allOps } from "@seylo/ops";
import { t } from "../../../i18n/t";

// The panel holds only kind "destructive" ops from MCP tokens for a
// person's approval (apps/panel/src/ops/pipeline.ts), and none while "Ask
// before destructive actions" is off; every other change a read-and-change
// token asks for runs right away. The words where an owner decides to hand
// out such a token must say that.
test("the MCP token and server copy say that only deleting waits for approval", () => {
  const runsRightAway = allOps.filter((op) => op.mcp && op.kind === "mutation").map((op) => op.id);
  expect(runsRightAway).toEqual(expect.arrayContaining(["env.set", "deployments.deploy", "domains.add", "files.write"]));
  const waits = allOps.filter((op) => op.mcp && op.kind === "destructive").map((op) => op.id);
  expect(waits).toEqual(expect.arrayContaining(["services.delete", "backups.restore"]));

  const writes = t("settingsKeys.create.mcpWrites");
  expect(writes).toContain("run right away");
  expect(writes).toContain("Deleting something");
  expect(writes).not.toMatch(/^Changes .* wait/);

  for (const key of ["settingsKeys.mcp.safety.readOnlyAsk", "settingsKeys.mcp.safety.writeAsk"] as const) {
    const safety = t(key);
    expect(safety).not.toContain("changes or deletes something waits");
    expect(safety).toContain("deletes something or changes it for good");
    expect(safety).toContain("waits until a person approves it");
  }

  // With the switch off nothing waits, and the words say so instead of promising an approval.
  for (const key of [
    "settingsKeys.create.mcpWritesNoAsk",
    "settingsKeys.mcp.safety.readOnlyNoAsk",
    "settingsKeys.mcp.safety.writeNoAsk",
  ] as const) {
    const text = t(key);
    expect(text).toContain("right away");
    expect(text).not.toContain("approv");
    expect(text).toContain("activity log");
  }
});
