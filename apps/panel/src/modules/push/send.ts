// Sending pushes. An alert the sink records (alerts/sink.ts) enqueues one
// push.fanout job; it works out who may get it and enqueues one push.send
// job per device, so a slow or dead device never holds up the others or
// retries everyone.
//
// Who gets an alert: people whose own list has its event, who may receive
// that event (members: their services, approvals they may decide, their own
// account's security changes), and who may see it in the alert feed now
// (the feed's own rule, at send time, so grant and role changes count).
// Panel mutes silence pushes as they silence channels.
//
// Endpoints come from browsers, so the panel only posts to the known push
// services, to an address checked like any outbound request (no private,
// loopback or metadata addresses) and pinned against DNS rebinding.

import { createHash } from "node:crypto";
import { slug } from "@seylo/brand";
import { type alerts as alertOps, push as pushOps } from "@seylo/ops";
import { eq, gt, isNull, lte, sql } from "drizzle-orm";
import { createAccess } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import { alerts, approvals, pushDevices, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { pinRequest } from "../../http/pinned-fetch";
import { defineJob } from "../../jobs/queue";
import { parseInput } from "../../ops/validate";
import { deleteSetting, getSetting } from "../../settings";
import { alertVisibility } from "../alerts/feed";
import { canSee, opById, openInput } from "../approvals/queue";
import { checkTarget, type TargetCheck } from "../uptime/targets";
import { eventsOf, forgetStaleDevices, openTarget, type PushDeviceRow } from "./devices";
import { ensureVapidKeys, pushFanoutJobType, pushRevokeJobType, pushSendJobType, revokedVapidKeys } from "./keys";
import { appPushActive, domainOrigin } from "./state";
import { maxPushPayloadBytes, type PushTarget, type PushUrgency, pushRequest, type VapidKeys } from "./web-push";

type AlertRow = typeof alerts.$inferSelect;

/** Sends one device may get in a burst: more than this in burstWindowMs are dropped (the feed still has them). */
export const burstLimit = 30;
export const burstWindowMs = 10 * 60_000;
/** Failed sends in a row after which a device is removed. */
export const maxFailures = 5;
const sendAttempts = 4;

/** The network side, swapped in tests (like notifications/senders.ts setNotifyIo). */
export interface PushIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  check: (deps: Pick<Deps, "db">, url: string) => Promise<TargetCheck>;
  timeoutMs: number;
}

const defaultIo: PushIo = {
  fetch: (url, init) => fetch(url, init),
  check: (deps, url) => checkTarget(deps, url, { allowInternal: false }),
  timeoutMs: 10_000,
};
let io: PushIo = defaultIo;
export function setPushIo(next: Partial<PushIo>): void {
  io = { ...defaultIo, ...next };
}
export function resetPushIo(): void {
  io = defaultIo;
}

/** What the service worker shows (apps/web/public/sw.js). */
export interface PushMessage {
  title: string;
  body: string;
  /** A path on the panel; the service worker opens only paths on its own origin. */
  url: string;
  /** Same tag, same notification: a newer one about the same thing replaces it. */
  tag: string;
  at: number;
}

/** Good news that replaces its problem's notification: "node-online:<node>:<ms>" takes the place of "node-offline:<node>:...". */
const recoveryOf: Record<string, string> = { "node-online": "node-offline" };

/**
 * What one incident's alerts share: the key without its trailing start
 * time ("crash:<svc>:<ms>" -> "crash:<svc>"). Keys without one stay whole
 * ("approval:<id>", "build-failed:<buildId>", "deploy-failed:<svc>:<gen>:<node>"),
 * so two different builds or approvals never replace each other.
 */
export function incidentOf(eventKey: string): string {
  const parts = eventKey.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts.at(-1) as string)) parts.pop();
  const kind = parts[0] as string;
  if (recoveryOf[kind]) parts[0] = recoveryOf[kind] as string;
  return parts.join(":");
}

/** A Topic and tag from an incident: 32 base64url characters of its hash. */
export function topicOf(eventKey: string): string {
  return createHash("sha256").update(incidentOf(eventKey)).digest("base64url").slice(0, 32);
}

const urgencyOf: Record<alertOps.AlertSeverity, PushUrgency> = { error: "high", warning: "normal", info: "low", ok: "low" };

/** The message for an alert, cut to fit one push. */
export function alertMessage(alert: AlertRow): PushMessage {
  const message: PushMessage = {
    title: alert.title,
    body: alert.message.slice(0, 600),
    url: alert.link?.startsWith("/") ? alert.link : "/",
    tag: topicOf(alert.eventKey),
    at: alert.createdAt.getTime(),
  };
  while (Buffer.byteLength(JSON.stringify(message)) > maxPushPayloadBytes && message.body.length > 0) {
    message.body = message.body.slice(0, Math.floor(message.body.length / 2));
  }
  return message;
}

/** Tells a device's service worker to drop its subscription (sw.js shows why: a push must show something). */
export interface RevokeMessage {
  type: "revoke";
  title: string;
  body: string;
  url: string;
  tag: string;
  at: number;
}

export type SendResult =
  | { kind: "sent" }
  /** 404/410: the browser dropped the subscription. */
  | { kind: "gone"; error: string }
  /** 400/401/403/413 or a refused address: sending again will not help. */
  | { kind: "rejected"; error: string }
  /** 429 (WNS: 406), 5xx, a timeout: worth a retry. */
  | { kind: "retry"; error: string };

/** Push service replies sometimes echo the endpoint; keep URLs out of stored errors. */
const scrub = (text: string) =>
  text
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Sends one message to one device. Never throws. */
export async function sendToDevice(
  deps: Pick<Deps, "db" | "secrets">,
  target: PushTarget,
  message: PushMessage | RevokeMessage,
  options: {
    urgency: PushUrgency;
    ttlSeconds: number;
    topic?: string;
    /** Another key and subject: the revoke job sends with the key the device was subscribed with. */
    keys?: VapidKeys;
    subject?: string;
  },
): Promise<SendResult> {
  const subject = options.subject ?? domainOrigin(deps);
  if (!subject) return { kind: "rejected", error: "The panel has no domain." };
  let url: URL;
  try {
    url = new URL(target.endpoint);
  } catch {
    return { kind: "rejected", error: "The device's address is not valid." };
  }
  if (url.protocol !== "https:" || !pushOps.isPushServiceHost(url.hostname)) {
    return { kind: "rejected", error: "The device's push service is not one the panel sends to." };
  }
  const check = await io.check(deps, target.endpoint);
  if (!check.ok) {
    // A name that does not resolve now may later; an address that is private or reserved never will be allowed.
    return check.reason === "unresolvable" && !check.notFound
      ? { kind: "retry", error: "The push service's name did not resolve." }
      : { kind: "rejected", error: "The push service's address is not one the panel may reach." };
  }
  const request = pushRequest(target, Buffer.from(JSON.stringify(message)), {
    keys: options.keys ?? ensureVapidKeys(deps.db, deps.secrets),
    subject,
    ttlSeconds: options.ttlSeconds,
    urgency: options.urgency,
    topic: options.topic,
  });
  const pinned = pinRequest(request.url, check.address);
  let response: Response;
  try {
    response = await io.fetch(pinned.url, {
      ...request.init,
      headers: { ...(request.init.headers as Record<string, string>), "user-agent": `${slug}-panel`, ...pinned.headers },
      signal: AbortSignal.timeout(io.timeoutMs),
      ...(pinned.tls ? { tls: pinned.tls } : {}),
    } as RequestInit);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "retry",
      error: timedOut ? `The push service did not answer within ${io.timeoutMs / 1000} seconds.` : "Could not reach the push service.",
    };
  }
  if (response.ok) {
    await response.body?.cancel();
    return { kind: "sent" };
  }
  const text = scrub(await response.text().catch(() => ""));
  const error = `The push service answered ${response.status}${text ? `: ${text}` : "."}`;
  if (response.status === 404 || response.status === 410) return { kind: "gone", error };
  // Microsoft's WNS says 406 when a device is over its throttle limit: later, not never.
  if (response.status === 429 || response.status === 406 || response.status >= 500) return { kind: "retry", error };
  return { kind: "rejected", error };
}

/** Records a send's outcome on the device row; removes the device when it is gone or kept failing. */
export function recordSend(deps: Pick<Deps, "db">, device: PushDeviceRow, result: SendResult, finalTry: boolean): void {
  if (result.kind === "gone") {
    deps.db.delete(pushDevices).where(eq(pushDevices.id, device.id)).run();
    return;
  }
  if (result.kind === "sent") {
    deps.db.update(pushDevices).set({ lastSentAt: new Date(), failures: 0, lastError: null }).where(eq(pushDevices.id, device.id)).run();
    return;
  }
  // A retry that will run again is not a failure yet.
  if (result.kind === "retry" && !finalTry) {
    deps.db.update(pushDevices).set({ lastError: result.error }).where(eq(pushDevices.id, device.id)).run();
    return;
  }
  // Counted in SQL: sends to one device run side by side, and a count from the row read before them would lose some.
  const counted = deps.db
    .update(pushDevices)
    .set({ failures: sql`${pushDevices.failures} + 1`, lastError: result.error })
    .where(eq(pushDevices.id, device.id))
    .returning({ failures: pushDevices.failures })
    .get();
  if (counted && counted.failures >= maxFailures) deps.db.delete(pushDevices).where(eq(pushDevices.id, device.id)).run();
}

/** Takes one slot of the device's burst window; false when it is full. */
function takeBurstSlot(deps: Pick<Deps, "db">, device: PushDeviceRow, now: number): boolean {
  const fresh = now - device.windowStart >= burstWindowMs;
  const count = fresh ? 0 : device.windowCount;
  if (count >= burstLimit) return false;
  deps.db
    .update(pushDevices)
    .set({ windowStart: fresh ? now : device.windowStart, windowCount: count + 1 })
    .where(eq(pushDevices.id, device.id))
    .run();
  return true;
}

type Person = { id: string; email: string; name: string; role: "owner" | "admin" | "member" };

/** The events a person may receive at all. */
export function eventChoicesFor(role: Person["role"]): pushOps.PushEventName[] {
  return role === "owner" || role === "admin" ? [...pushOps.pushEvents] : [...pushOps.memberPushEvents];
}

function principalOf(person: Person): Principal {
  return { type: "session", user: person, sessionId: "push" };
}

/** Whether a person may get this alert (event choices, the feed rule, approvals and own-account rules). */
export function mayReceive(deps: Pick<Deps, "db" | "secrets">, person: Person, alert: AlertRow): boolean {
  const event = alert.event as pushOps.PushEventName;
  if (!eventChoicesFor(person.role).includes(event)) return false;
  if (!eventsOf(deps, person.id).includes(event)) return false;
  const principal = principalOf(person);
  const access = createAccess(deps.db, principal);
  if (event === "approval_requested") {
    const id = alert.eventKey.startsWith("approval:") ? alert.eventKey.slice("approval:".length) : "";
    const row = deps.db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (row?.status !== "pending" || !canSee(deps.db, principal, row)) return false;
    // Only people who could approve it themselves (approvals/queue.ts approve checks the same).
    const op = opById(row.opId);
    if (!op) return false;
    try {
      access.require(op.permission, op.kind, parseInput(op.input, openInput(deps, row), false));
      return true;
    } catch {
      return false;
    }
  }
  // A person's own sign-in methods, keys and sessions (alerts/security.ts keys "security:<userId>:...").
  if (event === "security_change" && alert.eventKey.startsWith(`security:${person.id}:`)) return true;
  return alertVisibility(access)(alert);
}

export interface FanoutPayload {
  alertId: string;
}

export interface SendPayload {
  alertId: string;
  deviceId: string;
}

export const fanoutJob = defineJob<FanoutPayload>({
  type: pushFanoutJobType,
  maxAttempts: 3,
  async run(payload, ctx) {
    if (!appPushActive(ctx)) return;
    const alert = ctx.db.select().from(alerts).where(eq(alerts.id, payload.alertId)).get();
    if (!alert || alert.muted || !(pushOps.pushEvents as readonly string[]).includes(alert.event)) return;
    forgetStaleDevices(ctx);
    // Devices from before a --new-panel-identity rotation are being revoked (revokeJob), not pushed to.
    const revokedBefore = new Date(getSetting(ctx.db, "pushVapidRevoked")?.at ?? 0);
    const devices = ctx.db
      .select({ id: pushDevices.id, userId: pushDevices.userId })
      .from(pushDevices)
      .where(gt(pushDevices.createdAt, revokedBefore))
      .all();
    if (devices.length === 0) return;
    const people = ctx.db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(isNull(users.disabledAt))
      .all();
    const receives = new Map<string, boolean>();
    for (const person of people) {
      if (devices.some((device) => device.userId === person.id)) receives.set(person.id, mayReceive(ctx, person, alert));
    }
    for (const device of devices) {
      if (!receives.get(device.userId)) continue;
      ctx.jobs.enqueue(pushSendJobType, { alertId: alert.id, deviceId: device.id } satisfies SendPayload, {
        dedupeKey: `push-send:${alert.id}:${device.id}`,
        maxAttempts: sendAttempts,
      });
    }
  },
});

export const sendJob = defineJob<SendPayload>({
  type: pushSendJobType,
  maxAttempts: sendAttempts,
  async run(payload, ctx) {
    if (!appPushActive(ctx)) return;
    const device = ctx.db.select().from(pushDevices).where(eq(pushDevices.id, payload.deviceId)).get();
    const alert = ctx.db.select().from(alerts).where(eq(alerts.id, payload.alertId)).get();
    if (!device || !alert) return;
    const target = openTarget(ctx, device);
    if (!target) {
      ctx.db.delete(pushDevices).where(eq(pushDevices.id, device.id)).run();
      return;
    }
    // The first try takes a burst slot; retries of the same send do not take another.
    if (ctx.attempt === 1 && !takeBurstSlot(ctx, device, Date.now())) {
      ctx.db
        .update(pushDevices)
        .set({ lastError: `More than ${burstLimit} alerts in ${burstWindowMs / 60_000} minutes: the rest are in the alert feed.` })
        .where(eq(pushDevices.id, device.id))
        .run();
      return;
    }
    const result = await sendToDevice(ctx, target, alertMessage(alert), {
      urgency: urgencyOf[alert.severity],
      ttlSeconds: 24 * 3600,
      topic: topicOf(alert.eventKey),
    });
    const finalTry = ctx.attempt >= sendAttempts;
    recordSend(ctx, device, result, finalTry);
    if (result.kind === "retry" && !finalTry) throw new Error(result.error);
  },
});

/**
 * After a --new-panel-identity rotation (a leaked panel.db): every device
 * from before it gets one last push, sent with the old key it subscribed
 * with, telling its service worker to drop the subscription. Deleting the
 * rows alone would not do: a copy of panel.db and master.key could still
 * push to those subscriptions. A device the push service says is gone, or
 * that refuses, is done too; one that does not answer is tried again, and
 * the last try removes what is left. Then the old key goes.
 */
export const revokeJob = defineJob<Record<string, never>>({
  type: pushRevokeJobType,
  maxAttempts: 3,
  async run(_payload, ctx) {
    const old = revokedVapidKeys(ctx.db, ctx.secrets);
    const stored = getSetting(ctx.db, "pushVapidRevoked");
    if (!stored) return;
    const before = new Date(stored.at);
    const devices = ctx.db.select().from(pushDevices).where(lte(pushDevices.createdAt, before)).all();
    const finalTry = ctx.attempt >= 3;
    let pending = 0;
    for (const device of devices) {
      const target = old ? openTarget(ctx, device) : null;
      const result: SendResult = target
        ? await sendToDevice(
            ctx,
            target,
            {
              type: "revoke",
              title: "Push notifications were reset",
              body: "This panel's push key changed. Turn push notifications on again in Settings > Push notifications.",
              url: "/settings/push",
              tag: "push-revoke",
              at: Date.now(),
            },
            { urgency: "normal", ttlSeconds: 7 * 24 * 3600, keys: old as VapidKeys, subject: device.origin },
          )
        : { kind: "rejected", error: "The old push key cannot be opened." };
      if (result.kind === "retry" && !finalTry) {
        pending++;
        continue;
      }
      ctx.db.delete(pushDevices).where(eq(pushDevices.id, device.id)).run();
    }
    if (pending > 0) throw new Error(`${pending} device(s) did not answer; trying again`);
    deleteSetting(ctx.db, "pushVapidRevoked");
  },
});

/** At start: a rotation left devices to revoke. */
export function revokeOnStart(deps: Deps): void {
  if (getSetting(deps.db, "pushVapidRevoked")) deps.jobs.enqueue(pushRevokeJobType, {}, { dedupeKey: pushRevokeJobType, maxAttempts: 3 });
}
