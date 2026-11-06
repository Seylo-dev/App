import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * What a list or screen shows when it has nothing yet: an icon in a tinted
 * circle, a short title, one sentence and the action that fills it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Less padding, for empty tables and small cards. */
  compact?: boolean;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn("flex flex-col items-center gap-2 text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}
    >
      {icon && (
        <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground [&_svg]:size-5">
          {icon}
        </span>
      )}
      <h3 className="m-0 text-[14.5px] font-semibold text-foreground">{title}</h3>
      {description && <p className="m-0 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
