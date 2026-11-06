// The second factor: an authenticator app (TOTP) plus one-time recovery
// codes. Seeds are sealed ("totp.secret"). Recovery codes carry 50 bits, too
// few for a bare SHA-256 (a copy of panel.db could be brute-forced offline
// in about a day), so they are stored as HMACs under a key derived from
// master.key, which lives outside the database.

import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { recoveryCodes, totpSecrets } from "../db/schema";
import type { SecretBox } from "../security/secret-box";
import { base32Encode, verifyTotp } from "../security/totp";

export const recoveryCodeCount = 10;

export function confirmedTotp(db: PanelDb, userId: string) {
  const row = db.select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  return row?.confirmedAt ? row : undefined;
}

/** "abcde-fghij": 50 random bits each, easy to read back from paper. */
function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Replaces every recovery code of a person with new ones and returns them (shown once). */
/** What is stored for a recovery code. */
function recoveryCodeHash(secrets: SecretBox, code: string): string {
  return secrets.sign(normalizeRecoveryCode(code), "recovery-code");
}

export function issueRecoveryCodes(db: PanelDb, secrets: SecretBox, userId: string, now = new Date()): string[] {
  const codes = Array.from({ length: recoveryCodeCount }, newRecoveryCode);
  db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    tx.insert(recoveryCodes)
      .values(codes.map((code) => ({ userId, codeHash: recoveryCodeHash(secrets, code), createdAt: now })))
      .run();
  });
  return codes;
}

export function recoveryCodesLeft(db: PanelDb, userId: string): number {
  return db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all().length;
}

/** Checks an authenticator code; a code is accepted once (its step is remembered). */
export function checkTotpCode(
  db: PanelDb,
  secrets: SecretBox,
  userId: string,
  code: string,
  now = new Date(),
  requireConfirmed = true,
): boolean {
  const row = db.select().from(totpSecrets).where(eq(totpSecrets.userId, userId)).get();
  if (!row || (requireConfirmed && !row.confirmedAt)) return false;
  const secret = secrets.open(row.secretSealed, "totp.secret");
  if (!secret) return false;
  const step = verifyTotp(secret, code, now, row.lastUsedStep ?? null);
  if (step === null) return false;
  db.update(totpSecrets).set({ lastUsedStep: step }).where(eq(totpSecrets.userId, userId)).run();
  return true;
}

/** Uses up one recovery code; false when it is unknown or used. */
export function useRecoveryCode(db: PanelDb, secrets: SecretBox, userId: string, code: string, now = new Date()): boolean {
  const hash = recoveryCodeHash(secrets, code);
  const used = db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id })
    .all();
  return used.length > 0;
}

/** Either kind of code, for ops that accept "an authenticator code or a recovery code". */
export function checkAnySecondFactor(db: PanelDb, secrets: SecretBox, userId: string, code: string, now = new Date()): boolean {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) return checkTotpCode(db, secrets, userId, trimmed, now);
  return useRecoveryCode(db, secrets, userId, trimmed, now);
}

export function removeSecondFactor(db: PanelDb, userId: string): void {
  db.transaction((tx) => {
    tx.delete(totpSecrets).where(eq(totpSecrets.userId, userId)).run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  });
}
