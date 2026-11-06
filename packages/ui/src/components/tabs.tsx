import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * Underlined section tabs (service and database pages). Tabs are links to
 * routes, so the list only provides the look: render the router's Link with
 * `tabClassName`. The current tab is the one with aria-current="page" or
 * data-status="active" (what TanStack Router's Link sets).
 */
export function TabList({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav data-slot="tab-list" className={cn("flex flex-wrap gap-1 border-b border-border", className)} {...props} />;
}

export const tabClassName = cn(
  "-mb-px border-b-2 border-transparent px-3 py-[9px] text-[13.5px] text-muted-foreground transition-colors hover:text-foreground",
  "aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground",
  "data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground",
);
