// Build settings of a service and the panel-wide build queue. Builds
// themselves run as part of a deploy (deployments/engine.ts).

import { builds as buildOps, OpError } from "@seylo/ops";
import { and, asc, eq, inArray } from "drizzle-orm";
import { builds, deployments, nodes, projects, services } from "../../db/schema";
import { implement } from "../../ops/implement";
import { hasBuildx } from "../deployments/source";
import { defineModule } from "../module";
import { publishService, updateSpec } from "../services/ops";
import { loadService } from "../services/rows";
import { readSpec } from "../services/spec";

const queue = implement(buildOps.queue, (input, ctx) => {
  const rows = ctx.db
    .select({
      id: builds.id,
      deploymentId: builds.deploymentId,
      nodeId: builds.nodeId,
      builder: builds.builder,
      status: builds.status,
      createdAt: builds.createdAt,
      startedAt: builds.startedAt,
      serviceId: services.id,
      serviceName: services.name,
      projectId: projects.id,
      projectName: projects.name,
      commitSha: deployments.commitSha,
      nodeName: nodes.name,
    })
    .from(builds)
    .innerJoin(deployments, eq(deployments.id, builds.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .leftJoin(nodes, eq(nodes.id, builds.nodeId))
    .where(
      input.nodeId
        ? and(inArray(builds.status, ["queued", "running"]), eq(builds.nodeId, input.nodeId))
        : inArray(builds.status, ["queued", "running"]),
    )
    .orderBy(asc(builds.createdAt))
    .all()
    .filter((r) => ctx.access.can("services.view", { type: "service", id: r.serviceId }));
  const positions = new Map<string, number>();
  return {
    builds: rows.map((r) => {
      let position: number | null = null;
      if (r.status === "queued") {
        const key = r.nodeId ?? "";
        position = (positions.get(key) ?? 0) + 1;
        positions.set(key, position);
      }
      return {
        id: r.id,
        deploymentId: r.deploymentId,
        serviceId: r.serviceId,
        serviceName: r.serviceName,
        projectId: r.projectId,
        projectName: r.projectName,
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        builder: r.builder,
        status: r.status,
        position,
        commitSha: r.commitSha,
        queuedAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
      };
    }),
  };
});

function buildNodes(ctx: Parameters<typeof queue.run>[1]) {
  const busy = new Map<string, number>();
  for (const b of ctx.db
    .select({ nodeId: builds.nodeId })
    .from(builds)
    .where(inArray(builds.status, ["queued", "running"]))
    .all()) {
    if (b.nodeId) busy.set(b.nodeId, (busy.get(b.nodeId) ?? 0) + 1);
  }
  return ctx.db
    .select({ id: nodes.id, name: nodes.name, canBuild: nodes.canBuild })
    .from(nodes)
    .orderBy(asc(nodes.name))
    .all()
    .map((n) => ({ ...n, online: ctx.agents.isOnline(n.id), hasBuildx: hasBuildx(ctx, n.id), queued: busy.get(n.id) ?? 0 }));
}

const getSettings = implement(buildOps.getSettings, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  return { settings: readSpec(row.spec).build, nodes: buildNodes(ctx) };
});

const updateSettings = implement(buildOps.updateSettings, (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.kind !== "app" && row.kind !== "cron") throw new OpError("CONFLICT", `A ${row.kind} service is not built.`);
  // The node it has already is not checked again: that would refuse every other change, and its deploys say why they stop.
  if (input.buildNodeId && input.buildNodeId !== readSpec(row.spec).build.buildNodeId) {
    const node = ctx.db.select().from(nodes).where(eq(nodes.id, input.buildNodeId)).get();
    if (!node) throw new OpError("NOT_FOUND", "No node with this id.", { field: "buildNodeId" });
    if (!node.canBuild) throw new OpError("BAD_REQUEST", `${node.name} does not have Can build on.`, { field: "buildNodeId" });
    // Every deploy would stop on it (pickBuildNode): say so now, not at the next deploy.
    if (!hasBuildx(ctx, node.id)) {
      throw new OpError("BAD_REQUEST", `${node.name} has no docker buildx. Install docker-buildx-plugin on it.`, { field: "buildNodeId" });
    }
  }
  const { serviceId: _, ...changes } = input;
  const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  const next = updateSpec(ctx, row.id, (spec) => {
    const build = { ...spec.build, ...defined };
    if (spec.source.type === "inline") build.builder = "dockerfile";
    return { ...spec, build };
  });
  publishService(ctx, row);
  return readSpec(next.spec).build;
});

export default defineModule({ name: "builds", ops: [queue, getSettings, updateSettings] });
