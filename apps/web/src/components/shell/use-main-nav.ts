// The main navigation as this panel shows it: every item, except Approvals
// while nothing can ask for one (nav-items.ts showApprovals). Shared by the
// sidebar and the command palette; both read the same cached queries.

import { approvals, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useRouterState } from "@tanstack/react-router";
import { useLiveUp } from "../../lib/live";
import { type MainNavItem, mainNav, showApprovals } from "./nav-items";

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
  return { items: mainNav.filter((item) => item.to !== "/approvals" || approvalsShown), pendingCount };
}
