// Liveness and readiness for the container health check and the agent that
// runs the panel: answers only when the database responds.

import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Deps } from "../deps";

export const healthPath = "/api/health";

export function health(deps: Pick<Deps, "db" | "config">) {
  return new Elysia({ name: "health" }).get(healthPath, () => {
    try {
      deps.db.get(sql`select 1`);
      return Response.json({ status: "ok", version: deps.config.version }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ status: "unavailable", version: deps.config.version }, { status: 503 });
    }
  });
}
