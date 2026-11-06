// Where agents should dial from now on. Once the panel domain is
// live (the hourly domain check reached https://<domain>/api/health with a
// certificate the panel's public roots trust), every accepted connect tells
// nodes that joined over an IP address to move to https://<domain>. The pin
// stays empty: an "active" domain has a public certificate, which agents
// check with their system roots (an ACME certificate's key changes on
// renewal, so pinning it would break the next renewal). The panel's own node
// keeps dialing loopback and never gets a target. Agents connected over plain
// HTTP ignore it (anyone on that path could have named the address), so
// they stay until they join again with the https:// command
// (go/internal/agent/move.go).

import { eq } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { nodes } from "../db/schema";
import type { Logger } from "../logger";
import "../modules/settings/domain";
import { getSetting } from "../settings";
import type { AgentHub } from "./hub";

export interface AgentMoveTarget {
  /** Base URL like "https://panel.example.com" (agents add the connect path). */
  url: string;
  /** "sha256:<64 hex>", or "" to verify with the node's system roots. */
  pin: string;
}

/** The live panel domain as an agent address, or null while there is none. */
export function liveDomainTarget(db: PanelDb): AgentMoveTarget | null {
  const domain = getSetting(db, "panelDomain")?.trim().toLowerCase();
  if (!domain) return null;
  const status = getSetting(db, "panelDomainStatus");
  if (status?.domain.trim().toLowerCase() !== domain || status.state !== "active") return null;
  return { url: `https://${domain}`, pin: "" };
}

/** What HelloAccepted.panel_url/panel_pin carry for this node, or null to leave them empty. */
export function agentMoveTarget(db: PanelDb, nodeId: string): AgentMoveTarget | null {
  const target = liveDomainTarget(db);
  if (!target) return null;
  const node = db.select({ isPanelNode: nodes.isPanelNode }).from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node || node.isPanelNode) return null;
  return target;
}

/**
 * Right after the panel domain went live: closes the connection of every
 * online node that did not dial the domain, so it reconnects, reads
 * panel_url from HelloAccepted and moves (one or two reconnects per node;
 * services keep running). Returns how many were asked.
 */
export function askNodesToMove(deps: {
  db: PanelDb;
  agents: Pick<AgentHub, "onlineNodeIds" | "dialedHost" | "reconnect">;
  logger: Logger;
}): number {
  let asked = 0;
  for (const nodeId of deps.agents.onlineNodeIds()) {
    const target = agentMoveTarget(deps.db, nodeId);
    if (!target) continue;
    if (deps.agents.dialedHost(nodeId) === new URL(target.url).host) continue;
    deps.agents.reconnect(nodeId, "The panel has a domain now: reconnect to move to it.");
    asked++;
  }
  if (asked > 0) deps.logger.info({ nodes: asked }, "the panel domain is live; asked nodes to reconnect and move to it");
  return asked;
}
