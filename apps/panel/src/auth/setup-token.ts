// The one-time setup link (/setup?t=<token>) that creates the owner.
//
// The installer generates the token and writes it to <dataDir>/setup-token
// (one line, mode 0600) before the panel's first start, then prints the
// link. On start, while no owner exists, the panel imports that token
// (valid one hour from then) or, when the file is missing or its token
// expired, writes a fresh one there. `bun scripts/setup-link.ts` issues a
// new one by hand. Creating the owner burns the token and deletes the file.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { setupTokens, users } from "../db/schema";
import type { Logger } from "../logger";
import { hashToken, prefixedToken } from "../security/tokens";

export const setupTokenTtlMs = 60 * 60 * 1000;
export const setupTokenFileName = "setup-token";

export function ownerExists(db: PanelDb): boolean {
  return db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).get() !== undefined;
}

/** A new token, replacing every unused one (only the newest link works). */
export function issueSetupToken(db: PanelDb, now = new Date(), token = prefixedToken("setup")): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + setupTokenTtlMs);
  db.transaction((tx) => {
    tx.delete(setupTokens).where(isNull(setupTokens.usedAt)).run();
    tx.insert(setupTokens)
      .values({ tokenHash: hashToken(token), expiresAt, createdAt: now })
      .run();
  });
  return { token, expiresAt };
}

/** The usable token row, or undefined (unknown, used or expired). */
export function validSetupToken(db: PanelDb, token: string, now = new Date()) {
  return db
    .select()
    .from(setupTokens)
    .where(and(eq(setupTokens.tokenHash, hashToken(token)), isNull(setupTokens.usedAt), gt(setupTokens.expiresAt, now)))
    .get();
}

export function burnSetupToken(db: PanelDb, id: string, now = new Date()): void {
  db.update(setupTokens).set({ usedAt: now }).where(eq(setupTokens.id, id)).run();
}

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, setupTokenFileName);
}

export function removeSetupTokenFile(dataDir: string): void {
  rmSync(setupTokenPath(dataDir), { force: true });
}

/**
 * Makes sure a usable setup link exists while there is no owner (see the
 * header). Does nothing when the data dir does not exist (tests).
 */
export function prepareSetupLink(db: PanelDb, dataDir: string, logger: Logger, now = new Date()): void {
  if (!existsSync(dataDir)) return;
  const path = setupTokenPath(dataDir);
  if (ownerExists(db)) {
    removeSetupTokenFile(dataDir);
    return;
  }
  const fromFile = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (fromFile) {
    if (validSetupToken(db, fromFile, now)) return;
    const known = db
      .select({ id: setupTokens.id })
      .from(setupTokens)
      .where(eq(setupTokens.tokenHash, hashToken(fromFile)))
      .get();
    if (!known) {
      issueSetupToken(db, now, fromFile);
      logger.info({ path }, "imported the installer's setup link token; open /setup?t=<token> within an hour");
      return;
    }
  }
  const { token } = issueSetupToken(db, now);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  logger.info({ path }, "no owner yet: wrote a new setup link token; open /setup?t=<token> within an hour");
}
