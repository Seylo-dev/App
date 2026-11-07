// Compose stacks: a compose file (pasted or from a GitHub repo) parsed on an
// agent with compose-go and split into member services that share the
// stack's node and named volumes. A push to the stack's branch re-reads the
// file and redeploys (github module calls the refresher set in start()).

import { compose as composeOps, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { servicePlacements } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { setStackRefresher } from "../github/push";
import { defineModule } from "../module";
import { deleteServiceTree } from "../services/delete";
import { displaySource } from "../services/git-url";
import { insertService } from "../services/insert";
import { actorOf, publishService } from "../services/ops";
import { loadService, projectServiceRows, type ServiceRow, toDetail, toSummaries } from "../services/rows";
import { assertSourceAllowed } from "../services/source-guard";
import { applyPlan, diffMembers, fetchComposeFile, loadStackSource, planFromSource, saveStackSource, stackEnv } from "./apply";
import { assertPlanReferences, assertPushReferences } from "./references";

function stackNode(ctx: Pick<OpContext, "db">, stack: ServiceRow): string {
  const placement = ctx.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, stack.id)).get();
  if (!placement) throw new OpError("CONFLICT", "The stack has no node.");
  return placement.nodeId;
}

function requireStack(ctx: Pick<OpContext, "db">, serviceId: string): ServiceRow {
  const stack = loadService(ctx.db, serviceId);
  if (stack.kind !== "compose") throw new OpError("BAD_REQUEST", "This service is not a compose stack.", { field: "serviceId" });
  return stack;
}

const preview = implement(composeOps.preview, async (input, ctx) => {
  assertSourceAllowed(ctx, input.projectId, input.source);
  const yaml = await fetchComposeFile(ctx, input.source, undefined, input.nodeId);
  const plan = await planFromSource(ctx, { stackName: input.name, nodeId: input.nodeId, source: input.source, yaml, env: {} });
  assertPlanReferences(ctx, input.projectId, plan);
  const { members, conflicts } = diffMembers(ctx, null, plan, input.projectId, input.source);
  const warnings = [
    ...plan.warnings,
    ...conflicts.map((n) => `A service named ${n} already exists in this project; creating the stack would fail.`),
  ];
  return { members, warnings };
});

const create = implement(composeOps.create, async (input, ctx) => {
  assertSourceAllowed(ctx, input.projectId, input.source);
  const yaml = await fetchComposeFile(ctx, input.source, undefined, input.nodeId);
  const plan = await planFromSource(ctx, { stackName: input.name, nodeId: input.nodeId, source: input.source, yaml, env: {} });
  if (plan.members.length === 0) throw new OpError("BAD_REQUEST", "The compose file has no services.", { field: "source" });
  assertPlanReferences(ctx, input.projectId, plan);
  const { conflicts } = diffMembers(ctx, null, plan, input.projectId, input.source);
  if (conflicts.length > 0)
    throw new OpError("CONFLICT", `Services named ${conflicts.join(", ")} already exist in this project.`, { field: "name" });
  const userId = userOf(ctx.principal)?.id ?? null;
  const { id } = ctx.db.transaction((tx) =>
    insertService(tx, { projectId: input.projectId, name: input.name, kind: "compose", nodeId: input.nodeId, createdBy: userId }),
  );
  saveStackSource(ctx, id, input.source);
  const stack = loadService(ctx.db, id);
  try {
    await applyPlan(ctx, { stack, plan, nodeId: input.nodeId, actor: actorOf(ctx), createdBy: userId, deploy: input.deployNow ?? true });
  } catch (error) {
    await deleteServiceTree(ctx, loadService(ctx.db, id));
    throw error;
  }
  const rows = projectServiceRows(ctx.db, input.projectId).filter((r) => r.id === id || r.parentId === id);
  const [summary, ...memberSummaries] = toSummaries(ctx.db, ctx.agents, rows);
  publishService(ctx, stack);
  return { stack: summary as NonNullable<typeof summary>, members: memberSummaries };
});

const get = implement(composeOps.get, (input, ctx) => {
  const stack = requireStack(ctx, input.serviceId);
  const rows = projectServiceRows(ctx.db, stack.projectId).filter((r) => r.parentId === stack.id);
  return {
    stack: toDetail(ctx.db, ctx.agents, stack),
    source: displaySource(loadStackSource(ctx, stack)),
    members: toSummaries(ctx.db, ctx.agents, rows),
  };
});

const update = implement(composeOps.update, async (input, ctx) => {
  const stack = requireStack(ctx, input.serviceId);
  const nodeId = stackNode(ctx, stack);
  assertSourceAllowed(ctx, stack.projectId, input.source);
  const yaml = await fetchComposeFile(ctx, input.source, undefined, nodeId);
  const plan = await planFromSource(ctx, { stackName: stack.name, nodeId, source: input.source, yaml, env: stackEnv(ctx, stack.id) });
  assertPlanReferences(ctx, stack.projectId, plan);
  if (input.dryRun) {
    const { members, conflicts } = diffMembers(ctx, stack, plan, stack.projectId, input.source);
    return { members, warnings: [...plan.warnings, ...conflicts.map((n) => `A service named ${n} already exists in this project.`)] };
  }
  if (plan.members.length === 0) throw new OpError("BAD_REQUEST", "The compose file has no services.", { field: "source" });
  saveStackSource(ctx, stack.id, input.source);
  const members = await applyPlan(ctx, {
    stack: loadService(ctx.db, stack.id),
    plan,
    nodeId,
    actor: actorOf(ctx),
    createdBy: userOf(ctx.principal)?.id ?? null,
    deploy: true,
  });
  return { members, warnings: plan.warnings };
});

export default defineModule({
  name: "compose",
  ops: [preview, create, get, update],
  start() {
    setStackRefresher(async (deps, stack, push) => {
      const source = loadStackSource(deps, stack);
      const nodeId = stackNode(deps, stack);
      const yaml = await fetchComposeFile(deps, source, push.sha, nodeId);
      const plan = await planFromSource(deps, { stackName: stack.name, nodeId, source, yaml, env: stackEnv(deps, stack.id) });
      assertPushReferences(deps, stack, plan);
      const diff = await applyPlan(deps, {
        stack,
        plan,
        nodeId,
        actor: push.sender,
        createdBy: null,
        deploy: true,
        redeployBuilds: { commitSha: push.sha, branch: push.branch },
      });
      const changed = diff.filter((d) => d.action !== "unchanged").length;
      return { outcome: "deployed", detail: `Compose file at ${push.sha.slice(0, 7)}: ${changed} member(s) changed.` };
    });
  },
});
