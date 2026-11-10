// Projects and the services in them: what runs, where, and with which
// volumes. Live state (running, health, usage) is kept in memory from agent
// reports; tables hold desired state and history. Related tables by owner:
// deploys.ts (deployments, builds, previews), env.ts (env and secrets),
// networking.ts (domains, ports, tunnels), runtime.ts (crash reports).

import { type AnySQLiteColumn, blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
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
    /**
     * The person's own order of the project's services (top-level ids, top to
     * bottom; services.reorder). null or a missing id: after the listed ones, by name.
     */
    serviceOrder: json<string[]>("service_order"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] }), index("project_prefs_project_idx").on(t.projectId)],
);

/**
 * A project's uploaded image (projects.setImage, 0.2.6): PNG, JPEG or WebP
 * bytes, served at /api/avatars/project/<id>?v=<hash>. No row = its initial.
 */
export const projectImages = sqliteTable("project_images", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull(),
  /** First 32 hex characters of the bytes' SHA-256: the version in the image's URL. */
  hash: text("hash").notNull(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  createdAt: createdAt(),
});

export type ServiceKind =
  | "app"
  | "compose"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongo"
  | "redis"
  | "valkey"
  | "keydb"
  | "dragonfly"
  | "clickhouse"
  | "box"
  | "cron";

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

export type ServiceCopyStatus = "queued" | "copying" | "done" | "failed";

/**
 * A clone's data copy (services.clone with data "copy"): the source's
 * volumes go through the panel into the clone's folders on its node, the
 * source stopped meanwhile when asked (always for databases). The clone
 * cannot deploy until the copy ended.
 */
export const serviceCopies = sqliteTable(
  "service_copies",
  {
    id: id(),
    /** The clone; null once it was deleted (a copy that stopped its source still starts it again). */
    serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
    sourceServiceId: text("source_service_id").references((): AnySQLiteColumn => services.id, { onDelete: "set null" }),
    /** Kept for display once the source is gone. */
    sourceName: text("source_name").notNull(),
    fromNodeId: text("from_node_id").notNull(),
    toNodeId: text("to_node_id").notNull(),
    status: text("status").$type<ServiceCopyStatus>().notNull().default("queued"),
    /** Stop the source while its folders are read, and start it again afterwards. */
    stopSource: integer("stop_source", { mode: "boolean" }).notNull().default(true),
    /** The copy stopped the source and owes it a start (also after a panel restart mid-copy). */
    sourceStopped: integer("source_stopped", { mode: "boolean" }).notNull().default(false),
    /** Volume names copied (the clone uses the same names). */
    volumes: json<string[]>("volumes").notNull(),
    bytesCopied: integer("bytes_copied").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("service_copies_service_idx").on(t.serviceId), index("service_copies_source_idx").on(t.sourceServiceId)],
);
