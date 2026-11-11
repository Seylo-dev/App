// Whether a node's agent handles something new: the capabilities it
// advertised on its current connection, else the ones it advertised last
// time (nodes.facts, kept for offline nodes). A node that never connected
// has none. When a node's facts change, open screens of the databases
// exposed there read their exposure again (watchExposureCapabilities).

import { databases as dbOps, env as envOps, exposures as exposureOps, OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { nodes, portExposures, serviceDatabases } from "../../db/schema";
import type { Deps } from "../../deps";
import { invalidateService } from "../domains/lookup";
import { type Engine, engines, enginesCapability, exposureCapability } from "./engines";

export function nodeHasCapability(db: PanelDb, agents: Pick<AgentHub, "capabilities"> | null, nodeId: string, capability: string): boolean {
  const live = agents?.capabilities(nodeId);
  if (live) return live.has(capability);
  const facts = db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.id, nodeId)).get()?.facts;
  const stored = facts?.capabilities;
  return Array.isArray(stored) && stored.includes(capability);
}

/**
 * The capability a node's agent lacks to expose the engine TLS only, null
 * when it has what it needs: the engines added in 0.2 need
 * database.engines.v2 (an older agent relays them without TLS), and
 * Postgres, MySQL and MariaDB need database.exposure.v2 (an older agent
 * relays them without checking that clients ask for TLS, and set TLS up
 * only along with a separate user).
 */
export function missingExposureCapability(
  db: PanelDb,
  agents: Pick<AgentHub, "capabilities"> | null,
  engine: Engine,
  nodeId: string,
): string | null {
  if (engine.needsAgentCapability && !nodeHasCapability(db, agents, nodeId, enginesCapability)) return enginesCapability;
  if (engine.exposureNeedsCapability && !nodeHasCapability(db, agents, nodeId, exposureCapability)) return exposureCapability;
  return null;
}

/**
 * When a node's facts change (its agent connected, the hello stored them
 * first), open screens of every database exposed there read the exposure
 * again: one that waited for the node's update (exposure.state
 * "waitingForNodeUpdate") opens with the connect sync, and the Connection
 * tab, its URL and the env references follow without a reload. One query
 * per facts change. Returns a remover.
 */
export function watchExposureCapabilities(deps: Pick<Deps, "db" | "agents" | "live">): () => void {
  return deps.agents.state.onChange((nodeId, change) => {
    if (change.kind !== "facts") return;
    const exposed = deps.db
      .selectDistinct({ serviceId: portExposures.serviceId })
      .from(portExposures)
      .where(and(eq(portExposures.nodeId, nodeId), eq(portExposures.kind, "database")))
      .all();
    for (const { serviceId } of exposed) {
      invalidateService(deps, serviceId, [dbOps.get.id, dbOps.connection.id, exposureOps.get.id, envOps.references.id]);
    }
  });
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
