// Moving a service to another node. Without volumes it is a rollout on both
// nodes, after which the old placement goes (zero downtime). With volumes
// the old copy stops first, every volume is copied through the panel
// (ExportVolume on the old node piped into ImportVolume on the new one,
// since nodes share no network), and then the new node starts it. Progress
// is a deployment with trigger "move"; on failure the service stays on (or
// goes back to) the old node. With volumes, the old node keeps its stopped
// copy and its data until the new node is live, so a failed move loses
// nothing (services/desired.ts keeps it stopped there meanwhile).

import { OpError, services as serviceOps } from "@seylo/ops";
import { InstanceState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { deployments, servicePlacements, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { implement } from "../../ops/implement";
import { engineFor, finish, nextGeneration } from "../deployments/engine";
import { appendLog } from "../deployments/logs";
import { hasActiveDeploy } from "../deployments/queue";
import { initialSteps, publishDeploymentChange, setStep } from "../deployments/store";
import { assertNode, dataVolumes } from "./insert";
import { actorOf, publishService } from "./ops";
import { loadService, nodeNames } from "./rows";

export const moveJobType = "services.move";
const stopWaitMs = 2 * 60_000;

export const move = implement(serviceOps.move, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  if (svc.kind === "compose" || svc.parentId)
    throw new OpError("CONFLICT", "Compose stacks move as a whole; moving one is not supported yet.", { reason: "compose" });
  if (svc.protected) throw new OpError("CONFLICT", `${svc.name} is protected and cannot be moved.`);
  const placements = ctx.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, svc.id)).all();
  if (placements.length !== 1)
    throw new OpError("CONFLICT", "Only services on one node can be moved. Use replicas per node to spread a service instead.");
  const from = (placements[0] as (typeof placements)[number]).nodeId;
  if (from === input.toNodeId) throw new OpError("BAD_REQUEST", "The service already runs on this node.", { field: "toNodeId" });
  assertNode(ctx.db, input.toNodeId);
  if (!svc.liveDeploymentId) throw new OpError("CONFLICT", "Deploy the service before moving it.");
  if (hasActiveDeploy(ctx, svc.id)) throw new OpError("CONFLICT", "Wait for the running deploy to finish.");
  const live = ctx.db.select().from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get();
  if (!live?.imageRef) throw new OpError("CONFLICT", "The live version has no image to move.");

  const volumes = dataVolumes(ctx.db, svc.id);
  const names = nodeNames(ctx.db, [from, input.toNodeId]);
  if (volumes.length > 0) {
    for (const nodeId of [from, input.toNodeId]) {
      if (!ctx.agents.isOnline(nodeId))
        throw new OpError("UNAVAILABLE", `${names.get(nodeId)} is offline; volumes can only be copied between online nodes.`);
      if (!ctx.agents.supports(nodeId, nodeId === from ? "exportVolume" : "importVolume")) {
        throw new OpError("NOT_IMPLEMENTED", `The agent on ${names.get(nodeId)} is too old to copy volumes. Update the node.`);
      }
    }
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
      tx.insert(servicePlacements)
        .values({ serviceId: svc.id, nodeId: input.toNodeId, replicas: placements[0]?.replicas ?? 1 })
        .run();
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

/** Waits until the node reports no running container of the service. */
export async function waitStopped(deps: Deps, serviceId: string, nodeId: string): Promise<boolean> {
  const deadline = Date.now() + stopWaitMs;
  while (Date.now() < deadline) {
    const status = deps.agents.state.serviceStatuses(serviceId).find((s) => s.nodeId === nodeId)?.status;
    if (!status || status.instances.every((i) => i.state !== InstanceState.RUNNING && i.state !== InstanceState.RESTARTING)) return true;
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * Copies one volume: ExportVolume on `from` piped into ImportVolume on `to`.
 * `toServiceId` (a clone) receives it instead of the same service.
 */
export async function relayVolume(
  deps: Deps,
  input: { serviceId: string; volume: string; from: string; to: string; toServiceId?: string },
): Promise<number> {
  const exported = deps.agents.openRaw(input.from, "exportVolume", { serviceId: input.serviceId, volume: input.volume });
  const imported = deps.agents.openRaw(input.to, "importVolume", {
    serviceId: input.toServiceId ?? input.serviceId,
    volume: input.volume,
    replace: true,
  });
  try {
    for await (const chunk of exported.body) await imported.writer.write(chunk);
    imported.writer.end();
    const [, done] = await Promise.all([exported.response, imported.response]);
    return Number(done.sizeBytes);
  } catch (error) {
    exported.cancel("move failed");
    imported.cancel("move failed");
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
    const from = d.movedFromNodeId;
    const svc = loadService(deps.db, d.serviceId);
    const names = nodeNames(deps.db, [from, payload.toNodeId]);
    const log = (text: string, error = false) => appendLog(deps, svc.id, (d as typeof d & object).id, "ship", [text], error);
    const fail = (message: string) => {
      const current = deps.db.select().from(deployments).where(eq(deployments.id, payload.deploymentId)).get();
      if (current) finish(engineFor(deps), current, "failed", message);
    };
    try {
      deps.db
        .update(deployments)
        .set({ startedAt: new Date(), steps: setStep(d.steps, "ship", "running") })
        .where(eq(deployments.id, d.id))
        .run();
      deps.db.update(services).set({ stopped: true }).where(eq(services.id, svc.id)).run();
      deps.agents.desired.markDirty({ serviceId: svc.id });
      publishDeploymentChange(deps, svc.id, d.id);
      log(`Stopping ${svc.name} on ${names.get(from)} so the copy is consistent.`);
      await deps.agents.desired.settled();
      if (!(await waitStopped(deps, svc.id, from)))
        return fail(`${svc.name} did not stop on ${names.get(from)} within ${stopWaitMs / 1000}s.`);

      for (const volume of dataVolumes(deps.db, svc.id)) {
        log(`Copying volume ${volume.name}.`);
        const bytes = await relayVolume(deps, { serviceId: svc.id, volume: volume.name, from, to: payload.toNodeId });
        log(`Copied ${volume.name} (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
      }

      d = deps.db.select().from(deployments).where(eq(deployments.id, payload.deploymentId)).get();
      if (d?.status !== "queued") return;
      const replicas = deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, svc.id)).get()?.replicas ?? 1;
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
      fail(`Copying the data failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
