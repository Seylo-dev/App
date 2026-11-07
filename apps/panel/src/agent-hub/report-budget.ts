// Durable reports (ReportEvent, ReportCrash) end up in panel.db, so what one
// node can make the panel store is bounded twice:
//
//   - field caps (field-caps.ts): every string and list of a report is cut
//     before anything stores it or fans it out, and agent_reports keeps a
//     smaller copy still, since nothing reads it back (it dedupes by outbox
//     id);
//   - a budget per node and day (rows and bytes, crash reports and events
//     together): past it a report is acknowledged, so the agent drops it from
//     its outbox, but neither stored nor fanned out, and the panel raises one
//     alert per node and day.
//
// modules/nodes/retention.ts trims what each node has stored to the same
// caps every hour.

import { and, eq, gte, sql } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { agentReports, crashReports } from "../db/schema";

/** Rows and bytes one node may add to panel.db through durable reports per day. */
export const reportBudget = {
  /** A cron job every minute is 1,440 runs a day; fifty such jobs on a node stay below. */
  rowsPerDay: 75_000,
  /** Stored bytes (event JSON, crash lines). */
  bytesPerDay: 32 * 1024 * 1024,
  windowMs: 24 * 3600 * 1000,
};

interface Window {
  start: number;
  rows: number;
  bytes: number;
  alerted: boolean;
}

export interface ReportBudget {
  /**
   * Whether a report of `bytes` may still be stored for this node in the
   * current window. The first refusal of a window calls `onExceeded`.
   */
  allows(nodeId: string, bytes: number, now?: number): boolean;
  /** Counts a report that was stored. */
  spend(nodeId: string, bytes: number, now?: number): void;
}

/**
 * Per-node budgets over windows of a day. A node's first window starts with
 * what panel.db already holds from it for the last day (`storedSince`), so a
 * panel restart does not hand out a fresh budget. The limits are read on
 * every call (tests lower them).
 */
export function createReportBudget(options: {
  storedSince(nodeId: string, since: Date): { rows: number; bytes: number };
  onExceeded(nodeId: string, windowStart: number): void;
  limits?: typeof reportBudget;
}): ReportBudget {
  const limits = options.limits ?? reportBudget;
  const windows = new Map<string, Window>();
  const windowOf = (nodeId: string, now: number): Window => {
    let window = windows.get(nodeId);
    if (!window) {
      const stored = options.storedSince(nodeId, new Date(now - limits.windowMs));
      window = { start: now, rows: stored.rows, bytes: stored.bytes, alerted: false };
      windows.set(nodeId, window);
    } else if (now - window.start >= limits.windowMs) {
      window.start = now;
      window.rows = 0;
      window.bytes = 0;
      window.alerted = false;
    }
    return window;
  };
  return {
    allows(nodeId, bytes, now = Date.now()) {
      const window = windowOf(nodeId, now);
      if (window.rows + 1 <= limits.rowsPerDay && window.bytes + bytes <= limits.bytesPerDay) return true;
      if (!window.alerted) {
        window.alerted = true;
        options.onExceeded(nodeId, window.start);
      }
      return false;
    },
    spend(nodeId, bytes, now = Date.now()) {
      const window = windowOf(nodeId, now);
      window.rows++;
      window.bytes += bytes;
    },
  };
}

/** What panel.db holds from one node's durable reports since a time: rows and bytes. */
export function storedReportsSince(db: PanelDb, nodeId: string, since: Date): { rows: number; bytes: number } {
  const events = db
    .select({ rows: sql<number>`count(*)`, bytes: sql<number | null>`sum(length(${agentReports.event}))` })
    .from(agentReports)
    .where(and(eq(agentReports.nodeId, nodeId), gte(agentReports.createdAt, since)))
    .get();
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
