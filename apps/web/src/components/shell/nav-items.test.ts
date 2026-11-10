import { describe, expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { canHide, inSidebar, mainNav, showApprovals, showAssistant } from "./nav-items";

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

// Settings > Preferences turns sidebar items off per person (owner request).
// Settings never goes, so the switches to bring the others back stay in
// reach, and a pending approval never leaves the sidebar.
describe("inSidebar", () => {
  const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

  test("nothing turned off: every item the navigation shows", () => {
    expect(ids(inSidebar(mainNav, new Set(), 0))).toEqual([
      "dashboard",
      "nodes",
      "templates",
      "activity",
      "assistant",
      "approvals",
      "settings",
    ]);
  });

  test("turned-off items leave, in order, and Settings always stays", () => {
    expect(ids(inSidebar(mainNav, new Set(["templates", "activity"]), 0))).toEqual([
      "dashboard",
      "nodes",
      "assistant",
      "approvals",
      "settings",
    ]);
    // Even a list that names it (the panel never stores one), and with everything else off.
    expect(ids(inSidebar(mainNav, new Set(["settings"]), 0))).toEqual([
      "dashboard",
      "nodes",
      "templates",
      "activity",
      "assistant",
      "approvals",
      "settings",
    ]);
    expect(ids(inSidebar(mainNav, new Set([...auth.sidebarItems, "settings"]), 0))).toEqual(["settings"]);
  });

  test("Approvals turned off still shows while a request waits", () => {
    expect(ids(inSidebar(mainNav, new Set(["approvals"]), 0))).not.toContain("approvals");
    expect(ids(inSidebar(mainNav, new Set(["approvals"]), 1))).toContain("approvals");
    // A request waiting does not bring back other items.
    expect(ids(inSidebar(mainNav, new Set(["approvals", "templates"]), 3))).toEqual([
      "dashboard",
      "nodes",
      "activity",
      "assistant",
      "approvals",
      "settings",
    ]);
  });

  test("only hides: an item the navigation leaves out (Approvals with MCP and the assistant off) stays out when on", () => {
    const withoutApprovals = mainNav.filter((item) => item.id !== "approvals");
    expect(ids(inSidebar(withoutApprovals, new Set(), 0))).toEqual([
      "dashboard",
      "nodes",
      "templates",
      "activity",
      "assistant",
      "settings",
    ]);
    expect(ids(inSidebar(withoutApprovals, new Set(["templates"]), 0))).toEqual([
      "dashboard",
      "nodes",
      "activity",
      "assistant",
      "settings",
    ]);
  });

  test("every item but Settings has a switch, and the panel keeps each of their names", () => {
    expect(mainNav.filter(canHide).map((item) => item.id)).toEqual([...auth.sidebarItems]);
    expect(mainNav.filter((item) => !canHide(item)).map((item) => item.id)).toEqual(["settings"]);
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
