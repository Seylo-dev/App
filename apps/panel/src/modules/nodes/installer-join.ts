// The installer's "panel + node here" mode starts the first panel before
// any node exists and writes a join token for the local agent next to the
// setup token (<data dir>/join-token, one line, 0600). While the panel has
// no nodes, start() imports it as a join token valid one hour and deletes
// the file; the local agent then joins first and becomes the panel node.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { slug } from "@seylo/brand";
import { count, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { joinTokens, nodes } from "../../db/schema";
import type { Logger } from "../../logger";
import { hashToken } from "../../security/tokens";

export const installerJoinTokenFile = "join-token";
const ttlMs = 60 * 60 * 1000;
const tokenPattern = new RegExp(`^${slug}_join_[A-Za-z0-9_-]{43}$`);

/** Returns true when a token was imported. Does nothing without a data dir (tests). */
export function importInstallerJoinToken(db: PanelDb, dataDir: string, logger: Logger, now = new Date()): boolean {
  const path = join(dataDir, installerJoinTokenFile);
  if (!existsSync(path)) return false;
  const token = readFileSync(path, "utf8").trim();
  const nodeCount = db.select({ n: count() }).from(nodes).get()?.n ?? 0;
  if (nodeCount > 0 || !tokenPattern.test(token)) {
    // Only the very first join may use it; anything else is stale or not ours.
    rmSync(path, { force: true });
    if (nodeCount === 0) logger.warn({ path }, "ignored an installer join token that does not look like one");
    return false;
  }
  const tokenHash = hashToken(token);
  if (!db.select({ id: joinTokens.id }).from(joinTokens).where(eq(joinTokens.tokenHash, tokenHash)).get()) {
    db.insert(joinTokens)
      .values({ tokenHash, createdBy: null, expiresAt: new Date(now.getTime() + ttlMs) })
      .run();
  }
  rmSync(path, { force: true });
  logger.info({ path }, "imported the installer's join token for the local node");
  return true;
}
