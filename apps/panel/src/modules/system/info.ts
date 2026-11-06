import { system } from "@seylo/ops";
import { count } from "drizzle-orm";
import { nodes } from "../../db/schema";
import { implement } from "../../ops/implement";
import { readPanelName } from "../settings/keys";

export const info = implement(system.info, (_input, ctx) => {
  const total = ctx.db.select({ n: count() }).from(nodes).get()?.n ?? 0;
  return {
    name: readPanelName(ctx.db),
    version: ctx.config.version,
    panelId: ctx.panelId,
    startedAt: ctx.startedAt.toISOString(),
    nodes: { total, online: ctx.agents.onlineNodeIds().length },
  };
});
