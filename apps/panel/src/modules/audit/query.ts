// Filtering and shaping audit_log rows for the Activity page and exports.

import { OpError } from "@seylo/ops";
import { and, desc, eq, gte, like, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type ActorType, auditLog } from "../../db/schema";

export type AuditRow = typeof auditLog.$inferSelect;

export interface AuditFilters {
  actorId?: string;
  actorType?: ActorType;
  opId?: string;
  targetType?: string;
  targetId?: string;
  projectId?: string;
  outcome?: "ok" | "error";
  from?: string;
  to?: string;
  q?: string;
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** WHERE conditions for the filters; `onlyActorId` limits to one person's own entries. */
export function auditWhere(filters: AuditFilters, onlyActorId: string | null): SQL[] {
  const where: SQL[] = [];
  if (onlyActorId) where.push(eq(auditLog.actorId, onlyActorId));
  if (filters.actorId) where.push(eq(auditLog.actorId, filters.actorId));
  if (filters.actorType) where.push(eq(auditLog.actorType, filters.actorType));
  if (filters.opId) {
    where.push(filters.opId.endsWith(".") ? like(auditLog.opId, `${escapeLike(filters.opId)}%`) : eq(auditLog.opId, filters.opId));
  }
  if (filters.targetType) where.push(eq(auditLog.targetType, filters.targetType));
  if (filters.targetId) where.push(eq(auditLog.targetId, filters.targetId));
  if (filters.projectId) where.push(eq(auditLog.projectId, filters.projectId));
  if (filters.outcome) where.push(eq(auditLog.outcome, filters.outcome));
  if (filters.from) where.push(gte(auditLog.at, new Date(filters.from)));
  if (filters.to) where.push(lte(auditLog.at, new Date(filters.to)));
  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where.push(
      or(
        sql`lower(${auditLog.actorLabel}) like ${pattern} escape '\\'`,
        sql`lower(${auditLog.opId}) like ${pattern} escape '\\'`,
        sql`lower(coalesce(${auditLog.targetLabel}, '')) like ${pattern} escape '\\'`,
      ) as SQL,
    );
  }
  return where;
}

export function queryAudit(db: PanelDb, where: SQL[], options: { beforeId?: number; limit: number }): AuditRow[] {
  const conditions = [...where];
  if (options.beforeId !== undefined) conditions.push(lt(auditLog.id, options.beforeId));
  return db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(options.limit)
    .all();
}

export function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[0-9]{1,15}$/.test(cursor)) throw new OpError("BAD_REQUEST", "Invalid cursor.", { field: "cursor" });
  return Number(cursor);
}

/** One entry as the API returns it; avatarUrl is the actor's avatar now (list and get pass it, exports do not). */
export function toEntry(row: AuditRow, avatarUrl?: string) {
  const input =
    row.input !== null && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : { value: row.input };
  return {
    id: String(row.id),
    at: row.at.toISOString(),
    actor: {
      type: row.actorType,
      id: row.actorId,
      label: row.actorLabel,
      ...(avatarUrl ? { avatarUrl } : {}),
      credentialId: row.credentialId,
    },
    opId: row.opId,
    target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId, label: row.targetLabel } : null,
    projectId: row.projectId,
    input,
    outcome: row.outcome,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    ip: row.ip,
    userAgent: row.userAgent,
    approvalId: row.approvalId,
  };
}

const csvColumns = [
  "id",
  "at",
  "actorType",
  "actorId",
  "actorLabel",
  "credentialId",
  "transport",
  "opId",
  "targetType",
  "targetId",
  "targetLabel",
  "projectId",
  "outcome",
  "errorCode",
  "durationMs",
  "ip",
  "userAgent",
  "approvalId",
  "input",
] as const;

/** One CSV cell: quoted when needed, and formula-looking text defused so spreadsheets never run it. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: AuditRow[]): string {
  const lines = [csvColumns.join(",")];
  for (const row of rows) {
    lines.push(csvColumns.map((column) => csvCell(column === "input" ? JSON.stringify(row.input) : row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function toJsonl(rows: AuditRow[]): string {
  return rows.map((row) => `${JSON.stringify({ ...toEntry(row), transport: row.transport })}\n`).join("");
}
