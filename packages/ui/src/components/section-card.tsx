import type * as React from "react";
import { cn } from "../lib/utils";
import { Card } from "./card";

/**
 * A titled card for one section of a settings or detail page: header with
 * title, description and actions; the content; and an optional footer (a
 * save bar or a hint) on a quiet strip. `flush` drops the content padding
 * for tables and lists that run edge to edge.
 */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  flush = false,
  danger = false,
  className,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  flush?: boolean;
  /** Danger zone: a red title for delete and transfer sections. */
  danger?: boolean;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden p-0", className)} {...props}>
      {(title || actions) && (
        <div className={cn("flex flex-wrap items-start gap-3 px-5 pt-[18px]", flush ? "pb-3.5" : "pb-1")}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title && <h2 className={cn("m-0 text-[15px] font-semibold", danger && "text-chip-red-fg")}>{title}</h2>}
            {description && <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("flex flex-col gap-3", flush ? "" : "px-5 pt-3 pb-5", !title && !actions && !flush && "pt-5", contentClassName)}>
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider bg-raised px-5 py-3 text-[12.5px] text-muted-foreground">
          {footer}
        </div>
      )}
    </Card>
  );
}
