// Liveness and readiness for the container health check and the agent that
// runs the panel: answers only when the database responds.
//
// A moved panel that waits for its move's switch also answers "moveId"
// (modules/panelMove/arrival.ts): every node's StagePanelAddress probe
// requires it, so an address that reaches the old panel, which presents
// the same agents' TLS key on the same port, never passes. Once the commit
// marker of that move is in the data folder it answers "switched": true
// too, read on the spot: the old panel looks for it when the target's
// answer to CommitMovedPanel never came (modules/panelMove/probe.ts). This
// answer is served on the panel port and on the agents' TLS port alike.

import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Deps } from "../deps";
import { checkMoveCommit } from "../modules/panelMove/arrival";
import { arrivalMoveId } from "../modules/panelMove/pause";

export const healthPath = "/api/health";

export function health(deps: Pick<Deps, "db" | "config" | "logger">) {
  return new Elysia({ name: "health" }).get(healthPath, () => {
    const moveId = arrivalMoveId(deps.db);
    const move = moveId ? { moveId, ...(checkMoveCommit(deps) ? { switched: true } : {}) } : {};
    try {
      deps.db.get(sql`select 1`);
      return Response.json({ status: "ok", version: deps.config.version, ...move }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ status: "unavailable", version: deps.config.version, ...move }, { status: 503 });
    }
  });
}
