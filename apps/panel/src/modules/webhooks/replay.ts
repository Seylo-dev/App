// Replay protection for signed webhooks. A provider's signature covers only
// the body, so a captured delivery re-sent with a fresh delivery id would
// pass the signature check and deploy that old commit again. Bodies are
// remembered by hash for a few days (in memory, per panel); the same body
// under another delivery id is a replay. A provider's own retries keep
// their delivery id and pass. GitLab, Gitea and Bitbucket post one body to
// every hook of a repository, each under its own delivery id, so their
// bodies are remembered per hook: two services of one repository both get
// the push. Rejected deliveries are logged, but at most a few an hour, so a
// stream of bad requests cannot fill the database.

import { createHash, randomUUID } from "node:crypto";
import type { PanelDb } from "../../db/client";
import type { WebhookSource } from "../../db/schema";
import { recordDelivery } from "./deliveries";

/** How long a signed body is remembered (GitHub redelivers for 3 days). */
const replayWindowMs = 3 * 24 * 3600 * 1000;
const maxRemembered = 10_000;
/** Rejected deliveries recorded per hour at most: enough to see a wrong secret, not a disk filler. */
const rejectedPerHour = 20;

const seenBodies = new WeakMap<object, Map<string, { deliveryId: string; at: number }>>();
const rejectedCount = new WeakMap<object, { hour: number; n: number }>();

/**
 * Whether this body was already handled under another delivery id of the
 * same source (and hook: provider hooks are one per service, GitHub's App
 * has one for the whole panel and passes none).
 */
export function replayedBody(db: PanelDb, source: WebhookSource, deliveryId: string, raw: string, hookId?: string): boolean {
  let seen = seenBodies.get(db);
  if (!seen) {
    seen = new Map();
    seenBodies.set(db, seen);
  }
  const now = Date.now();
  // Oldest first: drop expired entries (and the oldest past the cap) until the first fresh one.
  for (const [hash, entry] of seen) {
    if (now - entry.at <= replayWindowMs && seen.size <= maxRemembered) break;
    seen.delete(hash);
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  const hash = hookId ? `${source}:${hookId}:${digest}` : `${source}:${digest}`;
  const before = seen.get(hash);
  if (before && before.deliveryId !== deliveryId) return true;
  seen.set(hash, { deliveryId, at: now });
  return false;
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
