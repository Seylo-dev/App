// Stored git credentials: sealed secrets, the op shape, and opening one
// for a build or an access check.

import { type git as gitOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, or, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { gitCredentials, services } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import type { RemoteAuth } from "./remote";

export type GitCredentialRow = typeof gitCredentials.$inferSelect;
export type GitCredential = Static<typeof gitOps.GitCredential>;

/** Services whose source (or compose source) uses each credential, the connected GitHub account (accountId) included. */
export function credentialUsage(db: PanelDb, credentialId?: string): Map<string, number> {
  const source = sql<string | null>`json_extract(${services.spec}, '$.source.credentialId')`;
  const account = sql<string | null>`json_extract(${services.spec}, '$.source.accountId')`;
  const stack = sql<string | null>`json_extract(${services.spec}, '$.stack.source.credentialId')`;
  const rows = db
    .select({ source, account, stack })
    .from(services)
    .where(
      credentialId
        ? or(sql`${source} = ${credentialId}`, sql`${account} = ${credentialId}`, sql`${stack} = ${credentialId}`)
        : or(sql`${source} is not null`, sql`${account} is not null`, sql`${stack} is not null`),
    )
    .all();
  const out = new Map<string, number>();
  for (const r of rows) {
    for (const id of new Set([r.source, r.account, r.stack])) if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

export function toCredential(row: GitCredentialRow, usedBy: number): GitCredential {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    username: row.username,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    knownHosts: row.knownHosts ?? "",
    origin: row.origin,
    usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function loadCredential(db: PanelDb, credentialId: string): GitCredentialRow {
  const row = db.select().from(gitCredentials).where(eq(gitCredentials.id, credentialId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No git credential with this id.", { field: "credentialId" });
  return row;
}

/** The credential's secret ready for a clone or ls-remote. */
export function openCredential(
  db: PanelDb,
  secrets: SecretBox,
  credentialId: string,
): RemoteAuth & { kind: GitCredentialRow["kind"]; host: string } {
  const row = loadCredential(db, credentialId);
  const secret = secrets.open(row.secretSealed, "git.credential");
  if (secret === null) throw new OpError("CONFLICT", `The git credential "${row.name}" cannot be opened. Enter its secret again.`);
  return row.kind === "token"
    ? { kind: "token", host: row.host, token: secret, username: row.username }
    : { kind: "ssh_key", host: row.host, sshPrivateKey: secret, knownHosts: row.knownHosts };
}
