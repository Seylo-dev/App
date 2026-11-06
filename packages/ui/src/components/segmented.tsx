import { ToggleGroup } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

export interface SegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the group, for example "Time range". */
  "aria-label": string;
  /** "muted" for tracks on a card, "track" for tracks on the page ground. */
  tone?: "muted" | "track";
  className?: string;
  children: React.ReactNode;
}

/**
 * A segmented control: a quiet track with the selected option raised as a
 * small white pill. Single choice; use for ranges and view switches.
 */
export function Segmented({ value, onValueChange, tone = "muted", className, children, ...rest }: SegmentedProps) {
  return (
    <ToggleGroup.Root
      data-slot="segmented"
      type="single"
      value={value}
      // Radix reports "" when the active item is clicked again; a segmented
      // control always keeps one option selected.
      onValueChange={(next) => next && onValueChange(next)}
      aria-label={rest["aria-label"]}
      className={cn("inline-flex gap-0.5 rounded-control p-[3px]", tone === "muted" ? "bg-muted" : "bg-track", className)}
    >
      {children}
    </ToggleGroup.Root>
  );
}

export function SegmentedItem({ className, ...props }: React.ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="segmented-item"
      className={cn(
        "cursor-pointer rounded-chip border-0 bg-transparent px-[11px] py-[5px] text-[12.5px] text-muted-foreground",
        "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-segment",
        className,
      )}
      {...props}
    />
  );
}
