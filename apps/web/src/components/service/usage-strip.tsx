// The five live numbers under the service header (Service.dc.html): CPU,
// memory with a 30-minute popover, network, live version and crash policy.
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
  const memoryPoints = (history.data?.points ?? []).slice(-popoverPoints);

  return (
    <div className="grid grid-cols-2 gap-1 rounded-card bg-card p-1.5 shadow-card sm:grid-cols-3 lg:grid-cols-5">
      <Cell label={t("service.usage.cpu")}>{formatPercent(service.cpuPercent)}</Cell>
      <Popover>
        <PopoverTrigger className="flex cursor-pointer flex-col gap-[3px] rounded-control border-0 bg-transparent px-3.5 py-2.5 text-left font-[inherit] text-muted-foreground data-[state=open]:bg-chip-blue-bg data-[state=open]:text-chip-blue-fg">
          <span className="flex items-center gap-[5px] text-xs">
            {t("service.usage.memory")}
            <IconChevronDown size={12} stroke={2.2} aria-hidden="true" />
          </span>
          <span className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">
            {formatBytes(memory)}{" "}
            <span className="text-xs font-normal tracking-normal text-muted-foreground">
              {service.memoryLimitBytes
                ? t("service.usage.ofLimit", { limit: formatBytes(service.memoryLimitBytes) })
                : t("service.usage.noLimit")}
            </span>
          </span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="flex w-[330px] max-w-[calc(100vw-32px)] flex-col gap-3 px-[18px]"
          aria-label={t("service.usage.memoryLast30")}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
            <b className="text-[13.5px] font-semibold">{t("service.usage.memoryLast30")}</b>
            <span className="text-xs text-muted-foreground">{t("service.usage.noFileCache")}</span>
          </div>
          {memoryPoints.length > 1 ? (
            <SmoothChart
              aria-label={t("service.usage.memoryLast30")}
              height={84}
              gridLines={3}
              series={[{ id: "memory", label: t("service.usage.memory"), values: memoryPoints.map((p) => p.memoryBytes) }]}
              formatValue={(v) => formatBytes(v)}
              min={0}
            />
          ) : (
            <p className="m-0 py-5 text-center text-[12.5px] text-muted-foreground">{t("service.usage.noHistory")}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-divider pt-2.5 text-[12.5px] text-ink-strong">
            <span>
              {t("service.usage.now")} <b className="font-semibold text-foreground">{formatBytes(memory)}</b>
            </span>
            {history.data && (
              <span>
                {t("service.usage.peak")} <b className="font-semibold text-foreground">{formatBytes(history.data.peakMemoryBytes)}</b>
              </span>
            )}
            <Link
              to="/p/$projectId/s/$serviceId/metrics"
              params={{ projectId: service.projectId, serviceId: service.id }}
              className="ml-auto font-medium"
            >
              {t("service.usage.openMetrics")}
            </Link>
          </div>
        </PopoverContent>
      </Popover>
      <Cell label={t("service.usage.network")}>{formatRate(network)}</Cell>
      <Cell label={t("service.usage.liveVersion")} mono>
        {service.liveDeployment?.label ?? "-"}
      </Cell>
      <Cell label={t("service.usage.crashPolicy")}>{crashPolicyLabel(service)}</Cell>
    </div>
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
