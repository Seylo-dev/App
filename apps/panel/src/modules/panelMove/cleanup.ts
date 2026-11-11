// Undo work of failed moves that waits for a node to come back: a target
// that still holds a staged copy of the panel (master.key among it) gets
// AbortMovedPanel, a node that still holds a staged address gets
// ClearPanelAddress, each on its next connect. Entries live in
// panelMoveCleanups (keys.ts) so a restart of the panel keeps them, and are
// dropped once done or after a week.
//
// A target that refuses AbortMovedPanel with "committed" took the switch
// after all: a forced cancel undid a move while the target was away and
// its moved panel showed nothing, but its CommitMovedPanel had landed. Its
// moved panel takes agents and nothing here can stop it. That is logged as
// an error with an audit row naming the node, and dropped. (A target that
// answers "committed" to the forced cancel's own AbortMovedPanel sends the
// move on with the switch instead, orchestrator.ts.)

import { OpError } from "@seylo/ops";
import { agentRefusalOf } from "../../agent-hub/calls";
import type { Deps } from "../../deps";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { writeMoveAudit } from "./audit";
import { cleanupKeepMs, type PanelMoveCleanup } from "./keys";

/** Nodes with a cleanup call in flight, per panel. */
const running = new WeakMap<object, Set<string>>();

export function addCleanup(deps: Pick<Deps, "db">, entry: PanelMoveCleanup): void {
  const list = (getSetting(deps.db, "panelMoveCleanups") ?? []).filter((other) => other.moveId !== entry.moveId);
  setSetting(deps.db, "panelMoveCleanups", [...list, entry]);
}

function update(deps: Pick<Deps, "db">, moveId: string, change: (entry: PanelMoveCleanup) => PanelMoveCleanup): void {
  const now = Date.now();
  const list = (getSetting(deps.db, "panelMoveCleanups") ?? [])
    .map((entry) => (entry.moveId === moveId ? change(entry) : entry))
    .filter((entry) => (entry.abortNodeId !== null || entry.clearNodeIds.length > 0) && now - entry.at < cleanupKeepMs);
  if (list.length > 0) setSetting(deps.db, "panelMoveCleanups", list);
  else deleteSetting(deps.db, "panelMoveCleanups");
}

/** A failure that will not go away by trying again on this node: it is dropped. */
function hopeless(error: unknown): boolean {
  return error instanceof OpError && (error.code === "NOT_IMPLEMENTED" || error.code === "NOT_FOUND");
}

/** AbortMovedPanel refused because the target took the switch of that move (CommitMovedPanel landed). */
export function refusedAsCommitted(error: unknown): boolean {
  const refusal = agentRefusalOf(error);
  return refusal?.status === "FAILED_PRECONDITION" && refusal.reason === "committed";
}

/** A forced cancel undid a move the target had committed: the owner must hear of it. */
export function reportForcedCancelConflict(
  deps: Pick<Deps, "db" | "logger">,
  moveId: string,
  nodeId: string,
  nodeName: string | null = null,
): void {
  deps.logger.error(
    { moveId, nodeId },
    "the target took the switch of a panel move that was cancelled with force: its moved panel takes agents",
  );
  writeMoveAudit(
    deps,
    "panelMove.forcedCancelConflict",
    {
      moveId,
      target: nodeId,
      ...(nodeName ? { targetName: nodeName } : {}),
      reason: "The target had taken the switch: its moved panel takes the nodes that reach it.",
    },
    "CONFLICT",
  );
}

/** Runs what waits for `nodeId`; every failure is logged and kept for its next connect. */
export async function runCleanups(deps: Pick<Deps, "db" | "agents" | "logger">, nodeId: string): Promise<void> {
  const list = getSetting(deps.db, "panelMoveCleanups") ?? [];
  const mine = list.filter((entry) => entry.abortNodeId === nodeId || entry.clearNodeIds.includes(nodeId));
  if (mine.length === 0) return;
  const busy = running.get(deps.db) ?? new Set<string>();
  running.set(deps.db, busy);
  if (busy.has(nodeId)) return;
  busy.add(nodeId);
  try {
    for (const entry of mine) {
      if (entry.abortNodeId === nodeId) {
        try {
          await deps.agents.call(nodeId, "abortMovedPanel", { moveId: entry.moveId }, { timeoutMs: 2 * 60_000 });
          update(deps, entry.moveId, (e) => ({ ...e, abortNodeId: null }));
          deps.logger.info({ nodeId, moveId: entry.moveId }, "removed the staged copy of a failed panel move");
        } catch (error) {
          if (refusedAsCommitted(error)) {
            // Its staged address leads to its own moved panel, which holds the switch: it stays too.
            update(deps, entry.moveId, (e) => ({ ...e, abortNodeId: null, clearNodeIds: e.clearNodeIds.filter((id) => id !== nodeId) }));
            reportForcedCancelConflict(deps, entry.moveId, nodeId);
            continue;
          }
          if (hopeless(error)) update(deps, entry.moveId, (e) => ({ ...e, abortNodeId: null }));
          deps.logger.warn({ err: error, nodeId, moveId: entry.moveId }, "removing the staged copy of a failed panel move failed");
        }
      }
      if (entry.clearNodeIds.includes(nodeId)) {
        try {
          await deps.agents.call(nodeId, "clearPanelAddress", { moveId: entry.moveId }, { timeoutMs: 30_000 });
          update(deps, entry.moveId, (e) => ({ ...e, clearNodeIds: e.clearNodeIds.filter((id) => id !== nodeId) }));
        } catch (error) {
          if (hopeless(error)) update(deps, entry.moveId, (e) => ({ ...e, clearNodeIds: e.clearNodeIds.filter((id) => id !== nodeId) }));
          deps.logger.warn({ err: error, nodeId, moveId: entry.moveId }, "clearing the staged address of a failed panel move failed");
        }
      }
    }
  } finally {
    busy.delete(nodeId);
  }
}

/** Runs the cleanups of every node as it connects. Call once from the module's start(). */
export function watchCleanups(deps: Pick<Deps, "db" | "agents" | "logger">): void {
  deps.agents.onConnection((nodeId, online) => {
    if (!online) return;
    // After the handshake: the session is registered but HelloAccepted is not sent yet.
    setTimeout(() => void runCleanups(deps, nodeId).catch((error) => deps.logger.error({ err: error }, "panel move cleanup failed")), 0);
  });
}
