// Reading the audit log: filtered pages, single entries and exports.
// Writing it is the op pipeline's job (src/ops/audit.ts). People without
// audit.view see only their own entries.
// Contracts: packages/ops/src/ops/audit.ts.

import { slug } from "@seylo/brand";
import { audit as auditOps, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { auditWhere, parseCursor, queryAudit, toCsv, toEntry, toJsonl } from "./query";

export const maxExportRows = 10_000;

/** Null when the caller sees the whole log, else their own user id. */
function ownOnly(ctx: OpContext): string | null {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return ctx.access.can("audit.view") ? null : ctx.principal.user.id;
}

const list = implement(auditOps.list, (input, ctx) => {
  const where = auditWhere(input, ownOnly(ctx));
  const rows = queryAudit(ctx.db, where, { beforeId: parseCursor(input.cursor), limit: input.limit + 1 });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { entries: page.map(toEntry), nextCursor: rows.length > input.limit && last ? String(last.id) : null };
});

const get = implement(auditOps.get, (input, ctx) => {
  const only = ownOnly(ctx);
  const row = ctx.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.id, Number(input.entryId)))
    .get();
  if (!row || (only && row.actorId !== only)) throw new OpError("NOT_FOUND", "That audit entry does not exist.");
  return toEntry(row);
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

export default defineModule({
  name: "audit",
  ops: [list, get, exportLog],
});
