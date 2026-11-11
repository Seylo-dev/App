// The write pause of a panel move. While it is on, the panel only reads:
//
//   - every mutation and destructive op answers CONFLICT, details.reason
//     "panelMoving" (or "panelMoved" on a copy a move left behind), except
//     panelMove.cancel (ops/pipeline.ts asks pauseRefusal);
//   - module HTTP endpoints that change things (webhooks, deploy trigger
//     URLs, uploads) answer 503 (panel.ts);
//   - agents' durable reports answer UNAVAILABLE, so they stay in the
//     agents' outboxes and reach whichever panel the agent talks to next
//     instead of a database that was copied already (agent-hub/panel-service.ts);
//   - joins are closed without a rejection (a rejection makes an agent wait
//     5 minutes; a closed socket is retried with backoff), because a node
//     joined now would be missing from the copy (agent-hub/session.ts);
//   - at the switch, and on a copy left behind, agents' connects answer 503
//     before the handshake, so every node gives up on this address and dials
//     the new one it was given (agent-hub/endpoint.ts). The moved panel does
//     the same while it waits for the switch (arrival.ts), so a node that
//     dials it early comes back to the old panel.
//
// The gate only stops changes that start after it: an op or a webhook that
// passed it a moment before may still be awaiting an agent or a provider
// before it writes. Both count themselves as writes in flight (beginWrite,
// from ops/pipeline.ts and panel.ts) and the move waits for them
// (writesSettled) before it copies the database.
//
// The job runner is held separately (Deps.jobControl). State is per panel,
// keyed by its database like the other module state, so the tailnet
// listener's deps (which share it) see the same pause.

import { OpError } from "@seylo/ops";
import type { PanelDb } from "../../db/client";

export interface WritePause {
  /** "moving": a move runs, or the moved panel waits for its first agent; "moved": this copy was left behind by a move. */
  reason: "moving" | "moved";
  /** The node the panel moves (or moved) to, for the messages. */
  targetName: string;
  /** "moved": where the panel answers now ("http://203.0.113.20:3000"), when known. */
  newUrl?: string | null;
  /** Agents' connects answer 503 (the switch began, this copy was left behind, or the moved copy waits for the switch). */
  agentsClosed: boolean;
  /**
   * Set on the moved panel while it waits as the copy of this move (until
   * its first agent): /api/health answers it as "moveId", which every
   * node's StagePanelAddress probe requires, so an address that reaches the
   * old panel (same key, same port) never passes.
   */
  arrivalMoveId?: string;
}

const pauses = new WeakMap<object, WritePause>();

interface Writes {
  count: number;
  waiters: (() => void)[];
}

const writes = new WeakMap<object, Writes>();

/**
 * Op ids that keep working while the panel moves: the cancel, and signing
 * in and out, since the owner may need a fresh session to cancel a switch
 * the target never confirmed (that wait has no end of its own). A session
 * made after the copy exists only here; on the moved panel people sign in
 * again.
 */
const allowedOps = new Set([
  "panelMove.cancel",
  "auth.login",
  "auth.verifySecondFactor",
  "auth.passkeyLoginBegin",
  "auth.passkeyLoginFinish",
  "auth.githubStart",
  "auth.githubPoll",
  "auth.logout",
]);

export function setWritePause(db: PanelDb, pause: WritePause | null): void {
  if (pause) pauses.set(db, pause);
  else pauses.delete(db);
}

export function writePause(db: PanelDb): WritePause | null {
  return pauses.get(db) ?? null;
}

export function writesPaused(db: PanelDb): boolean {
  return pauses.has(db);
}

/** The message every refused change gets. */
export function pauseMessage(pause: WritePause): string {
  if (pause.reason === "moved") {
    return `The panel moved to ${pause.targetName}${pause.newUrl ? ` and answers at ${pause.newUrl}` : ""}. This is the old copy: it takes no changes. Open the panel there.`;
  }
  return `The panel is moving to ${pause.targetName}. Try again in a few minutes.`;
}

/** The CONFLICT a change gets while the panel moves, or null when it may run. */
export function pauseRefusal(db: PanelDb, opId: string): OpError | null {
  const pause = pauses.get(db);
  if (!pause) return null;
  if (pause.reason === "moving" && allowedOps.has(opId)) return null;
  return new OpError("CONFLICT", pauseMessage(pause), { reason: pause.reason === "moved" ? "panelMoved" : "panelMoving" });
}

/** Why agents' connects answer 503 right now, or null when they are taken. */
export function agentsRefused(db: PanelDb): string | null {
  const pause = pauses.get(db);
  if (!pause?.agentsClosed) return null;
  if (pause.arrivalMoveId) {
    return "This is the moved copy of the panel and the move has not switched to it yet. Connect to the panel's current address.";
  }
  return pause.reason === "moved"
    ? `The panel moved to ${pause.targetName}. Connect to its new address.`
    : `The panel is moving to ${pause.targetName}. Connect to its new address.`;
}

/** The move this panel waits for as its moved copy, for /api/health; null otherwise. */
export function arrivalMoveId(db: PanelDb): string | null {
  return pauses.get(db)?.arrivalMoveId ?? null;
}

/**
 * Counts a change that passed the gate until the returned function runs
 * (once; later calls do nothing). Every op that is not a query and every
 * module endpoint that writes counts itself, paused or not.
 */
export function beginWrite(db: PanelDb): () => void {
  const state = writes.get(db) ?? { count: 0, waiters: [] };
  writes.set(db, state);
  state.count += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    state.count -= 1;
    if (state.count > 0) return;
    const waiting = state.waiters;
    state.waiters = [];
    for (const resolve of waiting) resolve();
  };
}

/** Changes that passed the gate and have not finished yet. */
export function writesInFlight(db: PanelDb): number {
  return writes.get(db)?.count ?? 0;
}

/** Resolves once no change that passed the gate is still running. */
export function writesSettled(db: PanelDb): Promise<void> {
  const state = writes.get(db);
  if (!state || state.count === 0) return Promise.resolve();
  return new Promise((resolve) => state.waiters.push(resolve));
}

/** Joins wait while the panel moves: a node that joined now would be missing from the moved panel. */
export function joinsRefused(db: PanelDb): boolean {
  return pauses.has(db);
}
