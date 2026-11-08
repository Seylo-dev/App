// Durable reports (ReportEvent, ReportCrash) end up in panel.db, so what one
// node can make the panel store is bounded twice:
//
//   - field caps (field-caps.ts): every string and list of a report is cut
//     before anything stores it or fans it out, and agent_reports keeps a
//     smaller copy still, since nothing reads it back (it dedupes by outbox
//     id);
//   - a budget per node, lane and day (rows and bytes): past it a report is
//     acknowledged, so the agent drops it from its outbox, but neither
//     stored nor fanned out, and the panel raises one alert per node, lane
//     and day.
//
// Lanes keep floods from starving what must arrive. Crash reports, node
// alerts and deploy and build results share the general lane: the default
// crash policy restarts every 5 s and never gives up, so a handful of
// services crash-looping all day fill it. Cron results have a lane of their
// own, and backup, cleanup and update results another, so a crash or alert
// flood never drops them and many cron jobs never crowd out a backup. All
// lanes together still bound what one node adds per day.
//
// modules/nodes/retention.ts trims what each node has stored to the same
// caps every hour, reading only the nodes report_totals shows over a cap.

import { and, eq, gte, inArray, notInArray, type SQL, sql } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { type AgentReportKind, agentReports, crashReports } from "../db/schema";

export type ReportLane = "general" | "cron" | "results";

/** Durable event kinds outside the general lane. */
const laneKinds: Record<Exclude<ReportLane, "general">, AgentReportKind[]> = {
  cron: ["cronRun"],
  results: ["backupResult", "cleanupRun", "updateResult"],
};
const ownLaneKinds = [...laneKinds.cron, ...laneKinds.results];

/** The lane of a durable event kind (ReportEvent); crash reports are "general". */
export function reportLane(kind: string): ReportLane {
  if ((laneKinds.cron as string[]).includes(kind)) return "cron";
  if ((laneKinds.results as string[]).includes(kind)) return "results";
  return "general";
}

/** The lane of an agent_reports row, in SQL, from its kind column. */
export function reportLaneSql(kind: SQL | typeof agentReports.kind): SQL {
  const list = (kinds: string[]) =>
    sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    );
  return sql`case when ${kind} in (${list(laneKinds.cron)}) then 'cron' when ${kind} in (${list(laneKinds.results)}) then 'results' else 'general' end`;
}

/** Rows and bytes one node may add to panel.db through durable reports per day, per lane. */
export const reportBudget = {
  /** General lane (crash reports, alerts, deploy and build results). */
  rowsPerDay: 75_000,
  /** Stored bytes (event JSON, crash lines). */
  bytesPerDay: 32 * 1024 * 1024,
  /** Cron results: a job every minute is 1,440 runs a day; fifty such jobs on a node stay below. */
  cronRowsPerDay: 75_000,
  cronBytesPerDay: 32 * 1024 * 1024,
  /** Backup, cleanup and update results: a few a day each on a healthy node. */
  resultRowsPerDay: 10_000,
  resultBytesPerDay: 8 * 1024 * 1024,
  windowMs: 24 * 3600 * 1000,
};

type BudgetLimits = typeof reportBudget;

function laneLimits(limits: BudgetLimits, lane: ReportLane): { rows: number; bytes: number } {
  if (lane === "cron") return { rows: limits.cronRowsPerDay, bytes: limits.cronBytesPerDay };
  if (lane === "results") return { rows: limits.resultRowsPerDay, bytes: limits.resultBytesPerDay };
  return { rows: limits.rowsPerDay, bytes: limits.bytesPerDay };
}

interface Window {
  start: number;
  rows: number;
  bytes: number;
  alerted: boolean;
}

export interface ReportBudget {
  /**
   * Whether a report of `bytes` may still be stored for this node in this
   * lane's current window. The first refusal of a window calls `onExceeded`.
   */
  allows(nodeId: string, lane: ReportLane, bytes: number, now?: number): boolean;
  /** Counts a report that was stored. */
  spend(nodeId: string, lane: ReportLane, bytes: number, now?: number): void;
}

/**
 * Per-node, per-lane budgets over windows of a day. A window starts with
 * what panel.db already holds from the node in that lane for the last day
 * (`storedSince`), so a panel restart does not hand out a fresh budget. The
 * limits are read on every call (tests lower them).
 */
export function createReportBudget(options: {
  storedSince(nodeId: string, lane: ReportLane, since: Date): { rows: number; bytes: number };
  onExceeded(nodeId: string, lane: ReportLane, windowStart: number): void;
  limits?: Partial<BudgetLimits>;
}): ReportBudget {
  const limits = (): BudgetLimits => ({ ...reportBudget, ...options.limits });
  const windows = new Map<string, Window>();
  const windowOf = (nodeId: string, lane: ReportLane, now: number): Window => {
    const key = `${lane}:${nodeId}`;
    const windowMs = limits().windowMs;
    let window = windows.get(key);
    if (!window) {
      const stored = options.storedSince(nodeId, lane, new Date(now - windowMs));
      window = { start: now, rows: stored.rows, bytes: stored.bytes, alerted: false };
      windows.set(key, window);
    } else if (now - window.start >= windowMs) {
      window.start = now;
      window.rows = 0;
      window.bytes = 0;
      window.alerted = false;
    }
    return window;
  };
  return {
    allows(nodeId, lane, bytes, now = Date.now()) {
      const window = windowOf(nodeId, lane, now);
      const cap = laneLimits(limits(), lane);
      if (window.rows + 1 <= cap.rows && window.bytes + bytes <= cap.bytes) return true;
      if (!window.alerted) {
        window.alerted = true;
        options.onExceeded(nodeId, lane, window.start);
      }
      return false;
    },
    spend(nodeId, lane, bytes, now = Date.now()) {
      const window = windowOf(nodeId, lane, now);
      window.rows++;
      window.bytes += bytes;
    },
  };
}

/** What panel.db holds from one node's durable reports in one lane since a time: rows and bytes. */
export function storedReportsSince(db: PanelDb, nodeId: string, lane: ReportLane, since: Date): { rows: number; bytes: number } {
  const kinds = lane === "general" ? notInArray(agentReports.kind, ownLaneKinds) : inArray(agentReports.kind, laneKinds[lane]);
  const events = db
    .select({ rows: sql<number>`count(*)`, bytes: sql<number | null>`sum(length(${agentReports.event}))` })
    .from(agentReports)
    .where(and(eq(agentReports.nodeId, nodeId), gte(agentReports.createdAt, since), kinds))
    .get();
  if (lane !== "general") return { rows: events?.rows ?? 0, bytes: events?.bytes ?? 0 };
  const crashes = db
    .select({
      rows: sql<number>`count(*)`,
      bytes: sql<number | null>`sum(length(${crashReports.lastLines}) + length(${crashReports.containerId}))`,
    })
    .from(crashReports)
    .where(and(eq(crashReports.nodeId, nodeId), gte(crashReports.createdAt, since)))
    .get();
  return {
    rows: (events?.rows ?? 0) + (crashes?.rows ?? 0),
    bytes: (events?.bytes ?? 0) + (crashes?.bytes ?? 0),
  };
}
