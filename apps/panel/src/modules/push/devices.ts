// People's push devices: one row per browser subscription (db/schema/push.ts).
// The endpoint and keys are sealed; the hash of the endpoint finds a row.
// A device added on another origin than today's panel domain cannot be
// reached any more (its service worker lives on the old address), so it is
// removed wherever devices are read.

import { createHash } from "node:crypto";
import { push as pushOps } from "@seylo/ops";
import { and, eq, inArray, lte, ne } from "drizzle-orm";
import { pushDevices, pushPrefs, sessions } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import "./keys";
import { domainOrigin } from "./state";
import type { PushTarget } from "./web-push";

export type PushDeviceRow = typeof pushDevices.$inferSelect;

const purpose = "push.subscription";

/** SHA-256 of an endpoint, hex: the same value the browser computes to find its own row. */
export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function sealTarget(deps: Pick<Deps, "secrets">, target: PushTarget): string {
  return deps.secrets.seal(JSON.stringify({ endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth }), purpose);
}

/** The endpoint and keys of a device; null when the master key cannot open them. */
export function openTarget(deps: Pick<Deps, "secrets">, row: PushDeviceRow): PushTarget | null {
  const plain = deps.secrets.open(row.subscriptionSealed, purpose);
  if (plain === null) return null;
  const parsed = JSON.parse(plain) as PushTarget;
  return { endpoint: parsed.endpoint, p256dh: parsed.p256dh, auth: parsed.auth };
}

/** Removes devices added on another origin than the current panel domain (all of them without a domain); returns how many. */
export function forgetOtherOrigins(deps: Pick<Deps, "db">): number {
  const origin = domainOrigin(deps);
  const removed = origin
    ? deps.db.delete(pushDevices).where(ne(pushDevices.origin, origin)).returning({ id: pushDevices.id }).all()
    : deps.db.delete(pushDevices).returning({ id: pushDevices.id }).all();
  return removed.length;
}

/**
 * Removes devices whose session ended without a sign-out: it expired (idle
 * for its lifetime, or past the hard cap, which expiresAt already holds).
 * Expired session rows linger until their person signs in again, so the
 * cascade alone would keep pushing to a browser nobody is signed in on.
 */
export function forgetEndedSessions(deps: Pick<Deps, "db">, now = new Date()): number {
  const ended = deps.db.select({ id: sessions.id }).from(sessions).where(lte(sessions.expiresAt, now));
  return deps.db.delete(pushDevices).where(inArray(pushDevices.sessionId, ended)).returning({ id: pushDevices.id }).all().length;
}

/** Devices of another origin or an ended session, gone; returns how many. */
export function forgetStaleDevices(deps: Pick<Deps, "db">): number {
  return forgetOtherOrigins(deps) + forgetEndedSessions(deps);
}

/** A person's devices, newest first, after the clean-up (devices waiting to be revoked are not theirs any more). */
export function devicesOf(deps: Pick<Deps, "db">, userId: string): PushDeviceRow[] {
  forgetStaleDevices(deps);
  const revokedBefore = getSetting(deps.db, "pushVapidRevoked")?.at ?? 0;
  return deps.db
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .all()
    .filter((row) => row.createdAt.getTime() > revokedBefore)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function toDevice(row: PushDeviceRow): pushOps.PushDevice {
  return {
    id: row.id,
    label: row.label,
    service: row.service,
    endpointHash: row.endpointHash,
    createdAt: row.createdAt.toISOString(),
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    failing: row.failures > 0,
    lastError: row.lastError,
  };
}

export function removeDeviceOf(deps: Pick<Deps, "db">, userId: string, deviceId: string): boolean {
  return (
    deps.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.id, deviceId), eq(pushDevices.userId, userId)))
      .returning({ id: pushDevices.id })
      .all().length > 0
  );
}

/** The events a person chose; the defaults until they choose. */
export function eventsOf(deps: Pick<Deps, "db">, userId: string): pushOps.PushEventName[] {
  const row = deps.db.select({ events: pushPrefs.events }).from(pushPrefs).where(eq(pushPrefs.userId, userId)).get();
  return row ? row.events : [...pushOps.defaultPushEvents];
}
