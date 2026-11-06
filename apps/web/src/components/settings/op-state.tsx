// How a settings screen shows a query that is loading or failed. Every op
// can answer NOT_IMPLEMENTED while the panel side is being built, and
// FORBIDDEN for people without the action, so both get their own wording
// instead of a generic error.

import { OpError } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconHammer, IconLock } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type * as React from "react";
import { t } from "../../i18n/t";
import { isReauthCancelled } from "../../lib/reauth";

export function errorText(error: unknown): string {
  if (error instanceof OpError) {
    if (error.code === "NOT_IMPLEMENTED") return t("settings.state.notBuilt");
    if (error.code === "FORBIDDEN") return t("settings.state.forbidden");
    return error.message;
  }
  return t("common.unknownError");
}

/** Toast for a failed mutation; the message is safe to show (OpError messages are written for people). */
export function toastError(error: unknown, title?: string): void {
  // The person closed the re-auth dialog: nothing failed, nothing to say.
  if (isReauthCancelled(error)) return;
  toast.error(title ?? t("settings.state.saveFailed"), { description: errorText(error) });
}

export function OpErrorCallout({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const code = error instanceof OpError ? error.code : null;
  if (code === "NOT_IMPLEMENTED") {
    return (
      <Alert tone="neutral" icon={<IconHammer size={16} stroke={1.8} />} title={t("settings.state.notBuiltTitle")} className={className}>
        {t("settings.state.notBuilt")}
      </Alert>
    );
  }
  if (code === "FORBIDDEN") {
    return (
      <Alert tone="neutral" icon={<IconLock size={16} stroke={1.8} />} title={t("settings.state.forbiddenTitle")} className={className}>
        {t("settings.state.forbidden")}
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      title={t("settings.state.loadFailed")}
      className={className}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )
      }
    >
      {errorText(error)}
    </Alert>
  );
}

/**
 * Renders a query: skeleton lines while loading, the error callout on
 * failure, else the children with the data.
 */
export function QueryView<T>({
  query,
  skeletonRows = 3,
  className,
  children,
}: {
  query: Pick<UseQueryResult<T, unknown>, "data" | "error" | "isPending" | "refetch">;
  skeletonRows?: number;
  className?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingLines rows={skeletonRows} className={className} />;
  if (query.error || query.data === undefined)
    return <OpErrorCallout error={query.error} onRetry={() => void query.refetch()} className={className} />;
  return <>{children(query.data)}</>;
}

export function LoadingLines({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" className={cn("flex flex-col gap-2.5", className)} aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows.
        <Skeleton key={i} className={cn("h-9", i % 2 === 1 && "w-4/5")} />
      ))}
    </div>
  );
}
