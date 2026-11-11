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
//     the new one it was given (agent-hub/endpoint.ts).
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
  /** Agents' connects answer 503 (the switch began, or this copy was left behind). */
  agentsClosed: boolean;
}

const pauses = new WeakMap<object, WritePause>();

/** Op ids that keep working while the panel moves. */
const allowedOps = new Set(["panelMove.cancel"]);

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
  return pause.reason === "moved"
    ? `The panel moved to ${pause.targetName}. Connect to its new address.`
    : `The panel is moving to ${pause.targetName}. Connect to its new address.`;
}

/** Joins wait while the panel moves: a node that joined now would be missing from the moved panel. */
export function joinsRefused(db: PanelDb): boolean {
  return pauses.has(db);
}
