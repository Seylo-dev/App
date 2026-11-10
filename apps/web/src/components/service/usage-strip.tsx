// The five live numbers under the service header (Service.dc.html): CPU,
// memory and network, each with a sparkline and a 30-minute popover, then
// live version and crash policy.
// CPU and memory come from services.get (the panel's in-memory node
// state); network and the memory history from metrics.service.

import { metrics } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Popover, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useLiveUp } from "../../lib/live";
import { formatBytes, formatPercent, formatRate } from "./format";
import { retryOp } from "./op-state";
import type { ServiceDetail } from "./use-service";

/** Points of the 1h range are one minute apart; the popover shows the last 30. */
const popoverPoints = 30;

export function crashPolicyLabel(service: Pick<ServiceDetail, "crashPolicy">): string {
  const { restart, stopAfterCrashes } = service.crashPolicy;
  if (!restart) return t("service.usage.crashNoRestart");
  return stopAfterCrashes > 0 ? t("service.usage.crashStopAfter", { count: stopAfterCrashes }) : t("service.usage.crashRestartAlways");
}

export function UsageStrip({ service }: { service: ServiceDetail }) {
  // The service layout follows "service:<id>", which refreshes this with every sample; poll only while the socket is down.
  const liveUp = useLiveUp();
  const history = useOp(
    metrics.service,
    { serviceId: service.id, range: "1h" },
    { retry: retryOp, refetchInterval: liveUp ? false : 60_000 },
  );
  const current = history.data?.current ?? [];
  const network = current.length ? current.reduce((sum, c) => sum + c.networkRxBytesPerSec + c.networkTxBytesPerSec, 0) : null;
  const memory = service.memoryBytes;
  const points = (history.data?.points ?? []).slice(-popoverPoints);
  const cpuValues = points.map((p) => p.cpuPercent);
  const memoryValues = points.map((p) => p.memoryBytes);
  const networkValues = points.map((p) => p.networkRxBytesPerSec + p.networkTxBytesPerSec);
  const metricsLink = (
    <Link
      to="/p/$projectId/s/$serviceId/metrics"
      params={{ projectId: service.projectId, serviceId: service.id }}
      className="ml-auto font-medium"
    >
      {t("service.usage.openMetrics")}
    </Link>
  );

  return (
    <div className="grid grid-cols-2 gap-1 rounded-card bg-card p-1.5 shadow-card sm:grid-cols-3 lg:grid-cols-5">
      <MetricCell
        id="cpu"
        label={t("service.usage.cpu")}
        value={formatPercent(service.cpuPercent)}
        title={t("service.usage.cpuLast30")}
        hint={t("service.usage.cpuHint")}
        values={cpuValues}
        format={(v) => formatPercent(v)}
        now={formatPercent(service.cpuPercent)}
        peak={cpuValues.length ? formatPercent(Math.max(...points.map((p) => p.cpuPercentMax))) : null}
        link={metricsLink}
      />
      <MetricCell
        id="memory"
        label={t("service.usage.memory")}
        value={formatBytes(memory)}
        extra={
          service.memoryLimitBytes
            ? t("service.usage.ofLimit", { limit: formatBytes(service.memoryLimitBytes) })
            : t("service.usage.noLimit")
        }
        title={t("service.usage.memoryLast30")}
        hint={t("service.usage.noFileCache")}
        values={memoryValues}
        format={(v) => formatBytes(v)}
        now={formatBytes(memory)}
        peak={history.data ? formatBytes(history.data.peakMemoryBytes) : null}
        link={metricsLink}
      />
      <MetricCell
        id="network"
        label={t("service.usage.network")}
        value={formatRate(network)}
        title={t("service.usage.networkLast30")}
        hint={t("service.usage.networkHint")}
        values={networkValues}
        format={(v) => formatRate(v)}
        now={formatRate(network)}
        peak={networkValues.length ? formatRate(Math.max(...networkValues)) : null}
        link={metricsLink}
      />
      <Cell label={t("service.usage.liveVersion")} mono>
        {service.liveDeployment?.label ?? "-"}
      </Cell>
      <Cell label={t("service.usage.crashPolicy")}>{crashPolicyLabel(service)}</Cell>
    </div>
  );
}

/**
 * A usage number that opens its last 30 minutes: the value, a small
 * sparkline of the same minutes at the cell's end (from sm up, decorative:
 * the popover carries the chart people read), and on click the chart with
 * now, peak and the way to Metrics.
 */
function MetricCell({
  id,
  label,
  value,
  extra,
  title,
  hint,
  values,
  format,
  now,
  peak,
  link,
}: {
  id: string;
  label: string;
  value: ReactNode;
  extra?: string;
  title: string;
  hint: string;
  values: number[];
  format: (v: number) => ReactNode;
  now: ReactNode;
  peak: ReactNode | null;
  link: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        data-testid={`usage-${id}`}
        className="flex min-w-0 cursor-pointer items-end gap-3 rounded-control border-0 bg-transparent px-3.5 py-2.5 text-left font-[inherit] text-muted-foreground transition-colors duration-200 hover:bg-raised data-[state=open]:bg-chip-blue-bg data-[state=open]:text-chip-blue-fg"
      >
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="flex items-center gap-[5px] text-xs">
            {label}
            <IconChevronDown size={12} stroke={2.2} aria-hidden="true" />
          </span>
          <span className="truncate text-[17px] font-semibold tracking-[-0.01em] text-foreground">
            {value} {extra && <span className="text-xs font-normal tracking-normal text-muted-foreground">{extra}</span>}
          </span>
        </span>
        {values.length > 1 && (
          <span
            aria-hidden="true"
            className="pointer-events-none ml-auto hidden w-[88px] shrink-0 sm:block"
            data-testid={`sparkline-${id}`}
          >
            <SmoothChart aria-label={title} height={30} gridLines={0} animate={false} min={0} series={[{ id, label, values }]} />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[330px] max-w-[calc(100vw-32px)] flex-col gap-3 px-[18px]" aria-label={title}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
          <b className="text-[13.5px] font-semibold">{title}</b>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </div>
        {values.length > 1 ? (
          <SmoothChart
            aria-label={title}
            height={84}
            gridLines={3}
            series={[{ id, label, values }]}
            formatValue={(v) => format(v)}
            min={0}
          />
        ) : (
          <p className="m-0 py-5 text-center text-[12.5px] text-muted-foreground">{t("service.usage.noHistory")}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-divider pt-2.5 text-[12.5px] text-ink-strong">
          <span>
            {t("service.usage.now")} <b className="font-semibold text-foreground">{now}</b>
          </span>
          {peak !== null && (
            <span>
              {t("service.usage.peak")} <b className="font-semibold text-foreground">{peak}</b>
            </span>
          )}
          {link}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Cell({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px] rounded-control px-3.5 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate", mono ? "font-mono text-base font-medium" : "text-[17px] font-semibold tracking-[-0.01em]")}>
        {children}
      </span>
    </div>
  );
}
