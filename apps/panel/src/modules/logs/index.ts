// Service logs: search (search.ts) and live tails over a ticketed WebSocket
// (follow.ts). Logs stay on the nodes; the panel only relays them.
// Contracts: packages/ops/src/ops/logs.ts.

import { logs, OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { pickServiceNode, serviceNodes, ticketsFor } from "../../agent-hub/relay";
import { builds, deployments } from "../../db/schema";
import { implement } from "../../ops/implement";
import { defineModule } from "../module";
import { type FollowTicket, logsHttp, logsSocketPath } from "./follow";
import { searchLogs } from "./search";

const search = implement(logs.search, (input, ctx) => searchLogs(ctx, input));

const follow = implement(logs.follow, (input, ctx) => {
  let nodeIds: string[];
  if (input.buildId) {
    // Build logs live on the node that built.
    const build = ctx.db
      .select({ nodeId: builds.nodeId })
      .from(builds)
      .innerJoin(deployments, eq(deployments.id, builds.deploymentId))
      .where(and(eq(builds.id, input.buildId), eq(deployments.serviceId, input.serviceId)))
      .get();
    if (!build) throw new OpError("NOT_FOUND", "No build with this id for this service.");
    if (!build.nodeId) throw new OpError("CONFLICT", "This build has not started on a node yet.");
    nodeIds = [build.nodeId];
  } else {
    nodeIds = input.nodeId
      ? [pickServiceNode(ctx.db, input.serviceId, input.nodeId).id]
      : serviceNodes(ctx.db, input.serviceId).map((n) => n.id);
    if (nodeIds.length === 0) throw new OpError("CONFLICT", "This service is not placed on any node yet.");
  }
  const data: FollowTicket = {
    serviceId: input.serviceId,
    buildId: input.buildId ?? null,
    nodeIds,
    tail: input.tail ?? 200,
    since: input.since ?? null,
  };
  const issued = ticketsFor(ctx).issue({ principal: ctx.principal, action: "logs.view", serviceId: input.serviceId }, data);
  return {
    url: `${logsSocketPath}?t=${encodeURIComponent(issued.ticket)}`,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
  };
});

export default defineModule({ name: "logs", ops: [search, follow], http: logsHttp });
