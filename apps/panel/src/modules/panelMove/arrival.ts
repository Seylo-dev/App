// The moved panel's side. It starts from the copy the old panel shipped,
// which holds panelMoveArrival (snapshot.ts). It is a standby first: the
// job runner is held, every change is refused (reason "panelMoving") and
// agents' connects answer 503 like the old panel's at the switch, because
// the old panel is still the live one (the switch has not happened, or the
// move is being undone and this copy is about to be deleted). A node that
// loses the old panel and dials this address early so finds nothing here
// and goes back.
//
// The switch is the old panel's CommitMovedPanel on this node: the agent
// writes move-commit into this panel's data folder, holding the move id.
// The standby reads it about every second; once it names this panel's
// move it takes agents, and the first accepted session commits the
// arrival: panelMoveArrival becomes panelMoveDone, an audit row says so,
// the runner starts and the marker goes. Nodes that do not reconnect
// within 5 minutes get the usual offline alert then (alerts/events.ts holds
// those alerts back meanwhile).
//
// Then, once the old node is connected, the old panel is retired from here
// too (RetirePanel), in case it did not stop itself: it must never take
// agents again.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { auditLog, nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { nodeOfflineJobType } from "../alerts/events";
import { panelServiceId } from "../nodes/panel-service";
import { arrivalGraceMs, type PanelMoveDone } from "./keys";
import { setWritePause, writePause } from "./pause";

/** RetirePanel calls the moved panel makes on the old node before it gives up. */
const maxRetireTries = 5;

/** The marker CommitMovedPanel writes into the data folder (go/internal/update): the move id, nothing else. */
export const commitMarkerName = "move-commit";

/** How often the standby reads the marker. */
export const commitPollMs = 1000;

/** Old nodes with a RetirePanel call in flight, per panel. */
const retiring = new WeakMap<object, boolean>();

/** At start: standby until the switch is committed here; then the arrival on the first agent's connect. */
export function watchArrival(deps: Deps): void {
  const arrival = getSetting(deps.db, "panelMoveArrival");
  if (arrival) {
    setWritePause(deps.db, { reason: "moving", targetName: arrival.toNodeName, agentsClosed: true, arrivalMoveId: arrival.moveId });
    // Nothing runs yet at start, so this resolves at once; the main start then starts a held runner.
    void deps.jobControl?.hold();
    deps.logger.warn(
      { moveId: arrival.moveId, from: arrival.fromNodeId },
      "this panel was moved here; it takes agents once the old panel switched to it",
    );
    // At once too: a restart after the commit takes agents right away.
    if (!checkMoveCommit(deps)) {
      const timer = setInterval(() => {
        if (writePause(deps.db)?.arrivalMoveId !== arrival.moveId || checkMoveCommit(deps)) clearInterval(timer);
      }, commitPollMs);
      timer.unref?.();
    }
  } else {
    // Left by an arrival whose removal failed: it names no move of this panel any more.
    removeCommitMarker(deps);
  }
  deps.agents.onConnection((nodeId, online) => {
    if (!online) return;
    // Only once the switch was committed here; before, no agent gets this far (they get 503).
    if (getSetting(deps.db, "panelMoveArrival") && !writePause(deps.db)?.agentsClosed) commitArrival(deps, nodeId);
    const done = getSetting(deps.db, "panelMoveDone");
    // After the handshake (HelloAccepted goes out right after the connection listeners).
    if (done && !done.oldPanelRetired && deps.agents.isOnline(done.fromNodeId)) setTimeout(() => void retireOldPanel(deps), 0);
  });
}

/**
 * Reads the commit marker: when it names the move this standby waits for,
 * agents' connects are taken from now on (the writes stay refused until
 * the first agent commits the arrival). True once that happened.
 */
export function checkMoveCommit(deps: Pick<Deps, "db" | "config" | "logger">): boolean {
  const pause = writePause(deps.db);
  if (!pause?.arrivalMoveId) return true;
  if (!pause.agentsClosed) return true;
  let marker: string;
  try {
    marker = readFileSync(join(deps.config.dataDir, commitMarkerName), "utf8").trim();
  } catch {
    return false;
  }
  if (marker !== pause.arrivalMoveId) return false;
  setWritePause(deps.db, { ...pause, agentsClosed: false });
  deps.logger.info({ moveId: marker }, "the old panel switched to this one; taking agents");
  return true;
}

function removeCommitMarker(deps: Pick<Deps, "config" | "logger">): void {
  try {
    rmSync(join(deps.config.dataDir, commitMarkerName), { force: true });
  } catch (error) {
    deps.logger.warn({ err: error }, "could not remove the panel move's commit marker");
  }
}

/** The switch, seen from the moved panel: called once, for its first agent. */
export function commitArrival(deps: Deps, firstNodeId: string, now = Date.now()): PanelMoveDone | null {
  const arrival = getSetting(deps.db, "panelMoveArrival");
  if (!arrival) return null;
  const done: PanelMoveDone = {
    moveId: arrival.moveId,
    fromNodeId: arrival.fromNodeId,
    fromNodeName: arrival.fromNodeName,
    toNodeId: arrival.toNodeId,
    toNodeName: arrival.toNodeName,
    address: arrival.address,
    at: now,
    leftBehind: arrival.leftBehind,
    domain: arrival.domain,
    startedAt: arrival.startedAt,
  };
  deps.db.transaction((tx) => {
    const db = tx as unknown as Deps["db"];
    deleteSetting(db, "panelMoveArrival");
    setSetting(db, "panelMoveDone", done);
    tx.insert(auditLog)
      .values({
        at: new Date(now),
        actorType: "system",
        actorId: null,
        credentialId: null,
        actorLabel: "system",
        opId: "panelMove.arrived",
        targetType: null,
        targetId: null,
        targetLabel: null,
        projectId: null,
        transport: "http",
        input: { moveId: done.moveId, from: done.fromNodeId, to: done.toNodeId, firstNodeId, leftBehind: done.leftBehind },
        outcome: "ok",
        errorCode: null,
        durationMs: 0,
        ip: null,
        userAgent: null,
        approvalId: null,
      })
      .run();
  });
  if (writePause(deps.db)?.reason === "moving") setWritePause(deps.db, null);
  // The marker did its work; this panel is no standby any more.
  removeCommitMarker(deps);
  if (deps.jobControl?.held) deps.jobControl.release();
  // Nodes that are not back after the grace get the offline alert then; ones that come back sooner never do.
  const away = deps.db
    .select({ id: nodes.id })
    .from(nodes)
    .where(isNull(nodes.disabledAt))
    .all()
    .filter((row) => row.id !== firstNodeId && !deps.agents.isOnline(row.id));
  for (const row of away) {
    deps.jobs.enqueue(
      nodeOfflineJobType,
      { nodeId: row.id, since: String(now) },
      { runAt: new Date(now + arrivalGraceMs), dedupeKey: `node-offline:${row.id}` },
    );
  }
  deps.logger.info({ moveId: done.moveId, firstNodeId }, "the moved panel took over");
  deps.live.publish("panel", { type: "invalidate", ops: ["panelMove.status", "panelMove.check", "nodes.list"] });
  return done;
}

/**
 * RetirePanel on the old node, from the moved panel: the old panel stops
 * (or stays stopped) whatever it did itself. Never on this panel's own
 * node. A few tries, then the card says the old panel may still run.
 */
export async function retireOldPanel(deps: Pick<Deps, "db" | "agents" | "logger" | "live">): Promise<void> {
  const done = getSetting(deps.db, "panelMoveDone");
  if (!done || done.oldPanelRetired || done.oldCopyRemoved || (done.retireTries ?? 0) >= maxRetireTries) return;
  const here = deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id;
  if (here === done.fromNodeId || !deps.agents.supports(done.fromNodeId, "retirePanel") || retiring.get(deps.db)) return;
  retiring.set(deps.db, true);
  try {
    await deps.agents.call(done.fromNodeId, "retirePanel", { moveId: done.moveId, serviceId: panelServiceId }, { timeoutMs: 30_000 });
    const now = getSetting(deps.db, "panelMoveDone");
    if (now?.moveId === done.moveId) setSetting(deps.db, "panelMoveDone", { ...now, oldPanelRetired: true });
  } catch (error) {
    deps.logger.warn({ err: error, nodeId: done.fromNodeId }, "the old node did not take RetirePanel");
    const now = getSetting(deps.db, "panelMoveDone");
    if (now?.moveId === done.moveId) setSetting(deps.db, "panelMoveDone", { ...now, retireTries: (now.retireTries ?? 0) + 1 });
  } finally {
    retiring.delete(deps.db);
    deps.live.publish("panel", { type: "invalidate", ops: ["panelMove.status"] });
  }
}
