// Approvals for ops models (MCP clients and the AI assistant) may not run
// on their own: listing, deciding, expiry. The queue itself is queue.ts;
// MCP and the assistant call requestApproval() there.
// Contracts: packages/ops/src/ops/approvals.ts.

import { approvals as approvalOps, OpError } from "@seylo/ops";
import { and, count, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { isNarrowedKey } from "../../auth/access";
import { requireSession } from "../../auth/sign-in";
import { approvals } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { approve as approveRequest, canSee, deny as denyRequest, expireOverdue, keyApprovalScope, toApproval } from "./queue";

const expireJobType = "approvals.expire";

function scope(ctx: OpContext): SQL | undefined {
  const p = ctx.principal;
  if (p.type === "anonymous") return eq(approvals.id, "");
  const byRole = p.user.role === "owner" || p.user.role === "admin" ? undefined : eq(approvals.requestedById, p.user.id);
  // A key limited to projects or actions reads its own requests and approvals inside its scope only.
  return isNarrowedKey(p) ? and(byRole, keyApprovalScope(ctx.db, p)) : byRole;
}

/** Who reads: an approval's chat title is only theirs to see when the chat is theirs. */
function viewerOf(ctx: OpContext): string | null {
  return ctx.principal.type === "anonymous" ? null : ctx.principal.user.id;
}

const list = implement(approvalOps.list, (input, ctx) => {
  expireOverdue(ctx);
  const limit = input.limit ?? 50;
  const status = input.status ?? "pending";
  let after: { at: Date; id: string } | null = null;
  if (input.cursor) {
    const match = /^(\d{1,15})_([a-z0-9]{16})$/.exec(input.cursor);
    if (!match) throw new OpError("BAD_REQUEST", "The cursor is not valid.", { field: "cursor" });
    after = { at: new Date(Number(match[1])), id: match[2] as string };
  }
  const visible = scope(ctx);
  const rows = ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        visible,
        status === "all" ? undefined : eq(approvals.status, status),
        after ? or(lt(approvals.createdAt, after.at), and(eq(approvals.createdAt, after.at), lt(approvals.id, after.id))) : undefined,
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const pendingCount =
    ctx.db
      .select({ n: count() })
      .from(approvals)
      .where(and(visible, eq(approvals.status, "pending")))
      .get()?.n ?? 0;
  return {
    approvals: page.map((row) => toApproval(ctx, row, viewerOf(ctx))),
    nextCursor: rows.length > limit && last ? `${last.createdAt.getTime()}_${last.id}` : null,
    pendingCount,
  };
});

const get = implement(approvalOps.get, (input, ctx) => {
  expireOverdue(ctx);
  const row = ctx.db.select().from(approvals).where(eq(approvals.id, input.approvalId)).get();
  if (!row || !canSee(ctx.db, ctx.principal, row)) throw new OpError("NOT_FOUND", "There is no such approval.");
  return toApproval(ctx, row, viewerOf(ctx));
});

// Approving replays the call with the approver's full rights, so it takes a
// person in the browser: a scoped API key must not lift a model's request
// past the key's own scope. Denying only stops something, so keys may.
const approve = implement(approvalOps.approve, async (input, ctx) => {
  requireSession(ctx);
  const done = await approveRequest(ctx, input.approvalId, ctx.principal, { ip: ctx.ip, userAgent: ctx.userAgent });
  return toApproval(ctx, done, viewerOf(ctx));
});

const deny = implement(approvalOps.deny, (input, ctx) =>
  toApproval(ctx, denyRequest(ctx, input.approvalId, ctx.principal, input.note), viewerOf(ctx)),
);

const expireJob = defineJob<Record<string, unknown>>({
  type: expireJobType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    expireOverdue(ctx);
  },
});

function start(deps: Deps) {
  deps.schedules.ensure({ key: expireJobType, jobType: expireJobType, intervalSeconds: 300, missedRun: "skip" });
}

export default defineModule({ name: "approvals", ops: [list, get, approve, deny], jobs: [expireJob], start });
