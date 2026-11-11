// Settings keys of a panel move (declared by augmenting SettingValues, as
// src/settings.ts describes). Which database holds which matters, because
// the moved panel starts from a copy of panel.db:
//
//   panelMoveArrival  written into the COPY only: the moved panel waits for
//                     the switch and its first agent, then turns it into
//                     panelMoveDone (arrival.ts).
//   panelMoveDone     the moved panel: the result card and "Delete the old
//                     copy". While its old copy is not deleted (and its node
//                     still exists) no other move starts (oldCopyLeft), so
//                     dropping it from the next copy loses nothing.
//   panelMoveOut      the OLD panel.db only (the offline edit drops it from
//                     the copy): how far the move got, so a restart of the old
//                     panel mid-move neither runs a second live panel next
//                     to the moved one nor forgets to clean up the target.
//   panelMoveCleanups undo work of failed moves that waits for a node to
//                     come back (a staged copy on the target, a staged
//                     address on a node). The copy keeps it: once the old
//                     panel is retired only the moved one can finish it.
//   panelMoveFailure  the old panel.db: the last failed move, for the card.
//
// None holds a secret. The offline edit (snapshot.ts) removes every one of
// them from the copy except panelMoveCleanups and the new panelMoveArrival.

import type { panelMove } from "@seylo/ops";

export interface PanelMoveArrival {
  moveId: string;
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  /** Host or IP nodes reach the moved panel at. */
  address: string;
  /** Epoch ms the copy was made. */
  at: number;
  /** Nodes that could not follow (the owner ticked that they join them again). */
  leftBehind: string[];
  /** The panel domain at the time, whose DNS record must point at `address`. */
  domain: string | null;
  /** Epoch ms the move started. */
  startedAt: number;
}

export interface PanelMoveDone {
  moveId: string;
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  address: string;
  /** Epoch ms the moved panel took over (its first agent connected). */
  at: number;
  leftBehind: string[];
  domain: string | null;
  startedAt: number;
  /** The old server's stopped copy was deleted (removeOldCopy). */
  oldCopyRemoved?: boolean;
  freedBytes?: number;
  /** The old node's agent confirmed the old panel is stopped (RetirePanel), from either panel. */
  oldPanelRetired?: boolean;
  /** RetirePanel calls the moved panel made that failed; it stops trying after a few. */
  retireTries?: number;
}

export type PanelMoveOutPhase = "registry" | "shipping" | "starting" | "staging" | "committing" | "aborting" | "switching" | "moved";

export interface PanelMoveOut {
  moveId: string;
  targetNodeId: string;
  targetNodeName: string;
  address: string;
  fromNodeId: string;
  fromNodeName: string;
  /**
   * registry, shipping, starting, staging, aborting: nothing is committed
   * (the moved panel takes no agent before CommitMovedPanel), so a restart
   * here undoes the move (the target and the staged nodes when they are
   * back) and carries on as before. committing: CommitMovedPanel was sent
   * and may have landed, so a restart sends it again until the target
   * answers. switching and moved: past the point of no return, a restarted
   * old panel stays retired (it takes no agents and no changes) and the
   * move ends on the new one.
   */
  phase: PanelMoveOutPhase;
  /** Nodes that may hold the new address: every node a StagePanelAddress went to, before it was sent. */
  staged: string[];
  leftBehind: string[];
  domain: string | null;
  startedAt: number;
  at: number;
  /** Who started it, for the audit rows after a restart. */
  by?: string;
  /** phase committing: epoch ms the first CommitMovedPanel failed without a definite answer. */
  waitingSince?: number;
  /** phase aborting: the step that failed and why, for the card after a restart. */
  abortStep?: panelMove.PanelMoveStep;
  abortMessage?: string;
  /** phase "moved": the old node's agent did not confirm that it stops this panel. */
  oldPanelRunning?: boolean;
}

export interface PanelMoveCleanup {
  moveId: string;
  /** The move's target still has to drop its staged copy (AbortMovedPanel); null once it did. */
  abortNodeId: string | null;
  /** Nodes that still have to forget the staged address (ClearPanelAddress). */
  clearNodeIds: string[];
  /** Epoch ms; entries are dropped after cleanupKeepMs. */
  at: number;
}

export interface PanelMoveFailure {
  moveId: string;
  targetNodeId: string;
  targetNodeName: string;
  address: string;
  step: panelMove.PanelMoveStep;
  message: string;
  startedAt: number;
  at: number;
}

declare module "../../settings" {
  interface SettingValues {
    panelMoveArrival: PanelMoveArrival;
    panelMoveDone: PanelMoveDone;
    panelMoveOut: PanelMoveOut;
    panelMoveCleanups: PanelMoveCleanup[];
    panelMoveFailure: PanelMoveFailure;
  }
}

/** How long a cleanup waits for its nodes to come back before it is dropped. */
export const cleanupKeepMs = 7 * 24 * 60 * 60 * 1000;

/** Nodes that reconnect within this time after the moved panel took over raise no offline alert. */
export const arrivalGraceMs = 5 * 60 * 1000;
