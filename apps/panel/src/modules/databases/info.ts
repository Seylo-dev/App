// Reads a database service with its secrets opened: credentials, node,
// exposure row and the internal and exposed connection details. Env
// references (${{db.INTERNAL_URL}}), the connection op and the desired
// state all use this, so they always agree. The exposed connection uses
// the database's own user and password, over TLS only.

import { OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { portExposures, serviceDatabases, serviceSecrets } from "../../db/schema";
import type { Deps } from "../../deps";
import type { SecretBox } from "../../security/secret-box";
import { getService, nodeAddress, type PlacedNode, type ServiceRow, serviceNodes } from "../domains/lookup";
import { type Credentials, connectionUrl, type Engine, engines, exposureRefusal, httpUrl } from "./engines";

type Tx = Parameters<Parameters<PanelDb["transaction"]>[0]>[0];

export const adminPasswordSecret = "admin_password";
/**
 * The password of the separate exposed user databases had before 0.2.9.
 * Nothing reads it any more; services.clone leaves it out.
 */
export const retiredExposedPasswordSecret = "exposed_password";

export type DatabaseRow = typeof serviceDatabases.$inferSelect;
export type ExposureRow = typeof portExposures.$inferSelect;

export interface DatabaseInfo {
  service: ServiceRow;
  row: DatabaseRow;
  engine: Engine;
  /** Databases run on exactly one node; null only if its placement was removed. */
  node: PlacedNode | null;
  /** Inside and through the exposed port alike. */
  admin: Credentials;
  exposure: ExposureRow | null;
}

export function readSecret(deps: Pick<Deps, "db" | "secrets">, serviceId: string, name: string): string | null {
  const row = deps.db
    .select({ value: serviceSecrets.valueSealed })
    .from(serviceSecrets)
    .where(and(eq(serviceSecrets.serviceId, serviceId), eq(serviceSecrets.name, name)))
    .get();
  return row ? deps.secrets.open(row.value, "service.secret") : null;
}

export function writeSecret(db: PanelDb | Tx, secrets: SecretBox, serviceId: string, name: string, value: string): void {
  const valueSealed = secrets.seal(value, "service.secret");
  db.insert(serviceSecrets)
    .values({ serviceId, name, valueSealed })
    .onConflictDoUpdate({ target: [serviceSecrets.serviceId, serviceSecrets.name], set: { valueSealed, updatedAt: new Date() } })
    .run();
}

export function findDatabase(db: PanelDb, serviceId: string): DatabaseRow | undefined {
  return db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get();
}

export function loadDatabase(deps: Pick<Deps, "db" | "secrets">, serviceId: string): DatabaseInfo {
  const service = getService(deps.db, serviceId);
  const row = findDatabase(deps.db, serviceId);
  if (!row) throw new OpError("NOT_FOUND", `${service.name} is not a database.`, { serviceId });
  const engine = engines[row.engine];
  const adminPassword = readSecret(deps, serviceId, adminPasswordSecret) ?? "";
  // A version without TLS (MariaDB 10.11) is never exposed: a row from before 0.2.9 reads as closed.
  const exposure =
    exposureRefusal(row) === null
      ? (deps.db
          .select()
          .from(portExposures)
          .where(and(eq(portExposures.serviceId, serviceId), eq(portExposures.kind, "database")))
          .get() ?? null)
      : null;
  return {
    service,
    row,
    engine,
    node: serviceNodes(deps.db, serviceId)[0] ?? null,
    admin: { user: row.adminUser, password: adminPassword, database: row.databaseName },
    exposure,
  };
}

export interface Connection {
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * For services of the project on the same node: host is the service name on
 * the project network. ClickHouse adds its HTTP interface (httpUrl).
 */
export function internalConnection(info: DatabaseInfo): Connection & { httpUrl?: string } {
  const host = info.service.name;
  const http = httpUrl(info.row.engine, info.admin, host);
  return {
    url: connectionUrl(info.row.engine, info.admin, host, info.engine.port),
    host,
    port: info.engine.port,
    ...info.admin,
    ...(http ? { httpUrl: http } : {}),
  };
}

/** Host and port people connect to from outside; null while exposure is off or the port is not known yet. */
export function exposedAddress(info: DatabaseInfo): { host: string; port: number | null } | null {
  if (!info.exposure) return null;
  const host = info.row.tlsHostname ?? (info.node ? nodeAddress(info.node) : null);
  if (!host) return null;
  return { host, port: info.exposure.listenPort > 0 ? info.exposure.listenPort : null };
}

export function exposedConnection(info: DatabaseInfo): (Connection & { tlsParams: string }) | null {
  const address = exposedAddress(info);
  if (!address || address.port === null) return null;
  // Mongo and ClickHouse speak TLS from the first byte through the agent; with no host name the
  // certificate is self-signed, so clients must be told to accept it (Postgres and MySQL "require"
  // never verifies).
  const accept = info.row.tlsHostname ? "" : (selfSignedParam[info.row.engine] ?? "");
  // The same user and password as inside: exposing only opens the port, with TLS.
  const url = connectionUrl(info.row.engine, info.admin, address.host, address.port, true);
  return {
    url: accept ? `${url}&${accept}` : url,
    host: address.host,
    port: address.port,
    ...info.admin,
    tlsParams: accept ? `${info.engine.tlsParams}&${accept}` : info.engine.tlsParams,
  };
}

/** The driver option that accepts the self-signed certificate, for engines whose URLs carry one. */
const selfSignedParam: Partial<Record<DatabaseRow["engine"], string>> = {
  mongo: "tlsAllowInvalidCertificates=true",
  clickhouse: "skip_verify=true",
};
