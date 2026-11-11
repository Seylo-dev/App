// Stored git credentials: sealed secrets, the op shape, and opening one
// for a build or an access check.

import { type git as gitOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, or, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { gitCredentials, services } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { checkKnownHostsFor, publicKeyOf, type RemoteAuth } from "./remote";

export type GitCredentialRow = typeof gitCredentials.$inferSelect;
export type GitCredential = Static<typeof gitOps.GitCredential>;
export type NewCredential = Static<typeof gitOps.createCredential.input>;

/**
 * What git.createCredential stores for its input, after its checks: the
 * known_hosts lines name the host, a token is given, or a private key the
 * panel can read, whose public key and fingerprint come from the key
 * itself. Imports build a credential from a file with it too. BAD_REQUEST
 * when a check fails; the caller seals `secret`.
 */
export function newCredential(input: NewCredential): {
  values: Omit<typeof gitCredentials.$inferInsert, "secretSealed" | "createdBy">;
  secret: string;
} {
  checkKnownHostsFor(input.host, input.knownHosts);
  let secret: string;
  let publicKey: string | null = null;
  let fingerprint: string | null = null;
  if (input.kind === "token") {
    if (!input.token) throw new OpError("BAD_REQUEST", "Enter the access token.", { field: "token" });
    secret = input.token.trim();
  } else {
    if (!input.privateKey) throw new OpError("BAD_REQUEST", "Paste the private key.", { field: "privateKey" });
    const pub = publicKeyOf(input.privateKey, input.name);
    if (!pub)
      throw new OpError("BAD_REQUEST", "This private key cannot be read. Use an OpenSSH or PEM key without a passphrase.", {
        field: "privateKey",
      });
    secret = `${input.privateKey.trim()}\n`;
    publicKey = pub.publicKey;
    fingerprint = pub.fingerprint;
  }
  return {
    values: {
      name: input.name.trim(),
      kind: input.kind,
      host: input.host.toLowerCase(),
      username: input.kind === "token" ? input.username?.trim() || null : null,
      knownHosts: input.knownHosts?.trim() || null,
      publicKey,
      fingerprint,
      origin: "manual",
    },
    secret,
  };
}

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
