// Deployment rows: the step timeline, mapping to the op shape, and the
// live invalidations screens follow.

import { builds as buildOps, deployments as deploymentOps, projects as projectOps, services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { builds, type DeployStep, type DeployStepKey, type DeployStepStatus, deployments, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { nodeNames } from "../services/rows";

export type DeploymentRow = typeof deployments.$inferSelect;
export type Deployment = Static<typeof deploymentOps.Deployment>;

/** Images kept for instant rollback ("Last 5 images kept"). */
export const keptImages = 5;

export const finalStatuses = ["live", "superseded", "failed", "cancelled"] as const;
export const activeStatuses = ["queued", "building", "deploying"] as const;

export function isFinal(status: DeploymentRow["status"]): boolean {
  return (finalStatuses as readonly string[]).includes(status);
}

export const stepOrder: DeployStepKey[] = ["clone", "build", "ship", "health", "switch"];

export function initialSteps(build: boolean): DeployStep[] {
  return stepOrder.map((key) => ({
    key,
    status: !build && (key === "clone" || key === "build") ? "skipped" : "pending",
    nodeId: null,
    detail: !build && (key === "clone" || key === "build") ? "Nothing to build" : "",
    durationMs: null,
  }));
}

/** Returns new steps with one step changed. Running steps remember when they started in durationMs (negative epoch ms). */
export function setStep(
  steps: readonly DeployStep[],
  key: DeployStepKey,
  status: DeployStepStatus,
  patch: { detail?: string; nodeId?: string | null } = {},
  now = Date.now(),
): DeployStep[] {
  return steps.map((step) => {
    if (step.key !== key) return step;
    let durationMs = step.durationMs;
    if (status === "running" && step.status !== "running") durationMs = -now;
    else if (status !== "running" && status !== "pending" && step.status === "running" && durationMs !== null && durationMs < 0) {
      durationMs = now + durationMs;
    } else if (status === "skipped") durationMs = null;
    return {
      ...step,
      status,
      durationMs,
      detail: patch.detail ?? step.detail,
      nodeId: patch.nodeId === undefined ? step.nodeId : patch.nodeId,
    };
  });
}

/** Ends every running step as failed (or skipped for pending ones) when a deploy stops early. */
export function closeSteps(steps: readonly DeployStep[], outcome: "failed" | "cancelled", now = Date.now()): DeployStep[] {
  let out = [...steps];
  for (const step of steps) {
    if (step.status === "running") out = setStep(out, step.key, outcome === "failed" ? "failed" : "skipped", {}, now);
    else if (step.status === "pending")
      out = setStep(out, step.key, "skipped", { detail: outcome === "failed" ? "Skipped, previous version kept" : "Cancelled" }, now);
  }
  return out;
}

/** Deployment ids that are among the last kept images of their service. */
function keptIds(db: PanelDb, serviceId: string): Set<string> {
  const rows = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ["live", "superseded"]), isNotNull(deployments.imageRef)))
    .orderBy(desc(deployments.createdAt))
    .limit(keptImages)
    .all();
  return new Set(rows.map((r) => r.id));
}

/**
 * The digest a deployment runs: the pushed digest of a build, or for an
 * image pulled by tag the digest its node reported (kept in nodeResults so
 * recording it never changes the running spec). Rollbacks pin to it.
 */
export function deploymentDigest(row: Pick<DeploymentRow, "imageDigest" | "nodeResults">): string | null {
  return row.imageDigest ?? Object.values(row.nodeResults).find((r) => r.digest)?.digest ?? null;
}

export function toDeployments(db: PanelDb, rows: readonly DeploymentRow[]): Deployment[] {
  if (rows.length === 0) return [];
  const nodeIds = new Set<string>();
  for (const r of rows) {
    if (r.builtOnNodeId) nodeIds.add(r.builtOnNodeId);
    for (const id of r.targetNodeIds) nodeIds.add(id);
    for (const s of r.steps) if (s.nodeId) nodeIds.add(s.nodeId);
  }
  const names = nodeNames(db, [...nodeIds]);
  const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? "removed node" } : null);
  const kept = new Map<string, Set<string>>();
  const now = Date.now();
  const builders = new Map(
    db
      .select({ deploymentId: builds.deploymentId, builder: builds.builder })
      .from(builds)
      .where(
        inArray(
          builds.deploymentId,
          rows.map((r) => r.id),
        ),
      )
      .all()
      .map((b) => [b.deploymentId, b.builder]),
  );

  return rows.map((r) => {
    let keep = kept.get(r.serviceId);
    if (!keep) {
      keep = keptIds(db, r.serviceId);
      kept.set(r.serviceId, keep);
    }
    return {
      id: r.id,
      serviceId: r.serviceId,
      generation: Math.max(1, r.generation),
      status: r.status,
      live: r.status === "live",
      trigger: r.trigger,
      actor: r.actor,
      commit: r.commitSha ? { sha: r.commitSha, message: r.commitMessage ?? "", branch: r.branch, author: r.commitAuthor } : null,
      builder: builders.get(r.id) ?? null,
      builtOn: ref(r.builtOnNodeId),
      shippedTo: r.targetNodeIds.map((id) => ref(id) as { id: string; name: string }),
      image: r.imageRef
        ? { reference: r.imageRef, digest: deploymentDigest(r), sizeBytes: r.imageSizeBytes, shippedBytes: r.shippedBytes }
        : null,
      steps: r.steps.map((s) => ({
        key: s.key,
        status: s.status,
        node: ref(s.nodeId),
        detail: s.detail,
        // A running step stores its start as a negative number; show the time so far.
        durationMs: s.durationMs === null ? null : s.durationMs < 0 ? Math.max(0, now + s.durationMs) : s.durationMs,
      })),
      durationMs: r.finishedAt && r.startedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      canRollback: r.status === "superseded" && keep.has(r.id),
      rollbackOf: r.rollbackOf,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export function toDeployment(db: PanelDb, row: DeploymentRow): Deployment {
  return toDeployments(db, [row])[0] as Deployment;
}

export function loadDeployment(db: PanelDb, serviceId: string, deploymentId: string): DeploymentRow | undefined {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.serviceId, serviceId)))
    .get();
}

/**
 * Tells open screens that a service's deployments (and so its status)
 * changed. With a deployment id, its new state also goes to
 * "deployment:<id>" as a { type: "deployment" } event, so a deploy log page
 * follows status and steps without refetching.
 */
/** Called after a deployment changed (status, steps, commit); never throws into the caller. */
export type DeploymentListener = (row: DeploymentRow) => void;
const deploymentListeners = new WeakMap<object, Set<DeploymentListener>>();

/** Lets a module follow deployments of this panel (for example to post commit statuses). */
export function onDeploymentChange(db: object, listener: DeploymentListener): () => void {
  let set = deploymentListeners.get(db);
  if (!set) {
    set = new Set();
    deploymentListeners.set(db, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

export function publishDeploymentChange(deps: Pick<Deps, "db" | "live">, serviceId: string, deploymentId?: string): void {
  if (deploymentId) {
    const row = loadDeployment(deps.db, serviceId, deploymentId);
    if (row) deps.live.publish(`deployment:${deploymentId}`, { type: "deployment", deployment: toDeployment(deps.db, row) });
    if (row) {
      for (const listener of deploymentListeners.get(deps.db) ?? []) {
        try {
          listener(row);
        } catch {
          // A listener's failure is its own; the deploy goes on.
        }
      }
    }
  }
  const svc = deps.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, serviceId)).get();
  deps.live.publish(`service:${serviceId}`, {
    type: "invalidate",
    ops: [deploymentOps.list.id, deploymentOps.get.id, deploymentOps.log.id, serviceOps.get.id, buildOps.queue.id],
  });
  if (svc) {
    deps.live.publish(`project:${svc.projectId}`, { type: "invalidate", ops: [serviceOps.list.id, projectOps.get.id] });
  }
  deps.live.publish("panel", { type: "invalidate", ops: [buildOps.queue.id, deploymentOps.recent.id] });
}
