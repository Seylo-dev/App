// The "Nodes" card on the dashboard (Main.dc.html): CPU, memory and
// network per node as smooth graphs, one line per node. The node chips in
// the header show or hide a node's line in all three graphs at once. The
// live topic "panel" invalidates metrics.nodes on every sample, so the
// graphs move by themselves.

import { metrics, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card, CardHeader, CardTitle } from "@seylo/ui/components/card";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { type ChartSeries, SmoothChart, seriesColor, toggleHidden } from "@seylo/ui/components/smooth-chart";
import { cn } from "@seylo/ui/lib/utils";
import { IconServer2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { formatPercent, formatPointTime, formatRate, formatUsedOfTotal } from "../../lib/format";
import type { MetricsRange, NodeSeries } from "../../lib/types";
import { QueryError } from "../query-error";

const ranges = ["1h", "24h", "7d"] as const satisfies readonly MetricsRange[];

type Metric = "cpu" | "memory" | "network";

export function NodeUsage() {
  const [range, setRange] = useState<MetricsRange>("1h");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const usage = useOp(metrics.nodes, { range }, { placeholderData: (previous) => previous });
  // The sidebar already has the node count: placeholders show as many node chips and values as will arrive.
  const nodeCount = useOp(system.info, {}).data?.nodes.total ?? 3;
  const series = usage.data?.nodes ?? [];
  // Members without nodes.view see the dashboard without the fleet graphs.
  if (usage.error?.code === "FORBIDDEN") return null;

  return (
    <Card aria-label={t("dashboard.nodeUsage")} className="gap-[18px] px-[22px] py-5">
      <CardHeader className="flex-wrap">
        <CardTitle>{t("dashboard.nodes")}</CardTitle>
        <Chip tone="green">
          <StatusDot status="ok" pulse />
          {t("dashboard.live")}
        </Chip>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {usage.isPending &&
            Array.from({ length: nodeCount }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <Skeleton key={i} className="h-[31px] w-[84px] rounded-[7px]" />
            ))}
          {series.map((node, index) => {
            const off = hidden.has(node.nodeId);
            return (
              <button
                key={node.nodeId}
                type="button"
                aria-pressed={!off}
                title={t("dashboard.toggleNode")}
                onClick={() => setHidden(toggleHidden(hidden, node.nodeId))}
                className={cn(
                  "flex cursor-pointer items-center gap-[7px] rounded-[7px] border-0 px-[11px] py-1.5 text-[12.5px]",
                  off ? "bg-card text-ink-faint" : "bg-muted text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-[3px] w-3 rounded-sm"
                  style={{ background: off ? "var(--ink-ghost)" : seriesColor({ id: node.nodeId, label: node.name, values: [] }, index) }}
                />
                {node.name}
              </button>
            );
          })}
          <Segmented
            aria-label={t("dashboard.timeRange")}
            value={range}
            onValueChange={(v) => setRange(v as MetricsRange)}
            className="ml-1.5"
          >
            {ranges.map((r) => (
              <SegmentedItem key={r} value={r}>
                {r}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      </CardHeader>
      {usage.isError && !usage.data ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : usage.isPending ? (
        <LoadingRegion label={t("common.loading")} className="grid grid-cols-1 gap-[22px] lg:grid-cols-3">
          <MetricChartSkeleton metric="cpu" nodes={nodeCount} />
          <MetricChartSkeleton metric="memory" nodes={nodeCount} />
          <MetricChartSkeleton metric="network" nodes={nodeCount} />
        </LoadingRegion>
      ) : series.length === 0 ? (
        <EmptyState
          compact
          icon={<IconServer2 />}
          title={t("dashboard.noNodes")}
          description={t("dashboard.noNodesHint")}
          action={
            <Button asChild size="sm" variant="primary">
              <Link to="/nodes" search={{ add: true }}>
                {t("nodes.addNode")}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-3">
          <MetricChart metric="cpu" series={series} hidden={hidden} range={range} />
          <MetricChart metric="memory" series={series} hidden={hidden} range={range} />
          <MetricChart metric="network" series={series} hidden={hidden} range={range} />
        </div>
      )}
    </Card>
  );
}

const metricText: Record<Metric, { title: MessageKey; unit: MessageKey; aria: MessageKey }> = {
  cpu: { title: "dashboard.cpu", unit: "dashboard.cpuUnit", aria: "dashboard.cpuAria" },
  memory: { title: "dashboard.memory", unit: "dashboard.memoryUnit", aria: "dashboard.memoryAria" },
  network: { title: "dashboard.network", unit: "dashboard.networkUnit", aria: "dashboard.networkAria" },
};

function pointValue(metric: Metric, point: NodeSeries["points"][number]): number {
  if (metric === "cpu") return point.cpuPercent;
  // Memory as a share of each node's total, so a 64 GB node does not flatten an 8 GB one.
  if (metric === "memory") return point.memoryTotalBytes > 0 ? (point.memoryUsedBytes / point.memoryTotalBytes) * 100 : 0;
  return point.networkRxBytesPerSec + point.networkTxBytesPerSec;
}

function latestText(metric: Metric, node: NodeSeries): ReactNode {
  const latest = node.latest;
  if (!latest) return "-";
  if (metric === "cpu") return formatPercent(latest.cpuPercent);
  if (metric === "memory") return formatUsedOfTotal(latest.memoryUsedBytes, latest.memoryTotalBytes);
  return formatRate(latest.networkRxBytesPerSec + latest.networkTxBytesPerSec);
}

/** About as wide as a node's value line ("de-fsn-1 6.2 / 16 GB"), so the values wrap as they will. */
const valueWidth: Record<Metric, string> = { cpu: "w-[84px]", memory: "w-[124px]", network: "w-[108px]" };

/** A graph while the samples load: its real title, the plot's height, a value per node. */
function MetricChartSkeleton({ metric, nodes }: { metric: Metric; nodes: number }) {
  const text = metricText[metric];
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink-strong">{t(text.title)}</span>
        <span className="text-xs text-muted-foreground">{t(text.unit)}</span>
      </div>
      <Skeleton className="h-[120px]" />
      <div className="flex flex-wrap gap-x-3.5 gap-y-1">
        {Array.from({ length: nodes }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
          <SkeletonText key={i} className={cn("text-[12.5px]", valueWidth[metric])} />
        ))}
      </div>
    </div>
  );
}

/**
 * One graph. Nodes report on their own clocks, so the points are put on
 * one time axis (every bucket any node has); a node without a point in a
 * bucket gets a gap there instead of a fake zero.
 */
function MetricChart({
  metric,
  series,
  hidden,
  range,
}: {
  metric: Metric;
  series: NodeSeries[];
  hidden: ReadonlySet<string>;
  range: MetricsRange;
}) {
  const times = [...new Set(series.flatMap((node) => node.points.map((point) => point.t)))].sort((a, b) => a - b);
  const chartSeries: ChartSeries[] = series.map((node) => {
    const byTime = new Map(node.points.map((point) => [point.t, pointValue(metric, point)]));
    return { id: node.nodeId, label: node.name, values: times.map((time) => byTime.get(time) ?? null) };
  });
  const text = metricText[metric];
  const format = (value: number) => (metric === "network" ? formatRate(value) : formatPercent(value));

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink-strong">{t(text.title)}</span>
        <span className="text-xs text-muted-foreground">{t(text.unit)}</span>
      </div>
      <SmoothChart
        series={chartSeries}
        hidden={hidden}
        labels={times.map((time) => formatPointTime(time, range !== "1h"))}
        aria-label={t(text.aria, { range })}
        height={120}
        min={metric === "network" ? undefined : 0}
        max={metric === "network" ? undefined : 100}
        formatValue={format}
      />
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-ink-strong">
        {series.map((node) => (
          <span key={node.nodeId} className={cn(hidden.has(node.nodeId) && "opacity-40")}>
            {node.name} <b className="font-semibold text-foreground">{latestText(metric, node)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
