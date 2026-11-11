// The old panel's start after a move it was running ended with it (a crash,
// a restart, the old node's agent stopping it at the switch). panelMoveOut
// says how far the move got:
//
//   registry, shipping,  no node knows the new address: nothing switched.
//   starting
//                        The target may hold a staged copy or a started
//                        panel; it gets AbortMovedPanel when it is back
//                        (cleanup.ts). The panel carries on as before and
//                        the card shows the failure.
//   staging and later    nodes may have switched to the moved panel on
//                        their own the moment this one went away: two live
//                        panels would split the fleet. This copy stays
//                        retired: agents' connects answer 503 (every node
//                        that knows the new address goes there), changes
//                        are refused and no job runs.
//
// Also deletes work folders a move left in the data folder (they hold a
// copy of the databases and the archive with master.key).

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../../deps";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { addCleanup } from "./cleanup";
import { newIpUrl, phaseStep, writeMoveAudit } from "./orchestrator";
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

/** Reads panelMoveOut at start and puts the panel in the state it says. */
export function recoverMoveOut(deps: Deps, now = Date.now()): "none" | "undone" | "retired" {
  const out = getSetting(deps.db, "panelMoveOut");
  if (!out) return "none";
  if (out.phase === "registry" || out.phase === "shipping" || out.phase === "starting") {
    addCleanup(deps, { moveId: out.moveId, abortNodeId: out.targetNodeId, clearNodeIds: [], at: now });
    setSetting(deps.db, "panelMoveFailure", {
      moveId: out.moveId,
      targetNodeId: out.targetNodeId,
      targetNodeName: out.targetNodeName,
      address: out.address,
      step: phaseStep(out.phase),
      message: "The panel restarted while it moved, before any node knew the new address. Nothing changed; try again.",
      startedAt: out.startedAt,
      at: now,
    });
    deleteSetting(deps.db, "panelMoveOut");
    writeMoveAudit(
      deps,
      "panelMove.failed",
      { moveId: out.moveId, to: out.targetNodeId, step: phaseStep(out.phase), reason: "restarted" },
      "CONFLICT",
    );
    deps.logger.warn({ moveId: out.moveId }, "a panel move ended with a restart of the panel; undoing it on the target when it is back");
    return "undone";
  }
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
