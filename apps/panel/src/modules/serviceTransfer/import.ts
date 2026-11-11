// The import ops: importBegin opens and checks the file's small entries
// (nothing is created), setChoices and importPreview show what would be
// created, import creates it in one transaction, uploadTicket hands out
// links for the parts of the uploaded archive and the volumes' data
// (import-data.ts), getImport tells a reloaded page where it stands and
// discardImport throws it away.

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { Value } from "@sinclair/typebox/value";
import { eq } from "drizzle-orm";
import { ticketsFor } from "../../agent-hub/relay";
import { requireFreshIfSession } from "../../auth/fresh";
import { userOf } from "../../auth/principal";
import {
  deployments,
  gitCredentials,
  gitProviders,
  type ImportEntry,
  projects,
  registryCredentials,
  serviceImports,
  services,
} from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { ensurePanelId } from "../../settings";
import { nodeHasCapability } from "../databases/capability";
import { queueDeploy } from "../deployments/queue";
import { releases } from "../domains/acme-hold";
import { hashBasicAuthPassword } from "../domains/checks";
import { checkHost, dnsLookups } from "../domains/dns";
import { getNode, placedNode } from "../domains/lookup";
import { enqueueOriginCheck, originApplies, originCapability } from "../domains/origin";
import { readProjectEnv, writeProjectEnv } from "../env/store";
import { openFirstRun } from "../exposures/logic";
import { assertGitSourceTarget, gitCaller } from "../git/targets";
import { accountById } from "../github/account";
import { panelBaseUrl } from "../github/app";
import { ensureRepoHook } from "../github/repo-hooks";
import { ensureHook } from "../gitProviders/hooks";
import { deleteServiceTree } from "../services/delete";
import { actorOf, publishService } from "../services/ops";
import { materializeService } from "../services/portable";
import { loadService, toDetail } from "../services/rows";
import { assertSourceAllowed } from "../services/source-guard";
import { readSpec } from "../services/spec";
import { syncSchedule } from "../uptime/checks";
import { assertTarget } from "../uptime/index";
import { deployTriggerPath } from "../webhooks/trigger";
import { aadFor, assertPassphrase, checkKdf, decryptSecrets, deriveKeys, type SecretsEnvelope, verifyManifest } from "./crypto";
import { checkDocument, checkManifest, manifestEntry } from "./document";
import { volumeEntryName } from "./export";
import { closeSessions, entriesNow } from "./import-data";
import { sourceFor } from "./mapping";
import { type ImportRow, mergeSharedLines, type Opened, planImport } from "./plan";
import type { ServiceSecrets } from "./snapshot";
import { forgetOpened, loadImport, openedOf } from "./store";

export const importPath = "/api/transfer/import";
/** A file opened by importBegin may be reviewed this long. */
export const previewingMs = 24 * 60 * 60_000;
/** An import that waits for its archive is given up this long after its last progress. */
export const receivingMs = 48 * 60 * 60_000;

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

function tampered(message: string): OpError {
  return new OpError("BAD_REQUEST", message, { reason: "tampered" });
}

/** The person who began an import is the only one who goes on with it. */
function assertOwnImport(ctx: OpContext, row: ImportRow): void {
  const user = userOf(ctx.principal);
  if (row.createdBy !== null && row.createdBy !== user?.id) {
    throw new OpError("FORBIDDEN", "Someone else started this import.", { reason: "notYours" });
  }
}

/** Where the parts of an imported archive collect until the last one is in. */
export function partPath(deps: Pick<Deps, "config">, importId: string): string {
  return join(deps.config.dataDir, "uploads", `import-${importId}.part`);
}

/**
 * Every volume archive the manifest lists is the data of a volume the
 * document names (and the other way round), with the counts its import is
 * limited by; and no archive says it unpacks to more than gzip can reach.
 */
function checkVolumeEntries(manifest: transferOps.PortableManifestV1, doc: transferOps.PortableServiceV1): void {
  const named = new Map(doc.volumes.filter((v) => v.data !== null).map((v) => [v.data as string, v.name]));
  for (const v of doc.volumes) {
    if (v.data !== null && v.data !== volumeEntryName(doc.name, v.name))
      throw new OpError("BAD_REQUEST", `The data of volume ${v.name} has another name in service.json than an export gives it.`, {
        reason: "badDocument",
      });
  }
  for (const entry of manifest.entries) {
    if (!transferOps.entryPatterns.volume.test(entry.path)) continue;
    if (!named.has(entry.path)) throw tampered(`${entry.path} is the data of no volume in service.json.`);
    if (entry.unpackedBytes === undefined)
      throw new OpError("BAD_REQUEST", `manifest.json gives no unpacked size for ${entry.path}.`, { reason: "badManifest" });
    if (entry.unpackedBytes > entry.size * transferOps.transferLimits.maxRatio + 16 * 1024 * 1024)
      throw new OpError("BAD_REQUEST", `manifest.json says ${entry.path} unpacks to more than gzip can make of it.`, {
        reason: "badManifest",
      });
  }
  for (const path of named.keys()) manifestEntry(manifest, path);
}

export const importBegin = implement(transferOps.importBegin, async (input, ctx) => {
  if (!ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.", { field: "projectId" });
  }
  const manifest = checkManifest(input.manifest);
  const manifestBytes = Buffer.from(input.manifest, "utf8");
  const service = manifest.services[0] as (typeof manifest.services)[number];
  let raw: unknown;
  let secrets: ServiceSecrets | null = null;
  if (manifest.secrets === "encrypted") {
    if (!input.secretsEnc) throw new OpError("BAD_REQUEST", "Send the file's secrets.enc too.", { field: "secretsEnc" });
    const entry = manifestEntry(manifest, transferOps.entryPatterns.secrets);
    if (Buffer.byteLength(input.secretsEnc) !== entry.size || sha256(input.secretsEnc) !== entry.sha256)
      throw tampered("secrets.enc does not match the file's manifest.");
    let envelope: SecretsEnvelope;
    try {
      envelope = JSON.parse(input.secretsEnc) as SecretsEnvelope;
    } catch {
      throw tampered("secrets.enc is damaged.");
    }
    if (!Value.Check(transferOps.SecretsEnvelopeV1, envelope)) throw tampered("secrets.enc is damaged.");
    checkKdf(envelope.kdf);
    if (!input.passphrase)
      throw new OpError("BAD_REQUEST", "This file is encrypted: type its passphrase.", { field: "passphrase", reason: "passphrase" });
    const keys = await deriveKeys(input.passphrase, envelope.kdf);
    assertPassphrase(keys, envelope.kdf);
    verifyManifest(manifestBytes, input.signature, keys.macKey);
    let plain: unknown;
    try {
      plain = JSON.parse(decryptSecrets(envelope, keys, aadFor(manifest.services)));
    } catch (error) {
      if (error instanceof OpError) throw error;
      throw tampered("secrets.enc is damaged.");
    }
    if (!Value.Check(transferOps.PortableSecretsV1, plain))
      throw new OpError("BAD_REQUEST", "secrets.enc does not fit the format.", { reason: "badDocument" });
    const own = plain.services[service.name];
    if (!own) throw new OpError("BAD_REQUEST", "secrets.enc holds nothing for the file's service.", { reason: "badDocument" });
    raw = own.doc;
    secrets = { ...own, doc: null };
  } else {
    const path = `services/${service.name}/service.json`;
    const sent = input.services?.find((s) => s.path === path);
    if (!sent) throw new OpError("BAD_REQUEST", `Send the file's ${path} too.`, { field: "services" });
    const entry = manifestEntry(manifest, path);
    if (Buffer.byteLength(sent.json) !== entry.size || sha256(sent.json) !== entry.sha256)
      throw tampered(`${path} does not match the file's manifest.`);
    try {
      raw = JSON.parse(sent.json);
    } catch {
      throw new OpError("BAD_REQUEST", `${path} is not JSON.`, { reason: "badDocument" });
    }
  }
  const checked = checkDocument(raw, service);
  const upload = checked.doc.upload;
  if (upload) {
    const entry = manifestEntry(manifest, upload.entry);
    if (upload.entry !== `services/${service.name}/source/upload.tar.gz` || entry.size !== upload.sizeBytes) {
      throw new OpError("BAD_REQUEST", "The uploaded archive in service.json does not match the manifest.", { reason: "badDocument" });
    }
  }
  checkVolumeEntries(manifest, checked.doc);
  const opened: Opened = { manifest, doc: checked.doc, secrets, unknownSettings: checked.unknownSettings, skipped: checked.skipped };
  const now = new Date();
  const row = ctx.db
    .insert(serviceImports)
    .values({
      projectId: input.projectId,
      docSealed: ctx.secrets.seal(JSON.stringify(opened), "service.import"),
      manifestSha256: sha256(manifestBytes),
      choices: {},
      entries: [],
      panelVersion: manifest.panel.version,
      secrets: manifest.secrets,
      samePanel: manifest.panel.id === ensurePanelId(ctx.db),
      createdBy: userOf(ctx.principal)?.id ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + previewingMs),
    })
    .returning()
    .get();
  ctx.auditDetails?.({
    importId: row.id,
    service: service.name,
    kind: service.kind,
    panelVersion: manifest.panel.version,
    secrets: manifest.secrets,
    samePanel: row.samePanel,
    manifestSha256: row.manifestSha256,
  });
  return planImport(ctx, row, opened, {}).preview;
});

export const setChoices = implement(transferOps.setChoices, (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  const opened = openedOf(ctx, row);
  const plan = planImport(ctx, row, opened, input.choices);
  // The normalised set, so a later preview and the import see exactly what this one showed.
  ctx.db.update(serviceImports).set({ choices: plan.preview.choices }).where(eq(serviceImports.id, row.id)).run();
  ctx.auditDetails?.({ importId: row.id, choices: plan.preview.choices });
  return plan.preview;
});

export const importPreview = implement(transferOps.importPreview, (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  return planImport(ctx, row, openedOf(ctx, row), row.choices as transferOps.ImportChoices).preview;
});

const blockerCodes: Record<string, "CONFLICT" | "FORBIDDEN" | "BAD_REQUEST"> = {
  permission: "FORBIDDEN",
  references: "CONFLICT",
  badDocument: "BAD_REQUEST",
};

export const importService = implement(transferOps.importService, async (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  requireFreshIfSession(ctx);
  const opened = openedOf(ctx, row);
  const plan = planImport(ctx, row, opened, row.choices as transferOps.ImportChoices);
  const [blocker] = plan.preview.blockers;
  if (blocker)
    throw new OpError(blockerCodes[blocker.reason] ?? "CONFLICT", blocker.message, {
      reason: blocker.reason,
      ...(blocker.field ? { field: blocker.field } : {}),
    });
  const [need] = plan.preview.needs;
  if (need) throw new OpError("CONFLICT", need.message, { reason: "needs", ...(need.field ? { field: need.field } : {}) });

  // New basic auth passwords for domains whose file had none.
  const m = plan.materialize;
  for (const [key, users] of plan.passwordsNeeded) {
    const domain = m.domains.find((d) => `${d.host}${d.pathPrefix ?? "/"}` === key);
    if (!domain) continue;
    const hashed: { username: string; hash: string }[] = [];
    for (const username of users) {
      const given = input.passwords?.find((p) => `${p.host}${p.pathPrefix}` === key && p.username === username);
      if (!given)
        throw new OpError("BAD_REQUEST", `Type a new password for ${username} on ${domain.host}, or skip the domain.`, {
          field: "passwords",
          reason: "password",
        });
      hashed.push({ username, hash: await hashBasicAuthPassword(given.password) });
    }
    domain.middlewares = { ...domain.middlewares, basicAuth: { users: hashed } };
  }
  // Uptime targets are checked like uptime.create does, before anything is written.
  const refusedTargets = new Set<string>();
  for (const url of new Set(plan.checkTargets)) {
    try {
      await assertTarget(ctx, url);
    } catch {
      refusedTargets.add(url);
    }
  }
  // Custom domains get domains.add's DNS check against the import's node: one whose records still point at the old
  // panel's node waits for them before its route asks Let's Encrypt (domains/acme-hold.ts), and the re-check of
  // waiting domains (domains/recheck.ts) takes it from there. Automatic ones point at the node by their wildcard.
  const target = [placedNode(getNode(ctx.db, m.nodeId))];
  const provable = nodeHasCapability(ctx.db, ctx.agents, m.nodeId, originCapability);
  const checkedAt = new Date();
  await Promise.all(
    m.domains
      .filter((d) => !d.auto)
      .map(async (d) => {
        const dns = await checkHost(d.host, target, dnsLookups());
        d.dnsStatus = dns.status;
        d.dnsCheckedAt = checkedAt;
        d.acmeReleasedAt = releases({ forward: d.forward ?? null }, { dnsStatus: dns.status, origin: null, provable }) ? checkedAt : null;
      }),
  );
  const skipped = [...plan.preview.skipped];
  if (refusedTargets.size) {
    m.uptimeChecks = (m.uptimeChecks ?? []).filter((c) => !refusedTargets.has(c.url));
    skipped.push({ what: "Uptime checks of internal addresses", why: "Uptime checks only reach public addresses." });
  }
  if (m.spec.source.type !== "none") {
    // A credential made from the file does not exist yet: the transaction checks the source once it does.
    if (plan.credential === null) assertSourceAllowed(ctx, row.projectId, m.spec.source);
    // As services.update does for the caller, so an admin's internal git host is recorded for the project.
    await assertGitSourceTarget(ctx.db, row.projectId, m.spec.source, gitCaller(ctx));
  }

  const user = userOf(ctx.principal);
  const userId = user?.id ?? null;
  const upload = plan.pendingUpload;
  const pendingVolumes = plan.pendingVolumes;
  const created = ctx.db.transaction((tx) => {
    // Merged into what is stored now, not what the preview read: a save in between is kept.
    if (plan.sharedLines.length) {
      const shared = mergeSharedLines(readProjectEnv(tx, ctx.secrets, row.projectId).text, plan.sharedLines);
      if (shared !== null) writeProjectEnv(tx, ctx.secrets, row.projectId, shared, userId);
    }
    let spec = m.spec;
    if (plan.credential) {
      const c = plan.credential;
      const createdId =
        c.kind === "gitCredential"
          ? tx
              .insert(gitCredentials)
              .values({ ...c.values, secretSealed: ctx.secrets.seal(c.secret, "git.credential"), createdBy: userId })
              .returning({ id: gitCredentials.id })
              .get().id
          : tx
              .insert(registryCredentials)
              .values({
                name: c.name,
                server: c.login.server,
                username: c.login.username,
                passwordSealed: ctx.secrets.seal(c.login.password, "registry.credential"),
                createdBy: userId,
              })
              .returning({ id: registryCredentials.id })
              .get().id;
      spec = { ...spec, source: sourceFor(opened.doc, plan.pick, { deployOnPush: plan.preview.choices.deployOnPush ?? false, createdId }) };
      assertSourceAllowed({ db: tx, access: ctx.access }, row.projectId, spec.source);
    }
    const made = materializeService(ctx, tx, { ...m, spec, createdBy: userId });
    // The archive first: the volumes' data then goes to a node that already parks the service.
    const entries: ImportEntry[] = [
      ...(upload
        ? [
            {
              path: upload.path,
              kind: "upload" as const,
              size: upload.size,
              sha256: upload.sha256,
              status: "pending" as const,
              received: 0,
              fileName: upload.fileName,
              error: null,
            },
          ]
        : []),
      ...pendingVolumes.map((v) => ({
        path: v.path,
        kind: "volume" as const,
        size: v.size,
        sha256: v.sha256,
        status: "pending" as const,
        received: 0,
        fileName: "",
        volume: v.volume,
        maxBytes: v.maxBytes,
        maxEntries: v.maxEntries,
        error: null,
      })),
    ];
    const now = new Date();
    tx.update(serviceImports)
      .set({
        serviceId: made.id,
        status: entries.length ? "receiving" : "done",
        docSealed: null,
        entries,
        deployWhenReady: plan.deployWhenReady,
        commitSha: plan.commitSha,
        expiresAt: entries.length ? new Date(now.getTime() + receivingMs) : row.expiresAt,
        finishedAt: entries.length ? null : now,
      })
      .where(eq(serviceImports.id, row.id))
      .run();
    return { made, entries, credentialCreated: plan.credential !== null };
  });
  forgetOpened(ctx, row.id);

  const serviceId = created.made.id;
  const svc = loadService(ctx.db, serviceId);
  // Like a new app: reachable on IP:port until it has a domain, when the file had none (plan.ts says why).
  if (plan.firstRun && created.made.domains.length === 0) openFirstRun(ctx.db, serviceId);
  // The node keeps the stopped service's folders until it starts.
  ctx.agents.desired.markDirty({ serviceId });
  // Behind Cloudflare's proxy only the origin check proves a domain, once the node wrote its route (domains.add's rule).
  for (const d of created.made.domains) if (originApplies(d, d.dnsStatus)) enqueueOriginCheck(ctx, d.id);
  for (const check of created.made.uptimeChecks) syncSchedule(ctx, check, check.enabled);
  publishService(ctx, svc);
  ctx.live.publish(`project:${row.projectId}`, { type: "invalidate", ops: ["env.references", "env.getShared"] });
  // The repository webhook, as github.connectRepo and gitProviders.connectRepo make it.
  if (plan.hooks) {
    const source = readSpec(svc.spec).source;
    try {
      if (source.type === "github" && source.accountId) {
        await ensureRepoHook(ctx, { serviceId, account: accountById(ctx.db, source.accountId), repo: source.repo });
      } else if (source.type === "provider") {
        const provider = ctx.db.select().from(gitProviders).where(eq(gitProviders.id, source.providerId)).get();
        // The address the caller reached the panel at only for people who manage connections (gitProviders hookOrigin).
        const origin = ctx.access.can("gitProviders.manage") ? (ctx.origin ?? null) : null;
        if (provider) await ensureHook(ctx, { serviceId, provider, repo: source.repo, origin });
      }
    } catch (error) {
      ctx.logger.warn({ err: error, serviceId }, "creating the imported service's repository webhook failed");
    }
  }
  if (created.entries.length === 0 && plan.deployWhenReady) startImported(ctx, serviceId, plan.commitSha, actorOf(ctx), userId);

  ctx.auditDetails?.({
    importId: row.id,
    serviceId,
    name: svc.name,
    projectId: row.projectId,
    nodeId: m.nodeId,
    panelVersion: row.panelVersion,
    secrets: row.secrets,
    domains: created.made.domains.map((d) => d.host),
    skipped: skipped.map((s) => s.what),
    credentialCreated: created.credentialCreated,
    upload: upload !== null,
    volumes: pendingVolumes.map((v) => v.volume),
  });
  const base = panelBaseUrl(ctx.db);
  const triggerPath = created.made.deployTriggerToken ? `${deployTriggerPath}/${created.made.deployTriggerToken}` : null;
  return {
    service: toDetail(ctx.db, ctx.agents, loadService(ctx.db, serviceId)),
    importId: row.id,
    pending: created.entries.map((e) => ({ entry: e.path, sizeBytes: e.size, kind: e.kind ?? "upload", volume: e.volume ?? null })),
    deployTrigger: triggerPath ? { url: base ? `${base}${triggerPath}` : triggerPath } : null,
    skipped,
  };
});

/** The first deploy of an imported service, at the exported commit when it was asked for. */
export function startImported(deps: Deps, serviceId: string, commitSha: string | null, actor: string | null, userId: string | null): void {
  try {
    queueDeploy(deps, {
      serviceId,
      trigger: "manual",
      actor,
      triggeredBy: userId,
      commitSha,
      notes: commitSha ? [`Imported: building the exported commit ${commitSha.slice(0, 12)}.`] : ["Imported: the first deploy."],
    });
  } catch (error) {
    // A source that nothing reads yet: the service stays stopped and the Source tab says what is missing.
    deps.logger.info({ err: error, serviceId }, "the imported service was not deployed");
  }
}

export const uploadTicket = implement(transferOps.uploadTicket, (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  if (row.status !== "receiving" || !row.serviceId)
    throw new OpError("CONFLICT", "This import is not waiting for files.", { reason: "notReceiving" });
  const entry = entriesNow(row).find((e) => e.path === input.entry);
  if (!entry || entry.status === "done") throw new OpError("NOT_FOUND", "This import is not waiting for that entry.", { field: "entry" });
  // A volume's stream lives in the panel's memory: without it (a restart, 10 idle minutes) the entry starts over.
  if (input.offset !== 0 && input.offset !== entry.received) {
    throw new OpError("CONFLICT", `The panel has ${entry.received} bytes of it; go on from there.`, { reason: "offset", field: "offset" });
  }
  const ticket = ticketsFor(ctx).issue(
    { principal: ctx.principal, action: "services.import", serviceId: row.serviceId },
    { importId: row.id, projectId: row.projectId, entry: entry.path, offset: input.offset },
  );
  return { url: `${importPath}?t=${encodeURIComponent(ticket.ticket)}`, ticket: ticket.ticket, expiresAt: ticket.expiresAt.toISOString() };
});

export const getImport = implement(transferOps.getImport, (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  return {
    importId: row.id,
    status: row.status,
    serviceId: row.serviceId,
    manifestSha256: row.manifestSha256,
    entries: entriesNow(row).map((e) => ({
      path: e.path,
      kind: e.kind ?? "upload",
      volume: e.volume ?? null,
      size: e.size,
      sha256: e.sha256,
      status: e.status,
      received: e.received,
      error: e.error,
    })),
    deployWhenReady: row.deployWhenReady,
    expiresAt: row.expiresAt.toISOString(),
  };
});

/** Imports whose archive part is being written right now (http.ts), so a discard waits for it. */
export const uploadsRunning = new Set<string>();

export const discardImport = implement(transferOps.discardImport, async (input, ctx) => {
  const row = loadImport(ctx, input.projectId, input.importId);
  assertOwnImport(ctx, row);
  if (uploadsRunning.has(row.id))
    throw new OpError("CONFLICT", "A part of its archive is uploading right now. Try again in a moment.", { reason: "uploading" });
  const deleted = await discard(ctx, row);
  return { deletedService: deleted };
});

/**
 * Deletes an import and, while it still waits for its archive or data
 * (receiving), the service it created: nothing ran there yet. A failed import's service
 * is the owner's to keep (the sweep told them to upload the code on the
 * Source tab), and a done one is in use: for those only the record and the
 * part file go. A protected service, or one that was deployed somehow, is
 * never deleted here: CONFLICT, services.delete is the way.
 */
export async function discard(deps: Deps, row: ImportRow): Promise<boolean> {
  let deleted = false;
  // A volume's open stream ends first; its node empties what arrived.
  closeSessions(row.id, "The import was discarded.");
  if (row.status === "receiving" && row.serviceId) {
    const svc = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();
    if (svc?.protected)
      throw new OpError("CONFLICT", `${svc.name} is protected, so discarding its import does not delete it. Turn protection off first.`, {
        reason: "protected",
      });
    if (svc && deps.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.serviceId, svc.id)).get())
      throw new OpError(
        "CONFLICT",
        `${svc.name} has deployments, so discarding its import does not delete it. Delete it on its Settings tab.`,
        {
          reason: "deployed",
        },
      );
    if (svc) {
      await deleteServiceTree(deps, svc);
      deleted = true;
    }
  }
  deps.db.delete(serviceImports).where(eq(serviceImports.id, row.id)).run();
  forgetOpened(deps, row.id);
  await rm(partPath(deps, row.id), { force: true }).catch(() => undefined);
  return deleted;
}
