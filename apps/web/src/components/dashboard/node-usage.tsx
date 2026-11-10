// The "Nodes" card on the dashboard (Main.dc.html): CPU, memory and
// network per node as smooth graphs, one line per node. The node chips in
// the header show or hide a node's line in all three graphs at once. Each
// node's "node:<id>" topic brings its newest values every sample (applied
// to the cache in lib/live-metrics.ts), and "panel" refetches the graphs
// when a minute was written, so they move by themselves.
//
// The Live chip (on by default, each person's last choice kept in this
// browser: lib/dashboard-range.ts) shows the last 5 minutes as they
// happen: a sample per node every 2 s over the nodes' node-live topics
// (lib/node-live.ts), seeded with the panel's 10-second points, sliding
// smoothly (SmoothChart's window). Picking 1h, 24h or 7d turns it off.
// Without live samples (the socket is down, or older or offline agents)
// it shows the last hour with a short note, never an empty graph.

import { type LiveTopic, metrics, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card, CardHeader, CardTitle } from "@seylo/ui/components/card";
import { chipVariants, StatusDot } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { type ChartSeries, SmoothChart, seriesColor, toggleHidden } from "@seylo/ui/components/smooth-chart";
import { cn } from "@seylo/ui/lib/utils";
import { IconServer2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { type NodeRange, nodeRanges, useNodeRange } from "../../lib/dashboard-range";
import { formatPercent, formatPointTime, formatRate, formatSampleTime, formatUsedOfTotal } from "../../lib/format";
import { useLiveTopics } from "../../lib/live";
import { useNodeLive } from "../../lib/node-live";
import { type LivePoint, liveWindow, type NodeLiveBuffer } from "../../lib/node-live-buffer";
import type { MetricsRange, NodeSeries } from "../../lib/types";
import { QueryError } from "../query-error";

type Metric = "cpu" | "memory" | "network";
type Usage = Pick<LivePoint, "cpuPercent" | "memoryUsedBytes" | "memoryTotalBytes" | "networkRxBytesPerSec" | "networkTxBytesPerSec">;

export function NodeUsage() {
  const [choice, choose] = useNodeRange();
  const [lastRange, setLastRange] = useState<NodeRange>(choice === "live" ? "1h" : choice);
  const liveOn = choice === "live";
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const usage = useOp(metrics.nodes, { range: liveOn ? "live" : choice }, { placeholderData: (previous) => previous });
  const series = usage.data?.nodes ?? [];
  const nodeIds = series.map((node) => node.nodeId);
  useLiveTopics(nodeIds.map((id): LiveTopic => `node:${id}`));

  // range "live": the panel's 10-second points of the last 5 minutes, the line until live samples cover it.
  const liveData = usage.data?.range === "live" ? usage.data : undefined;
  const seed = useMemo(() => liveData?.nodes.map((node) => ({ nodeId: node.nodeId, points: node.points })), [liveData]);
  const feed = useNodeLive(nodeIds, liveOn, { seed, refetchSeed: () => void usage.refetch() });
  const stalled = liveOn && feed.state === "stalled";
  // The seed goes into the buffer before the first paint (useNodeLive), so its points count already.
  const seedPoints = liveData?.nodes.some((node) => node.points.length > 0) ?? false;
  const hasPoints = seedPoints || !feed.buffer.empty();
  const nothingYet = liveOn && liveData !== undefined && !hasPoints;
  // The hour stands in while live samples do not come, or nothing is there yet to draw.
  const hour = useOp(metrics.nodes, { range: "1h" }, { enabled: stalled || nothingYet, placeholderData: (previous) => previous });
  const showLive = liveOn && !stalled && hasPoints;
  const rangeData = liveOn ? (stalled || nothingYet ? hour.data : usage.data) : usage.data;

  // The sidebar already has the node count: placeholders show as many node chips and values as will arrive.
  const nodeCount = useOp(system.info, {}).data?.nodes.total ?? 3;
  // With no nodes the answer is known: the empty state right away, not chart placeholders of another height.
  const noNodes = nodeCount === 0;
  // Members without nodes.view see the dashboard without the fleet graphs.
  if (usage.error?.code === "FORBIDDEN") return null;

  const pickRange = (range: NodeRange) => {
    setLastRange(range);
    choose(range);
  };

  return (
    <Card aria-label={t("dashboard.nodeUsage")} className="gap-[18px] px-[22px] py-5">
      <CardHeader className="flex-wrap">
        <CardTitle>{t("dashboard.nodes")}</CardTitle>
        <button
          type="button"
          aria-pressed={liveOn}
          title={t("dashboard.liveHint")}
          onClick={() => (liveOn ? choose(lastRange) : choose("live"))}
          className={cn(
            chipVariants({ tone: liveOn ? (stalled ? "amber" : "green") : "gray" }),
            "cursor-pointer border-0 transition-colors duration-200",
            !liveOn && "bg-transparent text-muted-foreground hover:bg-chip-gray-bg hover:text-foreground",
          )}
        >
          <StatusDot status={liveOn ? (stalled ? "busy" : "ok") : "off"} pulse={liveOn && feed.state === "streaming"} />
          {t("dashboard.live")}
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {usage.isPending &&
            Array.from({ length: nodeCount }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <Skeleton key={i} className="h-8 w-[84px] rounded-[7px]" />
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
                  // The kit's ChartLegend chip: 32px like the range picker next to it.
                  "flex h-8 cursor-pointer items-center gap-[7px] rounded-[7px] border-0 px-[11px] text-[12.5px] transition-colors duration-200",
                  off ? "bg-transparent text-ink-faint hover:bg-muted/60 hover:text-muted-foreground" : "bg-muted text-foreground",
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
          {/* While Live is on no range is picked: the chip says what the graphs show. */}
          <Segmented aria-label={t("dashboard.timeRange")} value={liveOn ? "" : choice} onValueChange={(v) => pickRange(v as NodeRange)}>
            {nodeRanges.map((r) => (
              <SegmentedItem key={r} value={r}>
                {r}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      </CardHeader>
      {stalled && (
        <p role="status" className="-mt-2 text-xs text-muted-foreground">
          {t(feed.reason === "socket" ? "dashboard.liveSocketDown" : "dashboard.liveNoSamples")}
        </p>
      )}
      {usage.isError && !usage.data ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (usage.isPending || (!showLive && !rangeData)) && !noNodes ? (
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
      ) : showLive ? (
        <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-3" data-live={feed.state}>
          <LiveMetricChart metric="cpu" series={series} hidden={hidden} buffer={feed.buffer} version={feed.version} />
          <LiveMetricChart metric="memory" series={series} hidden={hidden} buffer={feed.buffer} version={feed.version} />
          <LiveMetricChart metric="network" series={series} hidden={hidden} buffer={feed.buffer} version={feed.version} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-[22px] lg:grid-cols-3">
          {(["cpu", "memory", "network"] as const).map((metric) => (
            <MetricChart
              key={metric}
              metric={metric}
              series={rangeData?.nodes ?? series}
              hidden={hidden}
              range={(rangeData?.range ?? "1h") as MetricsRange}
            />
          ))}
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

function pointValue(metric: Metric, point: Usage): number {
  if (metric === "cpu") return point.cpuPercent;
  // Memory as a share of each node's total, so a 64 GB node does not flatten an 8 GB one.
  if (metric === "memory") return point.memoryTotalBytes > 0 ? (point.memoryUsedBytes / point.memoryTotalBytes) * 100 : 0;
  return point.networkRxBytesPerSec + point.networkTxBytesPerSec;
}

function latestText(metric: Metric, latest: Usage | null | undefined): ReactNode {
  if (!latest) return "-";
  if (metric === "cpu") return formatPercent(latest.cpuPercent);
  if (metric === "memory") return formatUsedOfTotal(latest.memoryUsedBytes, latest.memoryTotalBytes);
  return formatRate(latest.networkRxBytesPerSec + latest.networkTxBytesPerSec);
}

const formatterFor = (metric: Metric) => (value: number) => (metric === "network" ? formatRate(value) : formatPercent(value));

/** About as wide as a node's value line ("de-fsn-1 6.2 / 16 GB"), so the values wrap as they will. */
const valueWidth: Record<Metric, string> = { cpu: "w-[84px]", memory: "w-[124px]", network: "w-[108px]" };

/** A graph while the samples load: its real title, the plot's height, a value per node. */
function MetricChartSkeleton({ metric, nodes }: { metric: Metric; nodes: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <MetricTitle metric={metric} />
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

function MetricTitle({ metric }: { metric: Metric }) {
  const text = metricText[metric];
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[13px] font-medium text-ink-strong">{t(text.title)}</span>
      <span className="text-xs text-muted-foreground">{t(text.unit)}</span>
    </div>
  );
}

/** The newest value of every node under a graph. */
function LatestValues({
  metric,
  series,
  hidden,
  latest,
}: {
  metric: Metric;
  series: NodeSeries[];
  hidden: ReadonlySet<string>;
  latest: (node: NodeSeries) => Usage | null | undefined;
}) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-ink-strong">
      {series.map((node) => (
        <span key={node.nodeId} className={cn(hidden.has(node.nodeId) && "opacity-40")}>
          {node.name} <b className="font-semibold text-foreground">{latestText(metric, latest(node))}</b>
        </span>
      ))}
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

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <MetricTitle metric={metric} />
      <SmoothChart
        series={chartSeries}
        hidden={hidden}
        labels={times.map((time) => formatPointTime(time, range !== "1h"))}
        aria-label={t(text.aria, { range })}
        height={120}
        min={metric === "network" ? undefined : 0}
        max={metric === "network" ? undefined : 100}
        formatValue={formatterFor(metric)}
      />
      <LatestValues metric={metric} series={series} hidden={hidden} latest={(node) => node.latest} />
    </div>
  );
}

/**
 * One Live graph: every node's own points on a 5-minute window that
 * slides with the clock (SmoothChart window). The values under it follow
 * the newest sample. Re-renders when the buffer's version moves (at most
 * once a second); `version` is only here to say so.
 */
function LiveMetricChart({
  metric,
  series,
  hidden,
  buffer,
}: {
  metric: Metric;
  series: NodeSeries[];
  hidden: ReadonlySet<string>;
  buffer: NodeLiveBuffer;
  version: number;
}) {
  const now = Date.now();
  const since = now - liveWindow.spanMs - liveWindow.lagMs - liveWindow.maxGapMs;
  const chartSeries: ChartSeries[] = series.map((node) => {
    const points = buffer.points(node.nodeId, since);
    return { id: node.nodeId, label: node.name, values: points.map((p) => pointValue(metric, p)), times: points.map((p) => p.t) };
  });
  const text = metricText[metric];

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <MetricTitle metric={metric} />
      <SmoothChart
        series={chartSeries}
        hidden={hidden}
        window={{ now, spanMs: liveWindow.spanMs, lagMs: liveWindow.lagMs, follow: true, maxGapMs: liveWindow.maxGapMs }}
        formatTime={formatSampleTime}
        aria-label={t(text.aria, { range: t("dashboard.liveRange") })}
        height={120}
        min={metric === "network" ? undefined : 0}
        max={metric === "network" ? undefined : 100}
        formatValue={formatterFor(metric)}
      />
      <LatestValues metric={metric} series={series} hidden={hidden} latest={(node) => buffer.latest(node.nodeId) ?? node.latest} />
    </div>
  );
}
