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
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-card p-0 outline-none transition-interactive",
        "focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary duration-200 ease-out data-[state=checked]:animate-in data-[state=checked]:zoom-in-50" />
    </RadioPrimitive.Item>
  );
}

/**
 * A bigger choice: a card-like option with a title and description, raised
 * and outlined in primary when selected (builder pickers, plan choices).
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
        "flex cursor-pointer items-start gap-3 rounded-control border-0 bg-raised p-3 text-left shadow-none outline-none transition-interactive",
        "focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-card data-[state=checked]:shadow-[inset_0_0_0_1.5px_var(--primary),var(--shadow-control)]",
        className,
      )}
      {...props}
    >
      {icon && <span className="mt-px flex text-ink-faint">{icon}</span>}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-foreground">{title}</span>
        {description && <span className="text-[12.5px] text-muted-foreground">{description}</span>}
      </span>
    </RadioPrimitive.Item>
  );
}
