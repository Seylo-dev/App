import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { Select as SelectPrimitive } from "radix-ui";
import type * as React from "react";
import { popperMotion } from "../lib/overlay-motion";
import { cn } from "../lib/utils";
import { SkeletonText } from "./skeleton";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

/**
 * Looks like Input: 38px, white, hairline border. size="sm" for toolbars.
 * `loading` while the options are on their way: a skeleton line stands in
 * for the value (never a "Loading" placeholder) and the trigger stays shut.
 */
export function SelectTrigger({
  className,
  children,
  size = "default",
  loading = false,
  disabled,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "default" | "sm"; loading?: boolean }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-control border border-input bg-card px-3 text-left text-[13.5px] text-foreground outline-none transition-interactive",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[placeholder]:text-ink-ghost",
        "[&>span]:truncate",
        size === "sm" ? "h-8 text-[12.5px]" : "h-[38px]",
        // A loading trigger is shut, not unavailable: no faded look.
        loading && "disabled:cursor-progress disabled:opacity-100",
        className,
      )}
      {...props}
    >
      {loading ? <SkeletonText className="w-28" /> : children}
      <SelectPrimitive.Icon asChild>
        <IconChevronDown size={15} className="shrink-0 text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={6}
        className={cn(
          "z-50 max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-control bg-popover text-popover-foreground shadow-popover",
          "origin-(--radix-select-content-transform-origin)",
          popperMotion,
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-chip py-[7px] pr-8 pl-2.5 text-[13px] text-ink-strong outline-none transition-interactive",
        "data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex">
        <IconCheck size={14} stroke={2.2} className="text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-muted-foreground", className)} {...props} />;
}

export function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-divider", className)} {...props} />;
}
