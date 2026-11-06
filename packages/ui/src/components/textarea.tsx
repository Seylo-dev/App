import type * as React from "react";
import { cn } from "../lib/utils";

export function Textarea({ className, mono = false, ...props }: React.ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full min-w-0 resize-y rounded-control border border-input bg-card px-3 py-2.5 text-[13.5px] leading-relaxed text-foreground outline-none transition-interactive placeholder:text-ink-ghost",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        mono && "font-mono text-[12.5px]",
        className,
      )}
      {...props}
    />
  );
}
