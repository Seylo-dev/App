// Reading a service into the export format: the service document (every
// setting, panel-local ids replaced by names a panel can look up) and the
// secret values next to it. What the caller may not read stays out and is
// listed: the .env and file mounts need env.view, database logins
// databases.credentials, domains domains.view, the uploaded archive
// files.read, backups backups.view, database listeners exposures.view and
// the tunnel tunnels.view (owners and admins hold all of them; this is for
// API keys narrowed to some actions).

import { parseEnv } from "@seylo/env-analyzer";
import { OpError, type serviceTransfer } from "@seylo/ops";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  alertRules,
  backupDestinations,
  backupPolicies,
  cloudflareTunnels,
  cronJobs,
  deployments,
  deployTriggers,
  domains,
  gitCredentials,
  githubInstallations,
  gitProviders,
  maintenancePages,
  nodes,
  notificationChannels,
  portExposures,
  registryCredentials,
  serviceAccess,
  serviceBoxes,
  serviceDatabases,
  servicePlacements,
  serviceSecrets,
  sourceUploads,
  uptimeChecks,
  volumes,
} from "../../db/schema";
import { normalizeCronSchedule } from "../../jobs/cron-expr";
import type { OpContext } from "../../ops/implement";
import { retiredExposedPasswordSecret } from "../databases/info";
import { readProjectEnv, readServiceEnv } from "../env/store";
import { accountLogin } from "../github/account";
import { panelServiceId } from "../nodes/panel-service";
import { activeCopy, activeImport, activeMove } from "../services/copies";
import { withoutCredentials } from "../services/git-url";
import { portableSpecOf } from "../services/portable";
import type { ServiceRow } from "../services/rows";
import { readSpec, type ServiceSpecJson } from "../services/spec";

type Doc = serviceTransfer.PortableServiceV1;
export type ServiceSecrets = serviceTransfer.PortableSecretsV1["services"][string];
type Action = `${string}.${string}`;

export interface Snapshot {
  doc: Doc;
  secrets: ServiceSecrets;
  /** The newest uploaded archive, for upload apps. */
  upload: { id: string; fileName: string; sizeBytes: number; sha256: string } | null;
  /** Things that stay out of the file, and why. */
  leftOut: { what: string; why: string }[];
  /** The git credential or registry login the source reads with. */
  sourceLogin: { kind: "gitCredential" | "registry"; id: string; name: string } | null;
}

export interface ExportBlocker {
  reason: "compose" | "protected" | "panel" | "preview" | "copying" | "moving" | "importing" | "tooLarge";
  message: string;
}

/** Why `svc` cannot be exported now (empty: it can). tooLarge is checked on the built file. */
export function exportBlockers(ctx: Pick<OpContext, "db">, svc: ServiceRow): ExportBlocker[] {
  const out: ExportBlocker[] = [];
  const spec = readSpec(svc.spec);
  if (svc.kind === "compose" || svc.parentId)
    out.push({
      reason: "compose",
      message: "Compose stacks and their members cannot be exported yet. Export the services you need one by one once that comes.",
    });
  if (svc.protected) out.push({ reason: "protected", message: `${svc.name} is protected and cannot be exported.` });
  if (svc.id === panelServiceId)
    out.push({ reason: "panel", message: "The panel itself is not exported; move the panel with Panel move." });
  if (spec.preview) out.push({ reason: "preview", message: "Previews follow their pull request and are not exported." });
  if (activeCopy(ctx.db, svc.id, { anySource: true }))
    out.push({ reason: "copying", message: "Its data is being copied. Export it once the copy ends." });
  if (activeMove(ctx.db, svc.id)) out.push({ reason: "moving", message: "It is moving to another node. Export it once the move ends." });
  if (activeImport(ctx.db, svc.id))
    out.push({ reason: "importing", message: "It is still receiving its imported files. Export it once the import ends." });
  return out;
}

function portableSource(source: ServiceSpecJson["source"]): Doc["spec"]["source"] {
  switch (source.type) {
    case "github":
      return { type: "github", repo: source.repo, branch: source.branch, deployOnPush: source.deployOnPush };
    case "git":
      return { type: "git", url: withoutCredentials(source.url), branch: source.branch, deployOnPush: source.deployOnPush };
    case "provider":
      return { type: "provider", provider: source.provider, repo: source.repo, branch: source.branch, deployOnPush: source.deployOnPush };
    case "image":
      return { type: "image", image: source.image };
    case "upload":
      return { type: "upload", fileName: source.fileName };
    case "inline":
      return { type: "inline" };
    case "none":
      return { type: "none" };
  }
}

/** The domain's key in secrets.enc. */
export const domainKey = (d: { host: string; pathPrefix: string }) => `${d.host}${d.pathPrefix}`;

export function snapshotService(ctx: OpContext, svc: ServiceRow, options: { sourceLogin: boolean }): Snapshot {
  const can = (action: Action) => ctx.access.can(action, { type: "service", id: svc.id });
  const leftOut: Snapshot["leftOut"] = [];
  const without = (what: string, action: Action) => {
    leftOut.push({ what, why: `You do not have the ${action} permission on it.` });
    return false;
  };
  const spec = portableSpecOf(readSpec(svc.spec), "export");
  const secrets: ServiceSecrets = {
    doc: null,
    env: "",
    fileMounts: {},
    databaseSecrets: {},
    domains: {},
    tunnelToken: null,
    shared: {},
    sourceCredential: null,
  };

  // What read the source, as names another panel can look up.
  let sourceAccess: Doc["sourceAccess"] = null;
  let sourceLogin: Snapshot["sourceLogin"] = null;
  const source = spec.source;
  if (source.type === "github" && source.installationId) {
    const row = ctx.db.select().from(githubInstallations).where(eq(githubInstallations.id, source.installationId)).get();
    if (row) sourceAccess = { via: "githubInstallation", account: row.accountLogin };
  } else if (source.type === "github" && source.accountId) {
    const row = ctx.db.select().from(gitCredentials).where(eq(gitCredentials.id, source.accountId)).get();
    if (row) sourceAccess = { via: "githubAccount", login: accountLogin(row) };
  } else if (source.type === "git" && source.credentialId) {
    const row = ctx.db.select().from(gitCredentials).where(eq(gitCredentials.id, source.credentialId)).get();
    if (row) {
      sourceAccess = {
        via: "gitCredential",
        name: row.name,
        kind: row.kind,
        host: row.host,
        username: row.username,
        fingerprint: row.fingerprint,
      };
      sourceLogin = { kind: "gitCredential", id: row.id, name: row.name };
      if (options.sourceLogin) {
        if (!ctx.access.can("git.manage"))
          throw new OpError("FORBIDDEN", "Including the git credential needs the git.manage permission.", {
            action: "git.manage",
            field: "includeSourceLogin",
          });
        const secret = ctx.secrets.open(row.secretSealed, "git.credential");
        if (secret !== null)
          secrets.sourceCredential = { kind: "gitCredential", secret, knownHosts: row.knownHosts, publicKey: row.publicKey };
      }
    }
  } else if (source.type === "provider") {
    const row = ctx.db.select().from(gitProviders).where(eq(gitProviders.id, source.providerId)).get();
    if (row) sourceAccess = { via: "gitProvider", provider: row.kind, url: row.url, workspace: row.workspace };
  } else if (source.type === "image" && source.registryId) {
    const row = ctx.db.select().from(registryCredentials).where(eq(registryCredentials.id, source.registryId)).get();
    if (row) {
      sourceAccess = { via: "registry", name: row.name, server: row.server, username: row.username };
      sourceLogin = { kind: "registry", id: row.id, name: row.name };
      if (options.sourceLogin) {
        if (!ctx.access.can("registries.manage"))
          throw new OpError("FORBIDDEN", "Including the registry login needs the registries.manage permission.", {
            action: "registries.manage",
            field: "includeSourceLogin",
          });
        const password = ctx.secrets.open(row.passwordSealed, "registry.credential");
        if (password !== null) secrets.sourceCredential = { kind: "registry", password };
      }
    }
  }
  if (sourceLogin && !options.sourceLogin)
    leftOut.push({
      what: `The ${sourceLogin.kind === "registry" ? "registry login" : "git credential"} ${sourceLogin.name}`,
      why: "Logins are panel-wide; the import picks one on the new panel, or include it (encrypted).",
    });

  const nodeNames = new Map(
    ctx.db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .all()
      .map((n) => [n.id, n.name]),
  );
  const placements = ctx.db
    .select()
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, svc.id))
    .orderBy(asc(servicePlacements.createdAt))
    .all();
  const allVolumes = ctx.db.select().from(volumes).where(eq(volumes.serviceId, svc.id)).orderBy(asc(volumes.name)).all();
  const dataVolumes = allVolumes.filter((v) => v.kind === "volume" && !v.ownerServiceId);
  const fileRows = allVolumes.filter((v) => v.kind === "file");

  // The .env, file mounts and the shared variables it reads.
  const envReadable = can("env.view") || without("Environment variables and file mounts", "env.view");
  const envText = envReadable ? readServiceEnv(ctx.db, ctx.secrets, svc.id).text : "";
  const parsed = parseEnv(envText);
  const referenced = new Set<string>();
  const shared = new Set<string>();
  for (const entry of parsed.entries) {
    for (const ref of entry.references) {
      if (ref.target === "project") shared.add(ref.variable);
      else if (ref.target.toLowerCase() !== svc.name.toLowerCase()) referenced.add(ref.target.toLowerCase());
    }
  }
  if (envReadable) {
    secrets.env = envText;
    for (const f of fileRows) secrets.fileMounts[f.name] = (f.contentSealed && ctx.secrets.open(f.contentSealed, "volume.file")) ?? "";
    if (shared.size > 0) {
      if (ctx.access.can("env.view", { type: "project", id: svc.projectId })) {
        // Each line as written (quotes and all), so the import adds exactly what was here.
        const projectEnv = parseEnv(readProjectEnv(ctx.db, ctx.secrets, svc.projectId).text);
        for (const entry of projectEnv.entries)
          if (shared.has(entry.key)) secrets.shared[entry.key] = projectEnv.text.slice(entry.range.start, entry.range.end);
      } else without("Shared variables' values", "env.view");
    }
  }

  const databaseRow = ctx.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, svc.id)).get();
  if (databaseRow) {
    if (can("databases.credentials")) {
      for (const s of ctx.db.select().from(serviceSecrets).where(eq(serviceSecrets.serviceId, svc.id)).all()) {
        // A database from before 0.2.9 still holds its old exposed user's password: nothing reads it, and it stays here.
        if (s.name === retiredExposedPasswordSecret) continue;
        const value = ctx.secrets.open(s.valueSealed, "service.secret");
        if (value !== null) secrets.databaseSecrets[s.name] = value;
      }
    } else without("Database logins", "databases.credentials");
  }
  const boxRow = ctx.db.select().from(serviceBoxes).where(eq(serviceBoxes.serviceId, svc.id)).get();

  const domainRows =
    can("domains.view") || without("Domains", "domains.view")
      ? ctx.db.select().from(domains).where(eq(domains.serviceId, svc.id)).orderBy(asc(domains.createdAt)).all()
      : [];
  const docDomains: Doc["domains"] = domainRows.map((d) => {
    const m = d.middlewares ?? {};
    const entry: ServiceSecrets["domains"][string] = {};
    if (m.basicAuth?.users.length) entry.basicAuth = m.basicAuth.users.map((u) => ({ username: u.username, hash: u.hash }));
    if (d.https === "custom" && d.certificateSealed) {
      const cert = ctx.secrets.open(d.certificateSealed, "domain.certificate");
      if (cert) entry.certificate = JSON.parse(cert) as { certPem: string; keyPem: string };
    }
    if (entry.basicAuth || entry.certificate) secrets.domains[domainKey(d)] = entry;
    return {
      host: d.host,
      pathPrefix: d.pathPrefix,
      stripPrefix: d.stripPrefix,
      targetPort: d.targetPort,
      https: d.https,
      redirectToHttps: d.redirectToHttps,
      auto: d.auto,
      isPrimary: d.isPrimary,
      forward: d.forward ?? null,
      middlewares: {
        ipAllowList: m.ipAllowList ?? [],
        rateLimit: m.rateLimit
          ? { average: m.rateLimit.average, burst: m.rateLimit.burst, periodSeconds: m.rateLimit.periodSeconds ?? 1 }
          : null,
        redirects: (m.redirects ?? []).map((r) => ({ from: r.from, to: r.to, permanent: r.permanent })),
        basicAuthUsers: (m.basicAuth?.users ?? []).map((u) => u.username),
      },
      customCertificate: d.https === "custom" && !!d.certificateSealed,
    };
  });

  const access = ctx.db.select().from(serviceAccess).where(eq(serviceAccess.serviceId, svc.id)).get();
  const exposureRows =
    can("exposures.view") || without("Database listeners", "exposures.view")
      ? ctx.db
          .select()
          .from(portExposures)
          .where(and(eq(portExposures.serviceId, svc.id), eq(portExposures.kind, "database")))
          .all()
      : [];
  const tunnelRow =
    can("tunnels.view") || without("The Cloudflare tunnel", "tunnels.view")
      ? ctx.db.select().from(cloudflareTunnels).where(eq(cloudflareTunnels.serviceId, svc.id)).get()
      : undefined;
  if (tunnelRow?.tokenSealed) secrets.tunnelToken = ctx.secrets.open(tunnelRow.tokenSealed, "cloudflare.tunnel");
  const maintenance = ctx.db.select().from(maintenancePages).where(eq(maintenancePages.serviceId, svc.id)).get();

  const channels = new Map(
    ctx.db
      .select({ id: notificationChannels.id, name: notificationChannels.name, kind: notificationChannels.kind })
      .from(notificationChannels)
      .all()
      .map((c) => [c.id, c]),
  );
  const rules = ctx.db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.scopeType, "service"), eq(alertRules.scopeId, svc.id)))
    .all();
  const policies =
    can("backups.view") || without("Backup schedules", "backups.view")
      ? ctx.db.select().from(backupPolicies).where(eq(backupPolicies.serviceId, svc.id)).orderBy(asc(backupPolicies.createdAt)).all()
      : [];
  const destinations = new Map(
    policies.length
      ? ctx.db
          .select()
          .from(backupDestinations)
          .where(
            inArray(
              backupDestinations.id,
              policies.map((p) => p.destinationId),
            ),
          )
          .all()
          .map((d) => [d.id, d])
      : [],
  );
  const volumeNames = new Map(allVolumes.map((v) => [v.id, v.name]));

  const live = svc.liveDeploymentId ? ctx.db.select().from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get() : undefined;
  const newestUpload =
    source.type === "upload"
      ? can("files.read") || without("The uploaded archive", "files.read")
        ? ctx.db.select().from(sourceUploads).where(eq(sourceUploads.serviceId, svc.id)).orderBy(desc(sourceUploads.createdAt)).get()
        : undefined
      : undefined;
  const uploadEntry = `services/${svc.name}/source/upload.tar.gz`;

  leftOut.push(
    { what: "Deploy history, logs and built images", why: "They belong to this panel; the import builds or pulls the service again." },
    {
      what: "GitHub App, connected accounts and git host connections",
      why: "The new panel uses its own; the import picks one by account or host.",
    },
    { what: "People's access (grants and invites)", why: "Accounts differ between panels." },
  );
  if (spec.previews.enabled || readSpec(svc.spec).previews.enabled)
    leftOut.push({ what: "Previews", why: "Preview services follow pull requests here; the import keeps previews off." });

  const doc: Doc = {
    name: svc.name,
    kind: svc.kind,
    notes: svc.notes,
    templateSlug: svc.templateSlug,
    stopped: svc.stopped,
    spec: {
      source: portableSource(source),
      build: (({ buildNodeId: _, ...rest }) => rest)(spec.build),
      container: spec.container,
      ports: spec.ports,
      healthCheck: spec.healthCheck,
      crashPolicy: spec.crashPolicy,
      resources: spec.resources,
      deploy: spec.deploy,
      cron: spec.cron && { ...spec.cron, schedule: normalizeCronSchedule(spec.cron.schedule) },
      stickySessions: spec.stickySessions,
      watchPaths: spec.watchPaths,
      previews: { enabled: false, maxPreviews: spec.previews.maxPreviews },
    },
    sourceAccess,
    buildNode: spec.build.buildNodeId ? (nodeNames.get(spec.build.buildNodeId) ?? null) : null,
    placements: placements.map((p) => ({ node: nodeNames.get(p.nodeId) ?? p.nodeId, replicas: p.replicas })),
    volumes: dataVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath, readOnly: v.readOnly, data: null })),
    fileMounts: envReadable ? fileRows.map((f) => ({ name: f.name, mountPath: f.mountPath, readOnly: f.readOnly })) : [],
    env: { keys: parsed.entries.map((e) => e.key), services: [...referenced].sort(), shared: [...shared].sort() },
    database: databaseRow
      ? {
          engine: databaseRow.engine,
          version: databaseRow.version,
          variant: databaseRow.variant,
          databaseName: databaseRow.databaseName,
          // Exposure uses the admin user since 0.2.9; an old exposed user waiting for its retirement stays behind.
          adminUser: databaseRow.adminUser,
          webUiIdleMinutes: databaseRow.webUiIdleMinutes,
        }
      : null,
    box: boxRow ? { repository: boxRow.repository ? withoutCredentials(boxRow.repository) : null, idleMinutes: boxRow.idleMinutes } : null,
    domains: docDomains,
    access: access ? { closeWhenDomainLive: access.closeWhenDomainLive, redirectToPrimary: access.redirectToPrimary } : null,
    exposures: exposureRows.map((e) => ({ kind: "database" as const, listenPort: e.listenPort, allowedCidrs: e.allowedCidrs, tls: e.tls })),
    tunnel: tunnelRow
      ? { mode: tunnelRow.mode, targetPort: tunnelRow.targetPort, hostname: tunnelRow.hostname, hasToken: !!tunnelRow.tokenSealed }
      : null,
    maintenance: maintenance ? { enabled: maintenance.enabled, message: maintenance.message, html: maintenance.html } : null,
    cronJobs: ctx.db
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.serviceId, svc.id))
      .orderBy(asc(cronJobs.createdAt))
      .all()
      .map((j) => ({
        name: j.name,
        schedule: normalizeCronSchedule(j.schedule),
        timeZone: j.timeZone,
        command: j.command,
        timeoutSeconds: j.timeoutSeconds,
        concurrency: j.concurrency,
        enabled: j.enabled,
      })),
    uptimeChecks: ctx.db
      .select()
      .from(uptimeChecks)
      .where(eq(uptimeChecks.serviceId, svc.id))
      .orderBy(asc(uptimeChecks.createdAt))
      .all()
      .map((c) => ({
        name: c.name,
        url: c.url,
        method: c.method,
        expectedStatus: c.expectedStatus,
        intervalSeconds: c.intervalSeconds,
        timeoutMs: c.timeoutMs,
        failureThreshold: c.failureThreshold,
        keyword: c.keyword,
        maxLatencyMs: c.maxLatencyMs,
        enabled: c.enabled,
      })),
    alerts: rules
      .filter((r) => r.event !== undefined)
      .map((r) => ({
        event: r.event as Doc["alerts"][number]["event"],
        enabled: r.enabled,
        channels: r.channelIds.flatMap((id) => {
          const c = channels.get(id);
          return c ? [{ name: c.name, kind: c.kind }] : [];
        }),
      })),
    backups: policies.flatMap((p) => {
      const d = destinations.get(p.destinationId);
      if (!d) return [];
      return [
        {
          target: p.target,
          volume: p.volumeId ? (volumeNames.get(p.volumeId) ?? null) : null,
          schedule: p.schedule,
          keepLast: p.keepLast,
          stopService: p.stopService,
          enabled: p.enabled,
          destination: { name: d.name, provider: d.provider, bucket: d.bucket },
        },
      ];
    }),
    deployTrigger:
      ctx.db.select({ id: deployTriggers.id }).from(deployTriggers).where(eq(deployTriggers.serviceId, svc.id)).get() !== undefined,
    live: live
      ? {
          commitSha: live.commitSha && /^[0-9a-f]{7,64}$/.test(live.commitSha) ? live.commitSha : null,
          branch: live.branch,
          // The image of a panel build lives in this panel's registry: only an image source's digest means something elsewhere.
          imageDigest:
            source.type === "image" && live.imageDigest && /^sha256:[0-9a-f]{64}$/.test(live.imageDigest) ? live.imageDigest : null,
          deployedAt: (live.finishedAt ?? live.createdAt).toISOString(),
        }
      : null,
    upload: newestUpload ? { fileName: newestUpload.fileName, sizeBytes: newestUpload.sizeBytes, entry: uploadEntry } : null,
  };
  return {
    doc,
    secrets,
    upload: newestUpload
      ? { id: newestUpload.id, fileName: newestUpload.fileName, sizeBytes: newestUpload.sizeBytes, sha256: newestUpload.sha256 }
      : null,
    leftOut,
    sourceLogin,
  };
}
