// A service's configuration values: the .env file people edit and the
// secrets the panel generates (database passwords and the like). Both are
// sealed and resolved (references like ${{db.URL}} replaced) only when the
// desired state is compiled for an agent.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { projects, services } from "./projects";

/** The service's .env file, sealed as a whole; the env editor edits the text. */
export const serviceEnv = sqliteTable("service_env", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  contentSealed: sealed("content_sealed").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/**
 * Named secrets of a service that are not part of its .env text, for
 * example a database's admin password or a Box password. Other services
 * reach them through references (${{db.PASSWORD}}).
 */
export const serviceSecrets = sqliteTable(
  "service_secrets",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    valueSealed: sealed("value_sealed").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.name] })],
);

/** A project's shared variables (.env text), referenced as ${{project.NAME}}. */
export const projectEnv = sqliteTable("project_env", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  contentSealed: sealed("content_sealed").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

export type DatabaseEngine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

/**
 * The non-secret facts of a database service. Passwords live in
 * service_secrets ("admin_password", "exposed_password"); the exposure
 * listener is a port_exposures row of kind "database".
 */
export const serviceDatabases = sqliteTable("service_databases", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  engine: text("engine").$type<DatabaseEngine>().notNull(),
  /** Major version as chosen, for example "17". */
  version: text("version").notNull(),
  /** Default database; empty for Redis. */
  databaseName: text("database_name").notNull().default(""),
  adminUser: text("admin_user").notNull(),
  /** Separate TLS-only user for exposed access. */
  exposedUser: text("exposed_user").notNull(),
  /** Host name for the exposure's ACME certificate; null = self-signed. */
  tlsHostname: text("tls_hostname"),
  webUiIdleMinutes: integer("web_ui_idle_minutes").notNull().default(15),
  createdAt: createdAt(),
});

/** The non-secret facts of a Box (code-server workspace) service. */
export const serviceBoxes = sqliteTable("service_boxes", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  /** HTTPS git URL cloned into the workspace on first start. */
  repository: text("repository"),
  /** Sleeps after this many idle minutes; 0 never sleeps. */
  idleMinutes: integer("idle_minutes").notNull().default(30),
  /** Last time someone opened it through boxes.open. */
  lastUsedAt: timestamp("last_used_at"),
  createdAt: createdAt(),
});
