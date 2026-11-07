// Replay protection for signed webhooks. A provider's signature covers only
// the body, so a captured delivery re-sent with a fresh delivery id would
// pass the signature check and deploy that old commit again. Bodies are
// remembered by hash for a few days in panel.db (webhook_bodies), so a
// panel restart forgets nothing; the same body under another delivery id
// is a replay. A provider's own retries keep
// their delivery id and pass. GitLab, Gitea and Bitbucket post one body to
// every hook of a repository, each under its own delivery id, so their
// bodies are remembered per hook: two services of one repository both get
// the push. Rejected deliveries are logged, but at most a few an hour, so a
// stream of bad requests cannot fill the database.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type WebhookSource, webhookBodies } from "../../db/schema";
import { recordDelivery } from "./deliveries";

/** How long a signed body is remembered (GitHub redelivers for 3 days). retention.ts prunes the rows. */
export const replayWindowMs = 3 * 24 * 3600 * 1000;
/** Most bodies remembered; retention.ts drops the oldest past it. */
export const maxRememberedBodies = 10_000;
/** Rejected deliveries recorded per hour at most: enough to see a wrong secret, not a disk filler. */
const rejectedPerHour = 20;

const rejectedCount = new WeakMap<object, { hour: number; n: number }>();

/**
 * Whether this body was already handled under another delivery id of the
 * same source (and hook: provider hooks are one per service, GitHub's App
 * has one for the whole panel and passes none).
 */
export function replayedBody(db: PanelDb, source: WebhookSource, deliveryId: string, raw: string, hookId?: string): boolean {
  return bodySeen(db, source, deliveryId, raw, hookId) === "replay";
}

/**
 * What a signed body is to this source (and hook): "new", "again" (seen
 * in the window under this same delivery id: a provider's redelivery, or
 * a captured delivery posted again) or "replay" (seen under another id).
 * Remembers the body unless it is a replay.
 */
export function bodySeen(db: PanelDb, source: WebhookSource, deliveryId: string, raw: string, hookId?: string): "new" | "again" | "replay" {
  const now = Date.now();
  const key = { source, hookId: hookId ?? "", bodyHash: createHash("sha256").update(raw).digest("hex") };
  const before = db
    .select({ deliveryId: webhookBodies.deliveryId, seenAt: webhookBodies.seenAt })
    .from(webhookBodies)
    .where(and(eq(webhookBodies.source, key.source), eq(webhookBodies.hookId, key.hookId), eq(webhookBodies.bodyHash, key.bodyHash)))
    .get();
  const recent = before !== undefined && now - before.seenAt.getTime() <= replayWindowMs;
  if (recent && before.deliveryId !== deliveryId) return "replay";
  db.insert(webhookBodies)
    .values({ ...key, deliveryId, seenAt: new Date(now) })
    .onConflictDoUpdate({
      target: [webhookBodies.source, webhookBodies.hookId, webhookBodies.bodyHash],
      set: { deliveryId, seenAt: new Date(now) },
    })
    .run();
  return recent ? "again" : "new";
}

/**
 * Logs a refused delivery (bad signature, replay) for a service's delivery
 * list. The row gets its own id: a delivery id from an unverified request
 * must never overwrite the row of a real delivery.
 */
export function recordRejected(
  db: PanelDb,
  input: { source: WebhookSource; event: string; serviceId: string | null; detail: string },
): void {
  const hour = Math.floor(Date.now() / 3_600_000);
  const count = rejectedCount.get(db);
  const current = count?.hour === hour ? count : { hour, n: 0 };
  current.n += 1;
  rejectedCount.set(db, current);
  if (current.n > rejectedPerHour) return;
  recordDelivery(db, {
    source: input.source,
    deliveryId: `rejected-${randomUUID()}`,
    event: input.event,
    serviceId: input.serviceId,
    outcome: "rejected",
    detail: input.detail,
  });
}
