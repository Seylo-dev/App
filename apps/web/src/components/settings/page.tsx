// Building blocks every settings screen shares: the title row (h1 and one
// line under it, as in the Notifications and Appearance boards), labelled
// fields and a two-column form grid that folds to one column on phones.

import { cn } from "@seylo/ui/lib/utils";
import type * as React from "react";

export function SettingsPage({
  title,
  subtitle,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="m-0 text-[13.5px] text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** A label above its control, with an optional hint or error below. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  span,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  /** Take both columns of a FormGrid. */
  span?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", span && "sm:col-span-2", className)}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-strong">
        {label}
      </label>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-chip-red-fg">
          {error}
        </span>
      ) : (
        hint && <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

export function FormGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", className)}>{children}</div>;
}

/**
 * A row with a title and description on the left and a control (switch,
 * button) on the right. The text keeps at least 220px: a wide control (a
 * select, a segmented track) moves under it on a phone instead of
 * squeezing the description into a narrow column; a switch stays beside it.
 */
export function SettingRow({
  title,
  description,
  control,
  stack,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  /** Always put the control under the text on a phone, even when it would fit beside it (a select, not a switch). */
  stack?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-divider py-3 first:border-t-0 first:pt-0",
        stack && "max-sm:flex-col max-sm:items-stretch",
        className,
      )}
    >
      {/* In a stacked column the 220px basis would be a height, so it drops back to auto there. */}
      <div className={cn("flex min-w-0 flex-[1_1_220px] flex-col gap-0.5", stack && "max-sm:flex-auto")}>
        <span className="text-[13.5px] font-medium">{title}</span>
        {description && <span className="text-[12.5px] text-muted-foreground">{description}</span>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** Form actions aligned right, as in the boards. */
export function FormActions({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-wrap justify-end gap-2 pt-1", className)}>{children}</div>;
}
