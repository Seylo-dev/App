// Nodes: list, settings, join tokens, health checks, reboot and Docker
// updates (ops.ts). start() also wires the agent hub for the whole panel:
// PanelService handlers, the desired-state flusher, the agent version
// policy, stored facts, and live invalidations when nodes or their
// services change.

import { toJson } from "@bufbuild/protobuf";
import { NodeFactsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { createPanelService } from "../../agent-hub/panel-service";
import { servicesOnNode } from "../../agent-hub/service-scope";
import { minimumAgentVersion } from "../../agent-hub/version";
import { nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { type DesiredFlusher, startDesiredFlusher } from "../../desired";
import { defineJob } from "../../jobs/queue";
import { defineModule } from "../module";
import { manifestMinAgent } from "../updates/release-state";
import { seedPanelNodeAddress } from "./address";
import { importInstallerJoinToken } from "./installer-join";
import { ensureNodeCertificate, lbTlsContributor } from "./lb-tls";
import { nodeHandlers, publishNode } from "./ops";
import { ensurePanelService, panelContributor, panelServiceId } from "./panel-service";
import { pruneTables } from "./retention";

const flushers = new WeakMap<object, DesiredFlusher>();

/** The panel's desired-state flusher (tests call flush() on it). */
export function flusherFor(deps: Pick<Deps, "agents">): DesiredFlusher | undefined {
  return flushers.get(deps.agents);
}

/** Prunes what panel.db keeps (retention.ts); runs hourly (schedule "nodes.pruneReports"). */
const pruneReports = defineJob<Record<string, never>>({
  type: "nodes.pruneReports",
  async run(_payload, ctx) {
    pruneTables(ctx.db);
    // Renew LB certificates with under 30 days left; the node gets them with its settings.
    for (const node of ctx.db.select({ id: nodes.id }).from(nodes).all()) {
      if (ensureNodeCertificate(ctx, node.id)) ctx.agents.desired.markDirty({ nodeId: node.id });
    }
  },
});

function start(deps: Deps) {
  const nodesLogger = deps.logger.child({ component: "nodes" });
  importInstallerJoinToken(deps.db, deps.config.dataDir, nodesLogger);
  // Before the flusher starts: after a panel update the first desired state must already name the new image.
  const ensure = () => {
    try {
      if (ensurePanelService({ ...deps, logger: nodesLogger }) !== "unchanged")
        deps.agents.desired.markDirty({ serviceId: panelServiceId });
    } catch (error) {
      nodesLogger.error({ err: error }, "recording the panel service failed");
    }
  };
  ensure();
  deps.agents.desired.contribute(panelContributor);
  deps.agents.desired.contribute(lbTlsContributor);
  // A node may report only on the services it runs (agent-hub/service-scope.ts).
  deps.agents.setServiceScope((nodeId) => servicesOnNode(deps.db, nodeId));
  const logger = deps.logger.child({ component: "desired" });
  const flusher = startDesiredFlusher({ db: deps.db, secrets: deps.secrets, agents: deps.agents, logger });
  flushers.set(deps.agents, flusher);

  deps.agents.attachPanelService(
    createPanelService({
      db: deps.db,
      hub: deps.agents,
      logger: deps.logger.child({ component: "panel-service" }),
      desiredState: (nodeId, knownRevision) => flusher.currentState(nodeId, knownRevision),
      reportBudgetExceeded: (nodeId) => {
        const name = deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? "A node";
        deps.alerts.raise({
          event: "node_health_check_failed",
          key: `report-budget:${nodeId}:${new Date().toISOString().slice(0, 10)}`,
          title: `${name} sends more reports than the panel keeps`,
          message:
            "In the last day this node sent more durable reports (deploy, cron, backup and cleanup results, alerts, crashes) than the panel stores for one node. The panel acknowledges and drops the rest until the day is over. A healthy node does not get here: check what runs on it.",
          severity: "warning",
          nodeId,
        });
      },
    }),
  );
  deps.agents.setAgentVersionPolicy(() => minimumAgentVersion(deps.config.version, manifestMinAgent(deps.db)));

  deps.agents.onConnection((nodeId, online) => {
    // Its LB identity exists before the connect sync compiles the node's settings.
    if (online) {
      try {
        ensureNodeCertificate(deps, nodeId);
      } catch (error) {
        nodesLogger.error({ err: error, nodeId }, "issuing the node's load balancer certificate failed");
      }
    }
    if (!online) deps.db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, nodeId)).run();
    // The installer's local agent just joined as the panel node: record the panel container it runs.
    else if (deps.config.image) ensure();
    if (online) seedPanelNodeAddress(deps.db);
    publishNode(deps, nodeId);
  });

  deps.agents.state.onChange((nodeId, change) => {
    switch (change.kind) {
      case "facts": {
        // Keep the last facts for when the node is offline.
        const facts = deps.agents.state.get(nodeId)?.facts;
        if (facts) {
          deps.db
            .update(nodes)
            .set({
              facts: toJson(NodeFactsSchema, facts) as Record<string, unknown>,
              agentVersion: facts.agentVersion || undefined,
              publicIpv4: facts.publicIpv4 || undefined,
              publicIpv6: facts.publicIpv6 || undefined,
            })
            .where(eq(nodes.id, nodeId))
            .run();
        }
        publishNode(deps, nodeId);
        return;
      }
      case "snapshot":
      case "applied":
        publishNode(deps, nodeId);
        return;
      case "service": {
        const project = deps.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, change.serviceId)).get();
        deps.live.publish(`service:${change.serviceId}`, { type: "invalidate", ops: ["services.get", "nodes.get"] });
        if (project) deps.live.publish(`project:${project.projectId}`, { type: "invalidate", ops: ["services.list"] });
        deps.live.publish(`node:${nodeId}`, { type: "invalidate", ops: ["nodes.get"] });
        return;
      }
      default:
        return;
    }
  });

  deps.schedules.ensure({ key: "nodes.pruneReports", jobType: "nodes.pruneReports", cron: "17 * * * *" });
}

export default defineModule({ name: "nodes", ops: nodeHandlers, jobs: [pruneReports], start });
