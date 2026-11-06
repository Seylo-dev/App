import type * as React from "react";
import { cn } from "../lib/utils";
import { Sparkline } from "./sparkline";

export interface StatTileProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Small text after the value ("%", "GB", "of 16 GB"). */
  unit?: React.ReactNode;
  /** A line under the value ("3 nodes", "since yesterday"). */
  hint?: React.ReactNode;
  /** A change chip; tone says whether the change is good. */
  delta?: { value: React.ReactNode; tone: "good" | "bad" | "neutral" };
  icon?: React.ReactNode;
  /** Trend under the value. */
  spark?: readonly (number | null)[];
  sparkColor?: string;
  /** Render as a bare block inside another card instead of its own card. */
  bare?: boolean;
  className?: string;
}

const deltaTones = {
  good: "bg-chip-green-bg text-chip-green-fg",
  bad: "bg-chip-red-bg text-chip-red-fg",
  neutral: "bg-chip-gray-bg text-chip-gray-fg",
} as const;

/** One number with its label: service overview, node facts, usage totals. */
export function StatTile({ label, value, unit, hint, delta, icon, spark, sparkColor, bare = false, className }: StatTileProps) {
  return (
    <div
      data-slot="stat-tile"
      className={cn("flex min-w-0 flex-col gap-1.5", !bare && "rounded-card bg-card px-[18px] py-4 shadow-card", className)}
    >
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        {icon && <span className="flex text-ink-faint [&_svg]:size-4">{icon}</span>}
        <span className="truncate">{label}</span>
        {delta && (
          <span className={cn("ml-auto rounded-chip px-1.5 py-px text-[11.5px] font-medium", deltaTones[delta.tone])}>{delta.value}</span>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold tracking-[-0.02em] text-foreground tabular-nums">{value}</span>
        {unit && <span className="text-[13px] text-muted-foreground">{unit}</span>}
      </div>
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      {spark && <Sparkline values={spark} color={sparkColor} height={28} className="mt-1" />}
    </div>
  );
}
