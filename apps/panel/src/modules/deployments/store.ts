// Deployment rows: the step timeline, mapping to the op shape, and the
// live invalidations screens follow.

import {
  builds as buildOps,
  deployments as deploymentOps,
  previews as previewOps,
  projects as projectOps,
  services as serviceOps,
} from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import {
  buildInFlight,
  builds,
  type DeployStep,
  type DeployStepKey,
  type DeployStepStatus,
  deployments,
  previews,
  services,
  sourceUploads,
} from "../../db/schema";
import type { Deps } from "../../deps";
import { waitingBuilds, waitingDetail } from "../builds/slots";
import { databaseKinds } from "../domains/lookup";
import { moveCancellable, moveTarget } from "../services/move-runs";
import { nodeNames } from "../services/rows";
import { lastOutputOf, legacyError, maxLastOutputLines, portHintOf } from "./failure";

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
      // The wall clock can step back (NTP): never a negative duration.
      durationMs = Math.max(0, now + durationMs);
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
 * For a database: the image its live deployment runs (null without one).
 * Its other deployments ran an image from before a version change, whose
 * files the newer version may have changed: a rollback takes only a
 * deployment of this image (deployments.rollback, reason databaseVersion),
 * and canRollback is false for the others. undefined for every other kind.
 */
export function databaseRollbackImage(db: PanelDb, serviceId: string): DatabaseImage | null | undefined {
  const svc = db
    .select({ kind: services.kind, liveDeploymentId: services.liveDeploymentId })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
  if (!svc || !databaseKinds.has(svc.kind)) return undefined;
  if (!svc.liveDeploymentId) return null;
  const live = db
    .select({ imageRef: deployments.imageRef, imageDigest: deployments.imageDigest, nodeResults: deployments.nodeResults })
    .from(deployments)
    .where(eq(deployments.id, svc.liveDeploymentId))
    .get();
  return live ? { ref: live.imageRef ?? null, digest: deploymentDigest(live) } : null;
}

/** What a database's live deployment runs: its image reference and the digest it pulled (null when not recorded). */
export interface DatabaseImage {
  ref: string | null;
  digest: string | null;
}

/**
 * True when a database's deployment ran the same image as its live one. The
 * reference alone is not enough: a rollback pins the deployment's digest, so
 * an earlier deployment of a floating tag (mongo:latest, postgres:17) would run
 * the older release the tag pointed at then, on newer data. A digest recorded
 * on one side only counts as different.
 */
export function sameDatabaseImage(
  row: Pick<DeploymentRow, "imageRef" | "imageDigest" | "nodeResults">,
  live: DatabaseImage | null,
): boolean {
  if (!live || row.imageRef !== live.ref) return false;
  return deploymentDigest(row) === live.digest;
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
    for (const id of Object.keys(r.nodeResults)) nodeIds.add(id);
    if (r.movedFromNodeId) nodeIds.add(r.movedFromNodeId);
  }
  // Whether services.usePort applies to a failed deploy's service: an app of its own, not a compose member.
  const failedServices = [...new Set(rows.filter((r) => r.status === "failed").map((r) => r.serviceId))];
  const ownApps = new Set(
    failedServices.length === 0
      ? []
      : db
          .select({ id: services.id, kind: services.kind, parentId: services.parentId })
          .from(services)
          .where(inArray(services.id, failedServices))
          .all()
          .filter((s) => s.kind === "app" && s.parentId === null)
          .map((s) => s.id),
  );
  // Use port belongs to the service's newest deployment only: once another deploy was started (it went live
  // on the port, it runs, or it was Use port's own), an older failure's hint is history, not advice.
  const newest = new Map(
    failedServices.length === 0
      ? []
      : db
          .select({ serviceId: deployments.serviceId, generation: max(deployments.generation) })
          .from(deployments)
          .where(inArray(deployments.serviceId, failedServices))
          .groupBy(deployments.serviceId)
          .all()
          .map((g) => [g.serviceId, g.generation]),
  );
  // Builds waiting for a free slot on their node: their clone step says so instead of "Fetching source".
  const waits = waitingBuilds(
    db,
    rows.filter((r) => r.status === "building").map((r) => r.id),
  );
  for (const w of waits.values()) nodeIds.add(w.nodeId);
  const names = nodeNames(db, [...nodeIds]);
  const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? "removed node" } : null);
  const kept = new Map<string, Set<string>>();
  const databaseImages = new Map<string, DatabaseImage | null | undefined>();
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
  const uploadIds = [...new Set(rows.flatMap((r) => (r.uploadId ? [r.uploadId] : [])))];
  const archives = new Map(
    uploadIds.length === 0
      ? []
      : db
          .select({ id: sourceUploads.id, fileName: sourceUploads.fileName })
          .from(sourceUploads)
          .where(inArray(sourceUploads.id, uploadIds))
          .all()
          .map((u) => [u.id, u.fileName]),
  );

  return rows.map((r) => {
    let keep = kept.get(r.serviceId);
    if (!keep) {
      keep = keptIds(db, r.serviceId);
      kept.set(r.serviceId, keep);
    }
    if (!databaseImages.has(r.serviceId)) databaseImages.set(r.serviceId, databaseRollbackImage(db, r.serviceId));
    const databaseImage = databaseImages.get(r.serviceId);
    const wait = waits.get(r.id);
    const buildWait = wait ? { node: ref(wait.nodeId) as { id: string; name: string }, position: wait.position } : null;
    let output = r.status === "failed" ? lastOutputOf(r.nodeResults) : null;
    const hint = r.status === "failed" ? portHintOf(r.nodeResults) : null;
    // Failed before 0.2.16: the app's output is still in the stored error; split it off as it is read.
    let error = r.error;
    const legacy = r.status === "failed" && !output ? legacyError(r.error) : null;
    if (legacy) {
      error = legacy.error;
      const nodeId =
        Object.entries(r.nodeResults).find(([, n]) => n.status === "failed")?.[0] ?? r.targetNodeIds[0] ?? Object.keys(r.nodeResults)[0];
      if (nodeId && legacy.lines.length > 0) output = { nodeId, lines: legacy.lines.slice(-maxLastOutputLines) };
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
      source: deploymentSource(r, archives),
      builder: builders.get(r.id) ?? null,
      builtOn: ref(r.builtOnNodeId),
      buildWait,
      shippedTo: r.targetNodeIds.map((id) => ref(id) as { id: string; name: string }),
      image: r.imageRef
        ? { reference: r.imageRef, digest: deploymentDigest(r), sizeBytes: r.imageSizeBytes, shippedBytes: r.shippedBytes }
        : null,
      steps: r.steps.map((s) => ({
        key: s.key,
        status: s.status,
        node: ref(s.nodeId),
        // Read from the queue each time: deployments whose build waits on a node are published again when it moves.
        detail:
          buildWait && s.key === "clone" && s.status === "running" ? waitingDetail(buildWait.node.name, buildWait.position) : s.detail,
        // A running step stores its start as a negative number: show the time
        // so far. On a finished step a negative number is a duration measured
        // across a wall clock step back (stored before setStep clamped it): 0.
        durationMs:
          s.durationMs === null ? null : s.durationMs >= 0 ? s.durationMs : s.status === "running" ? Math.max(0, now + s.durationMs) : 0,
      })),
      durationMs: r.finishedAt && r.startedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
      canRollback: r.status === "superseded" && keep.has(r.id) && (databaseImage === undefined || sameDatabaseImage(r, databaseImage)),
      rollbackOf: r.rollbackOf,
      error,
      lastOutput: output ? { node: ref(output.nodeId) as { id: string; name: string }, lines: output.lines } : null,
      portHint: hint
        ? {
            node: ref(hint.nodeId) as { id: string; name: string },
            port: hint.port,
            listening: hint.listening,
            loopbackOnly: hint.loopbackOnly,
            canUsePort: hint.switchable && ownApps.has(r.serviceId) && newest.get(r.serviceId) === r.generation,
          }
        : null,
      move: moveOf(db, r, ref),
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

/** Deployment.move: where a move to another node goes, whether it still copies, and whether a cancel is taken now (services/move-runs.ts). */
function moveOf(db: PanelDb, r: DeploymentRow, ref: (id: string | null) => { id: string; name: string } | null): Deployment["move"] {
  const from = r.movedFromNodeId;
  const to = moveTarget(r);
  if (!from || !to) return null;
  const unfinished = !isFinal(r.status);
  return {
    from: ref(from) as { id: string; name: string },
    to: ref(to) as { id: string; name: string },
    copying: unfinished && r.moveCopying,
    canCancel: unfinished && moveCancellable(db, r),
  };
}

/**
 * What a deploy built from, from its own row: the branch, else the archive's
 * name (the upload's row, which goes once newer uploads replace it; then the
 * clone step's detail, which holds the name once the archive was unpacked).
 * Never the service's source as it is now: that names the latest upload or
 * branch on every older row.
 */
export function deploymentSource(
  r: Pick<DeploymentRow, "branch" | "uploadId" | "steps">,
  archives: ReadonlyMap<string, string>,
): string | null {
  if (r.branch) return r.branch;
  if (!r.uploadId) return null;
  const clone = r.steps.find((s) => s.key === "clone");
  return archives.get(r.uploadId) ?? (clone?.status === "ok" && clone.detail ? clone.detail : null);
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
  if (deploymentId) publishDeploymentEvent(deps, serviceId, deploymentId);
  const svc = deps.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, serviceId)).get();
  deps.live.publish(`service:${serviceId}`, {
    type: "invalidate",
    ops: [deploymentOps.list.id, deploymentOps.get.id, deploymentOps.log.id, serviceOps.get.id, buildOps.queue.id],
  });
  if (svc) deps.live.publish(`project:${svc.projectId}`, { type: "invalidate", ops: [serviceOps.list.id, projectOps.get.id] });
  // A preview's deploy: the Previews tab of the service it previews shows its latest deploy, and that page follows service:<id>.
  for (const p of deps.db.select({ serviceId: previews.serviceId }).from(previews).where(eq(previews.previewServiceId, serviceId)).all()) {
    deps.live.publish(`service:${p.serviceId}`, { type: "invalidate", ops: [previewOps.list.id] });
  }
  deps.live.publish("panel", { type: "invalidate", ops: [buildOps.queue.id, deploymentOps.recent.id] });
}

/**
 * A build on this node started, ended or was cancelled, or the node's
 * Builds at once changed: the deployments whose build is still queued there
 * go out again, with their new place in line (Deployment.buildWait and the
 * clone step's "Waiting for a build slot on <node> - 2 ahead").
 */
export function publishBuildQueue(deps: Pick<Deps, "db" | "live">, nodeId: string | null): void {
  if (!nodeId) return;
  const rows = deps.db
    .select({ id: deployments.id, serviceId: deployments.serviceId, status: builds.status })
    .from(builds)
    .innerJoin(deployments, eq(deployments.id, builds.deploymentId))
    .where(and(eq(builds.nodeId, nodeId), buildInFlight))
    .all();
  for (const r of rows) if (r.status === "queued") publishDeploymentChange(deps, r.serviceId, r.id);
}

/**
 * Only the deployment's own event (its log window's steps and timers) and
 * the in-process listeners, without the service, project and panel
 * invalidations of publishDeploymentChange. The log's 400 ms tick
 * (logs.ts) uses it: those invalidations made every open screen refetch
 * the deploy list, the service, the project's services and the recent
 * deploys every second while a build printed output. Status and step
 * changes still go through publishDeploymentChange.
 */
export function publishDeploymentEvent(deps: Pick<Deps, "db" | "live">, serviceId: string, deploymentId: string): void {
  const row = loadDeployment(deps.db, serviceId, deploymentId);
  if (!row) return;
  deps.live.publish(`deployment:${deploymentId}`, { type: "deployment", deployment: toDeployment(deps.db, row) });
  for (const listener of deploymentListeners.get(deps.db) ?? []) {
    try {
      listener(row);
    } catch {
      // A listener's failure is its own; the deploy goes on.
    }
  }
}
