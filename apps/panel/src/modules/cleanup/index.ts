// Docker cleanup of this panel's own resources on one node (Prune on the
// agent, which only ever touches seylo.* labeled resources). Contracts:
// packages/ops/src/ops/cleanup.ts.

import { cleanup, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { nodes } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";

/** Pruning images on a busy node can take minutes. */
const pruneTimeoutMs = 10 * 60_000;

async function prune(
  ctx: OpContext,
  input: { nodeId: string; images?: boolean; buildCache?: boolean; stoppedContainers?: boolean; orphanedServiceData?: boolean },
  dryRun: boolean,
) {
  const node = ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, input.nodeId)).get();
  if (!node) throw new OpError("NOT_FOUND", "No node with this id.");
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
  const result = await prune(ctx, input, false);
  ctx.live.publish(`node:${input.nodeId}`, { type: "invalidate", ops: ["nodes.get", "metrics.node"] });
  return result;
});

export default defineModule({ name: "cleanup", ops: [preview, run] });
