// Moving the panel to another node (added in 0.2.8). The old panel runs the
// move (orchestrator.ts) with writes paused (pause.ts); the copy it ships
// is made and edited in snapshot.ts; the moved panel takes over on its first
// agent (arrival.ts); a restart of the old panel in the middle is handled by
// recover.ts and undo work that waits for a node by cleanup.ts.
// Contracts: packages/ops/src/ops/panelMove.ts.

import type { Deps } from "../../deps";
import { defineModule } from "../module";
import { watchArrival } from "./arrival";
import { watchCleanups } from "./cleanup";
import { panelMoveHandlers } from "./ops";
import { recoverMoveOut, removeWorkDirs } from "./recover";

function start(deps: Deps) {
  removeWorkDirs(deps.config.dataDir, deps.logger);
  recoverMoveOut(deps);
  watchArrival(deps);
  watchCleanups(deps);
}

export default defineModule({ name: "panelMove", ops: panelMoveHandlers, start });
