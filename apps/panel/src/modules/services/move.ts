// Moving a service to another node. Without volumes it is a rollout on both
// nodes, after which the old placement goes (zero downtime). With volumes
// the old copy stops first and the new node gets the service placed but
// stopped (so its cleanup never sweeps the folder being filled), every
// volume is copied through the panel (ExportVolume on the old node piped
// into ImportVolume on the new one, since nodes share no network), and then
// the new node starts it. Progress
// is a deployment with trigger "move"; on failure the service stays on (or
// goes back to) the old node. With volumes, the old node keeps its stopped
// copy and its data until the new node is live, so a failed move loses
// nothing (services/desired.ts keeps it stopped there meanwhile). A cancel
// while it copies stops the copy first, then ends the move the same way
// (move-runs.ts); once the new node starts it, it cannot be cancelled. Once the
// new node is live its IP:port access follows (access-move.ts). The checks
// are exported for services.moveImpact (move-impact.ts), which lists them
// per node before anyone moves.

import { OpError, services as serviceOps } from "@seylo/ops";
import { InstanceState } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { backupRuns, deployments, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { implement, type OpContext } from "../../ops/implement";
import { assertEngineRunsOn, missingExposureCapability, nodeHasCapability } from "../databases/capability";
import { plainExposureCapability, plainExposureVersion } from "../databases/engines";
import { findDatabase, loadDatabase } from "../databases/info";
import { engineFor, finish, nextGeneration } from "../deployments/engine";
import { appendLog } from "../deployments/logs";
import { assertNoDeployForPlacement } from "../deployments/queue";
import { type DeploymentRow, initialSteps, isFinal, publishDeploymentChange, setStep } from "../deployments/store";
import { assertNoActiveCopy } from "./copies";
import { assertNode, dataVolumes } from "./insert";
import { startMoveRun } from "./move-runs";
import { actorOf, publishService } from "./ops";
import { loadService, nodeNames, type ServiceRow } from "./rows";
import { pipeIntoVolume, readVolume } from "./volume-pipe";

export const moveJobType = "services.move";
const stopWaitMs = 2 * 60_000;

/** Where the service runs now; refused (CONFLICT) for stacks and their members, protected services and services on more than one node. */
export function movableFrom(ctx: Pick<OpContext, "db">, svc: ServiceRow): { from: string; replicas: number } {
  if (svc.kind === "compose" || svc.parentId)
    throw new OpError("CONFLICT", "Compose stacks move as a whole; moving one is not supported yet.", { reason: "compose" });
  if (svc.protected) throw new OpError("CONFLICT", `${svc.name} is protected and cannot be moved.`, { reason: "protected" });
  const placements = ctx.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, svc.id)).all();
  const only = placements.length === 1 ? placements[0] : undefined;
  if (!only)
    throw new OpError("CONFLICT", "Only services on one node can be moved. Use replicas per node to spread a service instead.", {
      reason: "placements",
    });
  return { from: only.nodeId, replicas: only.replicas };
}

/**
 * Refuses a node that cannot run the service as it runs now: a database's
 * engine (assertEngineRunsOn) and, while it is exposed, an agent that
 * cannot keep its port TLS only (the port would close there, as
 * databaseRuntime keeps it) or, when it allows clients without TLS, one
 * that cannot take them (they would be refused there). CONFLICT, reason
 * agentTooOld. Other services pass.
 */
export function assertRunsOn(ctx: Pick<OpContext, "db" | "agents" | "secrets">, svc: ServiceRow, nodeId: string): void {
  const name = nodeNames(ctx.db, [nodeId]).get(nodeId);
  assertEngineRunsOn(ctx.db, ctx.agents, svc.id, nodeId, name);
  if (!findDatabase(ctx.db, svc.id)) return;
  const info = loadDatabase(ctx, svc.id);
  // Only what works now is refused to break: a port already closed for its node's update, or plain clients its node cannot take yet, stay so.
  if (!info.exposure || info.exposureWaitsFor) return;
  const where = name ?? "this node";
  if (missingExposureCapability(ctx.db, ctx.agents, info.engine, nodeId)) {
    throw new OpError(
      "CONFLICT",
      `The agent on ${where} cannot keep ${info.engine.label}'s exposed port TLS only yet, so the port would close there. Update the node first, or turn exposure off.`,
      { field: "toNodeId", reason: "agentTooOld" },
    );
  }
  if (info.exposure.allowPlain && !info.plainNeedsNodeUpdate && !nodeHasCapability(ctx.db, ctx.agents, nodeId, plainExposureCapability)) {
    throw new OpError(
      "CONFLICT",
      `The agent on ${where} cannot take connections without TLS yet (it needs ${plainExposureVersion}), so clients without TLS would be refused there. Update the node first.`,
      { field: "toNodeId", reason: "agentTooOld" },
    );
  }
}

/**
 * What must hold before the move starts, whatever the target: a live
 * version with an image, no deploy of it queued or running, and none of its
 * backups or restores running (the move stops it and, once the new node
 * serves, deletes the old node's folder those read or write).
 */
export function assertCanStartMove(ctx: Pick<OpContext, "db">, svc: ServiceRow): DeploymentRow {
  if (!svc.liveDeploymentId) throw new OpError("CONFLICT", "Deploy the service before moving it.", { reason: "notDeployed" });
  assertNoDeployForPlacement(ctx, svc.id);
  const live = ctx.db.select().from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get();
  if (!live?.imageRef) throw new OpError("CONFLICT", "The live version has no image to move.", { reason: "noImage" });
  const running = ctx.db
    .select({ kind: backupRuns.kind })
    .from(backupRuns)
    .where(and(eq(backupRuns.serviceId, svc.id), eq(backupRuns.status, "running")))
    .get();
  if (running?.kind === "restore")
    throw new OpError("CONFLICT", `A restore of ${svc.name} is running. Move it once the restore ends.`, { reason: "restoreRunning" });
  if (running)
    throw new OpError("CONFLICT", `A backup of ${svc.name} is running. Move it once the backup ends.`, { reason: "backupRunning" });
  return live;
}

/** With volumes, both nodes must be online and their agents able to copy them (UNAVAILABLE or NOT_IMPLEMENTED, reason offline or agentTooOld). */
export function assertCopyNode(ctx: Pick<OpContext, "db" | "agents">, nodeId: string, role: "from" | "to"): void {
  const name = nodeNames(ctx.db, [nodeId]).get(nodeId);
  if (!ctx.agents.isOnline(nodeId))
    throw new OpError("UNAVAILABLE", `${name} is offline; volumes can only be copied between online nodes.`, { reason: "offline", nodeId });
  if (!ctx.agents.supports(nodeId, role === "from" ? "exportVolume" : "importVolume")) {
    throw new OpError("NOT_IMPLEMENTED", `The agent on ${name} is too old to copy volumes. Update the node.`, {
      reason: "agentTooOld",
      nodeId,
    });
  }
}

export const move = implement(serviceOps.move, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const { from, replicas } = movableFrom(ctx, svc);
  if (from === input.toNodeId) throw new OpError("BAD_REQUEST", "The service already runs on this node.", { field: "toNodeId" });
  assertNode(ctx.db, input.toNodeId);
  // A clone's data copy reads (or writes) its folder on this node; the move stops it and removes that folder.
  assertNoActiveCopy(ctx.db, svc.id, { anySource: true });
  assertRunsOn(ctx, svc, input.toNodeId);
  const live = assertCanStartMove(ctx, svc);

  const volumes = dataVolumes(ctx.db, svc.id);
  const names = nodeNames(ctx.db, [from, input.toNodeId]);
  if (volumes.length > 0) {
    assertCopyNode(ctx, from, "from");
    assertCopyNode(ctx, input.toNodeId, "to");
  }

  const steps = setStep(initialSteps(false), "ship", "pending", {
    nodeId: input.toNodeId,
    detail: volumes.length > 0 ? `Copy ${volumes.length} volume(s)` : "",
  });
  const row = ctx.db.transaction((tx) => {
    const d = tx
      .insert(deployments)
      .values({
        serviceId: svc.id,
        generation: nextGeneration(ctx, svc.id),
        status: "queued",
        trigger: "move",
        actor: actorOf(ctx),
        triggeredBy: userOf(ctx.principal)?.id ?? null,
        commitSha: live.commitSha,
        commitMessage: live.commitMessage,
        commitAuthor: live.commitAuthor,
        branch: live.branch,
        imageRef: live.imageRef,
        imageDigest: live.imageDigest,
        imageSizeBytes: live.imageSizeBytes,
        runSettings: live.runSettings,
        envSealed: live.envSealed,
        movedFromNodeId: from,
        moveCopying: volumes.length > 0,
        steps,
      })
      .returning()
      .get();
    if (volumes.length === 0) {
      // Run on both nodes; the old placement goes once the new node is live.
      tx.insert(servicePlacements).values({ serviceId: svc.id, nodeId: input.toNodeId, replicas }).run();
    }
    return d;
  });
  appendLog(ctx, svc.id, row.id, "ship", [`Moving ${svc.name} from ${names.get(from)} to ${names.get(input.toNodeId)}.`]);
  publishDeploymentChange(ctx, svc.id, row.id);
  publishService(ctx, svc);
  if (volumes.length > 0)
    ctx.jobs.enqueue(moveJobType, { deploymentId: row.id, toNodeId: input.toNodeId }, { maxAttempts: 1, dedupeKey: `move:${row.id}` });
  else engineFor(ctx).kick(row.id);
  return { deploymentId: row.id };
});

/** Waits until the node reports no running container of the service; false after stopWaitMs, or at once once `signal` aborts. */
export async function waitStopped(deps: Deps, serviceId: string, nodeId: string, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + stopWaitMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const status = deps.agents.state.serviceStatuses(serviceId).find((s) => s.nodeId === nodeId)?.status;
    if (!status || status.instances.every((i) => i.state !== InstanceState.RUNNING && i.state !== InstanceState.RESTARTING)) return true;
    await pause(1000, signal);
  }
  return false;
}

/** Bun.sleep that ends early once `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Copies one volume: ExportVolume on `from` piped into ImportVolume on `to`
 * (volume-pipe.ts). `toServiceId` (a clone) receives it instead of the same
 * service. Returns the file bytes written on `to`, which are never fewer
 * than `from` archived (a file that shrank while it was read is padded).
 * `signal` (a cancelled move) cancels both streams at once and throws.
 */
export async function relayVolume(
  deps: Deps,
  input: { serviceId: string; volume: string; from: string; to: string; toServiceId?: string; signal?: AbortSignal },
): Promise<number> {
  const exported = readVolume(deps, { nodeId: input.from, serviceId: input.serviceId, volume: input.volume });
  try {
    const { written } = await pipeIntoVolume(deps, {
      nodeId: input.to,
      serviceId: input.toServiceId ?? input.serviceId,
      volume: input.volume,
      chunks: exported.body,
      signal: input.signal,
    });
    const archived = Number((await exported.response).sizeBytes);
    if (written < archived) throw new Error(`${input.volume}: ${archived} bytes were read but only ${written} written.`);
    return written;
  } catch (error) {
    exported.cancel(input.signal?.aborted ? "the move was cancelled" : "move failed");
    throw error;
  }
}

export const moveJob = defineJob<{ deploymentId: string; toNodeId: string }>({
  type: moveJobType,
  maxAttempts: 1,
  // Waits for the old copy to stop and the volumes to copy.
  lane: "slow",
  async run(payload, deps) {
    let d = deps.db.select().from(deployments).where(eq(deployments.id, payload.deploymentId)).get();
    if (d?.status !== "queued" || !d.moveCopying || !d.movedFromNodeId) return;
    // From here a cancel stops this run instead of ending the move (move-runs.ts): the run ends it
    // once its streams are closed. Before any await, so a cancel either ended it before (the check
    // above) or finds this run.
    const run = startMoveRun(deps.db, d.id);
    const from = d.movedFromNodeId;
    const svc = loadService(deps.db, d.serviceId);
    const names = nodeNames(deps.db, [from, payload.toNodeId]);
    const log = (text: string, error = false) => appendLog(deps, svc.id, (d as typeof d & object).id, "ship", [text], error);
    // Never over a move that ended meanwhile: a late failure must not undo what came after it.
    const end = (outcome: "failed" | "cancelled", message: string) => {
      const current = deps.db.select().from(deployments).where(eq(deployments.id, payload.deploymentId)).get();
      if (current && !isFinal(current.status)) finish(engineFor(deps), current, outcome, message);
    };
    const fail = (message: string) => end("failed", message);
    // A cancel asked: the copy is stopped, so the service goes back to the old node (restoreMove) and starts there.
    const cancelled = () => {
      const message = run.cancelled();
      if (message === null) return false;
      log(
        `Stopped the copy to ${names.get(payload.toNodeId)}. ${svc.name} starts again on ${names.get(from)} with its data, and ${names.get(payload.toNodeId)} removes what was copied.`,
      );
      end("cancelled", message);
      return true;
    };
    try {
      deps.db
        .update(deployments)
        .set({ startedAt: new Date(), steps: setStep(d.steps, "ship", "running") })
        .where(eq(deployments.id, d.id))
        .run();
      const replicas = deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, svc.id)).get()?.replicas ?? 1;
      deps.db.transaction((tx) => {
        tx.update(services).set({ stopped: true }).where(eq(services.id, svc.id)).run();
        // The new node gets the service now, stopped, so the folder the copy fills is in its desired
        // state and its cleanup never takes it for an orphan's (clone.ts parks a clone the same way).
        // A failed move (restoreMove) removes this placement and the partial copy with it.
        tx.insert(servicePlacements).values({ serviceId: svc.id, nodeId: payload.toNodeId, replicas }).onConflictDoNothing().run();
      });
      deps.agents.desired.markDirty({ serviceId: svc.id });
      publishDeploymentChange(deps, svc.id, d.id);
      log(`Stopping ${svc.name} on ${names.get(from)} so the copy is consistent.`);
      await deps.agents.desired.settled();
      if (cancelled()) return;
      const stopped = await waitStopped(deps, svc.id, from, run.signal);
      if (cancelled()) return;
      if (!stopped) return fail(`${svc.name} did not stop on ${names.get(from)} within ${stopWaitMs / 1000}s.`);

      for (const volume of dataVolumes(deps.db, svc.id)) {
        log(`Copying volume ${volume.name}.`);
        const bytes = await relayVolume(deps, { serviceId: svc.id, volume: volume.name, from, to: payload.toNodeId, signal: run.signal });
        if (cancelled()) return;
        log(`Copied ${volume.name} (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
      }

      d = deps.db.select().from(deployments).where(eq(deployments.id, payload.deploymentId)).get();
      if (d?.status !== "queued") return;
      deps.db.transaction((tx) => {
        // The old node keeps its (stopped) copy and data until the new node is live; see desired.ts.
        tx.insert(servicePlacements).values({ serviceId: svc.id, nodeId: payload.toNodeId, replicas }).onConflictDoNothing().run();
        tx.update(services).set({ stopped: false }).where(eq(services.id, svc.id)).run();
        tx.update(deployments)
          .set({
            moveCopying: false,
            steps: setStep((d as NonNullable<typeof d>).steps, "ship", "running", { detail: `Starting on ${names.get(payload.toNodeId)}` }),
          })
          .where(eq(deployments.id, payload.deploymentId))
          .run();
      });
      deps.agents.desired.markDirty({ serviceId: svc.id });
      publishService(deps, svc);
      engineFor(deps).kick(payload.deploymentId);
    } catch (error) {
      if (cancelled()) return;
      fail(`Copying the data failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      run.end();
    }
  },
});
