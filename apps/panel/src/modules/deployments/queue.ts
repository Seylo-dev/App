// Starting deploys. Every path that deploys (the deploy op, rollbacks,
// pushes, trigger URLs, previews, templates, compose and moves) calls
// queueDeploy, which writes a queued deployment and kicks the runner.

import { OpError } from "@seylo/ops";
import { and, eq, inArray } from "drizzle-orm";
import { type DeploymentTrigger, deployments, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { panelServiceId } from "../nodes/panel-service";
import { loadService } from "../services/rows";
import { readSpec } from "../services/spec";
import { engineFor, nextGeneration } from "./engine";
import { type DeploymentRow, deploymentDigest, initialSteps, publishDeploymentChange } from "./store";

export interface QueueDeployInput {
  serviceId: string;
  trigger: DeploymentTrigger;
  /** Email, GitHub login or key name shown on the deployment. */
  actor: string | null;
  triggeredBy?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  branch?: string | null;
  noCache?: boolean;
  /** Rollbacks: run this deployment's image again without building. */
  rollbackOf?: DeploymentRow | null;
  /** Upload sources: the archive to build (default: the newest upload). */
  uploadId?: string | null;
  /** Deployments of other services to wait for (a template's database before its app). */
  waitFor?: string[];
}

export function queueDeploy(deps: Deps, input: QueueDeployInput): DeploymentRow {
  const svc = loadService(deps.db, input.serviceId);
  const spec = readSpec(svc.spec);
  if (svc.kind === "compose") throw new OpError("BAD_REQUEST", "Deploy the stack's members, or use compose.update.");
  if (svc.id === panelServiceId) throw new OpError("CONFLICT", "The panel updates itself from Settings > Updates.", { reason: "panel" });
  if (spec.source.type === "none" && !input.rollbackOf) {
    throw new OpError("BAD_REQUEST", "Set a source first: a repository, an image or a Dockerfile.", { reason: "noSource" });
  }

  let uploadId: string | null = null;
  if (spec.source.type === "upload" && !input.rollbackOf) {
    const upload = input.uploadId
      ? deps.db
          .select()
          .from(sourceUploads)
          .where(and(eq(sourceUploads.id, input.uploadId), eq(sourceUploads.serviceId, svc.id)))
          .get()
      : deps.db.select().from(sourceUploads).where(eq(sourceUploads.serviceId, svc.id)).orderBy(sourceUploads.createdAt).all().at(-1);
    if (!upload) throw new OpError("BAD_REQUEST", "Upload an archive first.", { reason: "noUpload" });
    uploadId = upload.id;
  }

  const rollback = input.rollbackOf ?? null;
  const row = deps.db
    .insert(deployments)
    .values({
      serviceId: svc.id,
      generation: nextGeneration(deps, svc.id),
      status: "queued",
      trigger: input.trigger,
      actor: input.actor,
      triggeredBy: input.triggeredBy ?? null,
      commitSha: rollback?.commitSha ?? input.commitSha ?? null,
      commitMessage: rollback?.commitMessage ?? input.commitMessage ?? null,
      commitAuthor: rollback?.commitAuthor ?? input.commitAuthor ?? null,
      branch: rollback?.branch ?? input.branch ?? null,
      imageRef: rollback?.imageRef ?? null,
      imageDigest: rollback ? deploymentDigest(rollback) : null,
      imageSizeBytes: rollback?.imageSizeBytes ?? null,
      rollbackOf: rollback?.id ?? null,
      noCache: input.noCache ?? false,
      uploadId,
      waitFor: input.waitFor ?? [],
      steps: initialSteps(rollback === null && spec.source.type !== "image"),
    })
    .returning()
    .get();
  publishDeploymentChange(deps, svc.id, row.id);
  engineFor(deps).kick(row.id);
  return row;
}

/** Whether a deploy of the service is queued or running. */
export function hasActiveDeploy(deps: Pick<Deps, "db">, serviceId: string): boolean {
  return (
    deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ["queued", "building", "deploying"])))
      .get() !== undefined
  );
}
