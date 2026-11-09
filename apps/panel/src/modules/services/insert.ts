// Creating service rows. Every module that makes services (services.create,
// compose stacks, templates, previews, databases and Boxes) goes
// through insertService so names, placements and specs are checked the same
// way. It runs inside the caller's transaction; nothing reaches a node until
// the service is deployed (deployments/queue.ts queueDeploy).
//
//   const { id } = ctx.db.transaction((tx) => insertService(tx, { projectId, name, kind: "postgres", nodeId, spec: { source: { type: "image", image: "postgres:17", registryId: null } } }));
//   queueDeploy(ctx, { serviceId: id, trigger: "manual", actor });

import { OpError, services as serviceOps } from "@seylo/ops";
import { and, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { nodes, projects, type ServiceKind, servicePlacements, services, volumes } from "../../db/schema";
import { nameKey } from "./rows";
import { checkSpec, defaultSpec, type ServiceSpecJson } from "./spec";

const volumeNameRe = new RegExp(serviceOps.volumeNamePattern);

/** A transaction or the database itself. */
export type Tx = Pick<PanelDb, "select" | "insert" | "update" | "delete">;

export interface InsertServiceInput {
  projectId: string;
  /** DNS-safe, unique in the project (checked here). */
  name: string;
  kind: ServiceKind;
  /** First placement; more can be added with services.setPlacements. */
  nodeId: string;
  replicas?: number;
  /** Merged over the defaults (defaultSpec in spec.ts). */
  spec?: Partial<ServiceSpecJson>;
  parentId?: string | null;
  templateSlug?: string | null;
  notes?: string;
  protected?: boolean;
  createdBy?: string | null;
  /** Named volumes, mounted at mountPath. */
  volumes?: { name: string; mountPath: string; readOnly?: boolean; ownerServiceId?: string | null }[];
}

export function assertNode(tx: Tx, nodeId: string): { id: string; name: string } {
  const node = tx.select({ id: nodes.id, name: nodes.name, disabledAt: nodes.disabledAt }).from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new OpError("NOT_FOUND", "No node with this id.", { field: "nodeId" });
  if (node.disabledAt) throw new OpError("CONFLICT", `${node.name} is disabled.`, { field: "nodeId" });
  return node;
}

export function assertNameFree(tx: Tx, projectId: string, name: string, exceptServiceId?: string): void {
  const taken = tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, projectId), eq(services.nameKey, nameKey(name))))
    .get();
  if (taken && taken.id !== exceptServiceId) {
    throw new OpError("CONFLICT", `A service named "${name}" already exists in this project.`, { field: "name" });
  }
}

export function insertService(tx: Tx, input: InsertServiceInput): { id: string } {
  if (!tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.", { field: "projectId" });
  }
  assertNameFree(tx, input.projectId, input.name);
  assertNode(tx, input.nodeId);
  // New services get PORT for repository builds (spec.portEnv); a copied spec (clone, preview) keeps its own.
  const spec = checkSpec({ ...defaultSpec(), portEnv: true, ...input.spec });

  const row = tx
    .insert(services)
    .values({
      projectId: input.projectId,
      name: input.name,
      nameKey: nameKey(input.name),
      kind: input.kind,
      parentId: input.parentId ?? null,
      spec,
      generation: 0,
      templateSlug: input.templateSlug ?? null,
      notes: input.notes ?? "",
      protected: input.protected ?? false,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: services.id })
    .get();
  // A compose stack has no containers of its own; its placement records the node its members use.
  tx.insert(servicePlacements)
    .values({ serviceId: row.id, nodeId: input.nodeId, replicas: input.replicas ?? 1 })
    .run();
  for (const v of input.volumes ?? []) {
    // Every path that creates volumes ends here: a name the agent refuses would block the node's desired state.
    if (!volumeNameRe.test(v.name) || v.name.length > 60) {
      throw new OpError("BAD_REQUEST", `${v.name} is not a valid volume name: use a-z, 0-9, "_" and "-" (no dots).`, { field: "volumes" });
    }
    tx.insert(volumes)
      .values({
        serviceId: row.id,
        name: v.name,
        mountPath: v.mountPath,
        readOnly: v.readOnly ?? false,
        ownerServiceId: v.ownerServiceId ?? null,
      })
      .run();
  }
  return row;
}

/** Writes a new spec (validated) and bumps updatedAt. */
export function writeSpec(tx: Tx, serviceId: string, spec: ServiceSpecJson): void {
  tx.update(services)
    .set({ spec: checkSpec(spec), updatedAt: new Date() })
    .where(eq(services.id, serviceId))
    .run();
}

/** Volumes of a service that hold data (not file mounts). */
export function dataVolumes(tx: Tx, serviceId: string) {
  return tx
    .select()
    .from(volumes)
    .where(and(eq(volumes.serviceId, serviceId), eq(volumes.kind, "volume"), isNull(volumes.ownerServiceId)))
    .all();
}
