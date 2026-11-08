import { ToggleGroup } from "radix-ui";
import * as React from "react";
import { cn } from "../lib/utils";
import { ActiveIndicator } from "./motion";

export interface SegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the group, for example "Time range". */
  "aria-label": string;
  /** "muted" for tracks on a card, "track" for tracks on the page ground. */
  tone?: "muted" | "track";
  className?: string;
  children: React.ReactNode;
  /** The track element, for example scrollFadeRef on a track that scrolls. */
  ref?: React.Ref<HTMLDivElement>;
}

const SegmentedContext = React.createContext<{ value: string; layoutId: string } | null>(null);

/**
 * A segmented control: a quiet track with the selected option raised as a
 * small white pill that slides to the option you pick. Single choice; use
 * for ranges and view switches.
 */
export function Segmented({ value, onValueChange, tone = "muted", className, children, ref, ...rest }: SegmentedProps) {
  // Each control slides its own pill, never one from another control.
  const layoutId = `segmented-${React.useId()}`;
  return (
    <SegmentedContext.Provider value={{ value, layoutId }}>
      <ToggleGroup.Root
        ref={ref}
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
    </SegmentedContext.Provider>
  );
}

export function SegmentedItem({ className, children, ...props }: React.ComponentProps<typeof ToggleGroup.Item>) {
  const group = React.useContext(SegmentedContext);
  return (
    <ToggleGroup.Item
      data-slot="segmented-item"
      className={cn(
        "relative isolate cursor-pointer rounded-chip border-0 bg-transparent px-[11px] py-[5px] text-[12.5px] text-muted-foreground transition-colors",
        "hover:text-foreground data-[state=on]:text-foreground",
        className,
      )}
      {...props}
    >
      {group?.value === props.value && <SegmentPill layoutId={group.layoutId} />}
      {children}
    </ToggleGroup.Item>
  );
}

/**
 * The raised pill behind the selected option of a segmented track. Also for
 * hand-made tracks (a radio group or a row of filter buttons that looks like
 * Segmented): render it inside the selected button, which needs `relative
 * isolate`, with one `layoutId` per track.
 */
export function SegmentPill({ layoutId, className }: { layoutId: string; className?: string }) {
  return <ActiveIndicator layoutId={layoutId} className={cn("rounded-chip bg-card shadow-segment", className)} />;
}
