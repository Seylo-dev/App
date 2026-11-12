// The dashboard's Table view: every service of the projects on screen in
// one dense table (service, project, status, CPU, memory, node, last
// deploy), sorted by project and name until a column header is clicked.
// Each row opens its service. Like the node list, it needs a certain
// width: in a narrower card (a phone, a tablet, a small laptop next to the
// sidebar) each service is a stacked row with the column names as labels,
// and the sort moves to a row of buttons above the list.

import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SegmentPill } from "@seylo/ui/components/segmented";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { useScrollFadeRef } from "@seylo/ui/lib/scroll-fade";
import { cn } from "@seylo/ui/lib/utils";
import { IconArrowDown, IconArrowUp, IconSelector, IconStack2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { formatAgo, formatBytes, formatPercent } from "../../lib/format";
import { useLiveTopics } from "../../lib/live";
import { kindTag, placementLine, statusDisplay } from "../../lib/service-display";
import type { Project, ServiceSummary } from "../../lib/types";
import { useTableFits } from "../../lib/use-table-fits";
import { KindBadge } from "../new-service/kinds";
import { useMemoryTotals } from "../project/service-card";
import { ProjectTile } from "../project-tile";
import { formatDateTime } from "../settings/format";
import {
  ariaSort,
  nextServiceSort,
  type ServiceColumn,
  type ServiceSort,
  type ServiceTableRow,
  serviceColumns,
  sortServiceRows,
} from "./service-sort";

/** The card's width from which the table can fit without squeezing its columns. */
const tableWidth = 760;

/** Placeholder rows while the projects themselves load. */
const loadingRows = 5;

const columnLabels: Record<ServiceColumn, MessageKey> = {
  service: "dashboard.table.service",
  project: "dashboard.table.project",
  status: "dashboard.table.status",
  cpu: "dashboard.table.cpu",
  memory: "dashboard.table.memory",
  node: "dashboard.table.node",
  deployed: "dashboard.table.lastDeploy",
};

export function ServiceTable({
  projects,
  services,
  hidden,
  loading,
}: {
  /** The projects on screen, in the dashboard's order. */
  projects: readonly Project[];
  services: ReadonlyMap<string, ServiceSummary[]>;
  hidden: ReadonlySet<string>;
  /** The projects (or the hidden list) are not in yet. */
  loading: boolean;
}) {
  const [sort, setSort] = useState<ServiceSort | null>(null);
  const [measure, measureTable, wide] = useTableFits(tableWidth);
  const memoryTotals = useMemoryTotals();
  // Service changes are published on each project's topic.
  useLiveTopics(projects.map((project) => `project:${project.id}` as const));

  const rows: ServiceTableRow[] = [];
  let pending = loading ? loadingRows : 0;
  projects.forEach((project, projectIndex) => {
    const list = services.get(project.id);
    if (!list) pending += project.serviceCount;
    for (const service of list ?? []) if (service.parentId === null) rows.push({ service, project, projectIndex });
  });
  const sorted = sortServiceRows(rows, sort);
  const onSort = (column: ServiceColumn) => setSort((current) => nextServiceSort(current, column));
  const cell = (row: ServiceTableRow) => ({
    row,
    hidden: hidden.has(row.project.id),
    memoryOf: row.service.memoryLimitBytes ?? memoryTotals.get(row.service.placements[0]?.nodeId ?? "") ?? 0,
  });
  const empty = pending === 0 && rows.length === 0 && (
    <EmptyState compact icon={<IconStack2 />} title={t("dashboard.table.noServices")} description={t("dashboard.table.noServicesHint")} />
  );

  return (
    <section
      ref={measure}
      aria-label={t("dashboard.table.label")}
      aria-busy={pending > 0}
      // The table never runs past the card: it turns into stacked rows when it does not fit, and scrolls inside meanwhile.
      className={cn("@container relative min-w-0 rounded-card bg-card shadow-card", wide && "overflow-x-auto")}
    >
      {wide ? (
        <table ref={measureTable} className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {serviceColumns.map((column, i) => (
                <SortHeader
                  key={column}
                  column={column}
                  sort={sort}
                  onSort={onSort}
                  first={i === 0}
                  last={i === serviceColumns.length - 1}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <TableRow key={row.service.id} {...cell(row)} />
            ))}
            {Array.from({ length: pending }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <TableRowSkeleton key={i} />
            ))}
            {empty && (
              <tr>
                <td colSpan={serviceColumns.length}>{empty}</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <>
          <SortButtons sort={sort} onSort={onSort} />
          <ul className="m-0 flex list-none flex-col p-0">
            {sorted.map((row) => (
              <StackedRow key={row.service.id} {...cell(row)} />
            ))}
            {Array.from({ length: pending }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <StackedRowSkeleton key={i} />
            ))}
            {empty && <li>{empty}</li>}
          </ul>
        </>
      )}
    </section>
  );
}

function SortHeader({
  column,
  sort,
  onSort,
  first,
  last,
}: {
  column: ServiceColumn;
  sort: ServiceSort | null;
  onSort: (column: ServiceColumn) => void;
  first: boolean;
  last: boolean;
}) {
  const active = sort?.column === column;
  return (
    <th
      scope="col"
      aria-sort={ariaSort(sort, column)}
      className={cn(
        "border-b border-divider pt-3 pb-2.5 font-medium whitespace-nowrap",
        first ? "pl-[18px]" : "pl-2.5",
        last ? "pr-[18px] text-right" : "pr-2.5",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent p-0 font-medium text-inherit transition-colors duration-200 hover:text-foreground",
          active && "text-foreground",
          last && "flex-row-reverse",
        )}
      >
        {t(columnLabels[column])}
        <SortIcon active={active} desc={sort?.desc ?? false} />
      </button>
    </th>
  );
}

function SortIcon({ active, desc }: { active: boolean; desc: boolean }) {
  if (!active) return <IconSelector size={13} aria-hidden="true" className="text-ink-ghost" />;
  return desc ? <IconArrowDown size={13} stroke={2} aria-hidden="true" /> : <IconArrowUp size={13} stroke={2} aria-hidden="true" />;
}

/** The narrow list's sort: one button per column on a track, the current one raised, with its direction. */
function SortButtons({ sort, onSort }: { sort: ServiceSort | null; onSort: (column: ServiceColumn) => void }) {
  const fade = useScrollFadeRef<HTMLFieldSetElement>();
  const labelId = useId();
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-[18px] pt-3.5 pb-1">
      <span id={labelId} className="shrink-0 text-xs text-muted-foreground">
        {t("dashboard.table.sortBy")}
      </span>
      <fieldset
        ref={fade}
        aria-labelledby={labelId}
        className="scroll-row m-0 inline-flex min-w-0 gap-0.5 rounded-control border-0 bg-muted p-[3px]"
      >
        {serviceColumns.map((column) => {
          const active = sort?.column === column;
          const label = t(columnLabels[column]);
          return (
            <button
              key={column}
              type="button"
              aria-pressed={active}
              aria-label={
                active
                  ? t("dashboard.table.sorted", {
                      column: label,
                      direction: t(sort.desc ? "dashboard.table.descending" : "dashboard.table.ascending"),
                    })
                  : undefined
              }
              onClick={() => onSort(column)}
              className={cn(
                "relative isolate inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-chip border-0 bg-transparent px-[9px] text-[12px] transition-colors duration-200",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active && <SegmentPill layoutId="dashboard-table-sort" />}
              {label}
              {active && <SortIcon active desc={sort.desc} />}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

interface CellProps {
  row: ServiceTableRow;
  hidden: boolean;
  /** The memory the bar is a share of: the service's limit, else its node's memory. */
  memoryOf: number;
}

function TableRow({ row, hidden, memoryOf }: CellProps) {
  const { service, project } = row;
  const tag = kindTag(service);
  return (
    // The service link covers the row (its ::after), so the whole row opens it, with a real link's middle click and keys.
    <tr className="relative transition-colors duration-200 hover:bg-raised">
      <Td first>
        <span className="flex items-center gap-2.5">
          <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
          <Link
            to="/p/$projectId/s/$serviceId"
            params={{ projectId: service.projectId, serviceId: service.id }}
            className="cursor-pointer text-[13.5px] font-semibold text-foreground after:absolute after:inset-0 after:content-[''] hover:text-foreground"
          >
            {service.name}
          </Link>
        </span>
      </Td>
      <Td>
        <ProjectName project={project} hidden={hidden} />
      </Td>
      <Td>
        <StatusChip service={service} />
      </Td>
      <Td>
        <Meter value={service.cpuPercent === null ? null : formatPercent(service.cpuPercent)} percent={service.cpuPercent ?? 0} />
      </Td>
      <Td>
        <Meter value={service.memoryBytes === null ? null : formatBytes(service.memoryBytes)} percent={memoryShare(service, memoryOf)} />
      </Td>
      <Td>
        <NodeChip service={service} />
      </Td>
      <Td last>
        <LastDeploy service={service} />
      </Td>
    </tr>
  );
}

/** One service in a narrow list: kind, name and status, then the other columns as labelled facts. */
function StackedRow({ row, hidden, memoryOf }: CellProps) {
  const { service, project } = row;
  const tag = kindTag(service);
  return (
    <li className="border-t border-divider first:border-t-0">
      <Link
        to="/p/$projectId/s/$serviceId"
        params={{ projectId: service.projectId, serviceId: service.id }}
        className="flex cursor-pointer flex-col gap-3 px-[18px] py-3.5 text-foreground transition-colors duration-200 hover:bg-raised hover:text-foreground"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
          <span className="min-w-0 truncate text-[13.5px] font-semibold">{service.name}</span>
          <span className="ml-auto shrink-0">
            <StatusChip service={service} />
          </span>
        </span>
        <span className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[620px]:grid-cols-5">
          <Fact label={t("dashboard.table.project")}>
            <ProjectName project={project} hidden={hidden} />
          </Fact>
          <Fact label={t("dashboard.table.node")}>
            <NodeChip service={service} />
          </Fact>
          <Fact label={t("dashboard.table.cpu")}>
            <Meter value={service.cpuPercent === null ? null : formatPercent(service.cpuPercent)} percent={service.cpuPercent ?? 0} />
          </Fact>
          <Fact label={t("dashboard.table.memory")}>
            <Meter
              value={service.memoryBytes === null ? null : formatBytes(service.memoryBytes)}
              percent={memoryShare(service, memoryOf)}
            />
          </Fact>
          <Fact label={t("dashboard.table.lastDeploy")}>
            <LastDeploy service={service} />
          </Fact>
        </span>
      </Link>
    </li>
  );
}

function memoryShare(service: ServiceSummary, memoryOf: number): number {
  return service.memoryBytes !== null && memoryOf > 0 ? (service.memoryBytes / memoryOf) * 100 : 0;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span className="flex min-h-5 min-w-0 items-center">{children}</span>
    </span>
  );
}

function ProjectName({ project, hidden }: { project: Project; hidden: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProjectTile id={project.id} name={project.name} imageUrl={project.imageUrl} isProtected={project.protected} />
      <span className="min-w-0 truncate text-[12.5px] text-ink-strong">{project.name}</span>
      {hidden && (
        <Chip tone="track" className="shrink-0 px-1.5 py-0 text-[11px]">
          {t("dashboard.hiddenChip")}
        </Chip>
      )}
    </span>
  );
}

function StatusChip({ service }: { service: ServiceSummary }) {
  const status = statusDisplay(service.status, service.buildWaiting);
  return (
    <Chip tone={status.tone} className="px-[7px] py-0.5 text-[11.5px]">
      <StatusDot status={status.dot} pulse={status.dot === "busy"} />
      {status.label}
    </Chip>
  );
}

function NodeChip({ service }: { service: ServiceSummary }) {
  return (
    <Chip tone="track" className="min-w-0 truncate px-[7px] py-0.5">
      {placementLine(service)}
    </Chip>
  );
}

/** A small bar and its value; "-" while the service does not run. */
function Meter({ value, percent }: { value: string | null; percent: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-12 shrink-0 rounded-[3px] bg-muted" aria-hidden="true">
        {value !== null && (
          <span className="block h-1 rounded-[3px] bg-primary" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        )}
      </span>
      <span
        className={cn("text-[12.5px] whitespace-nowrap tabular-nums", value === null ? "text-ink-faint" : "font-medium text-ink-strong")}
      >
        {value ?? "-"}
      </span>
    </span>
  );
}

function LastDeploy({ service }: { service: ServiceSummary }) {
  // A service that never deployed (a database started from its image) has nothing to show, like CPU while stopped.
  if (!service.lastDeployedAt) return <span className="text-[12.5px] text-ink-faint">-</span>;
  return (
    <time
      dateTime={service.lastDeployedAt}
      title={formatDateTime(service.lastDeployedAt)}
      className="text-[12.5px] whitespace-nowrap text-muted-foreground"
    >
      {formatAgo(service.lastDeployedAt)}
    </time>
  );
}

function Td({ children, first, last }: { children: ReactNode; first?: boolean; last?: boolean }) {
  return (
    <td
      className={cn(
        "border-t border-divider py-2.5 whitespace-nowrap",
        first ? "pl-[18px]" : "pl-2.5",
        last ? "pr-[18px] text-right" : "pr-2.5",
      )}
    >
      {children}
    </td>
  );
}

/** A row while its project's services load, in the real row's line boxes. */
function TableRowSkeleton() {
  return (
    <tr>
      <Td first>
        <span className="flex items-center gap-2.5">
          <Skeleton className="h-[26px] w-[34px] shrink-0 rounded-chip" />
          <SkeletonText className="w-16 text-[13.5px]" />
        </span>
      </Td>
      <Td>
        <span className="flex items-center gap-2">
          <Skeleton className="size-5 shrink-0 rounded-chip" />
          <SkeletonText className="w-20 text-[12.5px]" />
        </span>
      </Td>
      <Td>
        <Skeleton className="h-[calc(1lh+4px)] w-[70px] rounded-chip text-[11.5px]" />
      </Td>
      {[0, 1].map((key) => (
        <Td key={key}>
          <span className="flex items-center gap-2">
            <Skeleton className="h-1 w-12 shrink-0 rounded-[3px]" />
            <SkeletonText className="w-10 text-[12.5px]" />
          </span>
        </Td>
      ))}
      <Td>
        <Skeleton className="h-5 w-16 rounded-chip" />
      </Td>
      <Td last>
        <SkeletonText className="ml-auto w-14 text-[12.5px]" />
      </Td>
    </tr>
  );
}

function StackedRowSkeleton() {
  return (
    <li aria-hidden="true" className="flex flex-col gap-3 border-t border-divider px-[18px] py-3.5 first:border-t-0">
      <span className="flex items-center gap-2.5">
        <Skeleton className="h-[26px] w-[34px] shrink-0 rounded-chip" />
        <SkeletonText className="w-20 text-[13.5px]" />
        <Skeleton className="ml-auto h-[calc(1lh+4px)] w-[70px] rounded-chip text-[11.5px]" />
      </span>
      <span className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[620px]:grid-cols-5">
        {(["project", "node", "cpu", "memory", "deployed"] as const).map((column) => (
          <span key={column} className="flex min-w-0 flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">{t(columnLabels[column])}</span>
            <span className="flex min-h-5 items-center">
              <SkeletonText className="w-20 text-[12.5px]" />
            </span>
          </span>
        ))}
      </span>
    </li>
  );
}
