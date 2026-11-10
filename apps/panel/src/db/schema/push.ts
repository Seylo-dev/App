// Push notifications to people's own devices (0.2.7, modules/push). A
// device is one browser's push subscription, added from a browser session
// on the panel domain: it belongs to that person and that session (signing
// out or revoking the session ends it, and it is removed before the next
// push) and to the domain origin it was added from (a new domain makes it
// useless, so it is removed then too).

import type { push as pushOps } from "@seylo/ops";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { sessions, users } from "./identity";

export const pushDevices = sqliteTable(
  "push_devices",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The session it was added from. Null once that session is gone (signed
     * out, revoked, or swept after it expired): the device counts as ended
     * and modules/push/devices.ts removes it, unless it awaits a revoke push.
     * Not a cascade, which would skip that revoke.
     */
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    /** SHA-256 of the endpoint, hex: one row per browser subscription, found without opening the sealed part. */
    endpointHash: text("endpoint_hash").notNull(),
    /** {endpoint, p256dh, auth} sealed with purpose "push.subscription": whoever has them can push to the device. */
    subscriptionSealed: sealed("subscription_sealed").notNull(),
    /** The push service's host, for example "fcm.googleapis.com". */
    service: text("service").notNull(),
    /** "https://<panel domain>" when it was added; a device of another origin is removed. */
    origin: text("origin").notNull(),
    /** What the browser said it is, for example "Chrome on Android". */
    label: text("label").notNull(),
    createdAt: createdAt(),
    lastSentAt: timestamp("last_sent_at"),
    /** Failed sends in a row; the device is removed at 5. */
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error"),
    /** Burst control: pushes sent since windowStart (ms), at most a few dozen per window. */
    windowStart: integer("window_start").notNull().default(0),
    windowCount: integer("window_count").notNull().default(0),
  },
  (t) => [uniqueIndex("push_devices_endpoint_unique").on(t.endpointHash), index("push_devices_user_idx").on(t.userId)],
);

/** A person's choice of the alert events that reach their devices; no row = the defaults (defaultPushEvents). */
export const pushPrefs = sqliteTable("push_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  events: json<pushOps.PushEventName[]>("events").notNull(),
  updatedAt: updatedAt(),
});
