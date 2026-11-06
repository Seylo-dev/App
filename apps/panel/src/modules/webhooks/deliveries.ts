// The webhook delivery log: one row per service a delivery touched (or one
// without a service when it matched nothing), for "why did my push not
// deploy?" and for dedupe of GitHub redeliveries.

import { and, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type WebhookOutcome, type WebhookSource, webhookDeliveries } from "../../db/schema";

export interface DeliveryRecord {
  source: WebhookSource;
  deliveryId: string;
  event: string;
  serviceId: string | null;
  outcome: WebhookOutcome;
  detail: string;
  deploymentId?: string | null;
}

/** Writes (or, for a redelivery, rewrites) the row of one delivery and service. */
export function recordDelivery(db: PanelDb, record: DeliveryRecord): void {
  const values = {
    source: record.source,
    deliveryId: record.deliveryId,
    event: record.event,
    serviceId: record.serviceId,
    outcome: record.outcome,
    detail: record.detail.slice(0, 500),
    deploymentId: record.deploymentId ?? null,
    receivedAt: new Date(),
  };
  if (record.serviceId === null) {
    db.insert(webhookDeliveries).values(values).run();
    return;
  }
  db.insert(webhookDeliveries)
    .values(values)
    .onConflictDoUpdate({
      target: [webhookDeliveries.source, webhookDeliveries.deliveryId, webhookDeliveries.serviceId],
      set: {
        outcome: values.outcome,
        detail: values.detail,
        deploymentId: values.deploymentId,
        receivedAt: values.receivedAt,
        event: values.event,
      },
    })
    .run();
}

/**
 * True when this delivery was already handled successfully (providers'
 * retries and redeliveries reuse their delivery id). Failed ones are
 * handled again.
 */
export function alreadyHandled(db: PanelDb, deliveryId: string, source: WebhookSource = "github"): boolean {
  const rows = db
    .select({ outcome: webhookDeliveries.outcome })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.source, source), eq(webhookDeliveries.deliveryId, deliveryId)))
    .all();
  return rows.length > 0 && rows.every((r) => r.outcome !== "failed");
}
