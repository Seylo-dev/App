// panelMove.status, from whichever record says the most about now: the
// move running in memory, the old copy's panelMoveOut after a restart, the
// moved panel's panelMoveArrival (waiting for its first agent) or
// panelMoveDone, or the last failure. A failure newer than panelMoveDone
// wins only once that move's old copy is deleted (or its node removed):
// until then the done state stays, with the failure in `error`, so the card
// keeps Delete the old copy. People without settings.view get the state
// and the target's name only, for the banner.

import type { panelMove } from "@seylo/ops";
import { eq, inArray } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { newIpUrl, phaseStep } from "./orchestrator";
import "./keys";
import { activeMove } from "./state";

type Status = panelMove.PanelMoveStatus;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

const idle: Status = {
  state: "idle",
  side: null,
  moveId: null,
  targetNodeId: null,
  targetNodeName: null,
  targetAddress: null,
  newUrl: null,
  step: null,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: null,
  error: null,
  leftBehind: [],
  doneAt: null,
  fromNodeId: null,
  fromNodeName: null,
  oldCopyRemoved: false,
  domain: null,
  canCancel: false,
  waitingSince: null,
  canForceCancel: false,
  oldPanelRunning: false,
};

function named(deps: Pick<Deps, "db">, ids: readonly string[]): { id: string; name: string }[] {
  if (ids.length === 0) return [];
  const rows = deps.db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(inArray(nodes.id, [...ids]))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id) as string }));
}

/** The full status; `moveStatus` cuts it for people without settings.view. */
export function fullStatus(deps: Pick<Deps, "db" | "config" | "agents">): Status {
  const move = activeMove(deps.db);
  if (move) {
    const done = move.doneAt !== null;
    return {
      ...idle,
      state: done ? "done" : "running",
      side: done ? "old" : null,
      moveId: move.moveId,
      targetNodeId: move.targetNodeId,
      targetNodeName: move.targetNodeName,
      targetAddress: move.address,
      step: move.step,
      bytesDone: move.bytesDone,
      bytesTotal: move.bytesTotal,
      startedAt: iso(move.startedAt),
      leftBehind: move.leftBehind,
      doneAt: iso(move.doneAt),
      fromNodeId: move.fromNodeId,
      fromNodeName: move.fromNodeName,
      domain: move.domain,
      canCancel: !done && !move.switching && !move.abort.signal.aborted,
      oldPanelRunning: done && move.oldPanelRunning,
    };
  }
  const out = getSetting(deps.db, "panelMoveOut");
  if (out) {
    // Restarted after the move got past the point of no return: this is the old copy.
    return {
      ...idle,
      state: "done",
      side: "old",
      moveId: out.moveId,
      targetNodeId: out.targetNodeId,
      targetNodeName: out.targetNodeName,
      targetAddress: out.address,
      step: phaseStep(out.phase),
      startedAt: iso(out.startedAt),
      leftBehind: named(deps, out.leftBehind),
      doneAt: iso(out.at),
      fromNodeId: out.fromNodeId,
      fromNodeName: out.fromNodeName,
      domain: out.domain,
      oldPanelRunning: out.oldPanelRunning === true || out.phase !== "moved",
    };
  }
  const arrival = getSetting(deps.db, "panelMoveArrival");
  if (arrival) {
    return {
      ...idle,
      state: "running",
      moveId: arrival.moveId,
      targetNodeId: arrival.toNodeId,
      targetNodeName: arrival.toNodeName,
      targetAddress: arrival.address,
      step: "switching",
      startedAt: iso(arrival.startedAt),
      leftBehind: named(deps, arrival.leftBehind),
      fromNodeId: arrival.fromNodeId,
      fromNodeName: arrival.fromNodeName,
      domain: arrival.domain,
    };
  }
  const done = getSetting(deps.db, "panelMoveDone");
  const failure = getSetting(deps.db, "panelMoveFailure");
  const failed = failure ? { step: failure.step, message: failure.message } : null;
  // A later move that failed never hides an old copy that is still on its server: the done state stays
  // (Delete the old copy), with that failure in `error`.
  const oldCopyLeft = done !== undefined && !done.oldCopyRemoved && nodeExists(deps, done.fromNodeId);
  if (failure && (!done || failure.at > done.at) && !oldCopyLeft) {
    return {
      ...idle,
      state: "failed",
      moveId: failure.moveId,
      targetNodeId: failure.targetNodeId,
      targetNodeName: failure.targetNodeName,
      targetAddress: failure.address,
      step: failure.step,
      startedAt: iso(failure.startedAt),
      error: failed,
    };
  }
  if (done) {
    // Nodes left behind that came back since need nothing any more.
    const seen = new Map(
      deps.db
        .select({ id: nodes.id, lastSeenAt: nodes.lastSeenAt })
        .from(nodes)
        .all()
        .map((row) => [row.id, row.lastSeenAt?.getTime() ?? 0]),
    );
    const still = done.leftBehind.filter((id) => !deps.agents.isOnline(id) && (seen.get(id) ?? 0) < done.at);
    return {
      ...idle,
      state: "done",
      side: "new",
      moveId: done.moveId,
      targetNodeId: done.toNodeId,
      targetNodeName: done.toNodeName,
      targetAddress: done.address,
      startedAt: iso(done.startedAt),
      leftBehind: named(deps, still),
      doneAt: iso(done.at),
      fromNodeId: done.fromNodeId,
      fromNodeName: done.fromNodeName,
      oldCopyRemoved: done.oldCopyRemoved === true,
      domain: done.domain,
      oldPanelRunning: !done.oldPanelRetired && !done.oldCopyRemoved && (done.retireTries ?? 0) >= 5,
      error: failure && failure.at > done.at ? failed : null,
    };
  }
  return idle;
}

function nodeExists(deps: Pick<Deps, "db">, nodeId: string): boolean {
  return deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).get() !== undefined;
}

/** panelMove.status for a caller; without settings.view only what the banner shows. */
export function moveStatus(deps: Pick<Deps, "db" | "config" | "agents">, full: boolean): Status {
  const found = fullStatus(deps);
  const status = { ...found, newUrl: found.targetAddress ? newIpUrl(deps, found.targetAddress) : null };
  if (full) return status;
  return {
    ...idle,
    state: status.state,
    side: status.side,
    step: status.step,
    targetNodeName: status.targetNodeName,
    startedAt: status.startedAt,
    // The old copy says where everyone finds the panel now.
    newUrl: status.side === "old" ? status.newUrl : null,
  };
}
