// Docker cleanup of this panel's own resources on one node (Prune on the
// agent, which only ever touches seylo.* labeled resources), the schedule
// a node runs by itself (NodeSettings.cleanup, also while the panel is
// down) and the history of runs. Contracts: packages/ops/src/ops/cleanup.ts.

import { cleanup, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { factsOf } from "../nodes/view";
import { ingestRun, listRuns, recordManualRun } from "./runs";
import { agentRunsSchedules, checkSchedule, fromSchedule, nextRun, stored, toProto, toSchedule } from "./schedule";

/** Pruning images on a busy node can take minutes. */
const pruneTimeoutMs = 10 * 60_000;

function nodeRow(ctx: Pick<OpContext, "db">, nodeId: string) {
  const node = ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new OpError("NOT_FOUND", "No node with this id.");
  return node;
}

async function prune(
  ctx: OpContext,
  input: { nodeId: string; images?: boolean; buildCache?: boolean; stoppedContainers?: boolean; orphanedServiceData?: boolean },
  dryRun: boolean,
) {
  const node = nodeRow(ctx, input.nodeId);
  const res = await ctx.agents.call(
    node.id,
    "prune",
    {
      images: input.images ?? true,
      buildCache: input.buildCache ?? true,
      stoppedContainers: input.stoppedContainers ?? true,
      orphanedServiceData: input.orphanedServiceData ?? false,
      dryRun,
    },
    { timeoutMs: pruneTimeoutMs },
  );
  return { nodeId: node.id, bytes: Number(res.reclaimedBytes), items: res.removed };
}

const preview = implement(cleanup.preview, (input, ctx) => prune(ctx, input, true));

const run = implement(cleanup.run, async (input, ctx) => {
  const startedAt = new Date();
  const userId = ctx.principal.type === "anonymous" ? null : ctx.principal.user.id;
  try {
    const result = await prune(ctx, input, false);
    recordManualRun(ctx, { nodeId: input.nodeId, userId, startedAt, bytes: result.bytes, items: result.items, error: null });
    ctx.live.publish(`node:${input.nodeId}`, { type: "invalidate", ops: ["nodes.get", "metrics.node"] });
    return result;
  } catch (error) {
    // A run the agent took and failed is history too; offline or unknown nodes are not.
    if (error instanceof OpError && error.details?.reason === "agent") {
      recordManualRun(ctx, { nodeId: input.nodeId, userId, startedAt, bytes: 0, items: [], error: error.message });
    }
    throw error;
  }
});

/** The node's own time zone, as its agent reported it. */
function timeZoneOf(deps: Deps, node: typeof nodes.$inferSelect): string | null {
  return factsOf(deps, node)?.timeZone || null;
}

const getSchedule = implement(cleanup.getSchedule, (input, ctx) => {
  const node = nodeRow(ctx, input.nodeId);
  const json = stored(node);
  const timeZone = timeZoneOf(ctx, node);
  const version = factsOf(ctx, node)?.agentVersion || node.agentVersion;
  return {
    nodeId: node.id,
    schedule: toSchedule(json),
    timeZone,
    nextRunAt: nextRun(json, timeZone),
    supported: agentRunsSchedules(version),
  };
});

const setSchedule = implement(cleanup.setSchedule, (input, ctx) => {
  const node = nodeRow(ctx, input.nodeId);
  const json = fromSchedule(input.schedule);
  const timeZone = timeZoneOf(ctx, node);
  checkSchedule(json, timeZone);
  ctx.db.update(nodes).set({ cleanupSchedule: json }).where(eq(nodes.id, node.id)).run();
  ctx.agents.desired.markDirty({ nodeId: node.id });
  ctx.live.publish(`node:${node.id}`, { type: "invalidate", ops: ["cleanup.getSchedule"] });
  return { nodeId: node.id, schedule: toSchedule(json), nextRunAt: nextRun(json, timeZone) };
});

const runs = implement(cleanup.runs, (input, ctx) => {
  const node = nodeRow(ctx, input.nodeId);
  return listRuns(ctx, node.id, input.limit ?? 20);
});

function start(deps: Deps) {
  deps.agents.onEvent("cleanupRun", (nodeId, event) => ingestRun(deps, nodeId, event));
  deps.agents.desired.contribute({
    name: "cleanup",
    node(ctx) {
      const node = ctx.db.select({ cleanupSchedule: nodes.cleanupSchedule }).from(nodes).where(eq(nodes.id, ctx.nodeId)).get();
      if (node) ctx.settings.cleanup = toProto(stored(node));
    },
  });
}

export default defineModule({ name: "cleanup", ops: [preview, run, getSchedule, setSchedule, runs], start });
