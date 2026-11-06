// Node health checks (the heart icon): the last report with every check's
// result and, for warnings and failures, what to do about it. "Run checks
// now" runs them on the node and stores the new report.

import { nodes } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconAlertTriangle, IconCircleCheck, IconCircleMinus, IconCircleX, IconHeart } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { queryClient } from "../../lib/api";
import { formatAgo } from "../../lib/format";
import type { HealthReport } from "../../lib/types";
import { QueryError } from "../query-error";

type Check = HealthReport["results"][number];

const checkIcon = {
  pass: { Icon: IconCircleCheck, className: "text-status-ok" },
  warn: { Icon: IconAlertTriangle, className: "text-status-busy" },
  fail: { Icon: IconCircleX, className: "text-status-error" },
  skipped: { Icon: IconCircleMinus, className: "text-ink-faint" },
} as const;

// Failures first, then warnings, so the things to fix are on top.
const order = { fail: 0, warn: 1, pass: 2, skipped: 3 } as const;

export function NodeHealth({ nodeId }: { nodeId: string }) {
  const report = useOp(nodes.healthReport, { nodeId });
  const run = useOpMutation(nodes.runHealthCheck, {
    onSuccess: (fresh) => {
      queryClient.setQueryData(opQueryKey(nodes.healthReport, { nodeId }), fresh);
      void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.list) });
    },
  });

  const data = report.data;
  const results = [...(data?.results ?? [])].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {data?.checkedAt ? (
          <>
            {data.summary.fail > 0 && <Chip tone="red">{t("nodes.healthCheck.failCount", { count: data.summary.fail })}</Chip>}
            {data.summary.warn > 0 && <Chip tone="amber">{t("nodes.healthCheck.warnCount", { count: data.summary.warn })}</Chip>}
            <Chip tone="green">{t("nodes.healthCheck.passCount", { count: data.summary.pass })}</Chip>
            <span className="text-xs text-muted-foreground">{t("nodes.healthCheck.checkedAgo", { when: formatAgo(data.checkedAt) })}</span>
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("nodes.healthCheck.never")}</span>
        )}
        <Button size="sm" variant="primary" className="ml-auto" disabled={run.isPending} onClick={() => run.mutate({ nodeId })}>
          <IconHeart size={15} aria-hidden="true" />
          {run.isPending ? t("nodes.healthCheck.running") : t("nodes.healthCheck.runNow")}
        </Button>
      </div>
      {run.error && <QueryError error={run.error} />}
      {report.isError ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : report.isPending ? (
        <Skeleton className="h-40" />
      ) : results.length === 0 ? (
        <EmptyState
          compact
          icon={<IconHeart />}
          title={t("nodes.healthCheck.noResults")}
          description={t("nodes.healthCheck.noResultsHint")}
        />
      ) : (
        <ul aria-label={t("nodes.health")} className="m-0 flex list-none flex-col gap-2 p-0">
          {results.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  const { Icon, className } = checkIcon[check.status];
  const needsFix = check.status === "fail" || check.status === "warn";
  return (
    <li className={cn("flex gap-3 rounded-control p-3", needsFix ? "bg-raised" : "")}>
      <Icon size={18} stroke={1.9} className={cn("mt-px shrink-0", className)} aria-label={t(`nodes.healthCheck.status.${check.status}`)} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13.5px] font-medium">{check.title}</span>
        {check.detail && <span className="text-[12.5px] text-muted-foreground">{check.detail}</span>}
        {needsFix && check.fixHint && (
          <span className="text-[12.5px] text-ink-strong">
            <b className="font-semibold">{t("nodes.healthCheck.fix")}</b> {check.fixHint}
          </span>
        )}
      </div>
    </li>
  );
}
