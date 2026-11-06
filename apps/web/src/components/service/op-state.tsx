// How a service screen shows a query that is loading or failed. Ops that
// the panel does not implement yet answer NOT_IMPLEMENTED (501); those get
// a calm "not available yet" note instead of an error, so an unfinished
// backend is never mistaken for a broken screen.

import { OpError } from "@seylo/ops";
import { Callout } from "@seylo/ui/components/alert";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconHammer } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";

export function isNotBuilt(error: unknown): boolean {
  return error instanceof OpError && error.code === "NOT_IMPLEMENTED";
}

export function isUnavailable(error: unknown): boolean {
  return error instanceof OpError && error.code === "UNAVAILABLE";
}

/** Query retry rule: never retry client errors or unbuilt ops, retry the rest once. */
export function retryOp(failureCount: number, error: unknown): boolean {
  if (error instanceof OpError && error.status < 500) return false;
  if (isNotBuilt(error)) return false;
  return failureCount < 1;
}

/** The error of a failed query or mutation, as a callout. */
export function OpErrorNote({ error, className, compact = false }: { error: unknown; className?: string; compact?: boolean }) {
  if (isNotBuilt(error)) {
    return (
      <Callout tone="neutral" icon={<IconHammer size={16} stroke={1.8} />} className={className}>
        <span className="font-medium text-foreground">{t("service.notBuilt.title")}</span>
        {!compact && <span className="block text-muted-foreground">{t("service.notBuilt.body")}</span>}
      </Callout>
    );
  }
  return (
    <Callout tone={isUnavailable(error) ? "warning" : "danger"} className={className}>
      {errorMessage(error, t("service.loadFailed"))}
    </Callout>
  );
}

/**
 * Renders children with the data once a query succeeded; a skeleton while
 * it loads and OpErrorNote when it failed.
 */
export function OpView<T>({
  query,
  children,
  skeleton,
  className,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined };
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  className?: string;
}) {
  if (query.isPending) return <>{skeleton ?? <Skeleton className={cn("h-28 w-full rounded-card", className)} />}</>;
  if (query.isError || query.data === undefined) return <OpErrorNote error={query.error} className={className} />;
  return <>{children(query.data)}</>;
}

/** Inline error line under a form after a mutation failed. */
export function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="m-0 text-[13px] text-chip-red-fg">
      {isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed"))}
    </p>
  );
}
