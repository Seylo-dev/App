// Usage history of one node in the node sheet: CPU, memory, disk and
// network, with a range switch. The "node:<id>" live topic refreshes it.

import { metrics } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { useState } from "react";
import { t } from "../../i18n/t";
import { formatBytes, formatPercent, formatPointTime, formatRate } from "../../lib/format";
import { useLiveTopic } from "../../lib/live";
import type { MetricsRange } from "../../lib/types";
import { QueryError } from "../query-error";

const ranges = ["live", "1h", "24h", "7d", "30d"] as const satisfies readonly MetricsRange[];

export function NodeGraphs({ nodeId }: { nodeId: string }) {
  const [range, setRange] = useState<MetricsRange>("1h");
  const usage = useOp(metrics.node, { nodeId, range }, { placeholderData: (previous) => previous });
  useLiveTopic(`node:${nodeId}`);
  const points = usage.data?.series.points ?? [];
  const labels = points.map((point) => formatPointTime(point.t, range === "7d" || range === "30d" || range === "24h"));

  return (
    <section aria-label={t("nodes.sheet.usage")} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.usage")}</h3>
        <Segmented
          aria-label={t("dashboard.timeRange")}
          value={range}
          onValueChange={(v) => setRange(v as MetricsRange)}
          className="ml-auto"
        >
          {ranges.map((r) => (
            <SegmentedItem key={r} value={r}>
              {r === "live" ? t("dashboard.live") : r}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      {usage.isError && !usage.data ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : usage.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Graph
            title={t("dashboard.cpu")}
            labels={labels}
            max={100}
            format={formatPercent}
            series={[{ id: "cpu", label: t("dashboard.cpu"), values: points.map((p) => p.cpuPercent) }]}
          />
          <Graph
            title={t("dashboard.memory")}
            labels={labels}
            max={points.at(-1)?.memoryTotalBytes}
            format={formatBytes}
            series={[{ id: "memory", label: t("dashboard.memory"), values: points.map((p) => p.memoryUsedBytes) }]}
          />
          <Graph
            title={t("nodes.disk")}
            labels={labels}
            format={formatBytes}
            series={[{ id: "disk", label: t("nodes.disk"), values: points.map((p) => p.diskUsedBytes) }]}
          />
          <Graph
            title={t("dashboard.network")}
            labels={labels}
            format={formatRate}
            series={[
              { id: "rx", label: t("nodes.sheet.in"), values: points.map((p) => p.networkRxBytesPerSec) },
              { id: "tx", label: t("nodes.sheet.out"), values: points.map((p) => p.networkTxBytesPerSec) },
            ]}
          />
        </div>
      )}
    </section>
  );
}

function Graph({
  title,
  labels,
  series,
  format,
  max,
}: {
  title: string;
  labels: string[];
  series: { id: string; label: string; values: number[] }[];
  format: (value: number) => string;
  max?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-control bg-raised p-3">
      <span className="text-xs font-medium text-ink-strong">{title}</span>
      <SmoothChart series={series} labels={labels} aria-label={title} height={80} min={0} max={max} formatValue={format} gridLines={2} />
    </div>
  );
}
