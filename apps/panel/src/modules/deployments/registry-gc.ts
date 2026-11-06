// Deleting old images from the panel registry. The registry's own garbage
// collection only frees blobs no manifest references, so the panel deletes
// the manifests of images it no longer keeps: those outside the rollback
// history, and every image of a deleted service. It speaks HTTP to the
// registry through a Tunnel(RegistryTarget) on the panel's node.

import { and, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { deployments, nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { registryRelay } from "./source";
import { keptImages } from "./store";

export const registryGcJobType = "deployments.registryGc";
export const registryGcSweepJobType = "deployments.registryGcSweep";

export interface RegistryGcPayload {
  /** Prune what a live service no longer keeps. */
  serviceId?: string;
  /** Delete these manifests of a deleted service (the rows are gone). */
  deleted?: { repository: string; digests: string[] };
}

/** One HTTP request to the registry through the panel node's tunnel; returns the status code. */
export async function registryRequest(deps: Pick<Deps, "agents">, nodeId: string, method: string, path: string): Promise<number> {
  const tunnel = deps.agents.openRaw(nodeId, "tunnel", { target: { case: "registry", value: {} } }, { timeoutMs: 30_000 });
  const request = `${method} ${path} HTTP/1.1\r\nHost: ${registryRelay}\r\nAccept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  await tunnel.writer.write(new TextEncoder().encode(request));
  let head = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of tunnel.body) {
      head += decoder.decode(chunk, { stream: true });
      if (head.includes("\r\n")) break;
    }
  } finally {
    tunnel.writer.end();
    tunnel.cancel("done");
  }
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!status) throw new Error("the registry did not answer over the tunnel");
  return Number(status[1]);
}

function panelNode(deps: Pick<Deps, "db" | "agents">): string | null {
  const row = deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
  return row && deps.agents.supports(row.id, "tunnel") ? row.id : null;
}

/** Built images of a service the rollback history no longer needs. */
export function prunableImages(deps: Pick<Deps, "db">, serviceId: string) {
  const svc = deps.db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!svc) return [];
  const rows = deps.db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        like(deployments.imageRef, `${registryRelay}/%`),
        isNotNull(deployments.imageDigest),
        isNull(deployments.imagePrunedAt),
      ),
    )
    .orderBy(deployments.createdAt)
    .all();
  const kept = new Set(
    rows
      .filter((r) => r.status === "live" || r.status === "superseded")
      .slice(-keptImages)
      .map((r) => r.imageDigest),
  );
  // Rollbacks and running deploys reuse digests: never delete one that is still wanted.
  const inUse = new Set(
    deps.db
      .select({ digest: deployments.imageDigest })
      .from(deployments)
      .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ["queued", "building", "deploying", "live"])))
      .all()
      .map((r) => r.digest),
  );
  return rows.filter(
    (r) => r.status !== "live" && !kept.has(r.imageDigest) && !inUse.has(r.imageDigest) && r.id !== svc.targetDeploymentId,
  );
}

export const registryGcJob = defineJob<RegistryGcPayload>({
  type: registryGcJobType,
  maxAttempts: 3,
  async run(payload, deps) {
    const node = panelNode(deps);
    // No reachable panel node (or an old agent): nothing to do now; the next deploy enqueues it again.
    if (!node) return;
    if (payload.deleted) {
      for (const digest of new Set(payload.deleted.digests)) {
        await registryRequest(deps, node, "DELETE", `/v2/${payload.deleted.repository}/manifests/${digest}`);
      }
    }
    if (payload.serviceId) {
      for (const row of prunableImages(deps, payload.serviceId)) {
        const status = await registryRequest(deps, node, "DELETE", `/v2/${row.serviceId}/manifests/${row.imageDigest}`);
        if (status === 202 || status === 404)
          deps.db.update(deployments).set({ imagePrunedAt: new Date() }).where(eq(deployments.id, row.id)).run();
        else deps.logger.warn({ serviceId: row.serviceId, status }, "the registry refused to delete an old image");
      }
    }
  },
});

/** Services with built images past the rollback history that are not deleted yet. */
export function servicesWithPrunableImages(deps: Pick<Deps, "db">): string[] {
  const ids = deps.db
    .selectDistinct({ serviceId: deployments.serviceId })
    .from(deployments)
    .where(and(like(deployments.imageRef, `${registryRelay}/%`), isNotNull(deployments.imageDigest), isNull(deployments.imagePrunedAt)))
    .all()
    .map((r) => r.serviceId);
  return ids.filter((id) => prunableImages(deps, id).length > 0);
}

/**
 * Daily: a GC run that could not happen after a deploy (the panel node was
 * offline, or the registry refused) is retried here, so the registry never
 * keeps images past the rollback history for long.
 */
export const registryGcSweepJob = defineJob<Record<string, never>>({
  type: registryGcSweepJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    for (const serviceId of servicesWithPrunableImages(deps)) {
      deps.jobs.enqueue(registryGcJobType, { serviceId }, { dedupeKey: `registry-gc:${serviceId}` });
    }
  },
});
