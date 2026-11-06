import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

/** On/off toggle for settings that apply right away. */
export function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { size?: "default" | "sm" }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 bg-track p-0.5 transition-interactive outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        size === "sm" ? "h-4 w-7" : "h-5 w-9",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-card shadow-segment transition-transform duration-200 ease-out data-[state=unchecked]:translate-x-0",
          size === "sm" ? "size-3 data-[state=checked]:translate-x-3" : "size-4 data-[state=checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
