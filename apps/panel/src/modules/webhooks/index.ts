// Deploy trigger URLs (rotate, show, delete), the webhook delivery log, and
// asking GitHub to redeliver failed deliveries. Trigger URLs are POST
// /api/hooks/deploy/<token> (trigger.ts); GitHub's own route is in the
// github module.

import { OpError, webhooks as webhookOps } from "@seylo/ops";
import { and, desc, eq, gte } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { deployTriggers, webhookDeliveries } from "../../db/schema";
import { implement } from "../../ops/implement";
import { hashToken, randomToken } from "../../security/tokens";
import { githubPages, githubRequest } from "../github/api";
import { appJwt, panelBaseUrl, requireApp } from "../github/app";
import { defineModule } from "../module";
import { loadService } from "../services/rows";
import { deployTriggerPath, triggerRoute } from "./trigger";

const redeliverWindowMs = 3 * 24 * 60 * 60_000;

const getTrigger = implement(webhookOps.getTrigger, (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const row = ctx.db
    .select()
    .from(deployTriggers)
    .where(eq(deployTriggers.serviceId, input.serviceId))
    .orderBy(desc(deployTriggers.createdAt))
    .get();
  return {
    configured: row !== undefined,
    hint: row?.hint ?? null,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
    createdAt: row?.createdAt.toISOString() ?? null,
  };
});

const rotateTrigger = implement(webhookOps.rotateTrigger, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  if (svc.kind === "compose") throw new OpError("CONFLICT", "Stacks deploy through their members' trigger URLs.");
  const token = randomToken();
  const row = ctx.db.transaction((tx) => {
    tx.delete(deployTriggers).where(eq(deployTriggers.serviceId, svc.id)).run();
    return tx
      .insert(deployTriggers)
      .values({ serviceId: svc.id, tokenHash: hashToken(token), hint: token.slice(-4), createdBy: userOf(ctx.principal)?.id ?? null })
      .returning()
      .get();
  });
  ctx.live.publish(`service:${svc.id}`, { type: "invalidate", ops: [webhookOps.getTrigger.id] });
  const path = `${deployTriggerPath}/${token}`;
  const base = panelBaseUrl(ctx.db);
  return { url: base ? `${base}${path}` : path, hint: row.hint, createdAt: row.createdAt.toISOString() };
});

const deleteTrigger = implement(webhookOps.deleteTrigger, (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const removed = ctx.db.delete(deployTriggers).where(eq(deployTriggers.serviceId, input.serviceId)).returning().all();
  if (removed.length === 0) throw new OpError("NOT_FOUND", "This service has no deploy trigger URL.");
  ctx.live.publish(`service:${input.serviceId}`, { type: "invalidate", ops: [webhookOps.getTrigger.id] });
  return {};
});

const listDeliveries = implement(webhookOps.listDeliveries, (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const rows = ctx.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.serviceId, input.serviceId))
    .orderBy(desc(webhookDeliveries.receivedAt))
    .limit(input.limit ?? 50)
    .all();
  const cutoff = Date.now() - redeliverWindowMs;
  return {
    deliveries: rows.map((r) => ({
      id: r.id,
      source: r.source,
      event: r.event,
      outcome: r.outcome,
      detail: r.detail,
      deploymentId: r.deploymentId,
      canRedeliver: r.source === "github" && r.outcome === "failed" && r.receivedAt.getTime() > cutoff && !r.deliveryId.startsWith("poll-"),
      receivedAt: r.receivedAt.toISOString(),
    })),
  };
});

const redeliver = implement(webhookOps.redeliver, async (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const since = new Date(Date.now() - redeliverWindowMs);
  const rows = ctx.db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.serviceId, input.serviceId),
        eq(webhookDeliveries.source, "github"),
        eq(webhookDeliveries.outcome, "failed"),
        gte(webhookDeliveries.receivedAt, since),
        ...(input.deliveryId ? [eq(webhookDeliveries.id, input.deliveryId)] : []),
      ),
    )
    .all()
    .filter((r) => !r.deliveryId.startsWith("poll-"));
  if (input.deliveryId && rows.length === 0) throw new OpError("NOT_FOUND", "No failed GitHub delivery with this id from the last 3 days.");
  if (rows.length === 0) return { requested: 0 };
  const app = requireApp(ctx.db);
  const jwt = appJwt(app, ctx.secrets);
  const guids = new Set(rows.map((r) => r.deliveryId));
  const found = await githubPages<{ id: number; guid: string }>(
    "/app/hook/deliveries",
    jwt,
    (page) => page as { id: number; guid: string }[],
    5,
  );
  const ids = [...new Map(found.filter((d) => guids.has(d.guid)).map((d) => [d.guid, d.id])).values()];
  let requested = 0;
  for (const id of ids) {
    await githubRequest(`/app/hook/deliveries/${id}/attempts`, { method: "POST", auth: jwt });
    requested++;
  }
  return { requested };
});

export { deployTriggerPath };

export default defineModule({
  name: "webhooks",
  ops: [getTrigger, rotateTrigger, deleteTrigger, listDeliveries, redeliver],
  http: (deps) => triggerRoute(deps),
});
