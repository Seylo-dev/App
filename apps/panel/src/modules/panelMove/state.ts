// The move that runs on this panel right now, in memory (keyed by the
// panel's database like the other module state). Nothing of it is in
// panel.db before the copy is made, so the moved panel never finds a
// "running" move of its own; what has to survive a restart of the old
// panel is in panelMoveOut (keys.ts).

import type { panelMove } from "@seylo/ops";
import type { PanelDb } from "../../db/client";

export interface RunningMove {
  moveId: string;
  targetNodeId: string;
  targetNodeName: string;
  /** Host or IP nodes reach the moved panel at (no brackets for IPv6). */
  address: string;
  fromNodeId: string;
  fromNodeName: string;
  domain: string | null;
  /** Nodes that follow on their own: told the new address before the switch. */
  follow: string[];
  /** Nodes that cannot follow (the owner accepted it), with names for the result. */
  leftBehind: { id: string; name: string }[];
  startedAt: number;
  step: panelMove.PanelMoveStep;
  bytesDone: number;
  bytesTotal: number;
  /** The owner cancelled, or the move failed: everything still running stops. */
  readonly abort: AbortController;
  /**
   * CommitMovedPanel was sent: the target may have taken the switch, so only
   * a definite refusal or a forced cancel undoes the move from here.
   */
  committing: boolean;
  /** Epoch ms the first CommitMovedPanel failed without a definite answer; null while none did. */
  waitingSince: number | null;
  /** From the switch on the move can no longer be undone. */
  switching: boolean;
  /** Nodes that hold the staged address of this move. */
  readonly staged: Set<string>;
  /** Releases the hold on desired-state sends to the target (set while the moved panel starts there). */
  releaseTarget?: () => void;
  /** Set when the switch finished from this panel's side. */
  doneAt: number | null;
  /** The old node's agent did not confirm it stops this panel. */
  oldPanelRunning: boolean;
  /** Who started it, for the audit rows the move writes itself. */
  by: string;
}

/** How long the target may leave the switch unconfirmed before panelMove.cancel takes force: true. */
export const forceCancelAfterMs = 10 * 60_000;

/** panelMove.cancel with force: true may undo this move now. */
export function canForceCancel(move: RunningMove, now = Date.now()): boolean {
  return (
    move.committing &&
    !move.switching &&
    !move.abort.signal.aborted &&
    move.waitingSince !== null &&
    now - move.waitingSince >= forceCancelAfterMs
  );
}

const moves = new WeakMap<object, RunningMove>();

export function activeMove(db: PanelDb): RunningMove | null {
  return moves.get(db) ?? null;
}

export function setActiveMove(db: PanelDb, move: RunningMove | null): void {
  if (move) moves.set(db, move);
  else moves.delete(db);
}
