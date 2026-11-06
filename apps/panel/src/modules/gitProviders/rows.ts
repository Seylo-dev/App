// Stored git provider connections: loading one, its sealed token, which
// services use it and the op shape.

import { OpError, type gitProviders as providerOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { gitProviders, services } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";

export type ProviderRow = typeof gitProviders.$inferSelect;
export type Provider = Static<typeof providerOps.Provider>;

/** Bitbucket Cloud's fixed addresses. */
export const bitbucketWeb = "https://bitbucket.org";
export const bitbucketApi = "https://api.bitbucket.org/2.0";
export const gitlabCom = "https://gitlab.com";

export function loadProvider(db: PanelDb, providerId: string, field = "providerId"): ProviderRow {
  const row = db.select().from(gitProviders).where(eq(gitProviders.id, providerId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No git provider connection with this id.", { field });
  return row;
}

/** host[:port] of the connection: where clones and API calls go. */
export function providerHost(row: Pick<ProviderRow, "url">): string {
  return new URL(row.url).host.toLowerCase();
}

export function openToken(secrets: SecretBox, row: ProviderRow): string {
  const token = secrets.open(row.tokenSealed, "git.provider");
  if (token === null)
    throw new OpError("CONFLICT", `The token of "${row.name}" cannot be opened. Enter it again in Settings > Git providers.`);
  return token;
}

/** Services (previews included) whose source uses each connection. */
export function providerUsage(db: PanelDb, providerId?: string): Map<string, number> {
  const source = sql<string | null>`json_extract(${services.spec}, '$.source.providerId')`;
  const rows = db
    .select({ source })
    .from(services)
    .where(providerId ? sql`${source} = ${providerId}` : sql`${source} is not null`)
    .all();
  const out = new Map<string, number>();
  for (const r of rows) if (r.source) out.set(r.source, (out.get(r.source) ?? 0) + 1);
  return out;
}

export function toProvider(row: ProviderRow, usedBy: number, full: boolean): Provider {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    host: providerHost(row),
    workspace: row.workspace,
    authKind: row.authKind,
    account: full ? row.account : null,
    username: full ? row.username : null,
    statusNotes: row.statusNotes,
    usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
