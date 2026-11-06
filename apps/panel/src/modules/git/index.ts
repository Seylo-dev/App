// Git credentials for hosts other than the GitHub App (HTTPS tokens and SSH
// deploy keys, sealed), host key scanning and branch listing for generic git
// sources.

import { git as gitOps, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { gitCredentials } from "../../db/schema";
import { implement } from "../../ops/implement";
import { defineModule } from "../module";
import { assertSourceAllowed } from "../services/source-guard";
import { blockedMessage, checkTarget } from "../uptime/targets";
import { credentialUsage, loadCredential, openCredential, toCredential } from "./credentials";
import { generateDeployKey, listRemoteRefs, publicKeyOf, scanHostKeys, targetUrl } from "./remote";

// Everyone signed in sees names and hosts for the source picker; the account
// details stay with people who manage credentials (git.manage). Attaching one
// is checked separately (services/source-guard.ts).
const listCredentials = implement(gitOps.listCredentials, (_input, ctx) => {
  const usage = credentialUsage(ctx.db);
  const rows = ctx.db.select().from(gitCredentials).orderBy(gitCredentials.name).all();
  const full = ctx.access.can("git.manage");
  return {
    items: rows.map((r) => {
      const item = toCredential(r, usage.get(r.id) ?? 0);
      return full ? item : { ...item, username: null, publicKey: null, fingerprint: null, knownHosts: "" };
    }),
  };
});

const createCredential = implement(gitOps.createCredential, (input, ctx) => {
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
  const row = ctx.db
    .insert(gitCredentials)
    .values({
      name: input.name.trim(),
      kind: input.kind,
      host: input.host.toLowerCase(),
      username: input.kind === "token" ? input.username?.trim() || null : null,
      secretSealed: ctx.secrets.seal(secret, "git.credential"),
      knownHosts: input.knownHosts?.trim() || null,
      publicKey,
      fingerprint,
      origin: "manual",
      createdBy: userOf(ctx.principal)?.id ?? null,
    })
    .returning()
    .get();
  return toCredential(row, 0);
});

const generateSshKey = implement(gitOps.generateSshKey, (input, ctx) => {
  const key = generateDeployKey(input.name);
  const row = ctx.db
    .insert(gitCredentials)
    .values({
      name: input.name.trim(),
      kind: "ssh_key",
      host: input.host.toLowerCase(),
      secretSealed: ctx.secrets.seal(key.privateKey, "git.credential"),
      knownHosts: input.knownHosts?.trim() || null,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      origin: "generated",
      createdBy: userOf(ctx.principal)?.id ?? null,
    })
    .returning()
    .get();
  return toCredential(row, 0);
});

const updateCredential = implement(gitOps.updateCredential, (input, ctx) => {
  const row = loadCredential(ctx.db, input.credentialId);
  const changes: Partial<typeof gitCredentials.$inferInsert> = {};
  if (input.name !== undefined) changes.name = input.name.trim();
  if (input.knownHosts !== undefined) changes.knownHosts = input.knownHosts.trim() || null;
  if (input.username !== undefined) {
    if (row.kind !== "token") throw new OpError("BAD_REQUEST", "Only token credentials have a user name.", { field: "username" });
    changes.username = input.username?.trim() || null;
  }
  if (input.token !== undefined) {
    if (row.kind !== "token")
      throw new OpError("BAD_REQUEST", "This is an SSH key credential; replace its private key instead.", { field: "token" });
    changes.secretSealed = ctx.secrets.seal(input.token.trim(), "git.credential");
  }
  if (input.privateKey !== undefined) {
    if (row.kind !== "ssh_key")
      throw new OpError("BAD_REQUEST", "This is a token credential; replace its token instead.", { field: "privateKey" });
    const pub = publicKeyOf(input.privateKey, changes.name ?? row.name);
    if (!pub)
      throw new OpError("BAD_REQUEST", "This private key cannot be read. Use an OpenSSH or PEM key without a passphrase.", {
        field: "privateKey",
      });
    changes.secretSealed = ctx.secrets.seal(`${input.privateKey.trim()}\n`, "git.credential");
    changes.publicKey = pub.publicKey;
    changes.fingerprint = pub.fingerprint;
    changes.origin = "manual";
  }
  const updated =
    Object.keys(changes).length === 0
      ? row
      : ctx.db.update(gitCredentials).set(changes).where(eq(gitCredentials.id, row.id)).returning().get();
  return toCredential(updated, credentialUsage(ctx.db, row.id).get(row.id) ?? 0);
});

const deleteCredential = implement(gitOps.deleteCredential, (input, ctx) => {
  const row = loadCredential(ctx.db, input.credentialId);
  const used = credentialUsage(ctx.db, row.id).get(row.id) ?? 0;
  if (used > 0) throw new OpError("CONFLICT", `${used} service(s) still clone with "${row.name}". Change their source first.`);
  ctx.db.delete(gitCredentials).where(eq(gitCredentials.id, row.id)).run();
  return {};
});

const scan = implement(gitOps.scanHostKeys, (input) => scanHostKeys(input.host));

const branches = implement(gitOps.branches, async (input, ctx) => {
  // The same rules as saving the source: own host, and attachable in this project.
  if (input.credentialId) assertSourceAllowed(ctx, input.projectId, { type: "git", url: input.url, credentialId: input.credentialId }, "");
  const auth = input.credentialId ? openCredential(ctx.db, ctx.secrets, input.credentialId) : {};
  // The panel itself makes this request: members cannot point it inside the panel's network.
  // Admins (root on the nodes anyway) may list a git server on a private network.
  const target = await checkTarget(ctx, targetUrl(input.url), ctx.access.can("git.manage") ? { allowInternal: true } : {});
  if (!target.ok) {
    throw new OpError("BAD_REQUEST", blockedMessage(target), {
      field: "url",
      reason: target.reason === "unresolvable" ? "unresolvable" : "internalTarget",
    });
  }
  const refs = await listRemoteRefs(input.url, auth, { address: target.address, byName: target.byName });
  return { branches: refs.branches.slice(0, 1000), defaultBranch: refs.defaultBranch };
});

export default defineModule({
  name: "git",
  ops: [listCredentials, createCredential, generateSshKey, updateCredential, deleteCredential, scan, branches],
});
