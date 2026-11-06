import type * as React from "react";
import { cn } from "../lib/utils";
import { ActiveIndicator } from "./motion";

/**
 * Underlined section tabs (service and database pages). Tabs are links to
 * routes, so the list only provides the look: render the router's Link with
 * `tabClassName`, and a `TabIndicator` inside the current tab (the one with
 * aria-current="page" or data-status="active", what TanStack Router's Link
 * sets). The underline slides from tab to tab.
 */
export function TabList({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav data-slot="tab-list" className={cn("flex flex-wrap gap-1 border-b border-border", className)} {...props} />;
}

export const tabClassName = cn(
  "relative -mb-px border-b-2 border-transparent px-3 py-[9px] text-[13.5px] text-muted-foreground transition-colors hover:text-foreground",
  "aria-[current=page]:text-foreground data-[status=active]:text-foreground",
);

/** The current tab's underline, drawn over its transparent bottom border. `layoutId` names the tab bar. */
export function TabIndicator({ layoutId }: { layoutId: string }) {
  return <ActiveIndicator layoutId={layoutId} className="inset-x-0 top-auto -bottom-0.5 z-0 h-0.5 bg-primary" />;
}
