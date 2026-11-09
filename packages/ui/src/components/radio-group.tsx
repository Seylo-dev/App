import { RadioGroup as RadioPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";

export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioPrimitive.Root>) {
  return <RadioPrimitive.Root data-slot="radio-group" className={cn("grid gap-2.5", className)} {...props} />;
}

export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioPrimitive.Item>) {
  return (
    <RadioPrimitive.Item
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-control-off bg-card p-0 outline-none transition-interactive",
        "focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" />
    </RadioPrimitive.Item>
  );
}

/**
 * A bigger choice: a card-like option with a title and description on a
 * quiet fill, tinted with the accent when selected (builder pickers, plan
 * choices). Fill only, no outline. The icon sits centered on the text.
 */
export function RadioCard({
  className,
  title,
  description,
  icon,
  ...props
}: Omit<React.ComponentProps<typeof RadioPrimitive.Item>, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <RadioPrimitive.Item
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-control border-0 bg-raised p-3 text-left shadow-none outline-none transition-interactive hover-enabled:bg-muted",
        "focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-accent data-[state=checked]:hover-enabled:bg-accent",
        className,
      )}
      {...props}
    >
      {icon && <span className="flex text-ink-faint group-data-[state=checked]:text-accent-foreground">{icon}</span>}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-foreground transition-colors group-data-[state=checked]:text-accent-foreground">
          {title}
        </span>
        {description && <span className="text-[12.5px] text-muted-foreground">{description}</span>}
      </span>
    </RadioPrimitive.Item>
  );
}
