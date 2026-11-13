// What a node says about a failed rollout besides its reason: the new
// container's last output (DeployProgress.last_output, agents from 0.2.16)
// and, when the default check was refused all along, the ports the app
// listens on instead (not_listening). Agents before 0.2.16 append the
// output to the reason after "last output:"; it is split off here, so the
// deployment's error, its log and alerts carry the reason alone and the
// deploy dialog shows the app's output in a block of its own.

import type { DeployProgress } from "@seylo/proto";
import type { DeployNodeResult, StoredNotListening } from "../../db/schema";

/** Where an agent before 0.2.16 starts the output in a failure message. */
const legacyMarker = "\nlast output:\n";
/** Lines kept per node, like the agent's tail (failureLines is 20; a node may send more). */
export const maxLastOutputLines = 200;

/** The reason of a failure message and the output an agent before 0.2.16 appended to it. */
export function splitLastOutput(message: string): { reason: string; lines: string[] } {
  const at = message.indexOf(legacyMarker);
  if (at < 0) {
    // Cut off right after the marker (the report's field cap): no lines.
    const bare = message.endsWith("\nlast output:") ? message.slice(0, -"\nlast output:".length) : message;
    return { reason: bare, lines: [] };
  }
  const lines = message.slice(at + legacyMarker.length).split("\n");
  return { reason: message.slice(0, at), lines: lines.slice(-maxLastOutputLines) };
}

/** A FAILED DeployProgress: its reason, and what it adds to the node's result. */
export function reportedFailure(progress: DeployProgress): {
  reason: string;
  extra: Pick<DeployNodeResult, "lastOutput" | "notListening">;
} {
  const { reason, lines } = splitLastOutput(progress.message);
  const output = progress.lastOutput.length > 0 ? progress.lastOutput.slice(-maxLastOutputLines) : lines;
  const extra: Pick<DeployNodeResult, "lastOutput" | "notListening"> = {};
  if (output.length > 0) extra.lastOutput = [...output];
  const nl = progress.notListening;
  if (nl && nl.port > 0) {
    extra.notListening = {
      port: nl.port,
      read: nl.read,
      listening: nl.listening.filter((p) => p.port > 0 && p.port <= 65535).map((p) => ({ port: p.port, loopbackOnly: p.loopbackOnly })),
    };
  }
  return { reason, extra };
}

/** The node whose failure the deployment shows: the first failed one, else any with output. */
function failedNode(results: Record<string, DeployNodeResult>): [string, DeployNodeResult] | undefined {
  const entries = Object.entries(results);
  return entries.find(([, r]) => r.status === "failed" && (r.lastOutput || r.notListening)) ?? entries.find(([, r]) => r.lastOutput);
}

/** Deployment.lastOutput: the new container's output on the node that failed. */
export function lastOutputOf(results: Record<string, DeployNodeResult>): { nodeId: string; lines: string[] } | null {
  const found = failedNode(results);
  if (!found?.[1].lastOutput?.length) return null;
  return { nodeId: found[0], lines: found[1].lastOutput };
}

export interface PortHint {
  nodeId: string;
  port: number;
  /** Ports the app listens on, on all addresses, other than port. */
  listening: number[];
  /** Ports it listens on only on a loopback address. */
  loopbackOnly: number[];
}

/**
 * Deployment.portHint: the app did not listen on the port checked but on
 * others (or only on 127.0.0.1). null when the node could not read its
 * sockets, it listened on nothing, or the agent is older than 0.2.16.
 */
export function portHintOf(results: Record<string, DeployNodeResult>): PortHint | null {
  for (const [nodeId, r] of Object.entries(results)) {
    const nl: StoredNotListening | undefined = r.notListening;
    if (r.status !== "failed" || !nl?.read) continue;
    const listening = nl.listening.filter((p) => !p.loopbackOnly && p.port !== nl.port).map((p) => p.port);
    const loopbackOnly = nl.listening.filter((p) => p.loopbackOnly).map((p) => p.port);
    if (listening.length === 0 && loopbackOnly.length === 0) continue;
    return { nodeId, port: nl.port, listening, loopbackOnly };
  }
  return null;
}
