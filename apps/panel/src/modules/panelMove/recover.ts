// The old panel's start after a move it was running ended with it (a crash,
// a restart, the old node's agent stopping it at the switch). panelMoveOut
// says how far the move got:
//
//   registry, shipping,  nothing is committed: the moved panel takes no
//   starting, staging,   agent before CommitMovedPanel, so no node can be
//   aborting             on it. The move is undone: the target gets
//                        AbortMovedPanel and every node that may hold the
//                        new address ClearPanelAddress when they are back
//                        (cleanup.ts). The panel carries on as before and
//                        the card shows the failure.
//   committing           CommitMovedPanel was sent and may have landed:
//                        the panel is read-only again and sends it again
//                        until the target answers, then switches, as the
//                        move would have (orchestrator.ts resumeCommit).
//   switching, moved     past the point of no return: nodes may be on the
//                        moved panel already, and two live panels would
//                        split the fleet. This copy stays retired: agents'
//                        connects answer 503 (every node that knows the new
//                        address goes there), changes are refused and no
//                        job runs.
//
// Also deletes work folders a move left in the data folder (they hold a
// copy of the databases and the archive with master.key).

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../../deps";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { writeMoveAudit } from "./audit";
import { addCleanup } from "./cleanup";
import type { PanelMoveOut } from "./keys";
import { newIpUrl, phaseStep, resumeCommit } from "./orchestrator";
import { setWritePause } from "./pause";

/** Removes `.move-<id>` folders a move left in the data folder. */
export function removeWorkDirs(dataDir: string, logger: Deps["logger"]): void {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\.move-[a-z0-9]{16}$/.test(name)) continue;
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true });
      logger.info({ folder: name }, "removed the work folder of a panel move that ended with the panel");
    } catch (error) {
      logger.warn({ err: error, folder: name }, "could not remove the work folder of a panel move");
    }
  }
}

/** What the card says about a move a restart undid. */
function restartMessage(out: PanelMoveOut): string {
  if (out.phase === "aborting" && out.abortMessage) return out.abortMessage;
  if (out.phase === "staging") {
    return "The panel restarted while it told the nodes the new address, before the switch. The move was undone and nothing changed; try again.";
  }
  return "The panel restarted while it moved, before the switch. Nothing changed; try again.";
}

/** Reads panelMoveOut at start and puts the panel in the state it says. */
export function recoverMoveOut(deps: Deps, now = Date.now()): "none" | "undone" | "resumed" | "retired" {
  const out = getSetting(deps.db, "panelMoveOut");
  if (!out) return "none";
  if (out.phase === "committing") {
    resumeCommit(deps, out);
    return "resumed";
  }
  if (out.phase === "switching" || out.phase === "moved") {
    setWritePause(deps.db, {
      reason: "moved",
      targetName: out.targetNodeName,
      newUrl: out.domain ? `https://${out.domain}` : newIpUrl(deps, out.address),
      agentsClosed: true,
    });
    void deps.jobControl?.hold();
    deps.logger.warn(
      { moveId: out.moveId, to: out.targetNodeId, phase: out.phase },
      "this panel was moved to another node and is the old copy: it takes no agents and no changes",
    );
    return "retired";
  }
  // Nothing was committed: undo it on the target and on every node that may hold the address, as each is back.
  const step = phaseStep(out);
  const message = restartMessage(out);
  addCleanup(deps, { moveId: out.moveId, abortNodeId: out.targetNodeId, clearNodeIds: out.staged, at: now });
  setSetting(deps.db, "panelMoveFailure", {
    moveId: out.moveId,
    targetNodeId: out.targetNodeId,
    targetNodeName: out.targetNodeName,
    address: out.address,
    step,
    message,
    startedAt: out.startedAt,
    at: now,
  });
  deleteSetting(deps.db, "panelMoveOut");
  writeMoveAudit(
    deps,
    "panelMove.failed",
    { moveId: out.moveId, to: out.targetNodeId, step, reason: "restarted", ...(out.by ? { by: out.by } : {}) },
    "CONFLICT",
  );
  deps.logger.warn(
    { moveId: out.moveId, phase: out.phase },
    "a panel move ended with a restart of the panel before its switch; undoing it on the nodes when they are back",
  );
  return "undone";
}
