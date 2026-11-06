// Deleting services. A stack takes its members with it, and a service
// takes its PR previews. The rows go in one transaction; the nodes that ran
// them are marked dirty so their agents remove the containers.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpError, services as serviceOps } from "@seylo/ops";
import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { deployments, grants, previews, servicePlacements, services, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { registryGcJobType } from "../deployments/registry-gc";
import { registryRelay } from "../deployments/source";
import { metricsFor } from "../metrics/ingest";
import { publishService } from "./ops";
import { loadService, type ServiceRow } from "./rows";

/** The service, its compose members and its preview services. */
function closure(deps: Pick<Deps, "db">, root: ServiceRow): ServiceRow[] {
  const out = new Map<string, ServiceRow>([[root.id, root]]);
  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const children = deps.db.select().from(services).where(eq(services.parentId, id)).all();
    const previewIds = deps.db
      .select({ id: previews.previewServiceId })
      .from(previews)
      .where(eq(previews.serviceId, id))
      .all()
      .map((p) => p.id)
      .filter((p): p is string => p !== null);
    const previewRows = previewIds.length > 0 ? deps.db.select().from(services).where(inArray(services.id, previewIds)).all() : [];
    for (const row of [...children, ...previewRows]) {
      if (out.has(row.id)) continue;
      out.set(row.id, row);
      queue.push(row.id);
    }
  }
  return [...out.values()];
}

/**
 * Deletes a service (and what belongs to it) without the op's checks.
 * Used by services.delete, previews and compose updates.
 */
export async function deleteServiceTree(deps: Deps, root: ServiceRow): Promise<void> {
  const rows = closure(deps, root);
  const ids = rows.map((r) => r.id);
  const nodeIds = new Set(
    deps.db
      .select({ nodeId: servicePlacements.nodeId })
      .from(servicePlacements)
      .where(inArray(servicePlacements.serviceId, ids))
      .all()
      .map((p) => p.nodeId),
  );
  const uploads = deps.db.select({ id: sourceUploads.id }).from(sourceUploads).where(inArray(sourceUploads.serviceId, ids)).all();
  // Their images in the panel registry go too (the rows are about to be deleted).
  const images = deps.db
    .select({ serviceId: deployments.serviceId, digest: deployments.imageDigest })
    .from(deployments)
    .where(
      and(
        inArray(deployments.serviceId, ids),
        like(deployments.imageRef, `${registryRelay}/%`),
        isNotNull(deployments.imageDigest),
        isNull(deployments.imagePrunedAt),
      ),
    )
    .all();
  deps.db.transaction((tx) => {
    tx.delete(grants)
      .where(and(eq(grants.scopeType, "service"), inArray(grants.scopeId, ids)))
      .run();
    // Members cascade with their stack; delete children first so restrict-style references never block.
    for (const row of [...rows].reverse()) tx.delete(services).where(eq(services.id, row.id)).run();
  });
  for (const nodeId of nodeIds) deps.agents.desired.markDirty({ nodeId });
  for (const id of ids) {
    const digests = images.filter((i) => i.serviceId === id).map((i) => i.digest as string);
    if (digests.length > 0) deps.jobs.enqueue(registryGcJobType, { deleted: { repository: id, digests } });
  }
  for (const row of rows) publishService(deps, row);
  for (const id of ids) metricsFor(deps).forgetService(id);
  await Promise.all(uploads.map((u) => rm(join(deps.config.dataDir, "uploads", `${u.id}.tar.gz`), { force: true }).catch(() => undefined)));
}

export const remove = implement(serviceOps.remove, async (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.protected) throw new OpError("CONFLICT", `${row.name} is protected and cannot be deleted.`);
  if (input.confirmName !== row.name)
    throw new OpError("BAD_REQUEST", "Type the service name exactly to confirm.", { field: "confirmName" });
  if (row.parentId)
    throw new OpError("CONFLICT", `${row.name} belongs to a compose stack. Remove it from the stack's compose file instead.`);
  await deleteServiceTree(ctx, row);
  return {};
});
