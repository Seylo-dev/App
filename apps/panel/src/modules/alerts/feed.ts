// alerts.list (filtered to what the caller can see) and the mute ops.

import { alerts as alertOps, OpError } from "@seylo/ops";
import { and, desc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Access } from "../../auth/access";
import { alertMutes, alerts } from "../../db/schema";
import { implement } from "../../ops/implement";

type AlertRow = typeof alerts.$inferSelect;

/** Cursor "<createdAt ms>_<id>": the last row of the previous page. */
function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d{1,15})_([a-z0-9]{16})$/.exec(cursor);
  if (!match) throw new OpError("BAD_REQUEST", "The cursor is not valid.", { field: "cursor" });
  return { at: new Date(Number(match[1])), id: match[2] as string };
}

function cursorOf(row: AlertRow): string {
  return `${row.createdAt.getTime()}_${row.id}`;
}

/**
 * Whether the caller may see one alert; caches per service, project and
 * node. The feed, and the push fan-out (modules/push/send.ts) for each
 * person with a device, use the same rule.
 */
export function alertVisibility(access: Access) {
  const cache = new Map<string, boolean>();
  const cached = (key: string, check: () => boolean) => {
    let value = cache.get(key);
    if (value === undefined) {
      value = check();
      cache.set(key, value);
    }
    return value;
  };
  return (row: AlertRow): boolean => {
    if (row.serviceId) {
      const id = row.serviceId;
      return cached(`s:${id}`, () => access.can("services.view", { type: "service", id }));
    }
    if (row.projectId) {
      const id = row.projectId;
      return cached(`p:${id}`, () => access.can("projects.view", { type: "project", id }));
    }
    if (row.nodeId) return cached("nodes", () => access.can("nodes.view"));
    // Panel-wide alerts (updates, approvals) are for the people who run the panel.
    return cached("panel", () => access.can("alerts.manage"));
  };
}

export function toAlert(row: AlertRow) {
  return {
    id: row.id,
    event: row.event,
    severity: row.severity,
    title: row.title,
    message: row.message,
    projectId: row.projectId,
    serviceId: row.serviceId,
    nodeId: row.nodeId,
    link: row.link,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    muted: row.muted,
    createdAt: row.createdAt.toISOString(),
  };
}

const scanBatch = 200;
const scanLimit = 5000;

export const list = implement(alertOps.list, (input, ctx) => {
  const limit = input.limit ?? 50;
  const filters: SQL[] = [];
  if (input.projectId) filters.push(eq(alerts.projectId, input.projectId));
  if (input.serviceId) filters.push(eq(alerts.serviceId, input.serviceId));
  if (input.nodeId) filters.push(eq(alerts.nodeId, input.nodeId));
  if (input.unresolvedOnly) filters.push(isNull(alerts.resolvedAt));
  const visible = alertVisibility(ctx.access);

  const out: AlertRow[] = [];
  let after = parseCursor(input.cursor);
  let scanned = 0;
  let exhausted = false;
  // Keyset pages over the newest rows, dropping what the caller cannot see.
  while (out.length <= limit && scanned < scanLimit) {
    const page = ctx.db
      .select()
      .from(alerts)
      .where(
        and(
          ...filters,
          after ? or(lt(alerts.createdAt, after.at), and(eq(alerts.createdAt, after.at), lt(alerts.id, after.id))) : undefined,
        ),
      )
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(scanBatch)
      .all();
    scanned += page.length;
    for (const row of page) if (visible(row)) out.push(row);
    const last = page.at(-1);
    if (page.length < scanBatch || !last) {
      exhausted = true;
      break;
    }
    after = { at: last.createdAt, id: last.id };
  }
  const pageRows = out.slice(0, limit);
  const more = out.length > limit || !exhausted;
  const lastRow = pageRows.at(-1);
  return { alerts: pageRows.map(toAlert), nextCursor: more && lastRow ? cursorOf(lastRow) : null };
});

function toMute(row: typeof alertMutes.$inferSelect) {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    event: row.event,
    until: row.until?.toISOString() ?? null,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export const mutes = implement(alertOps.mutes, (_input, ctx) => ({
  mutes: ctx.db
    .select()
    .from(alertMutes)
    .where(or(isNull(alertMutes.until), gt(alertMutes.until, new Date())))
    .orderBy(desc(alertMutes.createdAt))
    .all()
    .map(toMute),
}));

export const mute = implement(alertOps.mute, (input, ctx) => {
  if (input.scopeType === "global" && input.scopeId) {
    throw new OpError("BAD_REQUEST", "A global mute has no scope id.", { field: "scopeId" });
  }
  if (input.scopeType !== "global" && !input.scopeId) {
    throw new OpError("BAD_REQUEST", `Say which ${input.scopeType} to mute.`, { field: "scopeId" });
  }
  const until = input.until ? new Date(input.until) : null;
  if (until && until.getTime() <= Date.now()) throw new OpError("BAD_REQUEST", "The end of the mute is in the past.", { field: "until" });
  const row = ctx.db
    .insert(alertMutes)
    .values({
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      event: input.event ?? null,
      until,
      reason: input.reason ?? "",
      createdBy: ctx.principal.type === "anonymous" ? null : ctx.principal.user.id,
    })
    .returning()
    .get();
  ctx.live.publish("panel", { type: "invalidate", ops: ["alerts.mutes"] });
  return toMute(row);
});

export const unmute = implement(alertOps.unmute, (input, ctx) => {
  const removed = ctx.db.delete(alertMutes).where(eq(alertMutes.id, input.muteId)).returning({ id: alertMutes.id }).get();
  if (!removed) throw new OpError("NOT_FOUND", "There is no such mute.");
  ctx.live.publish("panel", { type: "invalidate", ops: ["alerts.mutes"] });
  return {};
});
