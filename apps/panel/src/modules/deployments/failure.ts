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

/** A reason as one sentence: its own full stop, or one added. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What finish() appends to the error of a rollout that failed while the previous version serves. */
export const stayedLive = "The previous version stayed live.";

/** What an agent puts before the reason in the status message of a service whose deploy failed (rollout.go failDeploy). */
const statePrefix = "deploy failed: ";

/** The reason in a ServiceStatus message of phase FAILED: as in the node's DeployProgress, without the agent's prefix. */
export function stateFailureReason(message: string): string {
  const { reason } = splitLastOutput(message);
  return reason.startsWith(statePrefix) ? reason.slice(statePrefix.length) : reason;
}

/**
 * A deployment that failed before 0.2.16 kept the output an agent appended
 * to its reason in its error: "<node>: <reason>\nlast output:\n<lines>
 * The previous version stayed live." Read now, the error is the reason
 * (and the trailer) and the lines are the failed node's last output, as for
 * a deploy that fails today. null for every other error.
 */
export function legacyError(error: string | null): { error: string; lines: string[] } | null {
  if (!error?.includes(legacyMarker)) return null;
  const { reason, lines } = splitLastOutput(error);
  const last = lines.at(-1);
  const trailer = ` ${stayedLive}`;
  if (last?.endsWith(trailer)) {
    const rest = last.slice(0, -trailer.length);
    const kept = rest === "" ? lines.slice(0, -1) : [...lines.slice(0, -1), rest];
    return { error: `${sentence(reason)} ${stayedLive}`, lines: kept };
  }
  return { error: reason, lines };
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
  /**
   * One of listening is the port to switch to (services.usePort): false
   * when the app listens on the checked port itself, only on 127.0.0.1.
   * That is the mistake to fix, and the other ports a debugger's or a
   * metrics one (the agent's hint says so too).
   */
  switchable: boolean;
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
    return { nodeId, port: nl.port, listening, loopbackOnly, switchable: listening.length > 0 && !loopbackOnly.includes(nl.port) };
  }
  return null;
}
