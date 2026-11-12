// PR preview settings, the list of previews and deleting one. Previews are
// opened, updated and closed by GitHub pull_request webhooks (github module).

import { OpError, previews as previewOps } from "@seylo/ops";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { deployments, previews } from "../../db/schema";
import { implement } from "../../ops/implement";
import { waitingBuilds } from "../builds/slots";
import { defineModule } from "../module";
import { publishService, updateSpec } from "../services/ops";
import { loadService, toSummaries } from "../services/rows";
import { readSpec } from "../services/spec";
import { previewsUnavailable, removePreview } from "./preview";

const getSettings = implement(previewOps.getSettings, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const reason = previewsUnavailable(svc);
  return { settings: readSpec(svc.spec).previews, available: reason === null, unavailableReason: reason };
});

const updateSettings = implement(previewOps.updateSettings, async (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const current = readSpec(svc.spec).previews;
  const enabling = input.enabled === true && !current.enabled;
  if (enabling) {
    const reason = previewsUnavailable(svc);
    if (reason) throw new OpError("CONFLICT", reason);
    if (input.acknowledgeSharedEnv !== true) {
      throw new OpError(
        "BAD_REQUEST",
        "Previews use this service's environment, so they reach the same database. Confirm to turn them on.",
        {
          field: "acknowledgeSharedEnv",
        },
      );
    }
  }
  const next = updateSpec(ctx, svc.id, (spec) => ({
    ...spec,
    previews: {
      enabled: input.enabled ?? spec.previews.enabled,
      domainPattern: input.domainPattern ?? spec.previews.domainPattern,
      maxPreviews: input.maxPreviews ?? spec.previews.maxPreviews,
    },
  }));
  if (input.enabled === false && current.enabled) {
    const open = ctx.db
      .select()
      .from(previews)
      .where(and(eq(previews.serviceId, svc.id), isNull(previews.closedAt)))
      .all();
    for (const p of open) await removePreview(ctx, p.id);
  }
  publishService(ctx, svc);
  return readSpec(next.spec).previews;
});

const list = implement(previewOps.list, (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const rows = ctx.db.select().from(previews).where(eq(previews.serviceId, input.serviceId)).orderBy(desc(previews.createdAt)).all();
  const ids = rows.map((r) => r.previewServiceId).filter((id): id is string => id !== null);
  const latest = new Map<string, { id: string; status: (typeof deployments.$inferSelect)["status"] }>();
  if (ids.length > 0) {
    for (const d of ctx.db
      .select({ id: deployments.id, serviceId: deployments.serviceId, status: deployments.status })
      .from(deployments)
      .where(inArray(deployments.serviceId, ids))
      .orderBy(desc(deployments.createdAt))
      .all()) {
      if (!latest.has(d.serviceId)) latest.set(d.serviceId, { id: d.id, status: d.status });
    }
  }
  // Latest deploys that build, but whose build waits for a free build slot on its node.
  const waiting = waitingBuilds(
    ctx.db,
    [...latest.values()].filter((d) => d.status === "building").map((d) => d.id),
  );
  const addresses = new Map(
    toSummaries(
      ctx.db,
      ctx.agents,
      ids.map((id) => loadService(ctx.db, id)),
    ).map((s) => [s.id, s.address]),
  );
  const out = rows.map((r) => {
    const address = r.previewServiceId ? (addresses.get(r.previewServiceId) ?? null) : null;
    const deploy = r.previewServiceId ? latest.get(r.previewServiceId) : undefined;
    return {
      id: r.id,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      branch: r.branch,
      commitSha: r.commitSha,
      previewServiceId: r.previewServiceId,
      url: address?.includes(".") && !address.includes(":") ? `https://${address}` : null,
      status: deploy?.status ?? null,
      buildWaiting: deploy ? waiting.has(deploy.id) : false,
      closedAt: r.closedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
  // Open ones first.
  return { previews: [...out.filter((p) => !p.closedAt), ...out.filter((p) => p.closedAt)] };
});

const remove = implement(previewOps.remove, async (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const row = ctx.db
    .select()
    .from(previews)
    .where(and(eq(previews.id, input.previewId), eq(previews.serviceId, svc.id)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "No preview with this id.");
  await removePreview(ctx, row.id);
  publishService(ctx, svc);
  return {};
});

export default defineModule({ name: "previews", ops: [getSettings, updateSettings, list, remove] });
