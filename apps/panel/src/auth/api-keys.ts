// Resolves an Authorization: Bearer token to the API key or MCP token it
// belongs to. Creating and listing keys is the people module's job.

import { and, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { apiKeys, users } from "../db/schema";
import { hashToken } from "../security/tokens";
import type { Principal } from "./principal";

export function lookupApiKey(db: PanelDb, token: string, now = new Date()): Principal | undefined {
  const row = db
    .select({
      key: apiKeys,
      user: { id: users.id, email: users.email, name: users.name, role: users.role, avatar: users.avatar, disabledAt: users.disabledAt },
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)))
    .get();
  if (!row || row.user.disabledAt) return undefined;
  if (row.key.expiresAt && row.key.expiresAt <= now) return undefined;

  // At most one write a minute per key, so a busy script does not turn every read into a write.
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > 60_000) {
    db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id)).run();
  }
  const { disabledAt: _, ...user } = row.user;
  return {
    type: "apiKey",
    user,
    keyId: row.key.id,
    keyName: row.key.name,
    keyKind: row.key.kind,
    actions: row.key.actions,
    projectIds: row.key.projectIds ?? null,
    readOnly: row.key.readOnly,
  };
}
