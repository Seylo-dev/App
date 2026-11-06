import type * as React from "react";
import { cn } from "../lib/utils";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        "h-[38px] w-full min-w-0 rounded-control border border-input bg-card px-3 text-[13.5px] text-foreground outline-none transition-interactive placeholder:text-ink-ghost",
        "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/15 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control.
  return <label data-slot="label" className={cn("text-[13px] font-medium text-ink-strong", className)} {...props} />;
}
