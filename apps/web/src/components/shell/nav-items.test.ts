import { describe, expect, test } from "bun:test";
import { showApprovals } from "./nav-items";

// Only MCP tools and the AI assistant ask for approvals, so Approvals stays
// out of the navigation until one of them is on (owner request), unless
// something waits for the viewer or the page is open.
describe("showApprovals", () => {
  const off = { mcpEnabled: false, aiEnabled: false, pendingCount: 0, onApprovals: false };
  test("hidden while MCP and the assistant are off and nothing waits", () => {
    expect(showApprovals(off)).toBe(false);
    expect(showApprovals({ ...off, mcpEnabled: undefined, aiEnabled: undefined })).toBe(false);
  });
  test("shown once MCP or the assistant is on", () => {
    expect(showApprovals({ ...off, mcpEnabled: true })).toBe(true);
    expect(showApprovals({ ...off, aiEnabled: true })).toBe(true);
  });
  test("shown while something waits or the page is open", () => {
    expect(showApprovals({ ...off, pendingCount: 1 })).toBe(true);
    expect(showApprovals({ ...off, onApprovals: true })).toBe(true);
  });
});
