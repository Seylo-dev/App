import { Progress as ProgressPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

const tones = {
  primary: "bg-primary",
  ok: "bg-status-ok",
  busy: "bg-status-busy",
  error: "bg-status-error",
} as const;

export type ProgressTone = keyof typeof tones;

/** Picks a tone from how full something is: green, then amber past 75%, red past 90%. */
export function usageTone(percent: number): ProgressTone {
  return percent >= 90 ? "error" : percent >= 75 ? "busy" : "ok";
}

/** A thin rounded bar. Pass value 0-100, or omit it for an indeterminate bar. */
export function Progress({
  className,
  value,
  tone = "primary",
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
  value?: number | null;
  tone?: ProgressTone;
  size?: "default" | "sm";
}) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={v}
      className={cn("relative w-full overflow-hidden rounded-full bg-track", size === "sm" ? "h-1" : "h-1.5", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full rounded-full transition-[width] duration-500", tones[tone], v === null && "w-1/3 animate-pulse")}
        style={v === null ? undefined : { width: `${v}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
