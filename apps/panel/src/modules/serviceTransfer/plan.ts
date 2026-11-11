// What an import would create, from the opened file and the owner's
// choices: the preview the review page shows (blockers, choices still
// needed, warnings, every reference to something that already exists) and
// the rows serviceTransfer.import writes (services/portable.ts
// materializeService). Every setting from the file goes through the checks
// the ops that set it run; database and Box specs are built from their
// engine, never taken from the file.

import { parseEnv } from "@seylo/env-analyzer";
import { boxes as boxOps, databases as dbOps, OpError, type serviceTransfer as transferOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  backupDestinations,
  type DatabaseEngine,
  domains,
  nodes,
  notificationChannels,
  portExposures,
  projects,
  type serviceImports,
  services,
} from "../../db/schema";
import { normalizeCronSchedule } from "../../jobs/cron-expr";
import type { OpContext } from "../../ops/implement";
import { ensurePanelId } from "../../settings";
import { nextRun } from "../backups/runs";
import { boxWorkspaceVolume } from "../boxes/desired";
import { boxSpec } from "../boxes/ops";
import { checkSchedule } from "../cron/index";
import { nodeHasCapability } from "../databases/capability";
import { databaseSpec, engines, enginesCapability, engineVersion, generatePassword } from "../databases/engines";
import { adminPasswordSecret, retiredExposedPasswordSecret as exposedPasswordSecret } from "../databases/info";
import { hasBuildx } from "../deployments/source";
import { checkCertificate, checkRedirects, normalizeCidrs } from "../domains/checks";
import { assertCertificateNames, hostConflict } from "../domains/ownership";
import { buildEnvGraph } from "../env/graph";
import { checkEnvReferences } from "../env/ops";
import { readProjectEnv } from "../env/store";
import { plantedMessage, plantedReferences, projectEnvOf, type ReferenceEffect, renameSelf } from "../services/impact";
import { checkWatchPaths, cronSettings } from "../services/ops";
import type { Materialize } from "../services/portable";
import { gitLabel, nameKey } from "../services/rows";
import { builtAppPort, defaultSpec, type ServiceSpecJson } from "../services/spec";
import { assertTimeout } from "../uptime/index";
import { type AccessOption, accessPlan, credentialFromFile, type FileCredential, sameName, sourceFor } from "./mapping";
import { domainKey, type ServiceSecrets } from "./snapshot";

type Doc = transferOps.PortableServiceV1;
type Manifest = transferOps.PortableManifestV1;
type Choices = transferOps.ImportChoices;
export type ImportPreview = Static<typeof transferOps.ImportPreview>;
export type ImportRow = typeof serviceImports.$inferSelect;
type Issue = { reason: string; message: string; field?: string };

/** The import's file as importBegin opened it (sealed on the row). */
export interface Opened {
  manifest: Manifest;
  doc: Doc;
  /** Null when secret values were left out. */
  secrets: ServiceSecrets | null;
  unknownSettings: string[];
  skipped: { what: string; why: string }[];
}

export interface Plan {
  preview: ImportPreview;
  materialize: Omit<Materialize, "createdBy">;
  pick: AccessOption | null;
  credential: FileCredential | null;
  /** The project's shared variables to write first (null: leave them). */
  sharedEnv: string | null;
  /** Domains by key whose basic auth users need a password from the import call. */
  passwordsNeeded: Map<string, string[]>;
  /** Uptime check URLs to check against internal targets before they are created. */
  checkTargets: string[];
  /** The env text is checked for hidden references (FORBIDDEN path) at import. */
  envText: string | null;
  deployWhenReady: boolean;
  commitSha: string | null;
  /** Repository hooks to create after the transaction (sources read through an account or a provider). */
  hooks: boolean;
  pendingUpload: { path: string; size: number; sha256: string; fileName: string } | null;
}

const bcryptHash = /^\$2[aby]\$(0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$/;
const databaseKinds = new Set(Object.keys(engines));

/** "<name>", else "<name>-2" and on, cut to 40 characters, that is free in the project. */
export function importName(taken: (name: string) => boolean, base: string): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return base;
}

function message(error: unknown): string {
  return error instanceof OpError ? error.message : "It does not pass this panel's checks.";
}

export function planImport(ctx: OpContext, row: ImportRow, opened: Opened, choicesIn: Choices): Plan {
  const { doc, manifest, secrets } = opened;
  const projectId = row.projectId;
  const can = (action: `${string}.${string}`) => ctx.access.can(action, { type: "project", id: projectId });
  const blockers: Issue[] = [];
  const needs: Issue[] = [];
  const warnings: Issue[] = [];
  const skipped: { what: string; why: string }[] = [...opened.skipped];
  const noPermission = (what: string, action: string) =>
    skipped.push({ what, why: `You do not have the ${action} permission in this project.` });
  const samePanel = manifest.panel.id === ensurePanelId(ctx.db);

  if (!can("services.create"))
    blockers.push({ reason: "permission", message: "Creating a service here needs the services.create permission.", field: "projectId" });

  // Node: the one of the same name, else the first that is not disabled.
  const nodeRows = ctx.db
    .select({ id: nodes.id, name: nodes.name, wildcard: nodes.wildcardDomain })
    .from(nodes)
    .where(isNull(nodes.disabledAt))
    .orderBy(asc(nodes.name))
    .all();
  const nodeId = choicesIn.nodeId ?? nodeRows.find((n) => n.name === doc.placements[0]?.node)?.id ?? nodeRows[0]?.id ?? null;
  const node = nodeRows.find((n) => n.id === nodeId);
  if (!node)
    blockers.push({
      reason: "node",
      message: nodeRows.length ? "Pick a node that is not disabled." : "Add a node first.",
      field: "nodeId",
    });
  if (doc.placements.length > 1)
    warnings.push({
      reason: "placements",
      message: `It ran on ${doc.placements.length} nodes; it starts on one. Add the others on its Scale tab.`,
    });

  // Database and Box: what runs comes from the engine; the file only names it.
  const isDatabase = databaseKinds.has(doc.kind);
  let databaseSpecOf: ReturnType<typeof databaseSpec> | null = null;
  let dataPath: string | null = null;
  if (isDatabase) {
    const engineName = doc.kind as DatabaseEngine;
    const engine = engines[engineName];
    const db = doc.database;
    const version = db && db.engine === engineName ? engineVersion(engineName, db.version, db.variant) : null;
    if (!db || db.engine !== engineName)
      blockers.push({ reason: "badDocument", message: "The file's database settings do not match its kind." });
    else if (!version)
      blockers.push({
        reason: "engineVersion",
        message: `${engine.label} ${db.version}${db.variant ? ` with ${db.variant}` : ""} is not offered on this panel.`,
      });
    else {
      databaseSpecOf = databaseSpec(engineName, version);
      dataPath = version.dataPath;
      if (
        !Value.Check(dbOps.create.input.properties.user, db.adminUser) ||
        (engine.hasDatabase && !Value.Check(dbOps.create.input.properties.database, db.databaseName))
      ) {
        blockers.push({ reason: "badDocument", message: "The database's user or database name is not one this panel accepts." });
      }
      if (engine.redisLike && db.adminUser !== "default")
        blockers.push({ reason: "badDocument", message: `${engine.label} has one user, default.` });
      if (node && engine.needsAgentCapability && !nodeHasCapability(ctx.db, ctx.agents, node.id, enginesCapability)) {
        blockers.push({
          reason: "engine",
          message: `The agent on ${node.name} does not run ${engine.label} yet. Update the node first.`,
          field: "nodeId",
        });
      }
    }
  }
  if (doc.kind === "box" && doc.box?.repository && !Value.Check(boxOps.create.input.properties.repository, doc.box.repository)) {
    blockers.push({ reason: "badDocument", message: "The Box's repository URL is not one this panel accepts." });
  }

  // Name: the file's, else <name>-2; never one that references already wait for.
  const graph = projectEnvOf(buildEnvGraph(ctx, projectId));
  const nameTaken = (name: string) =>
    ctx.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.projectId, projectId), eq(services.nameKey, nameKey(name))))
      .get() !== undefined;
  const name = choicesIn.name ?? importName((n) => nameTaken(n) || plantedReferences(graph, n, doc.kind, "").length > 0, doc.name);
  if (nameTaken(name))
    blockers.push({ reason: "nameTaken", message: `A service named "${name}" already exists in this project.`, field: "name" });
  const planted = plantedReferences(graph, name, doc.kind, "");
  if (planted.length > 0) {
    const project = ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get()?.name ?? "";
    blockers.push({ reason: "references", message: plantedMessage(ctx, planted, project, "Pick another name."), field: "name" });
  }

  // The spec, through the checks its own ops run.
  const base = defaultSpec();
  let spec: ServiceSpecJson = {
    ...base,
    build: { ...doc.spec.build, buildNodeId: null },
    container: doc.spec.container,
    ports: doc.spec.ports,
    healthCheck: doc.spec.healthCheck,
    crashPolicy: doc.spec.crashPolicy,
    resources: doc.spec.resources,
    deploy: doc.spec.deploy,
    cron: null,
    stickySessions: doc.spec.stickySessions,
    watchPaths: [],
    previews: { enabled: false, domainPattern: "", maxPreviews: doc.spec.previews.maxPreviews },
    portEnv: true,
  };
  try {
    spec.watchPaths = checkWatchPaths(doc.spec.watchPaths);
  } catch (error) {
    warnings.push({ reason: "watchPaths", message: `Watch paths left out: ${message(error)}` });
  }
  if (doc.kind === "cron") {
    if (!doc.spec.cron) blockers.push({ reason: "badDocument", message: "A cron service needs its schedule." });
    else {
      try {
        spec.cron = cronSettings(doc.spec.cron);
      } catch (error) {
        blockers.push({ reason: "cron", message: message(error) });
      }
    }
  }
  if (doc.spec.source.type === "inline") spec.build.builder = "dockerfile";
  if (doc.buildNode) {
    const buildNode = ctx.db.select().from(nodes).where(eq(nodes.name, doc.buildNode)).get();
    if (buildNode?.canBuild && hasBuildx(ctx, buildNode.id)) spec.build.buildNodeId = buildNode.id;
    else warnings.push({ reason: "buildNode", message: `No node named ${doc.buildNode} builds here; builds pick a node automatically.` });
  }
  if (databaseSpecOf) spec = { ...spec, ...databaseSpecOf, build: base.build, watchPaths: [] };
  if (doc.kind === "box") spec = { ...spec, ...boxSpec(), build: base.build, healthCheck: null, watchPaths: [] };
  if (doc.spec.previews.enabled) skipped.push({ what: "Previews", why: "Previews arrive off; turn them on on the Previews tab." });

  // What reads the source.
  const access = accessPlan(ctx.db, doc, secrets);
  let pick: AccessOption | null = access.match ?? (access.needed ? null : (access.options.find((o) => o.kind === "none") ?? null));
  if (choicesIn.sourceAccess) {
    const wanted = choicesIn.sourceAccess;
    pick = access.options.find((o) => o.kind === wanted.kind && (wanted.id === undefined || o.id === wanted.id)) ?? null;
    if (!pick)
      blockers.push({ reason: "sourceAccess", message: "That is not one of the ways to read this source.", field: "sourceAccess" });
  }
  if (access.needed && !pick && !choicesIn.sourceAccess) {
    needs.push({
      reason: "sourceAccess",
      message: `Nothing on this panel matches ${access.wanted ?? "what read the source"}. Pick what reads it, or import without it (deploys fail until you connect one).`,
      field: "sourceAccess",
    });
  }
  let credential: FileCredential | null = null;
  if (pick?.kind === "createFromFile") {
    const registry = doc.sourceAccess?.via === "registry";
    if (!ctx.access.can(registry ? "registries.manage" : "git.manage")) {
      blockers.push({
        reason: "permission",
        message: `Creating the ${registry ? "registry login" : "git credential"} needs ${registry ? "registries.manage" : "git.manage"}.`,
        field: "sourceAccess",
      });
    }
    try {
      credential = credentialFromFile(doc, secrets);
    } catch (error) {
      blockers.push({ reason: "sourceAccess", message: message(error), field: "sourceAccess" });
    }
  }
  const deployOnPush = choicesIn.deployOnPush ?? false;
  const source = isDatabase || doc.kind === "box" ? spec.source : sourceFor(doc, pick, { deployOnPush, createdId: "pending" });
  if (!isDatabase && doc.kind !== "box") {
    spec.source = source;
    if ((doc.spec.source.type === "github" || doc.spec.source.type === "provider") && source.type === "none") {
      skipped.push({ what: "The repository source", why: "Nothing reads it here; connect one on the Source tab, then deploy." });
    }
  }
  const live = doc.live;
  const repo = doc.spec.source.type === "github" || doc.spec.source.type === "git" || doc.spec.source.type === "provider";
  const commit = choicesIn.commit ?? (repo && live?.commitSha ? "live" : "head");
  const pinDigest = choicesIn.pinDigest ?? false;
  if (pinDigest && spec.source.type === "image" && live?.imageDigest) {
    spec.source = { ...spec.source, image: `${spec.source.image.split("@")[0]}@${live.imageDigest}` };
  }

  // The .env: its own name renamed, references to what is here listed.
  const envWritable = can("env.edit") && (doc.fileMounts.length === 0 || can("files.write"));
  if (!envWritable && (doc.env.keys.length || doc.fileMounts.length))
    noPermission("Environment variables and file mounts", doc.fileMounts.length && can("env.edit") ? "files.write" : "env.edit");
  const fileEnv = secrets ? secrets.env : doc.env.keys.map((k) => `${k}=`).join("\n");
  const own = renameSelf(fileEnv, doc.name, name);
  const envText = envWritable ? own.text : null;
  const references: ReferenceEffect[] = own.renamed.map((r) => ({ ...r, effect: "renamed" as const }));
  const readsFrom: { key: string; service: string; kind: Static<typeof transferOps.ImportPreview>["env"]["readsFrom"][number]["kind"] }[] =
    [];
  const missingServices = new Set<string>();
  for (const entry of parseEnv(own.text).entries) {
    for (const ref of entry.references) {
      if (ref.target === "project" || ref.target.toLowerCase() === name.toLowerCase()) continue;
      const there = graph.services.find((s) => s.name.toLowerCase() === ref.target.toLowerCase());
      if (there) {
        if (!readsFrom.some((r) => r.key === entry.key && r.service === there.name))
          readsFrom.push({ key: entry.key, service: there.name, kind: there.kind as never });
      } else missingServices.add(ref.target);
    }
  }
  if (missingServices.size)
    warnings.push({
      reason: "missingServices",
      message: `It references ${[...missingServices].join(", ")}, which this project does not have: import ${missingServices.size === 1 ? "it" : "them"} first, or those values stay empty.`,
    });
  if (readsFrom.length)
    warnings.push({
      reason: "readsFrom",
      message: `It reads values from ${[...new Set(readsFrom.map((r) => r.service))].join(", ")} in this project. Check that ${readsFrom.length === 1 ? "it is" : "they are"} the ones it means.`,
    });
  if (!secrets && doc.env.keys.length && envWritable)
    warnings.push({
      reason: "envEmpty",
      message: `${doc.env.keys.length} environment variables arrive without values: the file left them out. Set them before it deploys.`,
    });
  if (!secrets && doc.fileMounts.length && envWritable)
    warnings.push({
      reason: "fileMountsEmpty",
      message: `${doc.fileMounts.length} file mounts arrive empty: the file left their contents out.`,
    });
  if (envText?.trim()) {
    try {
      checkEnvReferences(ctx, projectId, [name], envText);
    } catch (error) {
      blockers.push({ reason: "references", message: message(error), field: "env" });
    }
  }

  // Shared variables it reads: missing ones can be added, differing ones are kept unless overwritten.
  const sharedChoice = choicesIn.sharedVariables ?? "addMissing";
  const projectText = readProjectEnv(ctx.db, ctx.secrets, projectId).text;
  const projectEnv = parseEnv(projectText);
  const sharedState = doc.env.shared.map((key) => {
    const here = projectEnv.entries.find((e) => e.key === key);
    // The file has each line as it was written there ("KEY=value", quotes and all).
    const line = secrets?.shared[key];
    const fileEntry = line === undefined ? undefined : parseEnv(line).entries.find((e) => e.key === key);
    const state: "missing" | "same" | "differs" | "noValue" = !fileEntry
      ? here
        ? "same"
        : "noValue"
      : !here
        ? "missing"
        : here.value === fileEntry.value
          ? "same"
          : "differs";
    return { name: key, state, line: fileEntry ? line : undefined, here };
  });
  let sharedEnv: string | null = null;
  const toWrite = sharedState.filter(
    (s) => s.line !== undefined && (s.state === "missing" || (sharedChoice === "overwrite" && s.state === "differs")),
  );
  if (sharedChoice !== "skip" && toWrite.length > 0) {
    if (can("env.edit")) {
      let text = projectText;
      // Replace from the end so earlier ranges stay put, then add the missing ones.
      for (const s of toWrite.filter((t) => t.here).sort((a, b) => (b.here?.range.start ?? 0) - (a.here?.range.start ?? 0))) {
        const range = s.here?.range as { start: number; end: number };
        text = `${text.slice(0, range.start)}${s.line}${text.slice(range.end)}`;
      }
      const added = toWrite.filter((t) => !t.here).map((t) => t.line);
      if (added.length) text = `${text.replace(/\n*$/, "")}${text.trim() ? "\n" : ""}${added.join("\n")}\n`;
      sharedEnv = text;
    } else noPermission("Shared variables", "env.edit");
  }
  const missingShared = sharedState.filter((s) => s.state === "noValue" || (s.state === "missing" && sharedChoice === "skip"));
  if (missingShared.length)
    warnings.push({
      reason: "missingShared",
      message: `Shared variables ${missingShared.map((s) => s.name).join(", ")} stay missing in this project.`,
    });

  // Domains, each through the checks domains.add, setMiddlewares and setCertificate run.
  const domainsEditable = can("domains.edit");
  if (!domainsEditable && doc.domains.length) noPermission("Domains", "domains.edit");
  const passwordsNeeded = new Map<string, string[]>();
  const domainRows: ImportPreview["domains"] = [];
  const domainInserts: Materialize["domains"] = [];
  const chosen = (d: { host: string; pathPrefix: string }) =>
    choicesIn.domains?.find((c) => c.host === d.host && c.pathPrefix === d.pathPrefix)?.action;
  for (const d of doc.domains) {
    const key = domainKey(d);
    const hashes = secrets?.domains[key]?.basicAuth ?? null;
    let status: ImportPreview["domains"][number]["status"] = "free";
    let note: string | null = null;
    const users = d.middlewares.basicAuthUsers;
    let ipAllowList: string[] = [];
    let certificate: { certPem: string; keyPem: string } | null = null;
    if (d.auto) {
      status = "auto";
      note = "Automatic domains belong to the old node; an automatic domain on this node can be added instead.";
    } else {
      try {
        checkRedirects(d.middlewares.redirects);
        ipAllowList = normalizeCidrs(d.middlewares.ipAllowList, "ipAllowList");
        if (users.length && hashes) {
          const byUser = new Map(hashes.map((h) => [h.username, h.hash]));
          if (byUser.size !== users.length || users.some((u) => !bcryptHash.test(byUser.get(u) ?? ""))) {
            throw new OpError("BAD_REQUEST", "Its basic auth users have hashes this panel does not accept (bcrypt, cost 4 to 12).");
          }
        }
      } catch (error) {
        status = "invalid";
        note = message(error);
      }
      if (status === "free" && users.length && !hashes) {
        status = "needsPassword";
        note = `The file left the passwords of ${users.join(", ")} out: type new ones, or skip the domain.`;
      }
      if (status === "free" && d.customCertificate) {
        const cert = secrets?.domains[key]?.certificate;
        try {
          if (!cert) throw new OpError("BAD_REQUEST", "The file left the certificate out.");
          checkCertificate(d.host, cert.certPem, cert.keyPem);
          assertCertificateNames(ctx, cert.certPem, "");
          certificate = cert;
        } catch (error) {
          status = "certificateDropped";
          note = `${message(error)} It is added with a Let's Encrypt certificate instead.`;
        }
      }
      const taken = ctx.db
        .select({ serviceId: domains.serviceId })
        .from(domains)
        .where(and(sql`lower(${domains.host}) = ${d.host}`, eq(domains.pathPrefix, d.pathPrefix)))
        .get();
      if (taken) {
        status = ctx.access.can("domains.view", { type: "service", id: taken.serviceId }) ? "usedHere" : "usedHidden";
        note =
          status === "usedHere"
            ? "Another service on this panel serves it. Move it there first, or skip it."
            : "It is in use on this panel.";
      } else if (status !== "invalid") {
        const conflict = hostConflict(ctx, d.host, "");
        if (conflict) {
          status = "usedHidden";
          note = conflict.message;
        }
      }
    }
    const forcedSkip = status === "auto" || status === "invalid" || status === "usedHere" || status === "usedHidden" || !domainsEditable;
    const action: "add" | "skip" = forcedSkip ? "skip" : (chosen(d) ?? "add");
    if (action === "add" && status === "needsPassword") passwordsNeeded.set(key, users);
    domainRows.push({
      host: d.host,
      pathPrefix: d.pathPrefix,
      https: d.https,
      primary: false,
      status,
      action,
      basicAuthUsers: users,
      message: note,
    });
    if (action === "add") {
      const https = certificate ? "custom" : d.https === "custom" ? "acme" : d.https;
      domainInserts.push({
        host: d.host,
        pathPrefix: d.pathPrefix,
        stripPrefix: d.stripPrefix,
        targetPort: d.targetPort,
        https,
        redirectToHttps: d.redirectToHttps,
        certificateSealed: certificate ? ctx.secrets.seal(JSON.stringify(certificate), "domain.certificate") : null,
        auto: false,
        forward: d.forward,
        isPrimary: false,
        middlewares: {
          ...(users.length
            ? { basicAuth: { users: users.map((u) => ({ username: u, hash: hashes?.find((h) => h.username === u)?.hash ?? "" })) } }
            : {}),
          ...(ipAllowList.length ? { ipAllowList } : {}),
          ...(d.middlewares.rateLimit ? { rateLimit: { ...d.middlewares.rateLimit } } : {}),
          ...(d.middlewares.redirects.length ? { redirects: d.middlewares.redirects.map((r) => ({ ...r })) } : {}),
        },
        dnsStatus: "unknown",
        certStatus: https === "off" ? "none" : https === "custom" ? "valid" : "pending",
      });
    }
  }

  // An automatic domain on this node, like a clone gets.
  const port = isDatabase
    ? null
    : (spec.ports.find((p) => p.protocol === "tcp")?.containerPort ??
      builtAppPort({ kind: doc.kind, parentId: null }, spec, doc.domains[0]?.targetPort ?? null));
  const autoHost = node?.wildcard ? `${name}.${node.wildcard}` : null;
  let autoReason: string | null = null;
  if (!autoHost) autoReason = "The node has no wildcard domain.";
  else if (port === null || doc.kind === "box") autoReason = "Only services with a port get an automatic domain.";
  else if (!domainsEditable) autoReason = "Adding a domain needs the domains.edit permission.";
  else if (ctx.db.select({ id: domains.id }).from(domains).where(eq(domains.host, autoHost)).get())
    autoReason = "That automatic domain is already in use.";
  const autoDomain = autoReason === null && (choicesIn.autoDomain ?? doc.domains.some((d) => d.auto));
  if (autoDomain && autoHost && port !== null) {
    domainInserts.push({
      host: autoHost,
      pathPrefix: "/",
      targetPort: port,
      https: "acme",
      auto: true,
      dnsStatus: "ok",
      dnsCheckedAt: new Date(),
      certStatus: "pending",
      isPrimary: false,
      middlewares: {},
    });
  }
  // The primary: the file's when it is added, else the first that is not a redirect (domains.add's rule).
  const primary =
    domainInserts.find((d) => !d.forward && doc.domains.some((f) => f.isPrimary && f.host === d.host && f.pathPrefix === d.pathPrefix)) ??
    domainInserts.find((d) => !d.forward);
  if (primary) primary.isPrimary = true;
  for (const r of domainRows) r.primary = !!primary && primary.host === r.host && primary.pathPrefix === r.pathPrefix;

  // Database listeners: added only to listed addresses by default, never on a port in use.
  const exposuresEditable = can("databases.expose");
  const exposureRows: ImportPreview["extras"]["exposures"] = [];
  const exposureInserts: NonNullable<Materialize["exposures"]> = [];
  if (isDatabase) {
    const engine = engines[doc.kind as DatabaseEngine];
    if (!exposuresEditable && doc.exposures.length) noPermission("Database listeners", "databases.expose");
    for (const e of doc.exposures) {
      let cidrs: string[] = [];
      let valid = true;
      try {
        cidrs = normalizeCidrs(e.allowedCidrs);
      } catch {
        valid = false;
      }
      const clash =
        !!node &&
        e.listenPort > 0 &&
        ctx.db
          .select({ id: portExposures.id })
          .from(portExposures)
          .where(and(eq(portExposures.nodeId, node.id), eq(portExposures.listenPort, e.listenPort)))
          .get() !== undefined;
      const forced = !valid || clash || !exposuresEditable || (engine.exposureNeedsAllowlist && cidrs.length === 0);
      const wanted = choicesIn.exposures?.find((c) => c.listenPort === e.listenPort)?.action ?? (cidrs.length > 0 ? "add" : "skip");
      const action = forced ? "skip" : wanted;
      exposureRows.push({ listenPort: e.listenPort, allowedCidrs: cidrs, clash, action });
      if (action === "add")
        exposureInserts.push({ kind: "database", listenPort: e.listenPort, targetPort: engine.port, allowedCidrs: cidrs, tls: true });
    }
    if (exposureRows.some((e) => e.action === "skip"))
      skipped.push({
        what: "Database listeners open to anyone or on a port in use",
        why: "Open them again on the database's Connect tab.",
      });
  }

  // Schedules: off by default when the file comes from this panel, so the copy does not run them twice.
  const cronChoice = choicesIn.cronJobs ?? (samePanel ? "disabled" : "asInFile");
  const cronJobs: NonNullable<Materialize["cronJobs"]> = [];
  if (doc.cronJobs.length && !can("services.cron")) noPermission("Cron jobs", "services.cron");
  else {
    for (const j of doc.cronJobs) {
      const schedule = normalizeCronSchedule(j.schedule.trim());
      try {
        checkSchedule(schedule, j.timeZone);
      } catch (error) {
        skipped.push({ what: `Cron job ${j.name}`, why: message(error) });
        continue;
      }
      cronJobs.push({
        name: j.name,
        schedule,
        timeZone: j.timeZone,
        command: j.command,
        timeoutSeconds: j.timeoutSeconds,
        concurrency: j.concurrency,
        enabled: cronChoice === "asInFile" ? j.enabled : false,
      });
    }
  }
  const uptimeChoice = choicesIn.uptimeChecks ?? (samePanel ? "disabled" : "asInFile");
  const checks: NonNullable<Materialize["uptimeChecks"]> = [];
  if (doc.uptimeChecks.length && uptimeChoice !== "skip" && !can("services.alerts")) noPermission("Uptime checks", "services.alerts");
  else if (uptimeChoice !== "skip") {
    for (const c of doc.uptimeChecks) {
      try {
        assertTimeout(c.intervalSeconds, c.timeoutMs);
        if (c.keyword && c.method === "HEAD") throw new OpError("BAD_REQUEST", "A keyword check needs GET.");
      } catch (error) {
        skipped.push({ what: `Uptime check ${c.name}`, why: message(error) });
        continue;
      }
      checks.push({ ...c, enabled: uptimeChoice === "asInFile" ? c.enabled : false });
    }
  }
  // Channels and destinations are panel-wide: matched by name, and skipped by default when the file comes from another panel.
  const alertChoice = choicesIn.alerts ?? (samePanel ? "mapByName" : "skip");
  const channelRows = ctx.db
    .select({ id: notificationChannels.id, name: notificationChannels.name, kind: notificationChannels.kind })
    .from(notificationChannels)
    .all();
  const alertRows = doc.alerts.map((a) => ({
    event: a.event,
    channels: a.channels.map((c) => ({
      name: c.name,
      id: channelRows.find((r) => sameName(r.name, c.name) && r.kind === c.kind)?.id ?? null,
    })),
    enabled: a.enabled,
  }));
  const alertInserts: NonNullable<Materialize["alertRules"]> = [];
  if (doc.alerts.length && alertChoice === "mapByName") {
    if (!can("services.alerts")) noPermission("Alert rules", "services.alerts");
    else
      for (const a of alertRows)
        alertInserts.push({ event: a.event, enabled: a.enabled, channelIds: a.channels.flatMap((c) => (c.id ? [c.id] : [])) });
  }
  const backupChoice = choicesIn.backups ?? (samePanel ? "disabled" : "skip");
  const destinationRows = ctx.db
    .select({
      id: backupDestinations.id,
      name: backupDestinations.name,
      provider: backupDestinations.provider,
      bucket: backupDestinations.bucket,
    })
    .from(backupDestinations)
    .all();
  const backupRows = doc.backups.map((b) => {
    const d = destinationRows.find(
      (r) => sameName(r.name, b.destination.name) && r.provider === b.destination.provider && r.bucket === b.destination.bucket,
    );
    const fits = b.target === "database" ? isDatabase : !!b.volume && doc.volumes.some((v) => v.name === b.volume);
    return { policy: b, destinationId: d?.id ?? null, fits };
  });
  const backupInserts: NonNullable<Materialize["backups"]> = [];
  if (doc.backups.length && backupChoice !== "skip") {
    if (!can("backups.edit")) noPermission("Backup schedules", "backups.edit");
    else {
      for (const { policy, destinationId, fits } of backupRows) {
        if (!destinationId || !fits) continue;
        const enabled = backupChoice === "mapByName" && policy.enabled;
        let nextRunAt: Date | null = null;
        try {
          nextRunAt = enabled ? nextRun(policy.schedule) : null;
        } catch {
          continue;
        }
        backupInserts.push({
          destinationId,
          target: policy.target,
          volume: policy.target === "volume" ? policy.volume : null,
          schedule: policy.schedule,
          keepLast: policy.keepLast,
          stopService: policy.target === "volume" && policy.stopService,
          enabled,
          nextRunAt,
        });
      }
    }
  }
  if (backupRows.some((b) => !b.destinationId || !b.fits) && backupChoice !== "skip")
    skipped.push({
      what: "Backup schedules without a destination of the same name here",
      why: "Add the destination and the schedule on the Backups tab.",
    });

  // Tunnel: always off, so two panels never share one connector.
  const tunnel =
    doc.tunnel && can("tunnels.edit")
      ? {
          enabled: false,
          mode: doc.tunnel.mode,
          targetPort: doc.tunnel.targetPort,
          hostname: doc.tunnel.hostname,
          token: secrets?.tunnelToken ?? null,
        }
      : null;
  if (doc.tunnel && !can("tunnels.edit")) noPermission("The Cloudflare tunnel", "tunnels.edit");
  if (tunnel)
    warnings.push({
      reason: "tunnel",
      message: "The Cloudflare tunnel arrives switched off. Turn it on once the old panel's copy is off.",
    });
  const maintenance = doc.maintenance && can("services.edit") ? { ...doc.maintenance } : null;
  if (doc.maintenance && !can("services.edit")) noPermission("The maintenance page", "services.edit");
  const deployTrigger = doc.deployTrigger && can("services.update");
  if (doc.deployTrigger && !can("services.update")) noPermission("The deploy trigger URL", "services.update");

  // The uploaded archive goes up after the service exists.
  const uploadEntry = doc.upload ? manifest.entries.find((e) => e.path === doc.upload?.entry) : undefined;
  const upload =
    doc.upload && uploadEntry && (choicesIn.upload ?? true) && can("services.update")
      ? { path: uploadEntry.path, size: uploadEntry.size, sha256: uploadEntry.sha256, fileName: doc.upload.fileName }
      : null;
  if (doc.upload && !upload) skipped.push({ what: "The uploaded archive", why: "Upload the code again on the Source tab." });

  let deployWhenReady = choicesIn.deployWhenReady ?? !doc.stopped;
  if (deployWhenReady && !can("services.deploy")) {
    deployWhenReady = false;
    warnings.push({ reason: "deploy", message: "Deploying here needs the services.deploy permission; it is created stopped." });
  }
  if (doc.volumes.length)
    warnings.push({
      reason: "volumes",
      message: `Volume data is not in this file: ${doc.volumes.map((v) => v.name).join(", ")} ${doc.volumes.length === 1 ? "arrives" : "arrive"} empty.`,
    });
  if (manifest.secrets === "omitted")
    warnings.push({
      reason: "unsigned",
      message: "Its secret values were left out, so only its integrity against its own manifest is checked, not who wrote it.",
    });
  if (opened.unknownSettings.length)
    warnings.push({
      reason: "unknownSettings",
      message: `Settings this panel does not know were skipped: ${opened.unknownSettings.slice(0, 10).join(", ")}${opened.unknownSettings.length > 10 ? " and more" : ""}.`,
    });
  for (const s of opened.skipped) warnings.push({ reason: "skipped", message: `${s.what}: ${s.why}` });

  const volumesIn =
    isDatabase && dataPath
      ? [{ name: "data", mountPath: dataPath, readOnly: false }]
      : doc.kind === "box"
        ? [{ name: boxWorkspaceVolume, mountPath: "/home/coder", readOnly: false }]
        : doc.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath, readOnly: v.readOnly }));
  const databaseSecrets = secrets?.databaseSecrets ?? {};
  const choices: Choices = {
    name,
    ...(nodeId ? { nodeId } : {}),
    ...(pick ? { sourceAccess: { kind: pick.kind, ...(pick.id ? { id: pick.id } : {}) } } : {}),
    commit,
    pinDigest,
    deployWhenReady,
    deployOnPush,
    domains: domainRows.map((d) => ({ host: d.host, pathPrefix: d.pathPrefix, action: d.action })),
    autoDomain,
    upload: upload !== null,
    sharedVariables: sharedChoice,
    cronJobs: cronChoice,
    uptimeChecks: uptimeChoice,
    alerts: alertChoice,
    backups: backupChoice,
    exposures: exposureRows.map((e) => ({ listenPort: e.listenPort, action: e.action as "add" | "skip" })),
  };

  const preview: ImportPreview = {
    importId: row.id,
    projectId,
    status: row.status,
    file: {
      panelVersion: manifest.panel.version,
      exportedAt: manifest.exportedAt,
      secrets: manifest.secrets,
      samePanel,
      unknownSettings: opened.unknownSettings,
    },
    service: { name, kind: doc.kind, source: summaryOf(doc, spec) },
    choices,
    blockers,
    needs,
    warnings,
    nodes: nodeRows.map((n) => ({ id: n.id, name: n.name, online: ctx.agents.isOnline(n.id) })),
    env: {
      keys: doc.env.keys,
      empty: !secrets,
      references,
      readsFrom,
      missingServices: [...missingServices],
      shared: sharedState.map((s) => ({ name: s.name, state: s.state })),
    },
    domains: domainRows,
    autoDomain: { host: autoReason === null ? autoHost : null, reason: autoReason },
    primaryDomain: primary ? `${primary.host}${primary.pathPrefix === "/" ? "" : primary.pathPrefix}` : null,
    source: {
      access: { picked: pick, options: access.options, wanted: access.wanted },
      commitSha: live?.commitSha ?? null,
      imageDigest: live?.imageDigest ?? null,
    },
    extras: {
      cronJobs: cronJobs.length,
      uptimeChecks: checks.length,
      maintenance: maintenance !== null,
      tunnel: tunnel !== null,
      deployTrigger,
      exposures: exposureRows,
      alerts: alertRows.map((a) => ({ event: a.event, channels: a.channels.map((c) => ({ name: c.name, mapped: c.id !== null })) })),
      backups: backupRows.map((b) => ({
        target: b.policy.target,
        volume: b.policy.volume,
        destination: b.policy.destination.name,
        mapped: b.destinationId !== null && b.fits,
      })),
    },
    data: {
      volumes: doc.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath })),
      upload: upload ? { fileName: upload.fileName, sizeBytes: upload.size } : null,
    },
    skipped,
    expiresAt: row.expiresAt.toISOString(),
  };

  return {
    preview,
    pick,
    credential,
    sharedEnv,
    passwordsNeeded,
    checkTargets: checks.map((c) => c.url),
    envText,
    deployWhenReady,
    commitSha: commit === "live" && repo ? (live?.commitSha ?? null) : null,
    hooks: !isDatabase && (pick?.kind === "githubAccount" || pick?.kind === "gitProvider"),
    pendingUpload: upload,
    materialize: {
      projectId,
      name,
      kind: doc.kind,
      nodeId: nodeId ?? "",
      replicas: doc.placements[0]?.replicas ?? 1,
      spec,
      // A custom template of the old panel may not exist here.
      templateSlug: null,
      notes: doc.notes,
      volumes: volumesIn,
      fileMounts: envWritable ? doc.fileMounts.map((f) => ({ ...f, content: secrets?.fileMounts[f.name] ?? null })) : [],
      env: envText,
      database:
        isDatabase && doc.database
          ? {
              facts: {
                engine: doc.kind as DatabaseEngine,
                version: doc.database.version,
                variant: doc.database.variant,
                databaseName: engines[doc.kind as DatabaseEngine].hasDatabase ? doc.database.databaseName : "",
                adminUser: doc.database.adminUser,
                exposedUser: engines[doc.kind as DatabaseEngine].redisLike ? "default" : "external",
                tlsHostname: null,
                webUiIdleMinutes: doc.database.webUiIdleMinutes,
              },
              secrets: [
                { name: adminPasswordSecret, value: databaseSecrets[adminPasswordSecret] ?? generatePassword() },
                { name: exposedPasswordSecret, value: databaseSecrets[exposedPasswordSecret] ?? generatePassword() },
              ],
            }
          : null,
      box: doc.kind === "box" ? { repository: doc.box?.repository ?? null, idleMinutes: Math.min(1440, doc.box?.idleMinutes ?? 30) } : null,
      domains: domainInserts,
      access: doc.access,
      exposures: exposureInserts,
      tunnel,
      maintenance,
      cronJobs,
      uptimeChecks: checks,
      alertRules: alertInserts,
      backups: backupInserts,
      deployTrigger,
    },
  };
}

/** The source line of the preview, from the file (no ids needed). */
function summaryOf(doc: Doc, spec: ServiceSpecJson): ImportPreview["service"]["source"] {
  const builder = doc.spec.source.type === "inline" ? "dockerfile" : spec.build.builder;
  if (databaseKinds.has(doc.kind))
    return { type: "database", label: spec.source.type === "image" ? spec.source.image : doc.kind, branch: null, builder: null };
  const s = doc.spec.source;
  switch (s.type) {
    case "github":
      return { type: "github", label: s.repo, branch: s.branch, builder };
    case "provider":
      return { type: s.provider, label: s.repo, branch: s.branch, builder };
    case "git":
      return { type: "git", label: gitLabel(s.url), branch: s.branch, builder };
    case "image":
      return { type: "image", label: s.image, branch: null, builder: null };
    case "inline":
      return { type: "inline", label: "Dockerfile", branch: null, builder: "dockerfile" };
    case "upload":
      return { type: "upload", label: doc.upload?.fileName ?? "", branch: null, builder };
    case "none":
      return { type: "none", label: "", branch: null, builder: null };
  }
}
