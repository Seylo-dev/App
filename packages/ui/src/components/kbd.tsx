import type * as React from "react";
import { cn } from "../lib/utils";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn("rounded-[5px] bg-card px-[5px] py-px font-mono text-[11px] text-ink-strong", className)}
      {...props}
    />
  );
}
