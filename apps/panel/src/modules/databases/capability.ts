// Whether a node's agent handles something new: the capabilities it
// advertised on its current connection, else the ones it advertised last
// time (nodes.facts, kept for offline nodes). A node that never connected
// has none.

import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { nodes, serviceDatabases } from "../../db/schema";
import { engines, enginesCapability } from "./engines";

export function nodeHasCapability(db: PanelDb, agents: Pick<AgentHub, "capabilities"> | null, nodeId: string, capability: string): boolean {
  const live = agents?.capabilities(nodeId);
  if (live) return live.has(capability);
  const facts = db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.id, nodeId)).get()?.facts;
  const stored = facts?.capabilities;
  return Array.isArray(stored) && stored.includes(capability);
}

/**
 * Refuses to move or clone a database to a node whose agent does not run its
 * engine (services.move, services.clone; databases.create checks the engine
 * it is asked for): it would run there without its shell, web UI and
 * backups. Other services pass.
 */
export function assertEngineRunsOn(
  db: PanelDb,
  agents: Pick<AgentHub, "capabilities">,
  serviceId: string,
  nodeId: string,
  nodeName = "this node",
  field = "toNodeId",
): void {
  const row = db.select({ engine: serviceDatabases.engine }).from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get();
  if (!row) return;
  const engine = engines[row.engine];
  if (engine.needsAgentCapability && !nodeHasCapability(db, agents, nodeId, enginesCapability)) {
    throw new OpError("CONFLICT", `The agent on ${nodeName} does not run ${engine.label} yet. Update the node first.`, {
      field,
      reason: "agentTooOld",
    });
  }
}
