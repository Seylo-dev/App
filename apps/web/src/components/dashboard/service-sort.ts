// The order of the dashboard's service table, kept apart so it can be
// tested without a DOM. Unsorted, it follows the projects in the person's
// order and each project's services by name; a column header sorts by
// that column, with that order breaking ties. Numbers and times start with
// the largest and newest (the busy services first), words from A.

import { type SortValue, sortRows } from "@seylo/ui/lib/sort";
import { placementLine } from "../../lib/service-display";
import type { Project, ServiceStatus, ServiceSummary } from "../../lib/types";

export interface ServiceTableRow {
  service: ServiceSummary;
  project: Project;
  /** The project's place on the dashboard (the sidebar order). */
  projectIndex: number;
}

export const serviceColumns = ["service", "project", "status", "cpu", "memory", "node", "deployed"] as const;
export type ServiceColumn = (typeof serviceColumns)[number];

export interface ServiceSort {
  column: ServiceColumn;
  desc: boolean;
}

/** Problems first, then work in progress, then what runs, then what does not. */
const statusRank: Record<ServiceStatus, number> = {
  crashed: 0,
  unhealthy: 1,
  partial: 2,
  building: 3,
  deploying: 4,
  starting: 5,
  running: 6,
  stopped: 7,
  idle: 8,
  unknown: 9,
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const sortValues: Record<ServiceColumn, (row: ServiceTableRow) => SortValue> = {
  service: (row) => row.service.name,
  project: (row) => row.project.name,
  status: (row) => statusRank[row.service.status],
  cpu: (row) => row.service.cpuPercent,
  memory: (row) => row.service.memoryBytes,
  node: (row) => (row.service.placements.length > 0 ? placementLine(row.service) : null),
  deployed: (row) => (row.service.lastDeployedAt ? Date.parse(row.service.lastDeployedAt) : null),
};

/** Columns whose first click puts the largest or newest first. */
const descendingFirst: ReadonlySet<ServiceColumn> = new Set(["cpu", "memory", "deployed"]);

function byProjectThenName(a: ServiceTableRow, b: ServiceTableRow): number {
  return a.projectIndex - b.projectIndex || collator.compare(a.service.name, b.service.name);
}

/** A sorted copy: by `sort`, or by project and name; empty values (no CPU while stopped, never deployed) go last either way. */
export function sortServiceRows(rows: readonly ServiceTableRow[], sort: ServiceSort | null): ServiceTableRow[] {
  const base = [...rows].sort(byProjectThenName);
  return sort ? sortRows(base, sortValues[sort.column], sort.desc) : base;
}

/** The next sort when a header is clicked: its first direction, the other one, then back to project and name. */
export function nextServiceSort(current: ServiceSort | null, column: ServiceColumn): ServiceSort | null {
  const first = descendingFirst.has(column);
  if (!current || current.column !== column) return { column, desc: first };
  if (current.desc === first) return { column, desc: !first };
  return null;
}

/** aria-sort for a column header. */
export function ariaSort(sort: ServiceSort | null, column: ServiceColumn): "ascending" | "descending" | "none" {
  if (sort?.column !== column) return "none";
  return sort.desc ? "descending" : "ascending";
}
