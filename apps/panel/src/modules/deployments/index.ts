// Deployments: deploy now, history, logs, cancel and instant rollback.
// The runner is engine.ts; start() feeds it agent events, and the
// deployments.tick job handles timeouts and picks up unfinished
// deployments after a panel restart.

import { deployments as deploymentOps, OpError } from "@seylo/ops";
import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import { describePrincipal, userOf } from "../../auth/principal";
import { deployments, services } from "../../db/schema";
import { defineJob } from "../../jobs/queue";
import { implement } from "../../ops/implement";
import { defineModule } from "../module";
import { loadService } from "../services/rows";
import {
  cancelDeployment,
  engineFor,
  fillReportedDigest,
  recordBuildProgress,
  recordDeployProgress,
  recordRefusedSpec,
  unfinishedDeployments,
} from "./engine";
import { readLog } from "./logs";
import { assertNoActiveDeploy, hasActiveDeploy, queueDeploy } from "./queue";
import { registryGcJob, registryGcSweepJob, registryGcSweepJobType } from "./registry-gc";
import {
  activeStatuses,
  databaseRollbackImage,
  isFinal,
  keptImages,
  loadDeployment,
  sameDatabaseImage,
  toDeployment,
  toDeployments,
} from "./store";

export const tickJobType = "deployments.tick";
const tickEverySeconds = 15;

function actorOf(principal: Parameters<typeof describePrincipal>[0]): string | null {
  if (principal.type === "anonymous") return null;
  return principal.type === "apiKey" ? describePrincipal(principal) : principal.user.email;
}

function triggerOf(principal: Parameters<typeof describePrincipal>[0]): "manual" | "api" {
  return principal.type === "apiKey" ? "api" : "manual";
}

const deploy = implement(deploymentOps.deploy, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  if (svc.kind === "compose") {
    // A stack deploys all of its members; the first member's deployment is returned.
    const members = ctx.db.select().from(services).where(eq(services.parentId, svc.id)).orderBy(services.nameKey).all();
    if (members.length === 0) throw new OpError("CONFLICT", "This stack has no members to deploy.");
    // All or none: a member with a deploy running refuses the stack's deploy before any member queues one.
    for (const m of members) assertNoActiveDeploy(ctx, m.id, m);
    const rows = members.map((m) =>
      queueDeploy(ctx, {
        serviceId: m.id,
        trigger: triggerOf(ctx.principal),
        actor: actorOf(ctx.principal),
        triggeredBy: userOf(ctx.principal)?.id,
      }),
    );
    return toDeployment(ctx.db, rows[0] as (typeof rows)[number]);
  }
  assertNoActiveDeploy(ctx, svc.id);
  const row = queueDeploy(ctx, {
    serviceId: svc.id,
    trigger: triggerOf(ctx.principal),
    actor: actorOf(ctx.principal),
    triggeredBy: userOf(ctx.principal)?.id ?? null,
    commitSha: input.commitSha ?? null,
    noCache: input.noCache ?? false,
  });
  return toDeployment(ctx.db, row);
});

const list = implement(deploymentOps.list, (input, ctx) => {
  loadService(ctx.db, input.serviceId);
  const limit = input.limit ?? 20;
  if (input.active) {
    // The deploy in progress first (the engine runs the oldest), then those waiting behind it.
    const active = ctx.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.serviceId, input.serviceId), inArray(deployments.status, [...activeStatuses])))
      .orderBy(asc(deployments.createdAt), asc(deployments.id))
      .limit(limit)
      .all();
    return { deployments: toDeployments(ctx.db, active), nextCursor: null, keptImages };
  }
  let cursor: { at: number; id: string } | null = null;
  if (input.cursor) {
    const [at, id] = input.cursor.split(".");
    if (!at || !id || Number.isNaN(Number(at))) throw new OpError("BAD_REQUEST", "Invalid cursor.", { field: "cursor" });
    cursor = { at: Number(at), id };
  }
  const where = cursor
    ? and(
        eq(deployments.serviceId, input.serviceId),
        or(
          lt(deployments.createdAt, new Date(cursor.at)),
          and(eq(deployments.createdAt, new Date(cursor.at)), lt(deployments.id, cursor.id)),
        ),
      )
    : eq(deployments.serviceId, input.serviceId);
  const rows = ctx.db
    .select()
    .from(deployments)
    .where(where)
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    deployments: toDeployments(ctx.db, page),
    nextCursor: rows.length > limit && last ? `${last.createdAt.getTime()}.${last.id}` : null,
    keptImages,
  };
});

function mustLoad(ctx: Parameters<typeof deploy.run>[1], serviceId: string, deploymentId: string) {
  const row = loadDeployment(ctx.db, serviceId, deploymentId);
  if (!row) throw new OpError("NOT_FOUND", "No deployment with this id.");
  return row;
}

const get = implement(deploymentOps.get, (input, ctx) => ({
  deployment: toDeployment(ctx.db, mustLoad(ctx, input.serviceId, input.deploymentId)),
  logTopic: `deployment:${input.deploymentId}`,
}));

const log = implement(deploymentOps.log, (input, ctx) => {
  const row = mustLoad(ctx, input.serviceId, input.deploymentId);
  const limit = input.limit ?? 1000;
  const lines = readLog(ctx, row.id, input.afterSeq ?? -1, limit);
  return {
    lines: lines.map((l) => ({ seq: l.seq, ts: l.ts.toISOString(), step: l.step, text: l.text, error: l.error })),
    done: isFinal(row.status) && lines.length < limit,
  };
});

const cancel = implement(deploymentOps.cancel, async (input, ctx) => {
  const row = mustLoad(ctx, input.serviceId, input.deploymentId);
  if (isFinal(row.status)) throw new OpError("CONFLICT", "This deployment already finished.");
  await cancelDeployment(ctx, row, actorOf(ctx.principal));
  return toDeployment(ctx.db, mustLoad(ctx, input.serviceId, input.deploymentId));
});

/**
 * A database's deployments run other images only after a version change
 * (databases.setVersion), whose files an older version may not read: a
 * rollback of a database takes only a deployment of the image it runs
 * (the same rule makes canRollback false for the others).
 */
function assertSameDatabaseImage(ctx: Parameters<typeof deploy.run>[1], target: ReturnType<typeof mustLoad>) {
  const running = databaseRollbackImage(ctx.db, target.serviceId);
  if (running === undefined) return;
  if (!sameDatabaseImage(target, running)) {
    const sameTag = running !== null && target.imageRef === running.ref;
    throw new OpError(
      "CONFLICT",
      sameTag
        ? `This deployment ran an earlier release of ${target.imageRef}: the tag moved since, and a database cannot go back to an older release, whose files the newer one may have changed. Restore a backup into a new database instead.`
        : `This deployment ran ${target.imageRef ?? "another image"}, not ${running?.ref ?? "what the database runs"}: a database cannot go back to an older version, whose files the newer one may have changed. Restore a backup into a new database instead.`,
      { reason: "databaseVersion" },
    );
  }
}

const rollback = implement(deploymentOps.rollback, (input, ctx) => {
  const target = mustLoad(ctx, input.serviceId, input.deploymentId);
  const view = toDeployment(ctx.db, target);
  if (target.status === "live") throw new OpError("CONFLICT", "This deployment is already live.");
  // Before the kept-images check: canRollback is false for these too, and the reason is the version.
  assertSameDatabaseImage(ctx, target);
  if (!view.canRollback) throw new OpError("CONFLICT", `Only the last ${keptImages} successful deployments can be rolled back to.`);
  assertNoActiveDeploy(ctx, target.serviceId);
  const row = queueDeploy(ctx, {
    serviceId: target.serviceId,
    trigger: "rollback",
    actor: actorOf(ctx.principal),
    triggeredBy: userOf(ctx.principal)?.id ?? null,
    rollbackOf: target,
  });
  return toDeployment(ctx.db, row);
});

const recent = implement(deploymentOps.recent, (input, ctx) => {
  const limit = input.limit ?? 5;
  const out: (ReturnType<typeof toDeployment> & { serviceName: string; projectId: string })[] = [];
  // Page through newest deployments until enough visible ones are found.
  for (let offset = 0; out.length < limit && offset < 5000; offset += 200) {
    const rows = ctx.db
      .select({ d: deployments, serviceName: services.name, projectId: services.projectId })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .where(input.projectId ? eq(services.projectId, input.projectId) : undefined)
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(200)
      .offset(offset)
      .all();
    if (rows.length === 0) break;
    const visible = rows
      .filter((r) => ctx.access.can("services.view", { type: "service", id: r.d.serviceId }))
      .slice(0, limit - out.length);
    const views = toDeployments(
      ctx.db,
      visible.map((r) => r.d),
    );
    visible.forEach((r, i) => {
      out.push({ ...(views[i] as ReturnType<typeof toDeployment>), serviceName: r.serviceName, projectId: r.projectId });
    });
  }
  return { deployments: out };
});

const tick = defineJob<Record<string, never>>({
  type: tickJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    const engine = engineFor(deps);
    for (const id of unfinishedDeployments(deps)) engine.kick(id);
    await engine.idle();
  },
});

export default defineModule({
  name: "deployments",
  ops: [deploy, list, get, log, cancel, rollback, recent],
  jobs: [tick, registryGcJob, registryGcSweepJob],
  start(deps) {
    const engine = engineFor(deps);
    deps.schedules.ensure({ key: registryGcSweepJobType, jobType: registryGcSweepJobType, cron: "17 4 * * *", jitterSeconds: 600 });
    deps.agents.onEvent("buildProgress", (nodeId, progress) => {
      const id = recordBuildProgress(engine, nodeId, progress);
      if (id) engine.kick(id);
    });
    deps.agents.onEvent("deployProgress", (nodeId, progress) => {
      const id = recordDeployProgress(engine, nodeId, progress);
      if (id) engine.kick(id);
    });
    // A node refused the spec it was sent: fail the rollout with its reason now.
    deps.agents.desired.onRefused((nodeId, refusal) => {
      try {
        const id = recordRefusedSpec(engine, nodeId, refusal);
        if (id) engine.kick(id);
      } catch (error) {
        deps.logger.error({ err: error, nodeId, serviceId: refusal.serviceId }, "recording a refused spec failed");
      }
    });
    // A node's reported state can finish a rollout whose events were lost.
    deps.agents.state.onChange((_nodeId, change) => {
      if (change.kind !== "service" && change.kind !== "snapshot") return;
      if (change.kind === "service") fillReportedDigest(deps, change.serviceId);
      const rows = deps.db
        .select({ id: deployments.id, serviceId: deployments.serviceId })
        .from(deployments)
        .where(
          change.kind === "service"
            ? and(eq(deployments.status, "deploying"), eq(deployments.serviceId, change.serviceId))
            : eq(deployments.status, "deploying"),
        )
        .all();
      for (const row of rows) engine.kick(row.id);
    });
    // A schedule, not a job that enqueues itself: a running job still holds
    // its own dedupe key, so a self re-enqueue would be dropped and the
    // timeouts and recovery the tick drives would never run again.
    deps.schedules.ensure({ key: tickJobType, jobType: tickJobType, intervalSeconds: tickEverySeconds, missedRun: "skip", runNow: true });
  },
});

export { activeStatuses, hasActiveDeploy, queueDeploy };
