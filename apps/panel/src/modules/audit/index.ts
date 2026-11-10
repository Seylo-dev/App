// Reading the audit log: filtered pages, single entries and exports.
// Writing it is the op pipeline's job (src/ops/audit.ts). People without
// audit.view see only their own entries; keys limited to projects only
// those projects' entries.
// Contracts: packages/ops/src/ops/audit.ts.

import { slug } from "@seylo/brand";
import { actionAllowed, audit as auditOps, OpError } from "@seylo/ops";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { isNarrowedKey } from "../../auth/access";
import { avatarUrlsOf } from "../../auth/avatar";
import { auditLog } from "../../db/schema";
import { defineJob } from "../../jobs/queue";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { auditWhere, parseCursor, queryAudit, toCsv, toEntry, toJsonl } from "./query";
import { pruneAudit } from "./retention";

export const maxExportRows = 10_000;

/** Null when the caller sees the whole log, else their own user id. */
function ownOnly(ctx: OpContext): string | null {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return ctx.access.can("audit.view") ? null : ctx.principal.user.id;
}

/**
 * A key limited to actions needs audit.view in its list to read the log at
 * all (the entries span every area); a key limited to projects reads only
 * entries of those projects. Unscoped keys and sessions read as before.
 */
function keyScope(ctx: OpContext): SQL[] {
  const p = ctx.principal;
  if (!isNarrowedKey(p)) return [];
  if (!actionAllowed(p.actions, "audit.view")) {
    throw new OpError("FORBIDDEN", "This key's actions do not include audit.view.", { action: "audit.view" });
  }
  if (p.projectIds === null) return [];
  return [p.projectIds.length ? inArray(auditLog.projectId, [...p.projectIds]) : sql`0`];
}

const list = implement(auditOps.list, (input, ctx) => {
  const where = [...auditWhere(input, ownOnly(ctx)), ...keyScope(ctx)];
  const rows = queryAudit(ctx.db, where, { beforeId: parseCursor(input.cursor), limit: input.limit + 1 });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const avatars = avatarUrlsOf(
    ctx.db,
    page.map((row) => row.actorId),
  );
  return {
    entries: page.map((row) => toEntry(row, row.actorId ? avatars.get(row.actorId) : undefined)),
    nextCursor: rows.length > input.limit && last ? String(last.id) : null,
  };
});

const get = implement(auditOps.get, (input, ctx) => {
  const only = ownOnly(ctx);
  const row = ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.id, Number(input.entryId)), ...keyScope(ctx)))
    .get();
  if (!row || (only && row.actorId !== only)) throw new OpError("NOT_FOUND", "That audit entry does not exist.");
  return toEntry(row, row.actorId ? avatarUrlsOf(ctx.db, [row.actorId]).get(row.actorId) : undefined);
});

const exportLog = implement(auditOps.exportLog, (input, ctx) => {
  const rows = queryAudit(ctx.db, auditWhere(input, null), { limit: maxExportRows + 1 });
  const truncated = rows.length > maxExportRows;
  const shown = rows.slice(0, maxExportRows);
  const date = new Date().toISOString().slice(0, 10);
  return input.format === "jsonl"
    ? {
        filename: `${slug}-audit-${date}.jsonl`,
        contentType: "application/x-ndjson",
        content: toJsonl(shown),
        rows: shown.length,
        truncated,
      }
    : {
        filename: `${slug}-audit-${date}.csv`,
        contentType: "text/csv; charset=utf-8",
        content: toCsv(shown),
        rows: shown.length,
        truncated,
      };
});

/** Applies the retention setting once a day (retention.ts). */
const prune = defineJob<Record<string, never>>({
  type: "audit.prune",
  async run(_payload, ctx) {
    const removed = pruneAudit(ctx.db);
    if (removed > 0) ctx.logger.info({ removed }, "old audit entries removed");
  },
});

export default defineModule({
  name: "audit",
  ops: [list, get, exportLog],
  jobs: [prune],
  start(deps) {
    deps.schedules.ensure({ key: "audit.prune", jobType: "audit.prune", cron: "47 3 * * *" });
  },
});
