// A service's live status, from the agents' reports in memory
// (deps.agents.state) plus the deploy in progress. Nothing here is stored.
// serviceStatus is what the service says (a deploy in progress first);
// runtimeStatus is what runs meanwhile, which the screens' status dot shows.

import type { services as serviceOps } from "@seylo/ops";
import { type ServiceStatus as AgentServiceStatus, HealthState, InstanceState, ServicePhase } from "@seylo/proto";
import type { Static } from "@sinclair/typebox";
import type { AgentHub } from "../../agent-hub/hub";

export type ServiceStatus = Static<typeof serviceOps.ServiceStatus>;

export interface StatusInput {
  serviceId: string;
  kind: string;
  stopped: boolean;
  /** Never deployed: nothing runs anywhere. */
  deployed: boolean;
  /** Status of a deployment in progress, if any. */
  activeDeploy: "queued" | "building" | "deploying" | null;
  nodeIds: readonly string[];
}

/** One node's phase reduced to the service vocabulary. */
export function phaseStatus(status: AgentServiceStatus): ServiceStatus {
  switch (status.phase) {
    case ServicePhase.RUNNING:
      return status.instances.some((i) => i.health === HealthState.UNHEALTHY) ? "unhealthy" : "running";
    case ServicePhase.DEPLOYING:
      return "deploying";
    case ServicePhase.PENDING:
    case ServicePhase.PULLING:
    case ServicePhase.STARTING:
      return "starting";
    case ServicePhase.DEGRADED:
      return status.instances.some((i) => i.state === InstanceState.RUNNING && i.health !== HealthState.UNHEALTHY)
        ? "partial"
        : "unhealthy";
    case ServicePhase.CRASH_LOOPING:
    case ServicePhase.FAILED:
      return "crashed";
    case ServicePhase.STOPPED:
    case ServicePhase.SLEEPING:
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * The node's phase for runtimeStatus: as phaseStatus, except DEPLOYING (the
 * agent rolls a new version out next to the one that runs): the state of
 * the containers that run, so a live version that serves through a deploy
 * reads running. With nothing running it stays "deploying".
 */
export function runtimePhaseStatus(status: AgentServiceStatus): ServiceStatus {
  if (status.phase !== ServicePhase.DEPLOYING) return phaseStatus(status);
  const running = status.instances.filter((i) => i.state === InstanceState.RUNNING);
  if (running.length === 0) return "deploying";
  return running.some((i) => i.health !== HealthState.UNHEALTHY) ? "running" : "unhealthy";
}

/** What the service says: a deploy in progress ("building" while queued or building, "deploying" while it rolls out), else what runs. */
export function serviceStatus(agents: AgentHub, input: StatusInput): ServiceStatus {
  if (input.activeDeploy === "queued" || input.activeDeploy === "building") return "building";
  if (input.activeDeploy === "deploying") return "deploying";
  return statusOfNodes(agents, input, phaseStatus);
}

/**
 * What runs now, whatever a deploy in progress does
 * (ServiceSummary.runtimeStatus): serviceStatus without the deploy's
 * "building" and "deploying", and a node that rolls a new version out next
 * to the one that runs reads as that one. "idle" while nothing was deployed
 * (a first deploy that has not reached its nodes yet).
 */
export function runtimeStatus(agents: AgentHub, input: Omit<StatusInput, "activeDeploy">): ServiceStatus {
  return statusOfNodes(agents, input, runtimePhaseStatus);
}

function statusOfNodes(
  agents: AgentHub,
  input: Omit<StatusInput, "activeDeploy">,
  phase: (status: AgentServiceStatus) => ServiceStatus,
): ServiceStatus {
  if (input.kind === "compose") return "idle";
  if (!input.deployed) return "idle";
  if (input.stopped) return "stopped";
  if (input.nodeIds.length === 0) return "idle";

  const reported = new Map(agents.state.serviceStatuses(input.serviceId).map((s) => [s.nodeId, s.status]));
  const perNode: ServiceStatus[] = input.nodeIds.map((nodeId) => {
    if (!agents.isOnline(nodeId)) return "unknown";
    const status = reported.get(nodeId);
    return status ? phase(status) : "starting";
  });
  return combine(perNode);
}

/** Several nodes: all the same is that status; some serving and some not is partial. */
export function combine(perNode: readonly ServiceStatus[]): ServiceStatus {
  const first = perNode[0];
  if (first === undefined) return "idle";
  if (perNode.every((s) => s === first)) return first;
  const serving = perNode.filter((s) => s === "running" || s === "partial").length;
  if (serving > 0) return "partial";
  if (perNode.includes("crashed")) return "crashed";
  if (perNode.includes("unhealthy")) return "unhealthy";
  if (perNode.includes("deploying")) return "deploying";
  if (perNode.includes("starting")) return "starting";
  return "unknown";
}

/** CPU and memory summed over the service's nodes; null when nothing reports. */
export function serviceUsage(agents: AgentHub, serviceId: string) {
  const rows = agents.state.serviceUsage(serviceId).filter((r) => agents.isOnline(r.nodeId));
  if (rows.length === 0) return { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null };
  let cpu = 0;
  let memory = 0n;
  let limit = 0n;
  for (const { usage } of rows) {
    cpu += usage.cpuPercent;
    memory += usage.memoryUsedBytes;
    limit += usage.memoryLimitBytes;
  }
  return { cpuPercent: Math.round(cpu * 10) / 10, memoryBytes: Number(memory), memoryLimitBytes: limit > 0n ? Number(limit) : null };
}
