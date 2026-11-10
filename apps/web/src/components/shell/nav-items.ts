// The sidebar's main navigation, shared with the command palette.

import type { auth } from "@seylo/ops";
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconHome,
  IconLayoutGrid,
  IconServer2,
  IconShieldCheck,
  IconSparkles,
} from "@tabler/icons-react";
import type { MessageKey } from "../../i18n/t";

export const mainNav = [
  { id: "dashboard", to: "/", label: "nav.dashboard", icon: IconHome, exact: true },
  { id: "nodes", to: "/nodes", label: "nav.nodes", icon: IconServer2, exact: false },
  { id: "templates", to: "/templates", label: "nav.templates", icon: IconLayoutGrid, exact: false },
  { id: "activity", to: "/activity", label: "nav.activity", icon: IconActivity, exact: false },
  { id: "assistant", to: "/assistant", label: "nav.assistant", icon: IconSparkles, exact: false },
  { id: "approvals", to: "/approvals", label: "nav.approvals", icon: IconShieldCheck, exact: false },
  { id: "settings", to: "/settings", label: "nav.settings", icon: IconAdjustmentsHorizontal, exact: false },
] as const satisfies readonly { id: auth.SidebarItemName | "settings"; to: string; label: MessageKey; icon: unknown; exact: boolean }[];

export type MainNavItem = (typeof mainNav)[number];

/**
 * Whether Approvals belongs in the navigation. Only MCP tools and the AI
 * assistant ask for approvals, so the page shows once either is on, and
 * always while something waits for the viewer or the page is open (a link
 * or a bookmark), so a request never sits out of sight.
 */
export function showApprovals(state: {
  mcpEnabled: boolean | undefined;
  aiEnabled: boolean | undefined;
  pendingCount: number;
  onApprovals: boolean;
}): boolean {
  return state.mcpEnabled === true || state.aiEnabled === true || state.pendingCount > 0 || state.onApprovals;
}

/** Whether a person can take the item out of their sidebar: every item but Settings, which holds the switches. */
export function canHide(item: { id: string }): boolean {
  return item.id !== "settings";
}

/**
 * The items the sidebar lists: the ones the main navigation shows (each
 * keeps its own rule, such as showApprovals) minus the ones the person
 * turned off under Settings > Preferences. Settings always stays, and
 * Approvals comes back while a request waits for the viewer, so a pending
 * approval is never out of sight. Only takes items away; the command
 * palette lists them all.
 */
export function inSidebar<I extends { id: string }>(items: readonly I[], hidden: ReadonlySet<string>, pendingCount: number): I[] {
  return items.filter((item) => !canHide(item) || !hidden.has(item.id) || (item.id === "approvals" && pendingCount > 0));
}

/**
 * Whether the Assistant page belongs in the navigation: the assistant is
 * there for the viewer (ai.me) and the Chat page setting is on. While
 * ai.me has not answered it stays out, so it never flashes in and out.
 */
export function showAssistant(me: { available: boolean; chatPage: boolean } | undefined): boolean {
  return me?.available === true && me.chatPage;
}
