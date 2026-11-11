// What an import would create, from the opened file and the owner's
// choices: the preview the review page shows (blockers, choices still
// needed, warnings, every reference to something that already exists) and
// the rows serviceTransfer.import writes (services/portable.ts
// materializeService). Every setting from the file goes through the checks
// the ops that set it run; database and Box specs are built from their
// engine, never taken from the file.

import { type EnvEntry, parseEnv } from "@seylo/env-analyzer";
import { boxes as boxOps, databases as dbOps, env as envOps, OpError, serviceTransfer as transferOps } from "@seylo/ops";
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
import { missingExposureCapability, nodeHasCapability } from "../databases/capability";
import {
  databaseSpec,
  type EngineVersion,
  engines,
  enginesCapability,
  engineVersion,
  exposureCapability,
  exposureRefusal,
  generatePassword,
} from "../databases/engines";
import { adminPasswordSecret } from "../databases/info";
import { compareVersions, customImage, imageRelease } from "../databases/version";
import { hasBuildx } from "../deployments/source";
import { checkCertificate, checkRedirects, normalizeCidrs } from "../domains/checks";
import { assertCertificateNames, hostConflict } from "../domains/ownership";
import { buildEnvGraph } from "../env/graph";
import { checkEnvReferences } from "../env/ops";
import { readProjectEnv } from "../env/store";
import { factsOf } from "../nodes/view";
import { plantedMessage, plantedReferences, projectEnvOf, type ReferenceEffect, renameSelf } from "../services/impact";
import { checkWatchPaths, cronSettings } from "../services/ops";
import type { Materialize } from "../services/portable";
import { gitLabel, nameKey } from "../services/rows";
import { builtAppPort, defaultSpec, type ServiceSpecJson } from "../services/spec";
import { importLimitsCapability } from "../services/volume-pipe";
import { assertTimeout } from "../uptime/index";
import { type AccessOption, accessPlan, credentialFromFile, type FileCredential, sameName, sourceFor } from "./mapping";
import { domainKey, type ServiceSecrets } from "./snapshot";

type NodeRow = typeof nodes.$inferSelect;
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
  /** Shared variables to add (or, with overwrite, replace) in the project's shared env, merged into the stored text at import. */
  sharedLines: SharedLine[];
  /** Open first-run IP:port access: an app with a port whose file had no domains at all. */
  firstRun: boolean;
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
  /** Volume data that goes up after the service exists, with the limits its node unpacks it with. */
  pendingVolumes: { path: string; size: number; sha256: string; volume: string; maxBytes: number; maxEntries: number }[];
}

/** The space the agent keeps free when it takes data (go/internal/volumes FreeFloor). */
export function freeFloor(total: number): number {
  return Math.min(Math.max(Math.floor(total / 10), 1024 ** 3), 5 * 1024 ** 3);
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;

/** A shared variable's line from the file, and whether it replaces a different value here. */
export interface SharedLine {
  key: string;
  line: string;
  overwrite: boolean;
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

/** What an imported database starts on, and what the review page says about it. */
export interface DatabaseImage {
  image: string;
  warning: string | null;
  /** The file's data cannot start on any image this panel would run. */
  blocker: string | null;
}

/**
 * The image an imported database starts on: this panel's catalog image of
 * its version, unless its data comes along and the file ran a newer release
 * of that line. Data files do not go back to an older release (judgeVersion
 * refuses it as olderImage), so it keeps that release when
 * databases.setVersion would take it (customImage: the engine's official
 * image with an exact tag of the line), and the data is refused when not.
 * Without the data an empty database starts on the catalog image.
 */
export function importedDatabaseImage(
  engine: DatabaseEngine,
  variant: string | null,
  version: EngineVersion,
  ran: string | null,
  withData: boolean,
): DatabaseImage {
  const catalog = version.image;
  if (!ran || ran === catalog) return { image: catalog, warning: null, blocker: null };
  const label = engines[engine].label;
  const theirs = imageRelease(ran);
  const ours = imageRelease(catalog);
  const newer = theirs !== null && ours !== null && compareVersions(theirs, ours) > 0;
  let kept: string | null = null;
  try {
    kept = newer ? customImage(engine, variant, version.version, ran) : null;
  } catch {
    kept = null;
  }
  const here = `${catalog}, this panel's image of ${label} ${version.version}`;
  if (newer && withData) {
    if (kept)
      return {
        image: kept,
        warning: `It ran ${ran}, newer than ${here}. It keeps ${kept}: its data cannot go back to an older release.`,
        blocker: null,
      };
    return {
      image: catalog,
      warning: null,
      blocker: `Its data was written by ${ran}, newer than ${here}, and data cannot go back to an older release. Update this panel, or leave the data out to start with an empty database.`,
    };
  }
  return {
    image: catalog,
    warning: `It ran ${ran}; it starts here on ${here}.${kept ? ` Once it runs, change it to ${kept} on the Version card of its Settings tab.` : ""}`,
    blocker: null,
  };
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
  let databaseVersion: EngineVersion | null = null;
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
      // This panel's image of the version, as databases.create runs it; the image once the data is known
      // (importedDatabaseImage): a file names the one it ran, which may be older (a panel that was not updated),
      // newer, or a custom one from databases.setVersion.
      databaseSpecOf = databaseSpec(engineName, version);
      databaseVersion = version;
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
  // Only a source from the file: a database's or Box's image is this panel's (a digest is never a database image).
  const ownSource = !isDatabase && doc.kind !== "box";
  const pinDigest = ownSource && (choicesIn.pinDigest ?? false);
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
  const projectEnv = parseEnv(readProjectEnv(ctx.db, ctx.secrets, projectId).text);
  const refusedShared: string[] = [];
  const sharedState = doc.env.shared.map((key) => {
    const here = projectEnv.entries.find((e) => e.key === key);
    // The file has each line as it was written there ("KEY=value", quotes and all).
    const line = secrets?.shared[key];
    const fileEntry = line === undefined ? undefined : sharedLineEntry(key, line);
    if (line !== undefined && !fileEntry) refusedShared.push(key);
    const state: "missing" | "same" | "differs" | "noValue" = !fileEntry
      ? here && line === undefined
        ? "same"
        : "noValue"
      : !here
        ? "missing"
        : here.value === fileEntry.value
          ? "same"
          : "differs";
    return { name: key, state, line: fileEntry ? line : undefined, here };
  });
  const sharedLines: SharedLine[] = [];
  const toWrite = sharedState.filter(
    (s) => s.line !== undefined && (s.state === "missing" || (sharedChoice === "overwrite" && s.state === "differs")),
  );
  if (sharedChoice !== "skip" && toWrite.length > 0) {
    if (can("env.edit")) {
      for (const s of toWrite) sharedLines.push({ key: s.name, line: s.line as string, overwrite: s.state === "differs" });
    } else noPermission("Shared variables", "env.edit");
  }
  if (refusedShared.length)
    warnings.push({
      reason: "sharedRefused",
      message: `The file's values of ${refusedShared.join(", ")} are not one KEY=value line without references, as shared variables need: they are left out.`,
    });
  const missingShared = sharedState.filter((s) => (s.state === "noValue" && !s.here) || (s.state === "missing" && sharedChoice === "skip"));
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
    let middlewares: DomainMiddlewares = {};
    let certificate: { certPem: string; keyPem: string } | null = null;
    if (d.auto) {
      status = "auto";
      note = "Automatic domains belong to the old node; one on this node can be added instead, with the same access rules.";
    } else {
      const checked = fileMiddlewares(d, hashes);
      middlewares = checked.middlewares;
      if (checked.problem !== null) {
        status = "invalid";
        note = checked.problem;
      } else if (checked.needsPassword) {
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
        middlewares,
        dnsStatus: "unknown",
        certStatus: https === "off" ? "none" : https === "custom" ? "valid" : "pending",
      });
    }
  }

  // An automatic domain on this node, like a clone gets, with the old automatic domain's access rules.
  const fileAuto = doc.domains.find((d) => d.auto);
  const autoRules = fileAuto ? fileMiddlewares(fileAuto, secrets?.domains[domainKey(fileAuto)]?.basicAuth ?? null) : null;
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
  else if (autoRules?.problem)
    autoReason = `The old automatic domain's access rules are not accepted here: ${autoRules.problem} Add one on the Domains tab after the import.`;
  else if (autoRules?.needsPassword)
    autoReason =
      "The old automatic domain had basic auth, and the file left its passwords out. Add one with new passwords on the Domains tab after the import.";
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
      middlewares: autoRules?.middlewares ?? {},
    });
  }
  // The primary: the file's when it is added, else the first that is not a redirect (domains.add's rule).
  const primary =
    domainInserts.find((d) => !d.forward && doc.domains.some((f) => f.isPrimary && f.host === d.host && f.pathPrefix === d.pathPrefix)) ??
    domainInserts.find((d) => !d.forward);
  if (primary) primary.isPrimary = true;
  for (const r of domainRows) r.primary = !!primary && primary.host === r.host && primary.pathPrefix === r.pathPrefix;

  // IP:port access like a new app's, only when the file had no domains at all: the file does not say whether
  // the old one's IP:port was closed, and a skipped domain may have been the only way in, behind basic auth or an allow list.
  const appWithPort = doc.kind === "app" && spec.ports.length > 0 && domainInserts.length === 0;
  const fileDomains = Math.max(doc.domains.length, manifest.services[0]?.counts.domains ?? 0);
  const firstRun = appWithPort && fileDomains === 0;
  if (appWithPort && fileDomains > 0)
    warnings.push({
      reason: "unreachable",
      message:
        "None of its domains are added here, so it is not reachable: IP:port access stays closed, since the old service may have been behind basic auth or an IP allow list. Add a domain, or open IP:port access on its Domains tab.",
    });

  // Database listeners: added only to listed addresses by default, never on a port in use.
  const exposuresEditable = can("databases.expose");
  const exposureRows: ImportPreview["extras"]["exposures"] = [];
  const exposureInserts: NonNullable<Materialize["exposures"]> = [];
  if (isDatabase) {
    const engine = engines[doc.kind as DatabaseEngine];
    if (!exposuresEditable && doc.exposures.length) noPermission("Database listeners", "databases.expose");
    // What databases.setExposure refuses: a version without TLS, a node whose agent cannot keep the port TLS only.
    const noTls = doc.database
      ? exposureRefusal({ engine: engine.engine, version: doc.database.version, variant: doc.database.variant })
      : null;
    const missing = node && doc.exposures.length ? missingExposureCapability(ctx.db, ctx.agents, engine, node.id) : null;
    const refusal =
      noTls ??
      (missing === null || !node
        ? null
        : missing === exposureCapability
          ? `The agent on ${node.name} cannot expose ${engine.label} with its own user over TLS yet. Update the node, then expose it on its Connect tab.`
          : `The agent on ${node.name} cannot expose ${engine.label} with TLS yet. Update the node, then expose it on its Connect tab.`);
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
      const forced = !valid || clash || refusal !== null || !exposuresEditable || (engine.exposureNeedsAllowlist && cidrs.length === 0);
      const wanted = choicesIn.exposures?.find((c) => c.listenPort === e.listenPort)?.action ?? (cidrs.length > 0 ? "add" : "skip");
      const action = forced ? "skip" : wanted;
      exposureRows.push({ listenPort: e.listenPort, allowedCidrs: cidrs, clash, action, refusal });
      if (action === "add")
        exposureInserts.push({ kind: "database", listenPort: e.listenPort, targetPort: engine.port, allowedCidrs: cidrs, tls: true });
    }
    if (refusal && exposureRows.length) skipped.push({ what: "Database listeners", why: refusal });
    else if (exposureRows.some((e) => e.action === "skip"))
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
  // The login from the file only when databases.create would take it: engines.ts writes it into SQL and shell input as it is.
  // One user inside and through the exposed port (0.2.9): a file from before that may name a separate exposed user and
  // its password, and neither is created here.
  const databaseLogins: { name: string; value: string }[] = [];
  let loginsMade = false;
  if (isDatabase) {
    const value = secrets?.databaseSecrets[adminPasswordSecret];
    const fits = value !== undefined && Value.Check(dbOps.create.input.properties.password, value);
    databaseLogins.push({ name: adminPasswordSecret, value: fits ? (value as string) : generatePassword() });
    if (!fits) loginsMade = true;
    if (value !== undefined && !fits) {
      warnings.push({
        reason: "databasePassword",
        message:
          "The file's admin password does not fit this panel's rule (12 to 128 letters, digits or . _ ~ -), so a new one is made. Apps that connect with the old one need the new one from the database's Connect tab.",
      });
    }
  }
  // Volume data in the file: what is picked goes up after the service exists, straight to its node.
  const room = volumesIn.map((v) => v.name);
  const inFile = doc.volumes.flatMap((v) => {
    const entry = v.data ? manifest.entries.find((e) => e.path === v.data) : undefined;
    return entry && room.includes(v.name) ? [{ volume: v.name, entry }] : [];
  });
  let picked = (choicesIn.volumes ?? inFile.map((v) => v.volume)).filter((name) => inFile.some((v) => v.volume === name));
  // A database's data goes up whole or not at all.
  if (isDatabase && picked.length > 0) picked = inFile.map((v) => v.volume);
  if (picked.length > 0 && !can("files.write")) {
    noPermission("Volume data", "files.write");
    picked = [];
  }
  const confirmData = choicesIn.confirmData === true;
  const pendingVolumes = inFile
    .filter((v) => picked.includes(v.volume))
    .map((v) => ({
      path: v.entry.path,
      size: v.entry.size,
      sha256: v.entry.sha256,
      volume: v.volume,
      ...transferOps.volumeImportLimits(v.entry),
    }));
  const neededBytes = pendingVolumes.reduce((n, v) => n + v.maxBytes, 0);
  const facts = node ? factsOf(ctx, ctx.db.select().from(nodes).where(eq(nodes.id, node.id)).get() as NodeRow) : null;
  const freeBytes = facts && facts.diskTotalBytes > 0n ? Number(facts.diskFreeBytes) : null;
  const totalBytes = facts && facts.diskTotalBytes > 0n ? Number(facts.diskTotalBytes) : null;
  if (pendingVolumes.length > 0 && node) {
    if (!ctx.agents.isOnline(node.id))
      blockers.push({
        reason: "offline",
        message: `${node.name} is offline, so the volume data cannot go up there now. Pick another node or leave the data out.`,
        field: "nodeId",
      });
    else if (!ctx.agents.supports(node.id, "importVolume") || !ctx.agents.capabilities(node.id)?.has(importLimitsCapability))
      blockers.push({
        reason: "agentTooOld",
        message: `The agent on ${node.name} is too old to take volume data from a file. Update the node, or leave the data out.`,
        field: "nodeId",
      });
    if (isDatabase && (!secrets || loginsMade))
      blockers.push({
        reason: "databaseLogins",
        message: secrets
          ? "The data only opens with the file's database logins, and this panel does not accept them. Leave the data out to start with an empty database."
          : "The data only opens with the database's logins, which this file left out. Leave the data out to start with an empty database.",
        field: "volumes",
      });
    warnings.push({ reason: "owners", message: "Files in the volumes keep the owners, modes and links they had in the file." });
    if (freeBytes !== null && totalBytes !== null && neededBytes + freeFloor(totalBytes) > freeBytes)
      warnings.push({
        reason: "space",
        message: `${node.name} last reported ${size(freeBytes)} free. The data may need up to ${size(neededBytes)} and the node keeps ${size(freeFloor(totalBytes))} free, so it may refuse it.`,
      });
    if (!confirmData) {
      if (freeBytes !== null && neededBytes > freeBytes / 2)
        needs.push({
          reason: "dataSpace",
          field: "confirmData",
          message: `The data may take up to ${size(neededBytes)} of the ${size(freeBytes)} free on ${node.name}. Confirm it on the Data section.`,
        });
      for (const v of pendingVolumes) {
        const unpacked = inFile.find((f) => f.volume === v.volume)?.entry.unpackedBytes ?? 0;
        if (unpacked > v.size * transferOps.transferLimits.confirmRatio)
          needs.push({
            reason: "dataRatio",
            field: "confirmData",
            message: `${v.volume} unpacks to ${size(unpacked)} from ${size(v.size)} in the file (more than ${transferOps.transferLimits.confirmRatio} times). Confirm it on the Data section if you expect that.`,
          });
      }
    }
  }
  if (isDatabase && databaseVersion && doc.database && spec.source.type === "image") {
    const ran = doc.spec.source.type === "image" ? doc.spec.source.image : null;
    const chosen = importedDatabaseImage(doc.kind as DatabaseEngine, doc.database.variant, databaseVersion, ran, picked.length > 0);
    spec.source = { ...spec.source, image: chosen.image };
    if (chosen.warning) warnings.push({ reason: "databaseImage", message: chosen.warning });
    if (chosen.blocker) blockers.push({ reason: "databaseImage", message: chosen.blocker, field: "volumes" });
  }
  for (const v of inFile.filter((f) => !picked.includes(f.volume)))
    skipped.push({ what: `The data of volume ${v.volume}`, why: "It was left out, so the volume arrives empty." });
  const withoutData = doc.volumes.filter((v) => v.data === null).map((v) => v.name);
  if (withoutData.length)
    warnings.push({
      reason: "volumes",
      message: `This file has no data for ${withoutData.join(", ")}: ${withoutData.length === 1 ? "it arrives" : "they arrive"} empty.`,
    });

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
    volumes: picked,
    confirmData,
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
      imageDigest: ownSource ? (live?.imageDigest ?? null) : null,
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
      volumes: volumesIn.map((v) => {
        const file = inFile.find((f) => f.volume === v.name);
        return {
          name: v.name,
          mountPath: v.mountPath,
          inFile: file !== undefined,
          sizeBytes: file?.entry.size ?? null,
          unpackedBytes: file?.entry.unpackedBytes ?? null,
          include: picked.includes(v.name),
        };
      }),
      upload: upload ? { fileName: upload.fileName, sizeBytes: upload.size } : null,
      neededBytes,
      node: { freeBytes, totalBytes },
    },
    skipped,
    expiresAt: row.expiresAt.toISOString(),
  };

  return {
    preview,
    pick,
    credential,
    sharedLines,
    firstRun,
    passwordsNeeded,
    checkTargets: checks.map((c) => c.url),
    envText,
    deployWhenReady,
    commitSha: commit === "live" && repo ? (live?.commitSha ?? null) : null,
    hooks: !isDatabase && (pick?.kind === "githubAccount" || pick?.kind === "gitProvider"),
    pendingUpload: upload,
    pendingVolumes,
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
                // Exposure uses the admin user; only databases from before 0.2.9 name another one, for their retirement.
                exposedUser: "",
                tlsHostname: null,
                webUiIdleMinutes: doc.database.webUiIdleMinutes,
              },
              secrets: databaseLogins,
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

type DomainMiddlewares = NonNullable<Materialize["domains"][number]["middlewares"]>;

/**
 * A domain's access rules from the file, through domains.setMiddlewares'
 * checks: problem when one does not pass; needsPassword when it has basic
 * auth users and the file left their hashes out (they stay empty until the
 * import call brings passwords).
 */
function fileMiddlewares(
  d: Doc["domains"][number],
  hashes: { username: string; hash: string }[] | null,
): { middlewares: DomainMiddlewares; problem: string | null; needsPassword: boolean } {
  const users = d.middlewares.basicAuthUsers;
  try {
    checkRedirects(d.middlewares.redirects);
    const ipAllowList = normalizeCidrs(d.middlewares.ipAllowList, "ipAllowList");
    if (users.length && hashes) {
      const byUser = new Map(hashes.map((h) => [h.username, h.hash]));
      if (byUser.size !== users.length || users.some((u) => !bcryptHash.test(byUser.get(u) ?? ""))) {
        throw new OpError("BAD_REQUEST", "Its basic auth users have hashes this panel does not accept (bcrypt, cost 4 to 12).");
      }
    }
    return {
      problem: null,
      needsPassword: users.length > 0 && !hashes,
      middlewares: {
        ...(users.length
          ? { basicAuth: { users: users.map((u) => ({ username: u, hash: hashes?.find((h) => h.username === u)?.hash ?? "" })) } }
          : {}),
        ...(ipAllowList.length ? { ipAllowList } : {}),
        ...(d.middlewares.rateLimit ? { rateLimit: { ...d.middlewares.rateLimit } } : {}),
        ...(d.middlewares.redirects.length ? { redirects: d.middlewares.redirects.map((r) => ({ ...r })) } : {}),
      },
    };
  } catch (error) {
    return { middlewares: {}, problem: message(error), needsPassword: false };
  }
}

/**
 * The entry of a shared variable's line from the file when it is what
 * env.setShared takes for that one variable: a single KEY=value of this
 * key over the whole line, without syntax problems or references (shared
 * variables cannot reference services). Otherwise undefined: one value
 * could carry more lines, and so variables the review page never shows.
 */
function sharedLineEntry(key: string, line: string): EnvEntry | undefined {
  const parsed = parseEnv(line);
  const [entry] = parsed.entries;
  if (!entry || parsed.entries.length !== 1 || parsed.problems.length > 0) return undefined;
  if (entry.key !== key || entry.references.length > 0 || entry.range.start !== 0 || entry.range.end !== line.length) return undefined;
  return entry;
}

/**
 * The project's shared env text with an import's lines: an overwrite
 * replaces the variable's line, a variable that is not there is added at
 * the end, and one someone added since the preview is left alone. Null
 * when nothing changes. The import runs it on the text stored at that
 * moment, inside its transaction, so a save in between is kept.
 */
export function mergeSharedLines(text: string, lines: readonly SharedLine[]): string | null {
  const entries = parseEnv(text).entries;
  let merged = text;
  const replaced = lines
    .flatMap((l) => {
      const here = entries.find((e) => e.key === l.key);
      return here && l.overwrite ? [{ line: l.line, range: here.range }] : [];
    })
    .sort((a, b) => b.range.start - a.range.start);
  // From the end, so earlier ranges stay put.
  for (const r of replaced) merged = `${merged.slice(0, r.range.start)}${r.line}${merged.slice(r.range.end)}`;
  const added = lines.filter((l) => !entries.some((e) => e.key === l.key)).map((l) => l.line);
  if (added.length) merged = `${merged.replace(/\n*$/, "")}${merged.trim() ? "\n" : ""}${added.join("\n")}\n`;
  if (merged === text) return null;
  if (!Value.Check(envOps.setShared.input.properties.text, merged)) {
    throw new OpError(
      "BAD_REQUEST",
      "The project's shared variables would pass 256 KiB with the file's. Leave them out, or make room first.",
      {
        field: "sharedVariables",
      },
    );
  }
  return merged;
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
