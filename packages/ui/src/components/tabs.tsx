import type * as React from "react";
import { useScrollFadeRef } from "../lib/scroll-fade";
import { cn } from "../lib/utils";
import { ActiveIndicator } from "./motion";

/**
 * Underlined section tabs (service, database and project pages). Tabs are
 * links to routes (or tab buttons), so the list only provides the look:
 * render the router's Link with `tabClassName`, and a `TabIndicator` inside
 * the current tab (the one with aria-current="page" or data-status="active",
 * what TanStack Router's Link sets). The underline slides from tab to tab.
 *
 * One row: when the tabs do not fit (a phone) the row scrolls sideways
 * with no scrollbar, the edge that hides tabs fades, and the current tab is
 * scrolled into view. The track line under the tabs is an inset shadow, so
 * the scrolling row never clips the underline. A list too long for a
 * desktop (an app's 16 service tabs) wraps from md up instead, with a track
 * line per row: a mouse wheel cannot scroll a sideways row.
 */
export function TabList({ className, ref, ...props }: React.ComponentProps<"nav">) {
  const rowRef = useScrollFadeRef(ref);
  return (
    <nav
      ref={rowRef}
      data-slot="tab-list"
      className={cn("scroll-row flex flex-nowrap gap-1 shadow-[inset_0_-1px_0_var(--border)]", className)}
      {...props}
    />
  );
}

export const tabClassName = cn(
  "relative shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-[9px] text-[13.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:-outline-offset-2",
  "aria-[current=page]:text-foreground data-[status=active]:text-foreground",
);

/** The current tab's underline, drawn over its transparent bottom border. `layoutId` names the tab bar. */
export function TabIndicator({ layoutId }: { layoutId: string }) {
  return <ActiveIndicator layoutId={layoutId} className="inset-x-0 top-auto -bottom-0.5 z-0 h-0.5 bg-primary" />;
}
