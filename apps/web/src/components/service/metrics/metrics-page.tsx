// The Metrics tab: CPU, memory (real use, without file cache) and network
// of the service summed over replicas and nodes, with ranges from the last
// five minutes to 30 days. Smooth curves with light fills, hover values,
// and the current value per node underneath.

import { metrics, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Card } from "@seylo/ui/components/card";
import { DataTable } from "@seylo/ui/components/data-table";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { StatTile } from "@seylo/ui/components/stat-tile";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatBytes, formatPercent, formatRate, formatRelative } from "../format";
import { OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { pointLabels } from "./point-labels";

type Range = OpOutput<typeof metrics.service>["range"];
type Data = OpOutput<typeof metrics.service>;
const ranges: Range[] = ["live", "1h", "24h", "7d", "30d"];

export function MetricsPage({ service }: { service: ServiceDetail }) {
  const [range, setRange] = useState<Range>("1h");
  const data = useOp(
    metrics.service,
    { serviceId: service.id, range },
    { retry: retryOp, refetchInterval: range === "live" ? 10_000 : range === "1h" ? 60_000 : false },
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={range} onValueChange={(v) => setRange(v as Range)} aria-label={t("serviceMetrics.range")} tone="track">
          {ranges.map((r) => (
            <SegmentedItem key={r} value={r}>
              {t(`serviceMetrics.ranges.${r}`)}
            </SegmentedItem>
          ))}
        </Segmented>
        <span className="text-[12.5px] text-muted-foreground">{t("serviceMetrics.memoryNote")}</span>
      </div>
      {data.isPending ? (
        <MetricsSkeleton />
      ) : data.isError ? (
        <OpErrorNote error={data.error} />
      ) : (
        <Charts service={service} data={data.data} />
      )}
    </div>
  );
}

function Charts({ service, data }: { service: ServiceDetail; data: Data }) {
  const labels = pointLabels(
    data.points.map((p) => p.t),
    data.range,
  );
  const last = data.points[data.points.length - 1];
  const cpu = data.points.map((p) => p.cpuPercent);
  const memory = data.points.map((p) => p.memoryBytes);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const limit = service.memoryLimitBytes ?? service.resources.memoryLimitBytes;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t("service.usage.cpu")} value={formatPercent(last?.cpuPercent ?? null)} spark={cpu} />
        <StatTile
          label={t("service.usage.memory")}
          value={formatBytes(last?.memoryBytes ?? null)}
          hint={limit ? t("service.usage.ofLimit", { limit: formatBytes(limit) }) : t("service.usage.noLimit")}
          spark={memory}
          sparkColor="var(--chart-5)"
        />
        <StatTile
          label={t("serviceMetrics.peakMemory")}
          value={formatBytes(data.peakMemoryBytes)}
          hint={t(`serviceMetrics.inRange.${data.range}`)}
        />
        <StatTile
          label={t("service.usage.network")}
          value={formatRate(last ? last.networkRxBytesPerSec + last.networkTxBytesPerSec : null)}
          spark={data.points.map((p) => p.networkRxBytesPerSec + p.networkTxBytesPerSec)}
          sparkColor="var(--chart-2)"
        />
      </div>
      {data.points.length < 2 ? (
        <Card>
          <p className="m-0 text-[13px] text-muted-foreground">{t("serviceMetrics.noData")}</p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title={t("service.usage.cpu")} hint={t("serviceMetrics.cpuHint")}>
            <SmoothChart
              aria-label={t("service.usage.cpu")}
              height={180}
              labels={labels}
              min={0}
              series={[
                { id: "cpu", label: t("serviceMetrics.average"), values: cpu, color: "var(--chart-1)" },
                { id: "cpuMax", label: t("serviceMetrics.peak"), values: data.points.map((p) => p.cpuPercentMax), color: "var(--chart-3)" },
              ]}
              hidden={hidden}
              onHiddenChange={setHidden}
              legend
              formatValue={(v) => formatPercent(v)}
            />
          </ChartCard>
          <ChartCard title={t("service.usage.memory")} hint={t("service.usage.noFileCache")}>
            <SmoothChart
              aria-label={t("service.usage.memory")}
              height={180}
              labels={labels}
              min={0}
              {...(limit ? { max: limit } : {})}
              series={[
                { id: "memory", label: t("serviceMetrics.average"), values: memory, color: "var(--chart-5)" },
                {
                  id: "memoryMax",
                  label: t("serviceMetrics.peak"),
                  values: data.points.map((p) => p.memoryBytesMax),
                  color: "var(--chart-3)",
                },
              ]}
              hidden={hidden}
              onHiddenChange={setHidden}
              legend
              formatValue={(v) => formatBytes(v)}
            />
          </ChartCard>
          <ChartCard title={t("service.usage.network")} hint={t("serviceMetrics.networkHint")} className="xl:col-span-2">
            <SmoothChart
              aria-label={t("service.usage.network")}
              height={160}
              labels={labels}
              min={0}
              series={[
                {
                  id: "rx",
                  label: t("serviceMetrics.received"),
                  values: data.points.map((p) => p.networkRxBytesPerSec),
                  color: "var(--chart-1)",
                },
                {
                  id: "tx",
                  label: t("serviceMetrics.sent"),
                  values: data.points.map((p) => p.networkTxBytesPerSec),
                  color: "var(--chart-2)",
                },
              ]}
              legend
              formatValue={(v) => formatRate(v)}
            />
          </ChartCard>
        </div>
      )}
      {data.current.length > 0 && (
        <Card className="gap-3">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceMetrics.perNode")}</h2>
          <DataTable
            bare
            aria-label={t("serviceMetrics.perNode")}
            rows={data.current}
            getRowId={(r) => r.nodeId}
            columns={[
              {
                id: "node",
                header: t("serviceMetrics.node"),
                cell: (r) => service.placements.find((p) => p.nodeId === r.nodeId)?.nodeName ?? r.nodeId,
              },
              {
                id: "cpu",
                header: t("service.usage.cpu"),
                cell: (r) => formatPercent(r.cpuPercent),
                sortValue: (r) => r.cpuPercent,
                align: "right",
              },
              {
                id: "memory",
                header: t("service.usage.memory"),
                cell: (r) =>
                  r.memoryLimitBytes ? `${formatBytes(r.memoryBytes)} / ${formatBytes(r.memoryLimitBytes)}` : formatBytes(r.memoryBytes),
                sortValue: (r) => r.memoryBytes,
                align: "right",
              },
              {
                id: "net",
                header: t("service.usage.network"),
                cell: (r) => `↓ ${formatRate(r.networkRxBytesPerSec)} · ↑ ${formatRate(r.networkTxBytesPerSec)}`,
                align: "right",
                hideOnMobile: true,
              },
              { id: "at", header: t("serviceMetrics.sampled"), cell: (r) => formatRelative(r.at), align: "right", hideOnMobile: true },
            ]}
          />
        </Card>
      )}
    </>
  );
}

/** The four tiles and three charts while the samples load, with their real labels. */
function MetricsSkeleton() {
  const tiles = [t("service.usage.cpu"), t("service.usage.memory"), t("serviceMetrics.peakMemory"), t("service.usage.network")];
  const charts: [string, number, string?][] = [
    [t("service.usage.cpu"), 180],
    [t("service.usage.memory"), 180],
    [t("service.usage.network"), 160, "xl:col-span-2"],
  ];
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((label) => (
          <div key={label} className="flex min-w-0 flex-col gap-1.5 rounded-card bg-card px-[18px] py-4 shadow-card">
            <span className="truncate text-[12.5px] text-muted-foreground">{label}</span>
            <SkeletonText className="w-20 text-[22px]" />
            <SkeletonText className="w-16 text-[12px]" />
            <Skeleton className="mt-1 h-7" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {charts.map(([title, height, span]) => (
          <Card key={title} className={span}>
            <div className="flex flex-wrap items-baseline gap-2.5">
              <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
              <SkeletonText className="w-32 text-xs" />
            </div>
            <Skeleton style={{ height }} />
            <div className="flex gap-1.5">
              <Skeleton className="h-[31px] w-[86px] rounded-[7px]" />
              <Skeleton className="h-[31px] w-[66px] rounded-[7px]" />
            </div>
          </Card>
        ))}
      </div>
    </LoadingRegion>
  );
}

function ChartCard({ title, hint, children, className }: { title: string; hint: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {children}
    </Card>
  );
}
