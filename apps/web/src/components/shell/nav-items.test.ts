import { describe, expect, test } from "bun:test";
import { showApprovals, showAssistant } from "./nav-items";

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

// The Assistant page is in the navigation only while the assistant is there
// for the viewer and the Chat page setting is on (owner request: on by
// default, hidden when off or for people who may not use the assistant).
describe("showAssistant", () => {
  test("shown when the assistant is there and the page is on", () => {
    expect(showAssistant({ available: true, chatPage: true })).toBe(true);
  });
  test("hidden when the page is off, the assistant is not for the viewer, or ai.me has not answered", () => {
    expect(showAssistant({ available: true, chatPage: false })).toBe(false);
    expect(showAssistant({ available: false, chatPage: true })).toBe(false);
    expect(showAssistant(undefined)).toBe(false);
  });
});
