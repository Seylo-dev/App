// Moving a service to another project (services.moveProject) and showing
// what that changes first (services.moveProjectImpact).
//
// The row's project changes at once, so access, references, shared
// variables and the private network all follow the new project. Grants on
// the service itself go (a member with one would otherwise reach the new
// project's shared variables through it). A running service then switches
// like a deploy: a deployment with trigger "move" runs the live image again
// (no rebuild) with its env resolved in the new project, and the agent
// re-attaches the containers to seylo-p-<new project> health-gated (or
// rolls new ones when more than the project changed). Until that
// deployment ships, the node's spec keeps the old project
// (services/desired.ts), so only the deployment moves the containers. A
// failed or cancelled switch puts the service, its grants and invites back
// (project-move-restore.ts, called by the deployments engine).

import { OpError, services as serviceOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { deployments, grants, invites, projects, services } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { engineFor, nextGeneration } from "../deployments/engine";
import { appendLog } from "../deployments/logs";
import { initialSteps, publishDeploymentChange, setStep } from "../deployments/store";
import { checkEnvReferences } from "../env/ops";
import { readServiceEnv } from "../env/store";
import { invitesNaming, moveImpact, needsConfirm } from "./impact";
import { actorOf, publishService } from "./ops";
import { loadService, type ServiceRow } from "./rows";

/** NOT_FOUND for a missing project; FORBIDDEN without services.create there. */
export function requireTargetProject(ctx: OpContext, projectId: string): { id: string; name: string } {
  const project = ctx.db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new OpError("NOT_FOUND", "That project does not exist.", { field: "projectId" });
  if (!ctx.access.can("services.create", { type: "project", id: projectId })) {
    throw new OpError("FORBIDDEN", "You do not have the services.create permission in that project.", {
      action: "services.create",
      field: "projectId",
    });
  }
  return project;
}

export const moveProjectImpact = implement(serviceOps.moveProjectImpact, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  requireTargetProject(ctx, input.projectId);
  return moveImpact(ctx, svc, input.projectId);
});

/** Tells both projects' screens (and everyone's sidebar) the service changed place. */
function publishMove(ctx: OpContext, svc: Pick<ServiceRow, "id">, fromProjectId: string, toProjectId: string): void {
  publishService(ctx, { id: svc.id, projectId: fromProjectId });
  publishService(ctx, { id: svc.id, projectId: toProjectId });
  for (const projectId of [fromProjectId, toProjectId]) {
    ctx.live.publish(`project:${projectId}`, { type: "invalidate", ops: ["env.references", "env.analyze"] });
  }
}

export const moveProject = implement(serviceOps.moveProject, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const target = requireTargetProject(ctx, input.projectId);
  const impact = moveImpact(ctx, svc, input.projectId);
  const blocker = impact.blockers[0];
  if (blocker) {
    throw new OpError(blocker.reason === "access" ? "FORBIDDEN" : "CONFLICT", blocker.message, { reason: blocker.reason });
  }
  if (needsConfirm(impact) && input.confirm !== true) {
    throw new OpError(
      "CONFLICT",
      "Moving changes references, grants or invites. Review services.moveProjectImpact and pass confirm: true.",
      {
        reason: "confirm",
      },
    );
  }
  // Its own references now resolve in the new project: the same rule as saving them there.
  checkEnvReferences(ctx, input.projectId, [svc.name], readServiceEnv(ctx.db, ctx.secrets, svc.id).text);

  const fromProjectId = svc.projectId;
  const live = svc.targetDeploymentId
    ? ctx.db.select().from(deployments).where(eq(deployments.id, svc.targetDeploymentId)).get()
    : undefined;
  const switches = !svc.stopped && live?.imageRef != null;
  const removedInvites = invitesNaming(ctx, svc.id);

  const result = ctx.db.transaction((tx) => {
    const removedGrants = tx
      .select()
      .from(grants)
      .where(and(eq(grants.scopeType, "service"), eq(grants.scopeId, svc.id)))
      .all();
    tx.delete(grants)
      .where(and(eq(grants.scopeType, "service"), eq(grants.scopeId, svc.id)))
      .run();
    const removedInviteGrants: { inviteId: string; actions: string[] }[] = [];
    for (const row of removedInvites) {
      const entry = row.grants.find((g) => g.scopeType === "service" && g.scopeId === svc.id);
      if (!entry) continue;
      removedInviteGrants.push({ inviteId: row.id, actions: entry.actions });
      tx.update(invites)
        .set({ grants: row.grants.filter((g) => g !== entry) })
        .where(eq(invites.id, row.id))
        .run();
    }
    tx.update(services).set({ projectId: input.projectId, updatedAt: new Date() }).where(eq(services.id, svc.id)).run();
    if (!switches || !live) return { deployment: null, removedGrants };
    const steps = setStep(initialSteps(false), "ship", "pending", { detail: `Switch to ${target.name}'s network` });
    const deployment = tx
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
        // Left empty on purpose: the engine resolves the env when the switch starts, in the new project.
        envSealed: null,
        steps,
        projectMove: {
          fromProjectId,
          toProjectId: input.projectId,
          removedGrants: removedGrants.map((g) => ({ userId: g.userId, actions: g.actions, createdBy: g.createdBy })),
          removedInviteGrants,
        },
      })
      .returning()
      .get();
    return { deployment, removedGrants };
  });

  ctx.auditDetails?.({ fromProjectId, toProjectId: input.projectId, grantsRemoved: result.removedGrants.length });
  for (const g of result.removedGrants) ctx.live.recheck({ userId: g.userId });
  publishMove(ctx, svc, fromProjectId, input.projectId);
  if (result.deployment) {
    const fromName = ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, fromProjectId)).get()?.name ?? "";
    appendLog(ctx, svc.id, result.deployment.id, "ship", [`Moving ${svc.name} from project ${fromName} to ${target.name}.`]);
    publishDeploymentChange(ctx, svc.id, result.deployment.id);
    engineFor(ctx).kick(result.deployment.id);
  } else {
    // Nothing runs (stopped, never deployed, or a database waiting for its first start): the change is all there is.
    ctx.agents.desired.markDirty({ serviceId: svc.id });
  }
  return { deploymentId: result.deployment?.id ?? null, impact };
});
