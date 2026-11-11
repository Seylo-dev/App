// Service ops: list, read, create, settings, notes, placements and run state.
// Delete is delete.ts, move is move.ts.

import { normalizeWatchPaths, OpError, services as serviceOps, watchPatternProblem } from "@seylo/ops";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { domains, projectPrefs, projects, servicePlacements, services, volumes } from "../../db/schema";
import type { Deps } from "../../deps";
import { isTimeZone, nodeCronProblem, normalizeCronSchedule } from "../../jobs/cron-expr";
import { implement, type OpContext } from "../../ops/implement";
import { assertNoActiveDeploy, queueDeploy } from "../deployments/queue";
import { openFirstRun } from "../exposures/logic";
import { assertGitSourceTarget, gitCaller } from "../git/targets";
import { dropRepoHooks } from "../github/repo-hooks";
import { dropHook } from "../gitProviders/hooks";
import { panelServiceId } from "../nodes/panel-service";
import { assertNoActiveCopy, assertNoMoveCopy } from "./copies";
import { assertCreateRights } from "./create-rights";
import { assertNameFree, assertNode, insertService, writeSpec } from "./insert";
import { entryNodeOf, loadService, nameKey, projectServiceRows, type ServiceRow, toDetail, toSummaries, volumesOf } from "./rows";
import { assertSourceAllowed } from "./source-guard";
import { defaultBuild, readSpec, restartDelaySeconds, type ServiceSpecJson } from "./spec";

export function actorOf(ctx: OpContext): string | null {
  const p = ctx.principal;
  if (p.type === "anonymous") return null;
  return p.type === "apiKey" ? `${p.user.email} via key ${p.keyName}` : p.user.email;
}

/** Tells open screens a service changed. */
export function publishService(deps: Pick<Deps, "live">, svc: Pick<ServiceRow, "id" | "projectId">): void {
  deps.live.publish(`service:${svc.id}`, { type: "invalidate", ops: [serviceOps.get.id, "builds.getSettings", "previews.getSettings"] });
  deps.live.publish(`project:${svc.projectId}`, { type: "invalidate", ops: [serviceOps.list.id, "projects.get"] });
  deps.live.publish("panel", { type: "invalidate", ops: ["projects.list"] });
}

/** Reads, changes and writes a service's spec; returns the new row. */
export function updateSpec(
  ctx: OpContext,
  serviceId: string,
  change: (spec: ServiceSpecJson, row: ServiceRow) => ServiceSpecJson,
): ServiceRow {
  const row = loadService(ctx.db, serviceId);
  const before = readSpec(row.spec);
  const spec = change(before, row);
  writeSpec(ctx.db, serviceId, spec);
  // A repository webhook belongs to the repository the service deployed: another source drops it.
  if (before.source.type === "provider" && !sameProviderRepo(before.source, spec.source)) dropHook(ctx, serviceId);
  if (viaAccount(before.source) && !sameAccountRepo(before.source, spec.source)) dropRepoHooks(ctx, [serviceId]);
  publishService(ctx, row);
  return loadService(ctx.db, serviceId);
}

function sameProviderRepo(a: ServiceSpecJson["source"], b: ServiceSpecJson["source"]): boolean {
  return a.type === "provider" && b.type === "provider" && a.providerId === b.providerId && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/** A GitHub source read through the connected account (its webhook is the service's own, github/repo-hooks.ts). */
function viaAccount(source: ServiceSpecJson["source"]): boolean {
  return source.type === "github" && source.installationId === null;
}

function sameAccountRepo(a: ServiceSpecJson["source"], b: ServiceSpecJson["source"]): boolean {
  return a.type === "github" && b.type === "github" && viaAccount(a) && viaAccount(b) && a.repo.toLowerCase() === b.repo.toLowerCase();
}

function forbidMemberEdit(row: ServiceRow, what: string): void {
  if (row.parentId)
    throw new OpError("CONFLICT", `${row.name} belongs to a compose stack: change its ${what} in the stack's compose file.`);
}

/** The caller's own order of a project's services (services.reorder), or null. */
function serviceOrderOf(ctx: OpContext, projectId: string): string[] | null {
  const user = userOf(ctx.principal);
  if (!user) return null;
  return (
    ctx.db
      .select({ order: projectPrefs.serviceOrder })
      .from(projectPrefs)
      .where(and(eq(projectPrefs.userId, user.id), eq(projectPrefs.projectId, projectId)))
      .get()?.order ?? null
  );
}

const list = implement(serviceOps.list, (input, ctx) => ({
  services: toSummaries(ctx.db, ctx.agents, projectServiceRows(ctx.db, input.projectId, serviceOrderOf(ctx, input.projectId))),
}));

/** The caller's own order; only their row changes, so nothing goes to shared live topics. */
const reorder = implement(serviceOps.reorder, (input, ctx) => {
  const user = userOf(ctx.principal);
  if (!user) throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
  if (!ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.");
  }
  const own = new Set(
    ctx.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.projectId, input.projectId), isNull(services.parentId)))
      .all()
      .map((r) => r.id),
  );
  const serviceIds = input.serviceIds.filter((id) => own.has(id));
  ctx.db
    .insert(projectPrefs)
    .values({ userId: user.id, projectId: input.projectId, serviceOrder: serviceIds })
    .onConflictDoUpdate({
      target: [projectPrefs.userId, projectPrefs.projectId],
      set: { serviceOrder: serviceIds, updatedAt: new Date() },
    })
    .run();
  return { projectId: input.projectId, serviceIds };
});

const get = implement(serviceOps.get, (input, ctx) => toDetail(ctx.db, ctx.agents, loadService(ctx.db, input.serviceId)));

/** A cron service's schedule as the node reads it: Sunday stored as 0, refused when the node could not run it. */
export function cronSettings(cron: NonNullable<ServiceSpecJson["cron"]>): NonNullable<ServiceSpecJson["cron"]> {
  if (!isTimeZone(cron.timeZone))
    throw new OpError("BAD_REQUEST", `${cron.timeZone} is not a time zone this panel knows.`, { field: "cron.timeZone" });
  const schedule = normalizeCronSchedule(cron.schedule.trim());
  const problem = nodeCronProblem(schedule, cron.timeZone);
  if (problem) throw new OpError("BAD_REQUEST", `The schedule is not valid: ${problem}.`, { field: "cron.schedule" });
  return { ...cron, schedule };
}

const create = implement(serviceOps.create, async (input, ctx) => {
  if (input.kind === "cron" && !input.cron) throw new OpError("BAD_REQUEST", "Cron services need a schedule.", { field: "cron" });
  if (input.source?.type === "github")
    throw new OpError("BAD_REQUEST", "Connect GitHub repositories with github.connectRepo after creating the service.", {
      field: "source",
    });
  if (input.source?.type === "provider")
    throw new OpError(
      "BAD_REQUEST",
      "Connect GitLab, Gitea and Bitbucket repositories with gitProviders.connectRepo after creating the service.",
      {
        field: "source",
      },
    );
  // Deploying it now is a first deploy: services.deploy, like services.start of a never-deployed service.
  assertCreateRights(ctx, { type: "project", id: input.projectId }, { deploy: input.deployNow === true });
  if (input.source) assertSourceAllowed(ctx, input.projectId, input.source);
  await assertGitSourceTarget(ctx.db, input.projectId, input.source, gitCaller(ctx));
  const spec: Partial<ServiceSpecJson> = {
    source: input.source ?? { type: "none" },
    build: { ...defaultBuild, ...input.build, ...(input.source?.type === "inline" ? { builder: "dockerfile" as const } : {}) },
    ports: input.ports ?? [],
    cron: input.kind === "cron" && input.cron ? cronSettings(input.cron) : null,
  };
  const { id } = ctx.db.transaction((tx) =>
    insertService(tx, {
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      nodeId: input.nodeId,
      spec,
      createdBy: userOf(ctx.principal)?.id ?? null,
    }),
  );
  // A new app is reachable on IP:port until it has a domain (exposures module).
  if (input.kind === "app" && (input.ports?.length ?? 0) > 0) openFirstRun(ctx.db, id);
  const row = loadService(ctx.db, id);
  publishService(ctx, row);
  if (input.deployNow)
    queueDeploy(ctx, { serviceId: id, trigger: "manual", actor: actorOf(ctx), triggeredBy: userOf(ctx.principal)?.id ?? null });
  return toDetail(ctx.db, ctx.agents, row);
});

const update = implement(serviceOps.update, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (input.cron !== undefined && row.kind !== "cron")
    throw new OpError("BAD_REQUEST", "Only cron services have a schedule.", { field: "cron" });
  const cron = input.cron === undefined ? undefined : cronSettings(input.cron);
  if (input.name !== undefined && input.name !== row.name) {
    if (row.protected) throw new OpError("CONFLICT", `${row.name} is protected and cannot be renamed.`, { field: "name" });
    assertNameFree(ctx.db, row.projectId, input.name, row.id);
    ctx.db
      .update(services)
      .set({ name: input.name, nameKey: nameKey(input.name) })
      .where(eq(services.id, row.id))
      .run();
  }
  if (input.ports !== undefined || input.container !== undefined) forbidMemberEdit(row, "ports and command");
  const hadPorts = readSpec(row.spec).ports.length > 0;
  const next = updateSpec(ctx, row.id, (spec) => ({
    ...spec,
    container: input.container ? { ...spec.container, ...input.container } : spec.container,
    ports: input.ports ?? spec.ports,
    cron: cron ?? spec.cron,
  }));
  // An app created without a port (set later, after the source) gets its first-run IP:port now, unless it has a domain.
  if (row.kind === "app" && !hadPorts && (input.ports?.length ?? 0) > 0) {
    const hasDomain = ctx.db.select({ id: domains.id }).from(domains).where(eq(domains.serviceId, row.id)).get() !== undefined;
    if (!hasDomain && openFirstRun(ctx.db, row.id)) ctx.agents.desired.markDirty({ serviceId: row.id });
  }
  return toDetail(ctx.db, ctx.agents, next);
});

const setSource = implement(serviceOps.setSource, async (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (input.source.type === "github")
    throw new OpError("BAD_REQUEST", "Use github.connectRepo for GitHub repositories.", { field: "source" });
  if (input.source.type === "provider")
    throw new OpError("BAD_REQUEST", "Use gitProviders.connectRepo for GitLab, Gitea and Bitbucket repositories.", { field: "source" });
  if (row.kind !== "app" && row.kind !== "cron") throw new OpError("CONFLICT", `The source of a ${row.kind} service cannot be changed.`);
  forbidMemberEdit(row, "source");
  assertSourceAllowed(ctx, row.projectId, input.source);
  await assertGitSourceTarget(ctx.db, row.projectId, input.source, gitCaller(ctx));
  const next = updateSpec(ctx, row.id, (spec) => ({
    ...spec,
    source: input.source,
    build: input.source.type === "inline" ? { ...spec.build, builder: "dockerfile" } : spec.build,
    // Previews need a GitHub or git provider source.
    previews: { ...spec.previews, enabled: false },
  }));
  return toDetail(ctx.db, ctx.agents, next);
});

/** Watch paths as stored: normalised, BAD_REQUEST on a pattern that cannot match. */
export function checkWatchPaths(patterns: readonly string[]): string[] {
  const watchPaths = normalizeWatchPaths([...patterns]);
  for (const [index, pattern] of watchPaths.entries()) {
    const problem = watchPatternProblem(pattern);
    if (problem) throw new OpError("BAD_REQUEST", `${pattern}: ${problem}`, { field: `watchPaths.${index}` });
  }
  return watchPaths;
}

const setWatchPaths = implement(serviceOps.setWatchPaths, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.parentId) throw new OpError("CONFLICT", `${row.name} belongs to a compose stack: set watch paths on the stack.`);
  if (row.kind !== "app" && row.kind !== "cron" && row.kind !== "compose")
    throw new OpError("CONFLICT", `A ${row.kind} service does not deploy on push.`);
  const watchPaths = checkWatchPaths(input.watchPaths);
  const next = updateSpec(ctx, row.id, (spec) => ({ ...spec, watchPaths }));
  return { watchPaths: readSpec(next.spec).watchPaths };
});

const setNotes = implement(serviceOps.setNotes, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  const updated = ctx.db.update(services).set({ notes: input.notes }).where(eq(services.id, row.id)).returning().get();
  publishService(ctx, row);
  return { notes: updated.notes, updatedAt: updated.updatedAt.toISOString() };
});

const setHealthCheck = implement(serviceOps.setHealthCheck, (input, ctx) => {
  const next = updateSpec(ctx, input.serviceId, (spec) => ({
    ...spec,
    healthCheck: input.healthCheck,
    deploy: input.deploy ?? spec.deploy,
  }));
  const spec = readSpec(next.spec);
  return { healthCheck: spec.healthCheck, deploy: spec.deploy };
});

const setCrashPolicy = implement(serviceOps.setCrashPolicy, (input, ctx) => {
  const next = updateSpec(ctx, input.serviceId, (spec) => ({
    ...spec,
    crashPolicy: { restart: input.restart, stopAfterCrashes: input.stopAfterCrashes },
  }));
  // The crash policy applies to running containers right away.
  ctx.agents.desired.markDirty({ serviceId: next.id });
  return { crashPolicy: readSpec(next.spec).crashPolicy, restartDelaySeconds };
});

const setResources = implement(serviceOps.setResources, (input, ctx) => {
  const { serviceId: _, ...resources } = input;
  const next = updateSpec(ctx, input.serviceId, (spec) => ({ ...spec, resources }));
  return readSpec(next.spec).resources;
});

const setVolumes = implement(serviceOps.setVolumes, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  forbidMemberEdit(row, "volumes");
  if (row.kind === "compose") throw new OpError("CONFLICT", "A stack's volumes come from its compose file.");
  // A move copies the volumes it read when the copy began, into a placement it already holds.
  assertNoMoveCopy(ctx.db, row.id);
  const names = input.volumes.map((v) => v.name);
  if (new Set(names).size !== names.length) throw new OpError("BAD_REQUEST", "Volume names must be unique.", { field: "volumes" });
  const paths = input.volumes.map((v) => v.mountPath);
  if (new Set(paths).size !== paths.length)
    throw new OpError("BAD_REQUEST", "Two volumes cannot mount at the same path.", { field: "volumes" });
  if (input.volumes.length > 0) {
    const nodes = ctx.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, row.id)).all();
    if (nodes.length > 1)
      throw new OpError("CONFLICT", "Services with volumes run on one node. Remove the other placements first.", { field: "volumes" });
  }
  ctx.db.transaction((tx) => {
    const existing = tx
      .select()
      .from(volumes)
      .where(and(eq(volumes.serviceId, row.id), eq(volumes.kind, "volume")))
      .all();
    const gone = existing.filter((v) => !names.includes(v.name)).map((v) => v.id);
    if (gone.length > 0) tx.delete(volumes).where(inArray(volumes.id, gone)).run();
    for (const v of input.volumes) {
      const found = existing.find((e) => e.name === v.name);
      if (found)
        tx.update(volumes)
          .set({ mountPath: v.mountPath, readOnly: v.readOnly ?? false })
          .where(eq(volumes.id, found.id))
          .run();
      else
        tx.insert(volumes)
          .values({ serviceId: row.id, name: v.name, mountPath: v.mountPath, readOnly: v.readOnly ?? false })
          .run();
    }
  });
  publishService(ctx, row);
  return { volumes: volumesOf(ctx.db, row.id) };
});

const setPlacements = implement(serviceOps.setPlacements, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.id === panelServiceId) throw new OpError("CONFLICT", "The panel runs once, on the panel node.", { reason: "panel" });
  if (row.kind === "compose") throw new OpError("CONFLICT", "A stack runs where its members run; move the stack instead.");
  // The move's copy fills a placement on the new node and reads the stopped one on the old.
  assertNoMoveCopy(ctx.db, row.id);
  const nodeIds = input.placements.map((p) => p.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) throw new OpError("BAD_REQUEST", "Each node can be listed once.", { field: "placements" });
  for (const id of nodeIds) assertNode(ctx.db, id);
  if (input.entryNodeId && !nodeIds.includes(input.entryNodeId)) {
    throw new OpError("BAD_REQUEST", "The entry node must be one of the service's nodes.", { field: "entryNodeId" });
  }
  const current = ctx.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, row.id)).all();
  const hasVolumes = ctx.db.select({ id: volumes.id }).from(volumes).where(eq(volumes.serviceId, row.id)).get() !== undefined;
  if ((hasVolumes || row.parentId) && nodeIds.length > 1) {
    throw new OpError("CONFLICT", "Services with volumes run on one node. Use Move to change the node.", { field: "placements" });
  }
  const currentIds = new Set(current.map((p) => p.nodeId));
  if (hasVolumes && current.length > 0 && !nodeIds.every((id) => currentIds.has(id))) {
    throw new OpError("CONFLICT", "Services with volumes change nodes with Move, which copies their data.", { field: "placements" });
  }
  ctx.db.transaction((tx) => {
    tx.delete(servicePlacements)
      .where(and(eq(servicePlacements.serviceId, row.id), notInArray(servicePlacements.nodeId, nodeIds)))
      .run();
    for (const p of input.placements) {
      tx.insert(servicePlacements)
        .values({ serviceId: row.id, nodeId: p.nodeId, replicas: p.replicas })
        .onConflictDoUpdate({ target: [servicePlacements.serviceId, servicePlacements.nodeId], set: { replicas: p.replicas } })
        .run();
    }
    if (input.stickySessions !== undefined || input.entryNodeId !== undefined) {
      const spec = readSpec(row.spec);
      writeSpec(tx, row.id, {
        ...spec,
        stickySessions: input.stickySessions ?? spec.stickySessions,
        entryNodeId: input.entryNodeId === undefined ? spec.entryNodeId : input.entryNodeId,
      });
    }
  });
  const removed = current.filter((p) => !nodeIds.includes(p.nodeId)).map((p) => p.nodeId);
  ctx.agents.desired.markDirty({ serviceId: row.id });
  for (const nodeId of removed) ctx.agents.desired.markDirty({ nodeId });
  // A node added to a deployed service needs the image: deploy so it is pulled and health checked there.
  const added = nodeIds.filter((id) => !currentIds.has(id));
  if (added.length > 0 && row.targetDeploymentId) {
    ctx.agents.desired.markDirty({ serviceId: row.id });
  }
  publishService(ctx, row);
  const placements = ctx.db
    .select()
    .from(servicePlacements)
    .where(and(eq(servicePlacements.serviceId, row.id), inArray(servicePlacements.nodeId, nodeIds)))
    .all();
  const names = new Map(
    (toSummaries(ctx.db, ctx.agents, [loadService(ctx.db, row.id)])[0]?.placements ?? []).map((p) => [p.nodeId, p.nodeName]),
  );
  const spec = readSpec(loadService(ctx.db, row.id).spec);
  const ordered = input.placements.map((p) => ({ nodeId: p.nodeId, nodeName: names.get(p.nodeId) ?? "", replicas: p.replicas }));
  const stored = new Map(placements.map((p) => [p.nodeId, p.replicas]));
  return {
    placements: ordered.map((p) => ({ ...p, replicas: stored.get(p.nodeId) ?? p.replicas })),
    stickySessions: spec.stickySessions,
    entryNodeId: entryNodeOf(spec.entryNodeId, ordered),
  };
});

function members(ctx: OpContext, row: ServiceRow): ServiceRow[] {
  return row.kind === "compose" ? ctx.db.select().from(services).where(eq(services.parentId, row.id)).all() : [row];
}

const start = implement(serviceOps.start, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  for (const m of members(ctx, row)) {
    assertNoActiveCopy(ctx.db, m.id);
    assertNoMoveCopy(ctx.db, m.id);
  }
  if (row.kind !== "compose" && !row.targetDeploymentId) {
    // A clone starts stopped and never deployed: starting it is its first deploy.
    if (!row.stopped) throw new OpError("CONFLICT", "This service was never deployed. Deploy it first.");
    if (!ctx.access.can("services.deploy", { type: "service", id: row.id })) {
      throw new OpError("FORBIDDEN", "Starting a service for the first time deploys it, which needs the services.deploy permission.", {
        action: "services.deploy",
      });
    }
    assertNoActiveDeploy(ctx, row.id);
    queueDeploy(ctx, { serviceId: row.id, trigger: "manual", actor: actorOf(ctx), triggeredBy: userOf(ctx.principal)?.id ?? null });
    publishService(ctx, row);
    return {};
  }
  for (const m of members(ctx, row)) {
    if (!m.targetDeploymentId) continue;
    ctx.db.update(services).set({ stopped: false }).where(eq(services.id, m.id)).run();
    ctx.agents.desired.markDirty({ serviceId: m.id });
    publishService(ctx, m);
  }
  publishService(ctx, row);
  return {};
});

const stop = implement(serviceOps.stop, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.id === panelServiceId) throw new OpError("CONFLICT", "Stopping the panel would lock everyone out.", { reason: "panel" });
  for (const m of members(ctx, row)) {
    ctx.db.update(services).set({ stopped: true }).where(eq(services.id, m.id)).run();
    ctx.agents.desired.markDirty({ serviceId: m.id });
    publishService(ctx, m);
  }
  publishService(ctx, row);
  return {};
});

const restart = implement(serviceOps.restart, async (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  const targets = members(ctx, row).filter((m) => m.targetDeploymentId && !m.stopped);
  if (targets.length === 0) throw new OpError("CONFLICT", "Nothing is running to restart.");
  const placements = ctx.db
    .select()
    .from(servicePlacements)
    .where(
      inArray(
        servicePlacements.serviceId,
        targets.map((t) => t.id),
      ),
    )
    .all();
  const results = await Promise.allSettled(placements.map((p) => ctx.agents.call(p.nodeId, "restartService", { serviceId: p.serviceId })));
  const failed = results.find((r) => r.status === "rejected");
  if (failed && results.every((r) => r.status === "rejected")) throw (failed as PromiseRejectedResult).reason;
  return {};
});

export const serviceOpsHandlers = [
  list,
  reorder,
  get,
  create,
  update,
  setSource,
  setNotes,
  setWatchPaths,
  setHealthCheck,
  setCrashPolicy,
  setResources,
  setVolumes,
  setPlacements,
  start,
  stop,
  restart,
];
