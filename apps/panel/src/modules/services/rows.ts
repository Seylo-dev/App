// Reads services with what their screens show (placements with node
// names, live deployment, members, address, live status and usage) and maps
// them to the op shapes ServiceSummary and ServiceDetail.

import { OpError, type services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { deployments, domains, nodes, servicePlacements, services, volumes } from "../../db/schema";
import { latestCopy } from "./copies";
import { readSpec, restartDelaySeconds, type ServiceSpecJson } from "./spec";
import { serviceStatus, serviceUsage } from "./status";

export type ServiceRow = typeof services.$inferSelect;
export type ServiceSummary = Static<typeof serviceOps.ServiceSummary>;
export type ServiceDetail = Static<typeof serviceOps.ServiceDetail>;
type SourceSummary = Static<typeof serviceOps.SourceSummary>;

const activeStatuses = ["queued", "building", "deploying"] as const;
const databaseKinds = new Set(["postgres", "mysql", "mariadb", "mongo", "redis"]);

/** Names compare without case. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function loadService(db: PanelDb, serviceId: string): ServiceRow {
  const row = db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No service with this id.");
  return row;
}

export function nodeNames(db: PanelDb, ids?: readonly string[]): Map<string, string> {
  const rows =
    ids === undefined
      ? db.select({ id: nodes.id, name: nodes.name }).from(nodes).all()
      : ids.length === 0
        ? []
        : db
            .select({ id: nodes.id, name: nodes.name })
            .from(nodes)
            .where(inArray(nodes.id, [...ids]))
            .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function placementsOf(db: PanelDb, serviceIds: readonly string[]) {
  const out = new Map<string, { nodeId: string; nodeName: string; replicas: number }[]>();
  if (serviceIds.length === 0) return out;
  const rows = db
    .select({
      serviceId: servicePlacements.serviceId,
      nodeId: servicePlacements.nodeId,
      replicas: servicePlacements.replicas,
      nodeName: nodes.name,
    })
    .from(servicePlacements)
    .innerJoin(nodes, eq(nodes.id, servicePlacements.nodeId))
    .where(inArray(servicePlacements.serviceId, [...serviceIds]))
    .orderBy(asc(servicePlacements.createdAt))
    .all();
  for (const r of rows) {
    const list = out.get(r.serviceId) ?? [];
    list.push({ nodeId: r.nodeId, nodeName: r.nodeName, replicas: r.replicas });
    out.set(r.serviceId, list);
  }
  return out;
}

export function sourceSummary(row: ServiceRow, spec: ServiceSpecJson): SourceSummary {
  const builder = spec.source.type === "inline" ? "dockerfile" : spec.build.builder;
  if (row.kind === "compose") {
    const source = spec.stack?.source;
    if (!source || source.type === "inline") return { type: "compose", label: "Compose file", branch: null, builder: null };
    return { type: "compose", label: source.type === "github" ? source.repo : gitLabel(source.url), branch: source.branch, builder: null };
  }
  const s = spec.source;
  if (databaseKinds.has(row.kind)) return { type: "database", label: s.type === "image" ? s.image : row.kind, branch: null, builder: null };
  switch (s.type) {
    case "github":
      return { type: "github", label: s.repo, branch: s.branch, builder };
    case "git":
      return { type: "git", label: gitLabel(s.url), branch: s.branch, builder };
    case "image":
      return { type: "image", label: s.image, branch: null, builder: null };
    case "inline":
      return { type: "inline", label: "Dockerfile", branch: null, builder: "dockerfile" };
    case "upload":
      return { type: "upload", label: s.fileName ?? "", branch: null, builder };
    case "none":
      return { type: "none", label: "", branch: null, builder: null };
  }
}

/** "git.example.com/team/app" from any git URL form. */
export function gitLabel(url: string): string {
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  const raw = scp ? `${scp[1]}/${scp[2]}` : url.replace(/^(https|ssh):\/\//, "").replace(/^[^@/]+@/, "");
  return raw.replace(/\.git$/, "");
}

interface Context {
  activeDeploy: Map<string, "queued" | "building" | "deploying">;
  live: Map<string, { id: string; label: string; createdAt: Date }>;
  lastDeployedAt: Map<string, Date>;
  primaryHosts: Map<string, string>;
  placements: Map<string, { nodeId: string; nodeName: string; replicas: number }[]>;
}

function loadContext(db: PanelDb, rows: readonly ServiceRow[]): Context {
  const ids = rows.map((r) => r.id);
  const ctx: Context = {
    activeDeploy: new Map(),
    live: new Map(),
    lastDeployedAt: new Map(),
    primaryHosts: new Map(),
    placements: placementsOf(db, ids),
  };
  if (ids.length === 0) return ctx;

  for (const d of db
    .select({ serviceId: deployments.serviceId, status: deployments.status })
    .from(deployments)
    .where(and(inArray(deployments.serviceId, ids), inArray(deployments.status, [...activeStatuses])))
    .all()) {
    // building/deploying win over queued.
    const prev = ctx.activeDeploy.get(d.serviceId);
    if (!prev || prev === "queued") ctx.activeDeploy.set(d.serviceId, d.status as "queued" | "building" | "deploying");
  }

  const liveIds = rows.map((r) => r.liveDeploymentId).filter((id): id is string => id !== null);
  if (liveIds.length > 0) {
    for (const d of db.select().from(deployments).where(inArray(deployments.id, liveIds)).all()) {
      ctx.live.set(d.serviceId, { id: d.id, label: deploymentLabel(d), createdAt: d.createdAt });
      ctx.lastDeployedAt.set(d.serviceId, d.finishedAt ?? d.createdAt);
    }
  }

  for (const d of db
    .select({ serviceId: domains.serviceId, host: domains.host, pathPrefix: domains.pathPrefix, isPrimary: domains.isPrimary })
    .from(domains)
    .where(inArray(domains.serviceId, ids))
    .orderBy(desc(domains.isPrimary), asc(domains.createdAt))
    .all()) {
    if (ctx.primaryHosts.has(d.serviceId)) continue;
    ctx.primaryHosts.set(d.serviceId, d.pathPrefix && d.pathPrefix !== "/" ? `${d.host}${d.pathPrefix}` : d.host);
  }
  return ctx;
}

/** Short commit, or the image tag for image sources. */
export function deploymentLabel(d: typeof deployments.$inferSelect): string {
  if (d.commitSha) return d.commitSha.slice(0, 7);
  if (d.imageRef) {
    const ref = d.imageRef;
    const at = ref.lastIndexOf(":");
    const slash = ref.lastIndexOf("/");
    return at > slash ? ref.slice(at + 1) : "latest";
  }
  return `#${d.generation}`;
}

function summarize(agents: AgentHub, row: ServiceRow, ctx: Context): ServiceSummary {
  const spec = readSpec(row.spec);
  const placements = ctx.placements.get(row.id) ?? [];
  const live = ctx.live.get(row.id) ?? null;
  const firstPort = spec.ports[0];
  const usage = serviceUsage(agents, row.id);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    status: serviceStatus(agents, {
      serviceId: row.id,
      kind: row.kind,
      stopped: row.stopped,
      deployed: row.targetDeploymentId !== null,
      activeDeploy: ctx.activeDeploy.get(row.id) ?? null,
      nodeIds: placements.map((p) => p.nodeId),
    }),
    source: sourceSummary(row, spec),
    address: ctx.primaryHosts.get(row.id) ?? (firstPort ? `${row.name}:${firstPort.containerPort}` : null),
    placements,
    cpuPercent: usage.cpuPercent,
    memoryBytes: usage.memoryBytes,
    memoryLimitBytes: usage.memoryLimitBytes ?? spec.resources.memoryLimitBytes,
    liveDeployment: live ? { id: live.id, label: live.label, createdAt: live.createdAt.toISOString() } : null,
    lastDeployedAt: ctx.lastDeployedAt.get(row.id)?.toISOString() ?? null,
    protected: row.protected,
    templateSlug: row.templateSlug,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummaries(db: PanelDb, agents: AgentHub, rows: readonly ServiceRow[]): ServiceSummary[] {
  const ctx = loadContext(db, rows);
  return rows.map((row) => summarize(agents, row, ctx));
}

export function toSummary(db: PanelDb, agents: AgentHub, row: ServiceRow): ServiceSummary {
  return toSummaries(db, agents, [row])[0] as ServiceSummary;
}

export function toDetail(db: PanelDb, agents: AgentHub, row: ServiceRow): ServiceDetail {
  const spec = readSpec(row.spec);
  const memberRows = db.select().from(services).where(eq(services.parentId, row.id)).orderBy(asc(services.nameKey)).all();
  const all = toSummaries(db, agents, [row, ...memberRows]);
  const summary = all[0] as ServiceSummary;
  return {
    ...summary,
    stopped: row.stopped,
    generation: Math.max(1, row.generation),
    sourceConfig: spec.source,
    build: spec.build,
    container: spec.container,
    ports: spec.ports,
    healthCheck: spec.healthCheck,
    crashPolicy: spec.crashPolicy,
    restartDelaySeconds,
    resources: spec.resources,
    deploy: spec.deploy,
    cron: spec.cron,
    stickySessions: spec.stickySessions,
    entryNodeId: entryNodeOf(spec.entryNodeId, summary.placements),
    notes: row.notes,
    members: all.slice(1).map((m) => ({ id: m.id, name: m.name, status: m.status })),
    volumes: volumesOf(db, row.id),
    dataCopy: latestCopy(db, row.id),
  };
}

/**
 * The node that takes a load-balanced service's public traffic, when one was
 * chosen and it is still a placement. Null: no entry node, every node takes
 * traffic for its domains and balances over the others (also with one
 * placement, where there is nothing to balance).
 */
export function entryNodeOf(chosen: string | null, placements: readonly { nodeId: string }[]): string | null {
  if (placements.length < 2 || !chosen) return null;
  return placements.some((p) => p.nodeId === chosen) ? chosen : null;
}

/** A service's volumes and file mounts, with the compose members that share each folder. */
export function volumesOf(db: PanelDb, serviceId: string): ServiceDetail["volumes"] {
  const own = db.select().from(volumes).where(eq(volumes.serviceId, serviceId)).orderBy(asc(volumes.name)).all();
  return own.map((v) => {
    const folderOwner = v.ownerServiceId ?? serviceId;
    const sharing = db
      .select({ id: services.id, name: services.name, volumeOwner: volumes.ownerServiceId, volumeService: volumes.serviceId })
      .from(volumes)
      .innerJoin(services, eq(services.id, volumes.serviceId))
      .where(eq(volumes.name, v.name))
      .all()
      .filter((r) => r.volumeService !== serviceId && (r.volumeOwner ?? r.volumeService) === folderOwner);
    return {
      id: v.id,
      name: v.name,
      mountPath: v.mountPath,
      kind: v.kind,
      readOnly: v.readOnly,
      sharedWith: sharing.map((r) => ({ id: r.id, name: r.name })),
    };
  });
}

/** Rows of a project in list order: stacks followed by their members, then by name. */
export function projectServiceRows(db: PanelDb, projectId: string): ServiceRow[] {
  const rows = db.select().from(services).where(eq(services.projectId, projectId)).orderBy(asc(services.nameKey)).all();
  const top = rows.filter((r) => r.parentId === null);
  const byParent = new Map<string, ServiceRow[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = byParent.get(r.parentId) ?? [];
    list.push(r);
    byParent.set(r.parentId, list);
  }
  return top.flatMap((r) => [r, ...(byParent.get(r.id) ?? [])]);
}
