// A service as a card (Project.dc.html): kind tag, name, status, source
// line, address, CPU and memory bars, node and last activity. The project
// page shows it full size; the dashboard's Cards view shows the compact
// one (smaller paddings, type and bars, the same facts) so more fit a row.

import { nodes } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { formatBytes, formatPercent } from "../../lib/format";
import { kindTag, lastActivity, placementLine, sourceLine, statusDisplay } from "../../lib/service-display";
import type { NodeRow, ServiceSummary } from "../../lib/types";
import { KindBadge } from "../new-service/kinds";

/** The two sizes' classes, shared by the card and its placeholder so both are the same height. */
const sizes = {
  regular: {
    card: "gap-3.5 p-[18px]",
    head: "flex-wrap gap-2.5",
    name: "text-[15px]",
    chip: "text-[11.5px]",
    lines: "text-[12.5px]",
    sourceSkeleton: "w-48",
    bars: "gap-3",
    barLabel: "text-[11.5px]",
    bar: "h-[5px]",
    foot: "flex-wrap gap-2 pt-3 text-xs",
    footChip: "",
  },
  compact: {
    card: "gap-3 p-3.5",
    head: "gap-2",
    name: "min-w-0 truncate text-[13.5px]",
    chip: "shrink-0 px-[7px] py-0.5 text-[11px]",
    lines: "text-xs",
    sourceSkeleton: "w-40",
    bars: "gap-2.5",
    barLabel: "text-[11px]",
    bar: "h-1",
    foot: "gap-2 pt-2.5 text-[11.5px]",
    footChip: "min-w-0 truncate",
  },
} as const;

/** Node id -> its memory, for the memory bar of a service without a limit. */
export function useMemoryTotals(): Map<string, number> {
  const nodeList = useOp(nodes.list, {}, { retry: false });
  return new Map((nodeList.data?.nodes ?? []).map((node: NodeRow) => [node.id, node.facts?.memoryTotalBytes ?? 0]));
}

export function ServiceCard({
  service,
  memoryTotal,
  compact = false,
}: {
  service: ServiceSummary;
  memoryTotal: number;
  compact?: boolean;
}) {
  const size = sizes[compact ? "compact" : "regular"];
  const tag = kindTag(service);
  const status = statusDisplay(service.status, service.buildWaiting);
  const cpu = service.cpuPercent;
  const memory = service.memoryBytes;
  const memoryOf = service.memoryLimitBytes ?? memoryTotal;
  return (
    <Link
      to="/p/$projectId/s/$serviceId"
      params={{ projectId: service.projectId, serviceId: service.id }}
      data-slot="service-card"
      className={cn(
        "flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-card bg-card text-foreground shadow-card transition-shadow duration-200 hover:text-foreground hover:shadow-popover",
        size.card,
      )}
    >
      <div className={cn("flex items-center", size.head)}>
        <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
        <span className={cn("font-semibold", size.name)}>{service.name}</span>
        <Chip tone={status.tone} className={cn("ml-auto", size.chip)}>
          <StatusDot status={status.dot} pulse={status.dot === "busy"} />
          {status.label}
        </Chip>
      </div>
      <div className={cn("flex flex-col gap-1 text-ink-strong", size.lines)}>
        <span className="truncate">{sourceLine(service)}</span>
        <CardAddress service={service} />
      </div>
      <div className={cn("grid grid-cols-2", size.bars)}>
        <UsageBar label={t("dashboard.cpu")} value={cpu === null ? "-" : formatPercent(cpu)} percent={cpu ?? 0} compact={compact} />
        <UsageBar
          label={t("dashboard.memory")}
          value={memory === null ? "-" : formatBytes(memory)}
          percent={memory !== null && memoryOf > 0 ? (memory / memoryOf) * 100 : 0}
          compact={compact}
        />
      </div>
      <div className={cn("flex items-center border-t border-divider text-muted-foreground", size.foot)}>
        <Chip tone="track" className={cn("px-[7px] py-0.5", size.footChip)}>
          {placementLine(service)}
        </Chip>
        <span className={cn("ml-auto", compact && "truncate")}>{lastActivity(service)}</span>
      </div>
    </Link>
  );
}

/** ServiceCard's rows at their real heights. */
export function ServiceCardSkeleton({ compact = false }: { compact?: boolean }) {
  const size = sizes[compact ? "compact" : "regular"];
  return (
    <div aria-hidden="true" className={cn("flex min-w-0 flex-col overflow-hidden rounded-card bg-card shadow-card", size.card)}>
      <div className={cn("flex items-center", size.head)}>
        <Skeleton className="h-[26px] w-[34px] shrink-0 rounded-chip" />
        <SkeletonText className={cn("w-20", size.name)} />
        {/* The chip: one line of its text plus its padding, like the real one. */}
        <Skeleton className={cn("ml-auto rounded-chip", compact ? "h-[calc(1lh+4px)] w-[70px] text-[11px]" : "h-[23px] w-[74px]")} />
      </div>
      <div className={cn("flex flex-col gap-1", size.lines)}>
        <SkeletonText className={size.sourceSkeleton} />
        <SkeletonText className="w-36 text-xs leading-4" />
      </div>
      <div className={cn("grid grid-cols-2", size.bars)}>
        {[t("dashboard.cpu"), t("dashboard.memory")].map((label) => (
          <div key={label} className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
            <span className={cn("flex justify-between text-muted-foreground", size.barLabel)}>
              <span>{label}</span>
              <SkeletonText className="w-10" />
            </span>
            <Skeleton className={cn("rounded-[3px]", size.bar)} />
          </div>
        ))}
      </div>
      <div className={cn("flex items-center border-t border-divider", size.foot)}>
        {/* The node chip keeps the kit's 12px text in both sizes: 16px plus its padding. */}
        <Skeleton className="h-5 w-16 rounded-chip" />
        <SkeletonText className={cn("ml-auto w-20", !compact && "leading-4")} />
      </div>
    </div>
  );
}

/**
 * The card's address line, as the service header shows it: a public domain
 * in link blue, an internal name:port in muted mono, and plain muted words
 * when the service has no port. The whole card is one link, so none of
 * these is a link of its own.
 */
function CardAddress({ service }: { service: ServiceSummary }) {
  const { address } = service;
  if (address === null)
    return (
      <span className="truncate text-xs text-muted-foreground">
        {t(service.kind === "app" || service.kind === "cron" ? "service.header.noPorts" : "project.noAddress")}
      </span>
    );
  // The panel writes "<name>:<port>" when the service has a port but no domain.
  const internal = address.startsWith(`${service.name}:`) && /^\d+$/.test(address.slice(service.name.length + 1));
  return <span className={cn("truncate font-mono text-xs", internal ? "text-muted-foreground" : "text-link")}>{address}</span>;
}

function UsageBar({ label, value, percent, compact }: { label: string; value: string; percent: number; compact: boolean }) {
  const size = sizes[compact ? "compact" : "regular"];
  return (
    <div className={cn("flex min-w-0 flex-col", compact ? "gap-1" : "gap-1.5")}>
      <span className={cn("flex justify-between gap-1.5 text-muted-foreground", size.barLabel)}>
        <span>{label}</span>
        <span className="truncate font-medium text-foreground">{value}</span>
      </span>
      <span className={cn("rounded-[3px] bg-muted", size.bar)} aria-hidden="true">
        <span className={cn("block rounded-[3px] bg-primary", size.bar)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
    </div>
  );
}
