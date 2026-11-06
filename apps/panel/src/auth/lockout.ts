// Brute-force guard for passwords and codes. Five wrong tries in a row lock
// the pair (subject, client address) for 30 s, doubling with each further
// failure up to 15 minutes; 15 quiet minutes forgive the streak.
//
// Next to that hard lock, a soft brake per typed email counts failures from
// every address: past 50 within the same 15-minute forgiveness window, each
// sign-in for that email waits a few seconds first and the account's owner
// gets one security_change alert per streak. It never locks anyone out, so
// it is no lever against the real owner, but many addresses no longer buy
// unlimited fast guesses at one account.
//
// Keyed by address, so a stranger who types wrong passwords for the owner's
// email only locks themselves out, never the owner. Keyed by the email as
// typed (account or not), so a locked account and an unknown email answer
// the same way and the lock tells nobody which emails exist. Kept in memory
// per panel database: a panel restart forgives every streak, which is fine
// for a brake (the strict per-address rate limit still applies).

import { OpError } from "@seylo/ops";
import type { PanelDb } from "../db/client";

export const freeFailures = 5;
const firstLockMs = 30 * 1000;
const maxLockMs = 15 * 60 * 1000;
const maxEntries = 50_000;

interface Streak {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

const byPanel = new WeakMap<PanelDb, Map<string, Streak>>();

function streaks(db: PanelDb): Map<string, Streak> {
  let map = byPanel.get(db);
  if (!map) {
    map = new Map();
    byPanel.set(db, map);
  }
  return map;
}

/** Key for password sign-in: the email as typed, so unknown emails lock too. */
export function emailKey(email: string, ip: string | null): string {
  return `email:${email.trim().toLowerCase()}|${ip ?? "unknown"}`;
}

/** Key for codes and passwords checked for a known account (2FA step, account security). */
export function userKey(userId: string, ip: string | null): string {
  return `user:${userId}|${ip ?? "unknown"}`;
}

/** Throws RATE_LIMITED while `key` is locked. */
export function assertNotLocked(db: PanelDb, key: string, now = Date.now()): void {
  const streak = streaks(db).get(key);
  if (streak && streak.lockedUntil > now) {
    const seconds = Math.ceil((streak.lockedUntil - now) / 1000);
    throw new OpError("RATE_LIMITED", `Too many failed sign-ins. Try again in ${seconds} seconds.`, { retryAfter: String(seconds) });
  }
}

/** Counts a wrong password or code for `key`. */
export function recordFailure(db: PanelDb, key: string, now = Date.now()): void {
  const map = streaks(db);
  const before = map.get(key);
  const failures = before && now - before.lastFailureAt <= maxLockMs ? before.failures + 1 : 1;
  const lockedUntil = failures >= freeFailures ? now + Math.min(firstLockMs * 2 ** (failures - freeFailures), maxLockMs) : 0;
  map.delete(key);
  map.set(key, { failures, lastFailureAt: now, lockedUntil });
  while (map.size > maxEntries) map.delete(map.keys().next().value as string);
}

/** Forgets the streak of `key` (a completed sign-in). */
export function clearFailures(db: PanelDb, key: string): void {
  streaks(db).delete(key);
}

/** Forgets every streak naming this email or account, from any address (an admin unlocking someone). */
export function clearAllFailures(db: PanelDb, subject: { email?: string; userId?: string }): void {
  const prefixes = [
    subject.email ? `email:${subject.email.trim().toLowerCase()}|` : null,
    subject.userId ? `user:${subject.userId}|` : null,
  ].filter((p): p is string => p !== null);
  const map = streaks(db);
  for (const key of [...map.keys()]) if (prefixes.some((p) => key.startsWith(p))) map.delete(key);
  if (subject.email) accounts(db).delete(accountKey(subject.email));
}

/** The per-email soft brake; tests shorten the delay. */
export const softThrottle = { failures: 50, delayMs: 2500 };

interface AccountStreak {
  failures: number;
  lastFailureAt: number;
  alerted: boolean;
}

const accountsByPanel = new WeakMap<PanelDb, Map<string, AccountStreak>>();

function accounts(db: PanelDb): Map<string, AccountStreak> {
  let map = accountsByPanel.get(db);
  if (!map) {
    map = new Map();
    accountsByPanel.set(db, map);
  }
  return map;
}

function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

function liveAccountStreak(db: PanelDb, email: string, now: number): AccountStreak | null {
  const streak = accounts(db).get(accountKey(email));
  return streak && now - streak.lastFailureAt <= maxLockMs ? streak : null;
}

/** How long a sign-in for this email waits before the password is checked: 0, or the soft delay. */
export function accountDelayMs(db: PanelDb, email: string, now = Date.now()): number {
  const streak = liveAccountStreak(db, email, now);
  return streak && streak.failures > softThrottle.failures ? softThrottle.delayMs : 0;
}

/**
 * Counts a wrong password for this email from any address. True exactly once
 * per streak, when it passes the soft limit: the caller raises the alert.
 */
export function recordAccountFailure(db: PanelDb, email: string, now = Date.now()): boolean {
  const map = accounts(db);
  const key = accountKey(email);
  const before = liveAccountStreak(db, email, now);
  const streak = before
    ? { ...before, failures: before.failures + 1, lastFailureAt: now }
    : { failures: 1, lastFailureAt: now, alerted: false };
  const alert = streak.failures > softThrottle.failures && !streak.alerted;
  if (alert) streak.alerted = true;
  map.delete(key);
  map.set(key, streak);
  while (map.size > maxEntries) map.delete(map.keys().next().value as string);
  return alert;
}
