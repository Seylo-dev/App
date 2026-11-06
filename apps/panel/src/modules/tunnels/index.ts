// Tunnels: Cloudflare Tunnel per service (quick trycloudflare.com or token
// mode) and the global tunnel token. The agent runs cloudflared and reports
// a quick tunnel's URL; a minute job turns quick tunnels off when they end.

import { tunnels as tunnelOps } from "@seylo/ops";
import type { ServiceStatus } from "@seylo/proto";
import { and, eq, lte } from "drizzle-orm";
import { cloudflareTunnels } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { invalidateService } from "../domains/lookup";
import { defineModule } from "../module";
import { get, getSettings, set, setSettings } from "./ops";
import "./settings";

const expireType = "tunnels.expire";

/** Turns off quick tunnels past their end, so the next desired state stops cloudflared. */
export function expireTunnels(deps: Pick<Deps, "db" | "agents" | "live">, now = new Date()): number {
  const ended = deps.db
    .update(cloudflareTunnels)
    .set({ enabled: false, url: null })
    .where(and(eq(cloudflareTunnels.enabled, true), lte(cloudflareTunnels.expiresAt, now)))
    .returning({ serviceId: cloudflareTunnels.serviceId })
    .all();
  for (const row of ended) {
    deps.agents.desired.markDirty({ serviceId: row.serviceId });
    invalidateService(deps, row.serviceId, [tunnelOps.get.id]);
  }
  return ended.length;
}

/** Stores the URL a quick tunnel reported, so it shows while the node state is not loaded. */
function recordTunnelUrl(deps: Deps, status: ServiceStatus) {
  if (!status.tunnelUrl) return;
  const row = deps.db.select().from(cloudflareTunnels).where(eq(cloudflareTunnels.serviceId, status.serviceId)).get();
  if (!row?.enabled || row.mode !== "quick" || row.url === status.tunnelUrl) return;
  deps.db.update(cloudflareTunnels).set({ url: status.tunnelUrl }).where(eq(cloudflareTunnels.serviceId, status.serviceId)).run();
  invalidateService(deps, status.serviceId, [tunnelOps.get.id]);
}

const expire = defineJob({
  type: expireType,
  maxAttempts: 1,
  run: async (_payload, ctx) => {
    expireTunnels(ctx);
  },
});

export default defineModule({
  name: "tunnels",
  ops: [get, set, getSettings, setSettings],
  jobs: [expire],
  start(deps) {
    deps.schedules.ensure({ key: expireType, jobType: expireType, intervalSeconds: 60 });
    deps.agents.state.onChange((nodeId, change) => {
      const view = deps.agents.state.get(nodeId);
      if (!view) return;
      const statuses =
        change.kind === "snapshot"
          ? [...view.services.values()]
          : change.kind === "service" && !change.removed
            ? [view.services.get(change.serviceId)]
            : [];
      for (const status of statuses) if (status) recordTunnelUrl(deps, status);
    });
  },
});
