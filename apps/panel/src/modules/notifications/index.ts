// Notification channels (sealed configs, test sends) and alert rules: panel
// defaults and per-service overrides. Delivery runs as a job per alert and
// channel (deliver.ts); alerts are raised through deps.alerts.
// Contracts: packages/ops/src/ops/notifications.ts.

import { notifications, OpError } from "@seylo/ops";
import { asc, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { notificationChannels } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { checkComplete, clearOtherDefaults, getChannelRow, mergeSecrets, openConfig, sealConfig, toChannelView } from "./channels";
import { deliverJob, sendTest } from "./deliver";
import { forgetChannel, readDefaults, readServiceRules, serviceDefaults, updateDefaults, updateServiceRules } from "./rules";

const invalidateChannels = (ctx: OpContext) =>
  ctx.live.publish("panel", { type: "invalidate", ops: ["notifications.channels", "notifications.defaults", "system.features"] });

// Members pick channels for their services' alert rules, so everyone signed
// in may list them; only people who manage channels see where they point.
const channels = implement(notifications.channels, (_input, ctx) => {
  const full = ctx.access.can("notifications.manage");
  return {
    channels: ctx.db
      .select()
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.createdAt))
      .all()
      .map((row) => toChannelView(ctx.db, ctx.secrets, row, full)),
  };
});

const createChannel = implement(notifications.createChannel, (input, ctx) => {
  checkComplete(input.config);
  const row = ctx.db.transaction((tx) => {
    const created = tx
      .insert(notificationChannels)
      .values({
        name: input.name,
        kind: input.config.kind,
        configSealed: sealConfig(ctx.secrets, input.config),
        enabled: input.enabled ?? true,
        isDefault: input.isDefault ?? false,
      })
      .returning()
      .get();
    if (created.isDefault) clearOtherDefaults(tx as unknown as PanelDb, created.id);
    return created;
  });
  invalidateChannels(ctx);
  return toChannelView(ctx.db, ctx.secrets, row);
});

const updateChannel = implement(notifications.updateChannel, (input, ctx) => {
  const existing = getChannelRow(ctx.db, input.channelId);
  let configSealed: string | undefined;
  if (input.config) {
    if (input.config.kind !== existing.kind) {
      throw new OpError("BAD_REQUEST", "A channel's kind cannot change. Create a new channel instead.", { field: "config.kind" });
    }
    const merged = mergeSecrets(input.config, openConfig(ctx.secrets, existing));
    checkComplete(merged);
    configSealed = sealConfig(ctx.secrets, merged);
  }
  const row = ctx.db.transaction((tx) => {
    const updated = tx
      .update(notificationChannels)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(configSealed ? { configSealed } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      })
      .where(eq(notificationChannels.id, existing.id))
      .returning()
      .get();
    if (updated.isDefault) clearOtherDefaults(tx as unknown as PanelDb, updated.id);
    return updated;
  });
  invalidateChannels(ctx);
  return toChannelView(ctx.db, ctx.secrets, row);
});

const deleteChannel = implement(notifications.deleteChannel, (input, ctx) => {
  getChannelRow(ctx.db, input.channelId);
  ctx.db.transaction((tx) => {
    forgetChannel(tx as unknown as PanelDb, input.channelId);
    tx.delete(notificationChannels).where(eq(notificationChannels.id, input.channelId)).run();
  });
  invalidateChannels(ctx);
  return {};
});

const testChannel = implement(notifications.testChannel, async (input, ctx) => {
  if (!input.channelId && !input.config) {
    throw new OpError("BAD_REQUEST", "Pass a saved channel, settings to try, or both.", { field: "config" });
  }
  const stored = input.channelId ? openConfig(ctx.secrets, getChannelRow(ctx.db, input.channelId)) : null;
  if (input.config && stored && input.config.kind !== stored.kind) {
    throw new OpError("BAD_REQUEST", "A channel's kind cannot change.", { field: "config.kind" });
  }
  const config = input.config ? mergeSecrets(input.config, stored) : stored;
  if (!config) throw new OpError("BAD_REQUEST", "Nothing to test.");
  checkComplete(config);
  // Only a test of the saved settings counts as the channel's last delivery.
  const savedOnly = input.channelId && !input.config ? input.channelId : null;
  const result = await sendTest(ctx, config, savedOnly);
  if (savedOnly) invalidateChannels(ctx);
  return result;
});

const defaults = implement(notifications.defaults, (_input, ctx) => ({ rules: readDefaults(ctx.db) }));

const updateDefaultsOp = implement(notifications.updateDefaults, (input, ctx) => {
  const rules = updateDefaults(ctx.db, input.rules);
  ctx.live.publish("panel", {
    type: "invalidate",
    ops: ["notifications.defaults", "notifications.serviceAlerts", "notifications.channels"],
  });
  return { rules };
});

const serviceView = (ctx: OpContext, serviceId: string) => {
  const own = readServiceRules(ctx.db, serviceId);
  const fallback = serviceDefaults(ctx.db);
  return { useDefaults: own === null, rules: own ?? fallback, defaults: fallback };
};

const serviceAlerts = implement(notifications.serviceAlerts, (input, ctx) => serviceView(ctx, input.serviceId));

const updateServiceAlerts = implement(notifications.updateServiceAlerts, (input, ctx) => {
  updateServiceRules(ctx.db, input.serviceId, input.useDefaults, input.rules);
  ctx.live.publish(`service:${input.serviceId}`, { type: "invalidate", ops: ["notifications.serviceAlerts"] });
  ctx.live.publish("panel", { type: "invalidate", ops: ["notifications.channels"] });
  return serviceView(ctx, input.serviceId);
});

export default defineModule({
  name: "notifications",
  ops: [channels, createChannel, updateChannel, deleteChannel, testChannel, defaults, updateDefaultsOp, serviceAlerts, updateServiceAlerts],
  jobs: [deliverJob],
});
