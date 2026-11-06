import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { popperMotion } from "../lib/overlay-motion";
import { cn } from "../lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = "center",
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 w-72 rounded-card bg-popover p-4 text-[13px] text-popover-foreground shadow-popover outline-none",
          "origin-(--radix-popover-content-transform-origin)",
          popperMotion,
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
