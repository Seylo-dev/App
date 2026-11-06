import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

/** Small tinted label: statuses, kinds, node names, counts. */
export const chipVariants = cva("inline-flex items-center gap-1.5 whitespace-nowrap rounded-chip px-2 py-[3px] text-xs font-medium", {
  variants: {
    tone: {
      blue: "bg-chip-blue-bg text-chip-blue-fg",
      sky: "bg-chip-sky-bg text-chip-sky-fg",
      red: "bg-chip-red-bg text-chip-red-fg",
      violet: "bg-chip-violet-bg text-chip-violet-fg",
      gray: "bg-chip-gray-bg text-chip-gray-fg",
      green: "bg-chip-green-bg text-chip-green-fg",
      amber: "bg-chip-amber-bg text-chip-amber-fg",
      /** Slightly stronger neutral, used for node names. */
      track: "bg-track text-ink-strong",
    },
    mono: { true: "font-mono", false: "" },
  },
  defaultVariants: { tone: "gray", mono: false },
});

export interface ChipProps extends React.ComponentProps<"span">, VariantProps<typeof chipVariants> {}

export function Chip({ className, tone, mono, ...props }: ChipProps) {
  return <span data-slot="chip" className={cn(chipVariants({ tone, mono }), className)} {...props} />;
}

const dotTones = {
  ok: "bg-status-ok",
  busy: "bg-status-busy",
  error: "bg-status-error",
  off: "bg-status-off",
} as const;

/** A 6px status dot; `pulse` for things that are live right now. */
export function StatusDot({ status, pulse = false, className }: { status: keyof typeof dotTones; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", dotTones[status], pulse && "animate-pulse", className)}
    />
  );
}
