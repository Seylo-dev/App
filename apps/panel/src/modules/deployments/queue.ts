// Starting deploys. Every path that deploys (the deploy op, rollbacks,
// pushes, trigger URLs, previews, templates, compose and moves) calls
// queueDeploy, which writes a queued deployment and kicks the runner.

import { OpError } from "@seylo/ops";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type DeploymentTrigger, deployments, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { panelServiceId } from "../nodes/panel-service";
import { assertNoActiveCopy } from "../services/copies";
import { loadService } from "../services/rows";
import { readSpec } from "../services/spec";
import { engineFor, nextGeneration } from "./engine";
import { appendLog } from "./logs";
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
  /** Lines for the start of the deploy log, such as which watch path a push matched. */
  notes?: readonly string[];
}

export function queueDeploy(deps: Deps, input: QueueDeployInput): DeploymentRow {
  const svc = loadService(deps.db, input.serviceId);
  const spec = readSpec(svc.spec);
  if (svc.kind === "compose") throw new OpError("BAD_REQUEST", "Deploy the stack's members, or use compose.update.");
  if (svc.id === panelServiceId) throw new OpError("CONFLICT", "The panel updates itself from Settings > Updates.", { reason: "panel" });
  // A clone's data copy writes its folders, or reads its stopped source's.
  assertNoActiveCopy(deps.db, svc.id);
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
  if (input.notes && input.notes.length > 0) appendLog(deps, svc.id, row.id, "clone", input.notes);
  publishDeploymentChange(deps, svc.id, row.id);
  engineFor(deps).kick(row.id);
  return row;
}

/** The service's oldest deploy that is queued or running (the one ahead of the rest), if any. */
export function activeDeploy(deps: Pick<Deps, "db">, serviceId: string): DeploymentRow | undefined {
  return deps.db
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ["queued", "building", "deploying"])))
    .orderBy(asc(deployments.createdAt), asc(deployments.id))
    .get();
}

/** Whether a deploy of the service is queued or running. */
export function hasActiveDeploy(deps: Pick<Deps, "db">, serviceId: string): boolean {
  return activeDeploy(deps, serviceId) !== undefined;
}

/**
 * One deploy of a service at a time for the ones a person starts (Deploy,
 * Redeploy, Roll back, the API, the CLI, MCP): while one is queued or
 * running, another is refused instead of queued behind it, so repeated
 * clicks never pile deploys up. Pushes and trigger URLs still queue behind
 * the running one (queuePushDeploy), so no push is lost.
 */
export function assertNoActiveDeploy(deps: Pick<Deps, "db">, serviceId: string, member?: { name: string }): void {
  const active = activeDeploy(deps, serviceId);
  if (!active) return;
  const what = active.status === "queued" ? "is waiting to start" : "is running";
  // A stack's deploy names the member, whose serviceId (not the stack's) deployments.get and cancel take.
  const whose = member ? member.name : "this service";
  throw new OpError(
    "CONFLICT",
    `A deploy of ${whose} (generation ${active.generation}) ${what}. Wait for it to finish, or cancel it, then deploy again.`,
    {
      reason: "deployRunning",
      deploymentId: active.id,
      serviceId,
    },
  );
}

export type PushDeploy =
  /** A new deployment, which starts once the running one (if any) is done. */
  | { kind: "queued"; deployment: DeploymentRow }
  /** A push deploy of the branch that had not started yet builds this commit now. */
  | { kind: "joined"; deployment: DeploymentRow }
  /** A push deploy of this very commit is waiting already. */
  | { kind: "same"; deployment: DeploymentRow };

/**
 * Deploys a push to the branch a service follows (webhooks and branch
 * polling), newest head wins: a push deploy of the branch that has not
 * started yet takes the push over and builds the newer commit, so pushes
 * never pile up deploys behind the running one; otherwise the push queues
 * its own deploy, which starts after the running one. A push is never
 * dropped because a deploy is running.
 */
export function queuePushDeploy(deps: Deps, input: Omit<QueueDeployInput, "trigger"> & { branch: string }): PushDeploy {
  const sha = input.commitSha ?? null;
  const waiting = deps.db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, input.serviceId),
        eq(deployments.status, "queued"),
        eq(deployments.trigger, "push"),
        eq(deployments.branch, input.branch),
      ),
    )
    .get();
  if (waiting) {
    if (waiting.commitSha === sha) return { kind: "same", deployment: waiting };
    const joined = deps.db
      .update(deployments)
      .set({ commitSha: sha, commitMessage: input.commitMessage ?? null, commitAuthor: input.commitAuthor ?? null })
      .where(eq(deployments.id, waiting.id))
      .returning()
      .get();
    const what = sha ? sha.slice(0, 7) : `the head of ${input.branch}`;
    appendLog(deps, input.serviceId, waiting.id, "clone", [
      `A newer push arrived before this deploy started: it builds ${what} now.`,
      ...(input.notes ?? []),
    ]);
    // Commit statuses follow: the old commit's "queued" becomes "superseded" (gitProviders/status.ts).
    publishDeploymentChange(deps, input.serviceId, waiting.id);
    return { kind: "joined", deployment: joined };
  }
  return { kind: "queued", deployment: queueDeploy(deps, { ...input, trigger: "push" }) };
}
