// Exposures: first-run IP:port access (redirect-then-close once a domain is
// live) and timed exposes locked to an IP or CIDR, both through the agent's
// portgate. A scheduled job sweeps ended rows every minute; ports the
// agents picked are recorded from their service status.

import { databases as dbOps, exposures as exposureOps } from "@seylo/ops";
import type { ServiceStatus } from "@seylo/proto";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { invalidateService } from "../domains/lookup";
import { defineModule } from "../module";
import { recordReportedPorts, sweepAndMark } from "./logic";
import { close, extendTimed, get, openTimed, setFirstRun } from "./ops";

const sweepType = "exposures.sweep";

const sweep = defineJob({
  type: sweepType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    sweepAndMark(ctx);
  },
});

/**
 * The ports without an end a node reports for a service, with whether TLS
 * is on inside the database behind them: a database's timed exposes say
 * TLS from these (databases/timed.ts timedDatabase), so a change makes
 * open screens read them again.
 */
function permanentPorts(status: ServiceStatus): string {
  return status.openPorts
    .filter((p) => !p.expiresAt)
    .map((p) => `${p.hostPort}:${p.databaseTls ?? "-"}`)
    .sort()
    .join(",");
}

function trackPorts(deps: Deps) {
  // "<node>/<service>" -> permanentPorts, while the node reports any.
  const seen = new Map<string, string>();
  return deps.agents.state.onChange((nodeId, change) => {
    const view = deps.agents.state.get(nodeId);
    if (!view) return;
    if (change.kind === "service" && change.removed) seen.delete(`${nodeId}/${change.serviceId}`);
    const statuses: ServiceStatus[] =
      change.kind === "snapshot"
        ? [...view.services.values()]
        : change.kind === "service" && !change.removed
          ? [view.services.get(change.serviceId)].filter((s): s is ServiceStatus => !!s)
          : [];
    for (const status of statuses) {
      const key = `${nodeId}/${status.serviceId}`;
      const ports = permanentPorts(status);
      const portsChanged = ports !== (seen.get(key) ?? "");
      if (ports) seen.set(key, ports);
      else seen.delete(key);
      if (status.openPorts.length === 0 && !portsChanged) continue;
      try {
        if (recordReportedPorts(deps.db, nodeId, status).length > 0 || portsChanged)
          invalidateService(deps, status.serviceId, [exposureOps.get.id, dbOps.connection.id]);
      } catch (error) {
        deps.logger.warn({ err: error, nodeId, serviceId: status.serviceId }, "recording reported ports failed");
      }
    }
  });
}

export default defineModule({
  name: "exposures",
  ops: [get, setFirstRun, openTimed, extendTimed, close],
  jobs: [sweep],
  start(deps) {
    trackPorts(deps);
    deps.schedules.ensure({ key: sweepType, jobType: sweepType, intervalSeconds: 60 });
  },
});
