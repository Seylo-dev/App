import { ToggleGroup } from "radix-ui";
import * as React from "react";
import { useScrollFadeRef } from "../lib/scroll-fade";
import { cn } from "../lib/utils";
import { ActiveIndicator } from "./motion";

export type SegmentedTone = "muted" | "track" | "terminal";

export interface SegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the group, for example "Time range". */
  "aria-label": string;
  /** "muted" for tracks on a card, "track" for tracks on the page ground, "terminal" in a terminal's dark header. */
  tone?: SegmentedTone;
  className?: string;
  children: React.ReactNode;
  /** The track element. The track already scrolls with faded edges when it does not fit (scrollFadeRef). */
  ref?: React.Ref<HTMLDivElement>;
}

const SegmentedContext = React.createContext<{ value: string; layoutId: string; tone: SegmentedTone } | null>(null);

const trackTone: Record<SegmentedTone, string> = { muted: "bg-muted", track: "bg-track", terminal: "bg-terminal" };

const lightItem = "text-muted-foreground hover:text-foreground data-[state=on]:text-foreground";
const itemTone: Record<SegmentedTone, string> = {
  muted: lightItem,
  track: lightItem,
  terminal: "text-terminal-muted hover:text-terminal-foreground data-[state=on]:text-terminal-foreground",
};

/**
 * A segmented control: a quiet track with the selected option raised as a
 * small white pill that slides to the option you pick. Single choice; use
 * for ranges and view switches. 32px tall, the height of a small button,
 * so it lines up with the buttons and chips next to it. Options never wrap;
 * a track wider than its row scrolls (scroll-row with scrollFadeRef).
 */
export function Segmented({ value, onValueChange, tone = "muted", className, children, ref, ...rest }: SegmentedProps) {
  // Each control slides its own pill, never one from another control.
  const layoutId = `segmented-${React.useId()}`;
  const trackRef = useScrollFadeRef(ref);
  return (
    <SegmentedContext.Provider value={{ value, layoutId, tone }}>
      <ToggleGroup.Root
        ref={trackRef}
        data-slot="segmented"
        type="single"
        value={value}
        // Radix reports "" when the active item is clicked again; a segmented
        // control always keeps one option selected.
        onValueChange={(next) => next && onValueChange(next)}
        aria-label={rest["aria-label"]}
        className={cn("scroll-row inline-flex max-w-full gap-0.5 rounded-control p-[3px]", trackTone[tone], className)}
      >
        {children}
      </ToggleGroup.Root>
    </SegmentedContext.Provider>
  );
}

export function SegmentedItem({ className, children, ...props }: React.ComponentProps<typeof ToggleGroup.Item>) {
  const group = React.useContext(SegmentedContext);
  const tone = group?.tone ?? "muted";
  return (
    <ToggleGroup.Item
      data-slot="segmented-item"
      className={cn(
        "relative isolate inline-flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-chip border-0 bg-transparent px-[11px] py-0 text-[12.5px] transition-colors focus-visible:-outline-offset-2",
        itemTone[tone],
        className,
      )}
      {...props}
    >
      {group?.value === props.value && (
        <SegmentPill layoutId={group.layoutId} className={tone === "terminal" ? "bg-terminal-field shadow-none" : undefined} />
      )}
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
  return <ActiveIndicator layoutId={layoutId} className={cn("rounded-chip bg-pill shadow-segment", className)} />;
}
