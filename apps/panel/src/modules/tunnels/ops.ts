// Tunnel op handlers: turn a service's Cloudflare tunnel on or off (quick
// trycloudflare.com URLs that end on their own, or token mode for a
// permanent hostname) and the global tunnel token.

import { OpError, tunnels as tunnelOps } from "@seylo/ops";
import { and, eq, isNull } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { cloudflareTunnels, settings } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { getSetting, setSetting } from "../../settings";
import { getService, invalidateService, mainPort } from "../domains/lookup";
import { effectiveToken, quickTunnelMinutes, tunnelRow, tunnelView } from "./logic";

function settingsView(ctx: OpContext) {
  const value = getSetting(ctx.db, "cloudflareTunnelToken");
  return { tokenSet: !!value, updatedAt: value ? new Date(value.updatedAt).toISOString() : null };
}

export const get = implement(tunnelOps.get, (input, ctx) => tunnelView(ctx, input.serviceId));

export const set = implement(tunnelOps.set, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const current = tunnelRow(ctx.db, service.id);
  const mode = input.mode ?? current?.mode ?? "quick";
  const targetPort = input.targetPort ?? current?.targetPort ?? mainPort(service);
  if (targetPort === null) {
    throw new OpError("BAD_REQUEST", `${service.name} has no port yet. Pass targetPort.`, { field: "targetPort" });
  }
  const tokenSealed =
    input.token === undefined
      ? (current?.tokenSealed ?? null)
      : input.token === null
        ? null
        : ctx.secrets.seal(input.token, "cloudflare.tunnel");
  // The global token is the owner's tunnel: only people who manage settings may run a service on it.
  const mayUseGlobal = ctx.access.can("settings.edit");
  if (input.enabled && mode === "token" && !effectiveToken(ctx, { tokenSealed }, { mayUseGlobal }).token) {
    throw new OpError(
      "BAD_REQUEST",
      mayUseGlobal
        ? "Token mode needs a Cloudflare tunnel token: pass one, or set the global token in Settings."
        : "Token mode needs this service's own Cloudflare tunnel token; only admins can use the panel's global one.",
      { field: "token" },
    );
  }
  if (input.enabled && mode === "token" && !tokenSealed) {
    // One cloudflared per tunnel: a second service on the global token would share its traffic.
    const others = ctx.db
      .select({ serviceId: cloudflareTunnels.serviceId })
      .from(cloudflareTunnels)
      .where(and(eq(cloudflareTunnels.enabled, true), eq(cloudflareTunnels.mode, "token"), isNull(cloudflareTunnels.tokenSealed)))
      .all()
      .filter((r) => r.serviceId !== service.id);
    if (others.length > 0) {
      throw new OpError("CONFLICT", "Another service already runs on the global tunnel token. Give this one its own token.", {
        field: "token",
        reason: "globalTokenInUse",
      });
    }
  }
  const restartQuick =
    input.enabled && mode === "quick" && (!current?.enabled || current.mode !== "quick" || input.durationMinutes !== undefined);
  const values = {
    enabled: input.enabled,
    mode,
    targetPort,
    tokenSealed,
    hostname: input.hostname === undefined ? (current?.hostname ?? null) : input.hostname,
    // A quick tunnel gets a new URL on every start and ends on its own.
    url: restartQuick || !input.enabled ? null : (current?.url ?? null),
    expiresAt:
      !input.enabled || mode === "token"
        ? null
        : restartQuick
          ? new Date(Date.now() + (input.durationMinutes ?? quickTunnelMinutes) * 60_000)
          : (current?.expiresAt ?? null),
    updatedBy: userOf(ctx.principal)?.id ?? null,
    updatedAt: new Date(),
  };
  ctx.db
    .insert(cloudflareTunnels)
    .values({ serviceId: service.id, ...values })
    .onConflictDoUpdate({ target: cloudflareTunnels.serviceId, set: values })
    .run();
  ctx.agents.desired.markDirty({ serviceId: service.id });
  invalidateService(ctx, service.id, [tunnelOps.get.id]);
  return tunnelView(ctx, service.id);
});

export const getSettings = implement(tunnelOps.getSettings, (_input, ctx) => settingsView(ctx));

export const setSettings = implement(tunnelOps.setSettings, (input, ctx) => {
  if (input.token === null) {
    // The settings helper has no delete; the row is this module's own key.
    ctx.db.delete(settings).where(eq(settings.key, "cloudflareTunnelToken")).run();
  } else {
    setSetting(ctx.db, "cloudflareTunnelToken", { tokenSealed: ctx.secrets.seal(input.token, "cloudflare.tunnel"), updatedAt: Date.now() });
  }
  // Token-mode tunnels without their own token run with the global one.
  const users = ctx.db
    .select({ serviceId: cloudflareTunnels.serviceId })
    .from(cloudflareTunnels)
    .where(and(eq(cloudflareTunnels.enabled, true), eq(cloudflareTunnels.mode, "token"), isNull(cloudflareTunnels.tokenSealed)))
    .all();
  for (const row of users) {
    ctx.agents.desired.markDirty({ serviceId: row.serviceId });
    invalidateService(ctx, row.serviceId, [tunnelOps.get.id]);
  }
  ctx.live.publish("panel", { type: "invalidate", ops: [tunnelOps.getSettings.id] });
  return settingsView(ctx);
});
