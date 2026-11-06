// Projects and the services in them: what runs, where, and with which
// volumes. Live state (running, health, usage) is kept in memory from agent
// reports; tables hold desired state and history. Related tables by owner:
// deploys.ts (deployments, builds, previews), env.ts (env and secrets),
// networking.ts (domains, ports, tunnels), runtime.ts (crash reports).

import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, updatedAt } from "./columns";
import { users } from "./identity";
import { nodes } from "./infra";

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    name: text("name").notNull(),
    /** lower(name), so names are unique without regard to case. */
    nameKey: text("name_key").notNull(),
    description: text("description").notNull().default(""),
    /** The Panel project (the panel and its registry); cannot be deleted. */
    protected: integer("protected", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("projects_name_key_unique").on(t.nameKey)],
);

/** Per-person sidebar state of a project: collapsed and position in their own order. */
export const projectPrefs = sqliteTable(
  "project_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
    /** null = not ordered; sorted by name after the ordered ones. */
    position: integer("position"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] }), index("project_prefs_project_idx").on(t.projectId)],
);

export type ServiceKind = "app" | "compose" | "postgres" | "mysql" | "mariadb" | "mongo" | "redis" | "box" | "cron";

export const services = sqliteTable(
  "services",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    kind: text("kind").$type<ServiceKind>().notNull(),
    /**
     * For compose members: the stack (kind "compose") they were split from
     * with compose-go. Members have kind "app", are listed under their
     * stack and are created and deleted only with it.
     */
    parentId: text("parent_id").references((): AnySQLiteColumn => services.id, { onDelete: "cascade" }),
    /**
     * Desired configuration (source, build, ports, health check, crash
     * policy, resources) as JSON. The services module owns its TypeBox
     * schema and validates before every write; it maps to ServiceSpec in
     * proto/seylo/agent/v1/service.proto when sent to agents. Never put
     * secrets here: they go in service_secrets or service_env.
     */
    spec: json<unknown>("spec").notNull(),
    /** Bumped on every change agents must apply; containers are named by it. */
    generation: integer("generation").notNull().default(1),
    /** The deployment currently serving traffic. */
    liveDeploymentId: text("live_deployment_id"),
    /**
     * The deployment whose image and settings agents should run now: the
     * live one, or the one rolling out. The desired-state compiler reads
     * the image and the settings snapshot from it; null = never deployed,
     * so nothing runs.
     */
    targetDeploymentId: text("target_deployment_id"),
    /** Desired run state: stopped services keep volumes, routes (status page) and history. */
    stopped: integer("stopped", { mode: "boolean" }).notNull().default(false),
    notes: text("notes").notNull().default(""),
    /** Compose stacks: the pasted compose file, sealed because compose files carry passwords. */
    composeFileSealed: sealed("compose_file_sealed"),
    protected: integer("protected", { mode: "boolean" }).notNull().default(false),
    /** Template slug this service was created from, if any. */
    templateSlug: text("template_slug"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("services_project_name_unique").on(t.projectId, t.nameKey),
    index("services_project_idx").on(t.projectId),
    index("services_parent_idx").on(t.parentId),
  ],
);

/** Where a service runs and with how many replicas; several rows = load balanced across nodes. */
export const servicePlacements = sqliteTable(
  "service_placements",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    replicas: integer("replicas").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.nodeId] }), index("service_placements_node_idx").on(t.nodeId)],
);

export type VolumeKind = "volume" | "file";

export const volumes = sqliteTable(
  "volumes",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    /** Folder name under services/<id>/volumes on the node. */
    name: text("name").notNull(),
    mountPath: text("mount_path").notNull(),
    kind: text("kind").$type<VolumeKind>().notNull().default("volume"),
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    /** Compose stacks: the member whose folder holds a volume several members share. */
    ownerServiceId: text("owner_service_id").references(() => services.id, { onDelete: "cascade" }),
    /** For file mounts: the file content, sealed because config files hold secrets. */
    contentSealed: sealed("content_sealed"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("volumes_service_name_unique").on(t.serviceId, t.name)],
);
