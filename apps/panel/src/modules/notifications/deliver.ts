// The delivery job (one alert to one channel) and the test send. Both
// record a notification_deliveries row, which the channel card shows as
// its last delivery.

import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { alerts, notificationDeliveries } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { type DeliverPayload, deliverJobType } from "../alerts/sink";
import { readPanelName } from "../settings/keys";
import { panelLink, panelPublicUrl } from "../settings/public-url";
import { getChannelRow, openConfig } from "./channels";
import { type ChannelConfig, DeliveryError, deliver, type Notice } from "./senders";

export function recordDelivery(
  db: PanelDb,
  row: { alertId: string | null; channelId: string | null; test: boolean; status: "sent" | "failed"; error: string | null },
) {
  db.insert(notificationDeliveries).values(row).run();
}

export function alertNotice(deps: Pick<Deps, "db" | "config">, alert: typeof alerts.$inferSelect): Notice {
  return {
    type: "alert",
    event: alert.event,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    link: panelLink(deps, alert.link),
    panelName: readPanelName(deps.db),
    panelUrl: panelPublicUrl(deps),
    at: alert.createdAt,
    alertId: alert.id,
    projectId: alert.projectId,
    serviceId: alert.serviceId,
    nodeId: alert.nodeId,
  };
}

export function testNotice(deps: Pick<Deps, "db" | "config">, now = new Date()): Notice {
  const panelName = readPanelName(deps.db);
  const panelUrl = panelPublicUrl(deps);
  return {
    type: "test",
    event: "test",
    severity: "info",
    title: "Test notification",
    message: `This channel works. Alerts from ${panelName} will arrive here.`,
    link: `${panelUrl}/settings/notifications`,
    panelName,
    panelUrl,
    at: now,
    alertId: null,
    projectId: null,
    serviceId: null,
    nodeId: null,
  };
}

/** Sends a test notice and records it when the channel is saved; never throws for delivery problems. */
export async function sendTest(
  deps: Pick<Deps, "db" | "config">,
  config: ChannelConfig,
  channelId: string | null,
): Promise<{ ok: boolean; error: string | null; durationMs: number }> {
  const started = performance.now();
  let error: string | null = null;
  try {
    await deliver(config, testNotice(deps));
  } catch (thrown) {
    error = thrown instanceof DeliveryError ? thrown.message : "The notification could not be sent.";
  }
  if (channelId) recordDelivery(deps.db, { alertId: null, channelId, test: true, status: error ? "failed" : "sent", error });
  return { ok: error === null, error, durationMs: Math.round(performance.now() - started) };
}

export const deliverJob = defineJob<DeliverPayload>({
  type: deliverJobType,
  maxAttempts: 4,
  async run(payload, ctx) {
    const alert = ctx.db.select().from(alerts).where(eq(alerts.id, payload.alertId)).get();
    if (!alert) return; // deleted with its service: nothing to say any more
    let channel: ReturnType<typeof getChannelRow>;
    try {
      channel = getChannelRow(ctx.db, payload.channelId);
    } catch {
      return; // channel deleted since
    }
    if (!channel.enabled) return;
    try {
      await deliver(openConfig(ctx.secrets, channel), alertNotice(ctx, alert));
      recordDelivery(ctx.db, { alertId: alert.id, channelId: channel.id, test: false, status: "sent", error: null });
    } catch (error) {
      const message = error instanceof DeliveryError ? error.message : "The notification could not be sent.";
      recordDelivery(ctx.db, { alertId: alert.id, channelId: channel.id, test: false, status: "failed", error: message });
      throw error;
    }
  },
});
