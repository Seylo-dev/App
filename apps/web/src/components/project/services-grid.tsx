// The project's services as cards (Project.dc.html): kind tag, name,
// status, source line, address, CPU and memory bars, node and last
// activity, plus the dashed "Add a service" card that opens the New
// service menu.

import { nodes, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { formatBytes, formatPercent } from "../../lib/format";
import { kindTag, lastActivity, placementLine, sourceLine, statusDisplay } from "../../lib/service-display";
import type { NodeRow, ServiceSummary } from "../../lib/types";
import { KindBadge } from "../new-service/kinds";
import { NewServiceMenu } from "../new-service/new-service-menu";
import { QueryError } from "../query-error";

export function ServicesGrid({ projectId, canCreate }: { projectId: string; canCreate: boolean }) {
  const list = useOp(services.list, { projectId });
  const nodeList = useOp(nodes.list, {}, { retry: false });
  const memoryTotals = new Map((nodeList.data?.nodes ?? []).map((node: NodeRow) => [node.id, node.facts?.memoryTotalBytes ?? 0]));

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  const rows = list.data?.services.filter((service) => service.parentId === null) ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.isPending && [0, 1, 2].map((key) => <Skeleton key={key} className="h-[190px] rounded-card" />)}
      {rows.map((service) => (
        <ServiceCard key={service.id} service={service} memoryTotal={memoryTotals.get(service.placements[0]?.nodeId ?? "") ?? 0} />
      ))}
      {canCreate && !list.isPending && (
        <NewServiceMenu
          projectId={projectId}
          trigger={
            <button
              type="button"
              className="flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-card border-[1.5px] border-dashed border-input bg-card/55 text-[13.5px] font-medium text-ink-strong hover:bg-card"
            >
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <IconPlus size={16} stroke={2.2} />
              </span>
              {t("project.addService")}
            </button>
          }
        />
      )}
    </div>
  );
}

function ServiceCard({ service, memoryTotal }: { service: ServiceSummary; memoryTotal: number }) {
  const tag = kindTag(service);
  const status = statusDisplay(service.status);
  const cpu = service.cpuPercent;
  const memory = service.memoryBytes;
  const memoryOf = service.memoryLimitBytes ?? memoryTotal;
  return (
    <Link
      to="/p/$projectId/s/$serviceId"
      params={{ projectId: service.projectId, serviceId: service.id }}
      className="flex min-w-0 flex-col gap-3.5 overflow-hidden rounded-card bg-card p-[18px] text-foreground shadow-card transition-shadow hover:text-foreground hover:shadow-popover"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
        <span className="text-[15px] font-semibold">{service.name}</span>
        <Chip tone={status.tone} className="ml-auto text-[11.5px]">
          <StatusDot status={status.dot} pulse={status.dot === "busy"} />
          {status.label}
        </Chip>
      </div>
      <div className="flex flex-col gap-1 text-[12.5px] text-ink-strong">
        <span className="truncate">{sourceLine(service)}</span>
        <span className="truncate font-mono text-xs text-link">{service.address ?? t("project.noAddress")}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <UsageBar label={t("dashboard.cpu")} value={cpu === null ? "-" : formatPercent(cpu)} percent={cpu ?? 0} />
        <UsageBar
          label={t("dashboard.memory")}
          value={memory === null ? "-" : formatBytes(memory)}
          percent={memory !== null && memoryOf > 0 ? (memory / memoryOf) * 100 : 0}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3 text-xs text-muted-foreground">
        <Chip tone="track" className="px-[7px] py-0.5">
          {placementLine(service)}
        </Chip>
        <span className="ml-auto">{lastActivity(service)}</span>
      </div>
    </Link>
  );
}

function UsageBar({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex justify-between text-[11.5px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-medium text-foreground">{value}</span>
      </span>
      <span className="h-[5px] rounded-[3px] bg-muted" aria-hidden="true">
        <span className="block h-[5px] rounded-[3px] bg-primary" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
    </div>
  );
}
