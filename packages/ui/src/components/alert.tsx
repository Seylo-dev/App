import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";

const alertVariants = cva("flex items-start gap-3 rounded-control px-4 py-3 text-[13px]", {
  variants: {
    tone: {
      info: "bg-chip-blue-bg text-chip-blue-fg",
      success: "bg-chip-green-bg text-chip-green-fg",
      warning: "bg-chip-amber-bg text-chip-amber-fg",
      danger: "bg-chip-red-bg text-chip-red-fg",
      neutral: "bg-muted text-ink-strong",
    },
  },
  defaultVariants: { tone: "info" },
});

const defaultIcons = {
  info: IconInfoCircle,
  success: IconCircleCheck,
  warning: IconAlertTriangle,
  danger: IconCircleX,
  neutral: IconInfoCircle,
} as const;

export interface AlertProps extends Omit<React.ComponentProps<"div">, "title">, VariantProps<typeof alertVariants> {
  title?: React.ReactNode;
  /** A different icon, or null for none. */
  icon?: React.ReactNode | null;
  /** A button or link on the right. */
  action?: React.ReactNode;
}

/**
 * A tinted callout inside a page or card: warnings ("same env = same DB"),
 * results, hints. role="alert" only for danger, so screen readers are not
 * interrupted by hints.
 */
export function Alert({ className, tone, title, icon, action, children, ...props }: AlertProps) {
  const Icon = defaultIcons[tone ?? "info"];
  return (
    <div data-slot="alert" role={tone === "danger" ? "alert" : "note"} className={cn(alertVariants({ tone }), className)} {...props}>
      {icon !== null && <span className="mt-px flex shrink-0">{icon ?? <Icon size={17} stroke={1.9} />}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <span className="font-semibold">{title}</span>}
        {children && <div className="leading-relaxed [&_a]:font-medium [&_a]:text-current [&_a]:underline">{children}</div>}
      </div>
      {action && <div className="ml-2 flex shrink-0 items-center gap-2 self-center">{action}</div>}
    </div>
  );
}

/** Alias: the same component, for places that read better as a callout. */
export const Callout = Alert;
