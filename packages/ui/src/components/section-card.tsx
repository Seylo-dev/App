import type * as React from "react";
import { cn } from "../lib/utils";
import { Card } from "./card";
import { SkeletonText } from "./skeleton";

/**
 * A titled card for one section of a settings or detail page: header with
 * title, description and actions; the content; and an optional footer (a
 * save bar or a hint) on a quiet strip. `flush` drops the content padding
 * for tables and lists that run edge to edge. The title column keeps at
 * least 240px: on a narrow card (a phone) the actions wrap under the title
 * instead of squeezing it to one word per line.
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
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
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

/**
 * A SectionCard while its content loads: the same paddings, a title and
 * description line, and `children` (placeholders shaped like the content)
 * in the content area. Pass `actions` (for example a Skeleton the size of
 * the card's button) and `footer` when the real card has them.
 */
export function SectionCardSkeleton({
  header = true,
  titleWidth = "w-36",
  description = true,
  actions,
  footer,
  flush = false,
  className,
  contentClassName,
  children,
}: {
  /** false for a card without a title row (its content starts at the top padding). */
  header?: boolean;
  titleWidth?: string;
  description?: boolean | string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card aria-hidden="true" className={cn("gap-0 overflow-hidden p-0", className)}>
      {header && (
        <div className={cn("flex flex-wrap items-start gap-3 px-5 pt-[18px]", flush ? "pb-3.5" : "pb-1")}>
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
            <SkeletonText className={cn("text-[15px]", titleWidth)} />
            {description && (
              <SkeletonText
                className={cn("text-[13px] leading-relaxed", typeof description === "string" ? description : "w-2/3 max-w-96")}
              />
            )}
          </div>
          {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("flex flex-col gap-3", flush ? "" : "px-5 pt-3 pb-5", !header && !flush && "pt-5", contentClassName)}>
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider bg-raised px-5 py-3 text-[12.5px]">{footer}</div>
      )}
    </Card>
  );
}
