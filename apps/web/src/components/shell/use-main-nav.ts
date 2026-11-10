// The main navigation as this panel shows it: every item, except Approvals
// while nothing can ask for one (nav-items.ts showApprovals). The command
// palette lists all of it; the sidebar (useSidebarNav) also leaves out the
// items the person turned off under Settings > Preferences. Both read the
// same cached queries.

import { approvals, auth, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useRouterState } from "@tanstack/react-router";
import { useLiveUp } from "../../lib/live";
import { hiddenSidebarItems } from "../../lib/use-sidebar-items";
import { inSidebar, type MainNavItem, mainNav, showApprovals } from "./nav-items";

export function useMainNav(): { items: MainNavItem[]; pendingCount: number } {
  const features = useOp(system.features, {});
  // The panel filters approvals per person, so this is what waits for the viewer.
  // The panel topic refreshes it the moment a request arrives or is decided; poll only while the socket is down.
  const liveUp = useLiveUp();
  const pending = useOp(approvals.list, { status: "pending", limit: 1 }, { retry: false, refetchInterval: liveUp ? false : 30_000 });
  const pendingCount = pending.data?.pendingCount ?? 0;
  const onApprovals = useRouterState({ select: (state) => state.location.pathname.startsWith("/approvals") });
  const approvalsShown = showApprovals({
    mcpEnabled: features.data?.mcp.enabled,
    aiEnabled: features.data?.ai.enabled,
    pendingCount,
    onApprovals,
  });
  return { items: mainNav.filter((item) => item.id !== "approvals" || approvalsShown), pendingCount };
}

/**
 * What the sidebar lists (nav-items.ts inSidebar): `all` is useMainNav's
 * list, for placeholders of the same count, and `items` is undefined until
 * the person's preferences answer, so an item they turned off never shows
 * for a moment. A failed read hides nothing.
 */
export function useSidebarNav(): { items: MainNavItem[] | undefined; all: MainNavItem[]; pendingCount: number } {
  const { items: all, pendingCount } = useMainNav();
  const preferences = useOp(auth.preferences, {});
  const hidden = hiddenSidebarItems(preferences.data?.preferences);
  return { items: preferences.isPending ? undefined : inSidebar(all, hidden, pendingCount), all, pendingCount };
}
