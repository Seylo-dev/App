// The push ops: the admin switch (push.settings, push.updateSettings) and a
// person's own devices and events (push.mine, subscribe, removeDevice,
// setEvents, test). Contracts: packages/ops/src/ops/push.ts.

import { OpError, push as pushOps } from "@seylo/ops";
import { and, eq, gt, sql } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { requireSession } from "../../auth/sign-in";
import { pushDevices, pushPrefs } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { getSetting, setSetting } from "../../settings";
import {
  devicesOf,
  endpointHash,
  eventsOf,
  forgetStaleDevices,
  notAwaitingRevoke,
  openTarget,
  removeDeviceOf,
  sealTarget,
  toDevice,
} from "./devices";
import { ensureVapidKeys, readAppPush } from "./keys";
import { eventChoicesFor, recordSend, sendToDevice } from "./send";
import { appPushActive, domainOrigin, onDomainNow, turnOnBlocks, unavailableReason } from "./state";
import { validTargetKeys } from "./web-push";

/** Devices one person may have; adding one more drops their oldest. */
export const maxDevicesPerPerson = 20;

/** Everyone's settings, sidebars and pages that show push. */
function changed(ctx: OpContext): void {
  ctx.live.publish("panel", { type: "invalidate", ops: [pushOps.settings.id, pushOps.mine.id, "system.features"] });
}

function settingsView(ctx: OpContext): pushOps.AppPushSettings {
  const stored = readAppPush(ctx.db);
  forgetStaleDevices(ctx);
  // Devices a key rotation is revoking are not in use any more.
  const revokedBefore = new Date(getSetting(ctx.db, "pushVapidRevoked")?.at ?? 0);
  const counts = ctx.db
    .select({ devices: sql<number>`count(*)`, people: sql<number>`count(distinct ${pushDevices.userId})` })
    .from(pushDevices)
    .where(gt(pushDevices.createdAt, revokedBefore))
    .get();
  return {
    enabled: stored.enabled,
    active: appPushActive(ctx),
    domainUrl: domainOrigin(ctx),
    onDomainNow: onDomainNow(ctx),
    blocks: stored.enabled ? [] : turnOnBlocks(ctx),
    people: counts?.people ?? 0,
    devices: counts?.devices ?? 0,
    changedAt: stored.changedAt ? new Date(stored.changedAt).toISOString() : null,
    changedBy: stored.by,
  };
}

const settings = implement(pushOps.settings, (_input, ctx) => settingsView(ctx));

const updateSettings = implement(pushOps.updateSettings, (input, ctx) => {
  const current = readAppPush(ctx.db);
  if (input.enabled === current.enabled) return settingsView(ctx);
  let removed = 0;
  if (input.enabled) {
    const [block] = turnOnBlocks(ctx);
    if (block) throw new OpError("CONFLICT", block.message, { reason: block.code });
    // The key browsers bind their subscriptions to, made now so the first device can use it.
    ensureVapidKeys(ctx.db, ctx.secrets);
  } else {
    // Off for everyone: no device keeps a subscription that nothing sends to (devices awaiting a revoke still get it).
    removed = ctx.db.delete(pushDevices).where(notAwaitingRevoke(ctx)).returning({ id: pushDevices.id }).all().length;
  }
  const by = userOf(ctx.principal)?.email ?? null;
  setSetting(ctx.db, "appPush", { enabled: input.enabled, changedAt: Date.now(), by });
  if (removed > 0) ctx.auditDetails?.({ devicesRemoved: removed });
  changed(ctx);
  return settingsView(ctx);
});

const mine = implement(pushOps.mine, (_input, ctx) => {
  const user = userOf(ctx.principal);
  if (!user) throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const active = appPushActive(ctx);
  const choices = eventChoicesFor(user.role);
  return {
    enabled: readAppPush(ctx.db).enabled,
    available: active,
    reason: active ? "" : unavailableReason(ctx),
    domainUrl: active ? domainOrigin(ctx) : null,
    onDomainNow: onDomainNow(ctx),
    // Made here when missing (a --new-panel-identity rotation drops it while push stays on).
    publicKey: active ? ensureVapidKeys(ctx.db, ctx.secrets).publicKey : null,
    devices: devicesOf(ctx, user.id).map(toDevice),
    events: eventsOf(ctx, user.id).filter((event) => choices.includes(event)),
    eventChoices: choices,
  };
});

/** An endpoint the panel will post to: https, a push service's host, no credentials or odd port. */
function checkEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OpError("BAD_REQUEST", "The subscription's endpoint is not a URL.", { field: "endpoint" });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || !pushOps.isPushServiceHost(url.hostname)) {
    throw new OpError("BAD_REQUEST", "This browser's push service is not one the panel sends to (Google, Mozilla, Apple or Microsoft).", {
      field: "endpoint",
      reason: "unknownPushService",
    });
  }
  return url;
}

const subscribe = implement(pushOps.subscribe, (input, ctx) => {
  const { userId, sessionId } = requireSession(ctx);
  if (!appPushActive(ctx)) throw new OpError("CONFLICT", unavailableReason(ctx), { reason: "notAvailable" });
  const origin = domainOrigin(ctx);
  if (!origin || !onDomainNow(ctx)) {
    throw new OpError("CONFLICT", `Open the panel at ${origin ?? "its domain"} to turn on push notifications on this device.`, {
      reason: "notOnDomain",
    });
  }
  const url = checkEndpoint(input.endpoint);
  const target = { endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth };
  if (!validTargetKeys(target)) throw new OpError("BAD_REQUEST", "The subscription's keys are not valid.", { field: "p256dh" });
  const hash = endpointHash(input.endpoint);
  const row = ctx.db.transaction((tx) => {
    // The same browser signed in as someone else, or added again: the subscription moves to this person and session.
    tx.delete(pushDevices).where(eq(pushDevices.endpointHash, hash)).run();
    const inserted = tx
      .insert(pushDevices)
      .values({
        userId,
        sessionId,
        endpointHash: hash,
        subscriptionSealed: sealTarget(ctx, target),
        service: url.hostname.toLowerCase(),
        origin,
        label: input.label.trim().slice(0, 80) || "Browser",
      })
      .returning()
      .get();
    // The cap counts and prunes only devices in use: ones awaiting a revoke are the revoke job's.
    const all = tx
      .select({ id: pushDevices.id, createdAt: pushDevices.createdAt })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, userId), notAwaitingRevoke(ctx)))
      .all();
    const extra = all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(maxDevicesPerPerson);
    for (const old of extra) tx.delete(pushDevices).where(eq(pushDevices.id, old.id)).run();
    return inserted;
  });
  return toDevice(row);
});

const removeDevice = implement(pushOps.removeDevice, (input, ctx) => {
  const { userId } = requireSession(ctx);
  return { removed: removeDeviceOf(ctx, userId, input.deviceId) };
});

const setEvents = implement(pushOps.setEvents, (input, ctx) => {
  const { userId, user } = requireSession(ctx);
  const choices = eventChoicesFor(user.role);
  const refused = input.events.filter((event) => !choices.includes(event));
  if (refused.length > 0) {
    throw new OpError("BAD_REQUEST", `You cannot get these events: ${refused.join(", ")}.`, { field: "events" });
  }
  // Kept in the order of the list people see.
  const events = pushOps.pushEvents.filter((event) => input.events.includes(event));
  ctx.db
    .insert(pushPrefs)
    .values({ userId, events })
    .onConflictDoUpdate({ target: pushPrefs.userId, set: { events, updatedAt: new Date() } })
    .run();
  return { events };
});

const test = implement(pushOps.test, async (_input, ctx) => {
  const { userId } = requireSession(ctx);
  if (!appPushActive(ctx)) throw new OpError("CONFLICT", unavailableReason(ctx), { reason: "notAvailable" });
  const devices = devicesOf(ctx, userId);
  const message = {
    title: "Test notification",
    body: "Push notifications reach this device.",
    url: "/settings/push",
    tag: "push-test",
    at: Date.now(),
  };
  const results = await Promise.all(
    devices.map(async (device) => {
      const target = openTarget(ctx, device);
      const result = target
        ? await sendToDevice(ctx, target, message, { urgency: "normal", ttlSeconds: 300 })
        : ({ kind: "rejected", error: "The device's subscription cannot be read with this panel's key." } as const);
      // A test is tried once: what it says is what the person sees.
      recordSend(ctx, device, result, true);
      return { deviceId: device.id, label: device.label, ok: result.kind === "sent", error: result.kind === "sent" ? null : result.error };
    }),
  );
  return { results };
});

export const pushOpHandlers = [settings, updateSettings, mine, subscribe, removeDevice, setEvents, test];
