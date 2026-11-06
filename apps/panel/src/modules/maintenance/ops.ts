// Maintenance op handlers: panel-wide maintenance with the global page,
// per-service maintenance with its own page, and a preview of what
// visitors see. Changes reach the nodes' edge right away, without a deploy.

import { maintenance as maintenanceOps, OpError } from "@seylo/ops";
import { maintenancePages } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { setSetting } from "../../settings";
import { getService, invalidateService } from "../domains/lookup";
import { effectivePage, globalMaintenanceState, servicePageRow } from "./page";

function globalView(ctx: OpContext) {
  const state = globalMaintenanceState(ctx.db);
  return { enabled: state.enabled, message: state.message, html: state.html, updatedAt: state.updatedAt?.toISOString() ?? null };
}

function serviceView(ctx: OpContext, serviceId: string) {
  const row = servicePageRow(ctx.db, serviceId);
  const global = globalMaintenanceState(ctx.db);
  return {
    serviceId,
    enabled: row?.enabled ?? false,
    message: row?.message ?? "",
    html: row?.html ?? null,
    pageSource: effectivePage(ctx.db, serviceId).source,
    globalEnabled: global.enabled,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export const getGlobal = implement(maintenanceOps.getGlobal, (_input, ctx) => globalView(ctx));

export const setGlobal = implement(maintenanceOps.setGlobal, (input, ctx) => {
  const current = globalMaintenanceState(ctx.db);
  setSetting(ctx.db, "maintenanceGlobal", {
    enabled: input.enabled ?? current.enabled,
    message: input.message ?? current.message,
    html: input.html === undefined ? current.html : input.html,
    updatedAt: Date.now(),
  });
  // Every node's settings and every service page that falls back to the global page change.
  ctx.agents.desired.markDirty({ all: true });
  ctx.live.publish("panel", { type: "invalidate", ops: [maintenanceOps.getGlobal.id, maintenanceOps.get.id, maintenanceOps.preview.id] });
  return globalView(ctx);
});

export const get = implement(maintenanceOps.get, (input, ctx) => {
  getService(ctx.db, input.serviceId);
  return serviceView(ctx, input.serviceId);
});

export const set = implement(maintenanceOps.set, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  if (service.protected && input.enabled) {
    throw new OpError("BAD_REQUEST", "The panel's own services are never put in maintenance.", { field: "enabled" });
  }
  const current = servicePageRow(ctx.db, service.id);
  const values = {
    enabled: input.enabled ?? current?.enabled ?? false,
    message: input.message ?? current?.message ?? "",
    html: input.html === undefined ? (current?.html ?? null) : input.html,
    updatedAt: new Date(),
  };
  ctx.db
    .insert(maintenancePages)
    .values({ serviceId: service.id, ...values })
    .onConflictDoUpdate({ target: maintenancePages.serviceId, set: values })
    .run();
  ctx.agents.desired.markDirty({ serviceId: service.id });
  invalidateService(ctx, service.id, [maintenanceOps.get.id, maintenanceOps.preview.id]);
  return serviceView(ctx, service.id);
});

export const preview = implement(maintenanceOps.preview, (input, ctx) => {
  if (input.serviceId) {
    getService(ctx.db, input.serviceId);
    if (!ctx.access.can("services.view", { type: "service", id: input.serviceId })) {
      throw new OpError("FORBIDDEN", "You do not have the services.view permission here.", { action: "services.view" });
    }
  }
  return { html: effectivePage(ctx.db, input.serviceId ?? null).html };
});
