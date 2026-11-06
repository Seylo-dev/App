import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * The title row at the top of a screen: optional breadcrumb above, a
 * leading icon or avatar, the title and subtitle, and actions on the right
 * (they wrap under the title on narrow screens).
 */
export function PageHeader({
  title,
  subtitle,
  leading,
  actions,
  breadcrumb,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-2.5", className)}>
      {breadcrumb && (
        <nav className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground [&_a]:text-muted-foreground [&_a:hover]:text-foreground">
          {breadcrumb}
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <div className="m-0 text-[13.5px] text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}
