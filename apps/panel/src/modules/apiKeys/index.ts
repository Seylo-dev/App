// API keys and MCP tokens: create (secret shown once), list, revoke.
// Authenticating with them is auth/api-keys.ts, run by the op pipeline.
// Contracts: packages/ops/src/ops/apiKeys.ts.

import { slug } from "@seylo/brand";
import { actionCatalog, allOps, expandActionEntry, apiKeys as keyOps, OpError } from "@seylo/ops";
import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { requireFreshSignIn } from "../../auth/fresh";
import type { PanelDb } from "../../db/client";
import { apiKeys, mcpClients, projects, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { hashToken, prefixedToken } from "../../security/tokens";
import { raiseSecurityChange } from "../alerts/security";
import { defineModule } from "../module";

type KeyRow = typeof apiKeys.$inferSelect;

const dayMs = 24 * 60 * 60 * 1000;
let knownActions: string[] | undefined;

/** Every entry must be "*", "<area>.*" for a real area, or a real action. */
export function checkActions(actions: readonly string[]): string[] {
  knownActions ??= actionCatalog(allOps).map((info) => info.action);
  const unique = [...new Set(actions)];
  for (const entry of unique) {
    if (expandActionEntry(entry, knownActions).length === 0) {
      throw new OpError("BAD_REQUEST", `"${entry}" is not a known action.`, { field: "actions", action: entry });
    }
  }
  return unique;
}

function toKeys(db: PanelDb, rows: KeyRow[]) {
  const ownerIds = [...new Set(rows.map((r) => r.userId))];
  const clientIds = [...new Set(rows.map((r) => r.mcpClientId).filter((id): id is string => id !== null))];
  const owners = new Map(
    ownerIds.length
      ? db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, ownerIds))
          .all()
          .map((u) => [u.id, u])
      : [],
  );
  const clients = new Map(
    clientIds.length
      ? db
          .select({ id: mcpClients.id, name: mcpClients.name })
          .from(mcpClients)
          .where(inArray(mcpClients.id, clientIds))
          .all()
          .map((c) => [c.id, c.name])
      : [],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    actions: row.actions,
    projectIds: row.projectIds ?? null,
    readOnly: row.readOnly,
    mcpClient: (row.mcpClientId && clients.get(row.mcpClientId)) || null,
    owner: owners.get(row.userId) ?? { id: row.userId, email: "" },
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

function isAdmin(ctx: OpContext): boolean {
  return ctx.principal.type !== "anonymous" && (ctx.principal.user.role === "owner" || ctx.principal.user.role === "admin");
}

/** Projects a key is narrowed to; NOT_FOUND when one does not exist. */
export function checkProjects(db: PanelDb, projectIds: readonly string[] | undefined): string[] | null {
  if (!projectIds) return null;
  const found = db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]))
    .all();
  const missing = projectIds.find((id) => !found.some((p) => p.id === id));
  if (missing) throw new OpError("NOT_FOUND", "One of the chosen projects does not exist.", { projectId: missing });
  return [...projectIds];
}

/** Creates a key row; the token is returned once and only its hash is stored. Callers check actions and projects. */
export function insertApiKey(
  db: PanelDb,
  key: {
    userId: string;
    kind: "api" | "mcp";
    name: string;
    actions: string[];
    projectIds: string[] | null;
    readOnly: boolean;
    expiresAt: Date | null;
  },
  now = new Date(),
): { row: KeyRow; token: string } {
  const token = prefixedToken(key.kind === "mcp" ? "mcp" : "key");
  const prefixLength = `${slug}_key_`.length + 4;
  const row = db
    .insert(apiKeys)
    .values({
      userId: key.userId,
      kind: key.kind,
      name: key.name.trim(),
      prefix: token.slice(0, prefixLength),
      tokenHash: hashToken(token),
      actions: key.actions,
      projectIds: key.projectIds,
      readOnly: key.readOnly,
      expiresAt: key.expiresAt,
      createdAt: now,
    })
    .returning()
    .get();
  return { row, token };
}

const create = implement(keyOps.create, (input, ctx) => {
  // Only sessions create keys, so a leaked key can never mint another one, and only
  // right after a sign-in or a re-auth, so a session left open cannot either.
  const { userId, user } = requireFreshSignIn(ctx);
  const actions = checkActions(input.actions);
  const projectIds = checkProjects(ctx.db, input.projectIds);
  const now = new Date();
  const { row, token } = insertApiKey(
    ctx.db,
    {
      userId,
      kind: input.kind,
      name: input.name,
      actions,
      projectIds,
      readOnly: input.readOnly ?? input.kind === "mcp",
      expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * dayMs) : null,
    },
    now,
  );
  raiseSecurityChange(ctx, user, `created the ${input.kind === "mcp" ? "MCP token" : "API key"} ${row.name}`);
  return { key: toKeys(ctx.db, [row])[0] as ReturnType<typeof toKeys>[number], token };
});

const list = implement(keyOps.list, (input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  // A key acts as its owner, narrowed to its scope: everyone's keys are for an admin's own session.
  if (input.all && !(isAdmin(ctx) && ctx.principal.type === "session")) {
    throw new OpError("FORBIDDEN", "Only owners and admins, signed in in the browser, can see everyone's keys.");
  }
  const filters: SQL[] = [];
  if (!input.all) filters.push(eq(apiKeys.userId, ctx.principal.user.id));
  if (input.kind) filters.push(eq(apiKeys.kind, input.kind));
  if (!input.includeRevoked) filters.push(isNull(apiKeys.revokedAt));
  const rows = ctx.db
    .select()
    .from(apiKeys)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(apiKeys.createdAt))
    .all();
  return { keys: toKeys(ctx.db, rows) };
});

const revoke = implement(keyOps.revoke, (input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const row = ctx.db.select().from(apiKeys).where(eq(apiKeys.id, input.keyId)).get();
  const mine = row?.userId === ctx.principal.user.id;
  // A key may revoke itself; managing other keys needs a browser session.
  const allowed = ctx.principal.type === "apiKey" ? ctx.principal.keyId === input.keyId : mine || isAdmin(ctx);
  if (!row || !allowed) throw new OpError("NOT_FOUND", "That key does not exist.");
  if (!row.revokedAt) ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id)).run();
  return {};
});

export default defineModule({
  name: "apiKeys",
  ops: [create, list, revoke],
});
