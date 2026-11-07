// Brute-force guard for passwords and codes. Five wrong tries in a row lock
// the pair (subject, client address) for 30 s, doubling with each further
// failure up to 15 minutes; 15 quiet minutes forgive the streak. Addresses
// are grouped like the rate limits (http/ip-ranges.ts addressKey): IPv6 by
// its /64, so the addresses of one line are one caller.
//
// Next to that hard lock, a brake per typed email counts failures from
// every address: past 50 within the same 15-minute forgiveness window, the
// email gets at most one password check every 2.5 s and one at a time,
// whatever the number of addresses (more answer RATE_LIMITED, nothing waits
// in the panel), and the account's owner gets one security_change alert per
// streak. Addresses that gave the right password for the email in the last
// 30 days skip the brake, so a campaign against the owner's email does not
// keep the owner out; they still have their own per-address lock.
//
// Keyed by address, so a stranger who types wrong passwords for the owner's
// email only locks themselves out, never the owner. Keyed by the email as
// typed (account or not), so a locked account and an unknown email answer
// the same way and the lock tells nobody which emails exist. Kept in memory
// per panel database: a panel restart forgives every streak, which is fine
// for a brake (the strict per-address rate limit still applies).

import { OpError } from "@seylo/ops";
import type { PanelDb } from "../db/client";
import { addressKey } from "../http/ip-ranges";

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
  return `email:${email.trim().toLowerCase()}|${addressKey(ip)}`;
}

/** Key for codes and passwords checked for a known account (2FA step, account security). */
export function userKey(userId: string, ip: string | null): string {
  return `user:${userId}|${addressKey(ip)}`;
}

/** Throws RATE_LIMITED while `key` is locked. */
export function assertNotLocked(db: PanelDb, key: string, now = Date.now()): void {
  const streak = streaks(db).get(key);
  if (streak && streak.lockedUntil > now) {
    const seconds = Math.ceil((streak.lockedUntil - now) / 1000);
    throw new OpError("RATE_LIMITED", `Too many failed sign-ins. Try again in ${seconds} seconds.`, {
      retryAfter: String(seconds),
      reason: "locked",
    });
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

/** The per-email brake; tests change the numbers. */
export const softThrottle = { failures: 50, intervalMs: 2500 };
const goodAddressTtlMs = 30 * 24 * 60 * 60 * 1000;

interface AccountStreak {
  failures: number;
  lastFailureAt: number;
  alerted: boolean;
  /** When the next password check may start while the brake is on. */
  nextCheckAt: number;
}

interface AccountState {
  streaks: Map<string, AccountStreak>;
  /** Password checks running per email (only counted while the brake is on). */
  inFlight: Map<string, number>;
  /** "email|address group" -> when the right password last came from there. */
  goodAddresses: Map<string, number>;
}

const accountsByPanel = new WeakMap<PanelDb, AccountState>();

function state(db: PanelDb): AccountState {
  let value = accountsByPanel.get(db);
  if (!value) {
    value = { streaks: new Map(), inFlight: new Map(), goodAddresses: new Map() };
    accountsByPanel.set(db, value);
  }
  return value;
}

function accounts(db: PanelDb): Map<string, AccountStreak> {
  return state(db).streaks;
}

function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

function liveAccountStreak(db: PanelDb, email: string, now: number): AccountStreak | null {
  const streak = accounts(db).get(accountKey(email));
  return streak && now - streak.lastFailureAt <= maxLockMs ? streak : null;
}

/** Whether the per-email brake is on for this email. */
export function accountBraked(db: PanelDb, email: string, now = Date.now()): boolean {
  const streak = liveAccountStreak(db, email, now);
  return !!streak && streak.failures > softThrottle.failures;
}

/** Remembers that `ip` gave the right password for `email`; that address group skips the brake. */
export function rememberGoodAddress(db: PanelDb, email: string, ip: string | null, now = Date.now()): void {
  const map = state(db).goodAddresses;
  const key = `${accountKey(email)}|${addressKey(ip)}`;
  map.delete(key);
  map.set(key, now);
  while (map.size > maxEntries) map.delete(map.keys().next().value as string);
}

function knownGood(db: PanelDb, email: string, ip: string | null, now: number): boolean {
  const at = state(db).goodAddresses.get(`${accountKey(email)}|${addressKey(ip)}`);
  return at !== undefined && now - at <= goodAddressTtlMs;
}

/**
 * Call before checking a password for `email`. While the brake is on it
 * lets one check start every softThrottle.intervalMs and one run at a time,
 * and throws RATE_LIMITED (with retryAfter) for the rest, so the number of
 * addresses buys no extra guesses. Returns the function to call when the
 * check finished (in a finally).
 */
export function beginPasswordCheck(db: PanelDb, email: string, ip: string | null, now = Date.now()): () => void {
  const streak = liveAccountStreak(db, email, now);
  if (!streak || streak.failures <= softThrottle.failures || knownGood(db, email, ip, now)) return () => {};
  const key = accountKey(email);
  const running = state(db).inFlight;
  const busy = (running.get(key) ?? 0) > 0;
  if (busy || now < streak.nextCheckAt) {
    const seconds = Math.max(1, Math.ceil((Math.max(streak.nextCheckAt, now + 1) - now) / 1000));
    throw new OpError("RATE_LIMITED", `Too many failed sign-ins for this email. Try again in ${seconds} seconds.`, {
      retryAfter: String(seconds),
      reason: "accountBrake",
    });
  }
  streak.nextCheckAt = now + softThrottle.intervalMs;
  running.set(key, 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running.delete(key);
  };
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
    : { failures: 1, lastFailureAt: now, alerted: false, nextCheckAt: 0 };
  const alert = streak.failures > softThrottle.failures && !streak.alerted;
  if (alert) streak.alerted = true;
  map.delete(key);
  map.set(key, streak);
  while (map.size > maxEntries) map.delete(map.keys().next().value as string);
  return alert;
}
