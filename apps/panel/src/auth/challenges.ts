// Short-lived, single-use tickets for sign-in flows with more than one
// step: the second factor after a password, WebAuthn ceremonies and GitHub
// device-flow polls. The client holds the ticket; only its hash is stored,
// and expired rows are swept whenever a new one is created.

import { and, eq, lte } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { authChallenges, type ChallengePurpose } from "../db/schema";
import { hashToken, randomToken } from "../security/tokens";

/** Wrong codes before a challenge dies and the person starts over. */
export const maxChallengeAttempts = 5;

export type Challenge = typeof authChallenges.$inferSelect;

export interface NewChallenge {
  purpose: ChallengePurpose;
  userId?: string | null;
  data?: Record<string, unknown>;
  secretSealed?: string | null;
  ttlMs: number;
}

export function createChallenge(db: PanelDb, challenge: NewChallenge, now = new Date()) {
  db.delete(authChallenges).where(lte(authChallenges.expiresAt, now)).run();
  const ticket = randomToken();
  const expiresAt = new Date(now.getTime() + challenge.ttlMs);
  const row = db
    .insert(authChallenges)
    .values({
      purpose: challenge.purpose,
      userId: challenge.userId ?? null,
      tokenHash: hashToken(ticket),
      data: challenge.data ?? {},
      secretSealed: challenge.secretSealed ?? null,
      expiresAt,
      createdAt: now,
    })
    .returning()
    .get();
  return { ticket, expiresAt, row };
}

/** The live challenge for this ticket and purpose, or undefined (unknown, expired, used, other purpose). */
export function findChallenge(db: PanelDb, ticket: string, purpose: ChallengePurpose, now = new Date()): Challenge | undefined {
  const row = db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.tokenHash, hashToken(ticket)), eq(authChallenges.purpose, purpose)))
    .get();
  if (!row) return undefined;
  if (row.expiresAt <= now || row.attempts >= maxChallengeAttempts) {
    deleteChallenge(db, row.id);
    return undefined;
  }
  return row;
}

export function deleteChallenge(db: PanelDb, id: string): void {
  db.delete(authChallenges).where(eq(authChallenges.id, id)).run();
}

/** Counts a wrong answer; returns the attempts left (0 means the challenge is gone). */
export function failChallenge(db: PanelDb, challenge: Challenge): number {
  const attempts = challenge.attempts + 1;
  if (attempts >= maxChallengeAttempts) {
    deleteChallenge(db, challenge.id);
    return 0;
  }
  db.update(authChallenges).set({ attempts }).where(eq(authChallenges.id, challenge.id)).run();
  return maxChallengeAttempts - attempts;
}

export function updateChallengeData(db: PanelDb, challenge: Challenge, data: Record<string, unknown>): void {
  db.update(authChallenges)
    .set({ data: { ...challenge.data, ...data } })
    .where(eq(authChallenges.id, challenge.id))
    .run();
}
