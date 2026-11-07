// How long the audit log keeps entries: settings.general's
// auditRetentionDays (default 365, null keeps everything), applied once a
// day by the "audit.prune" job. Successful security changes are kept
// whatever the setting: sign-ins and account security, API keys and MCP
// tokens, people, invites and grants, CLI sign-ins, host shells, the setup
// and join tokens. Refused attempts at them (failed sign-ins) follow the
// setting like everything else.

import { and, lt, ne, notLike, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { auditLog } from "../../db/schema";
import { getSetting, setSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /** Days the audit log keeps entries; 0 keeps them forever (a null setting is a missing one). Absent: the default. */
    auditRetentionDays: number;
  }
}

export const defaultAuditRetentionDays = 365;

/** Op ids (prefixes end with ".") whose successful entries are never pruned. */
export const keptAuditOps = [
  "auth.",
  "apiKeys.",
  "users.",
  "invites.",
  "grants.",
  "cliLogin.",
  "hostShell.",
  "mcp.",
  "setup.",
  "nodes.createJoinToken",
] as const;

/** Days entries are kept, or null for forever. */
export function readAuditRetentionDays(db: PanelDb): number | null {
  const stored = getSetting(db, "auditRetentionDays");
  if (stored === undefined) return defaultAuditRetentionDays;
  return stored === 0 ? null : stored;
}

export function writeAuditRetentionDays(db: PanelDb, days: number | null): void {
  setSetting(db, "auditRetentionDays", days ?? 0);
}

/** Deletes entries older than the retention, except kept security changes. Returns how many went. */
export function pruneAudit(db: PanelDb, now = Date.now()): number {
  const days = readAuditRetentionDays(db);
  if (days === null) return 0;
  const cutoff = new Date(now - days * 24 * 3600 * 1000);
  const notKept = and(...keptAuditOps.map((id) => notLike(auditLog.opId, id.endsWith(".") ? `${id}%` : id)));
  const result = db
    .delete(auditLog)
    .where(and(lt(auditLog.at, cutoff), or(ne(auditLog.outcome, "ok"), notKept)))
    .run() as unknown as { changes?: number };
  return result.changes ?? 0;
}
