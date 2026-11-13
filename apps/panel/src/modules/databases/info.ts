// Reads a database service with its secrets opened: credentials, node,
// exposure row and the internal and exposed connection details. Env
// references (${{db.INTERNAL_URL}}), the connection op and the desired
// state all use this, so they always agree. The exposed connection uses
// the database's own user and password, over TLS (and also without when
// the owner allowed it and the node's agent can, plainAccepted), and reads
// as closed while the node's agent is too old to keep the port TLS only
// (exposureWaitsFor), as the desired state keeps it.

import { OpError } from "@seylo/ops";
import type { OpenPort } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { portExposures, serviceDatabases, serviceSecrets } from "../../db/schema";
import type { Deps } from "../../deps";
import type { SecretBox } from "../../security/secret-box";
import { getService, nodeAddress, type PlacedNode, type ServiceRow, serviceNodes } from "../domains/lookup";
import { missingExposureCapability, nodeHasCapability } from "./capability";
import { type Credentials, connectionUrl, type Engine, engines, exposureRefusal, httpUrl, plainExposureCapability } from "./engines";

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
  /**
   * The capability the node's agent lacks to keep the exposed port TLS only
   * (missingExposureCapability, from the node's stored facts as the desired
   * state reads them); null when it has it or exposure is off. While set,
   * the row is kept but the port is closed (databaseRuntime), and every
   * reader says so: exposedAddress and exposedConnection are null.
   */
  exposureWaitsFor: string | null;
  /**
   * The node's agent cannot take clients without TLS (no
   * database.exposure.plain.v1 in its stored facts, or no node): the port
   * stays TLS only whatever exposure.allowPlain says (databaseRuntime
   * sends allowPlain only when this is false).
   */
  plainNeedsNodeUpdate: boolean;
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
  const node = serviceNodes(deps.db, serviceId)[0] ?? null;
  return {
    service,
    row,
    engine,
    node,
    admin: { user: row.adminUser, password: adminPassword, database: row.databaseName },
    exposure,
    exposureWaitsFor: exposure && node ? missingExposureCapability(deps.db, null, engine, node.id) : null,
    plainNeedsNodeUpdate: !node || !nodeHasCapability(deps.db, null, node.id, plainExposureCapability),
  };
}

/** Clients without TLS get through the open port: the owner allowed them and the node's agent can. */
export function plainAccepted(info: DatabaseInfo): boolean {
  return exposureState(info) === "open" && !!info.exposure?.allowPlain && !info.plainNeedsNodeUpdate;
}

/** databases.get exposure.state: "waitingForNodeUpdate" while exposure is on and the node's agent is too old for it. */
export function exposureState(info: DatabaseInfo): "off" | "open" | "waitingForNodeUpdate" {
  if (!info.exposure) return "off";
  return info.exposureWaitsFor ? "waitingForNodeUpdate" : "open";
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
 * the project network. ClickHouse adds its HTTP interface (httpUrl). creds:
 * another user than the main one (databases.createUser's URLs).
 */
export function internalConnection(info: DatabaseInfo, creds: Credentials = info.admin): Connection & { httpUrl?: string } {
  const host = info.service.name;
  const http = httpUrl(info.row.engine, creds, host);
  return {
    url: connectionUrl(info.row.engine, creds, host, info.engine.port),
    host,
    port: info.engine.port,
    ...creds,
    ...(http ? { httpUrl: http } : {}),
  };
}

/**
 * Host and port people connect to from outside (port null until the agent
 * reports it); null while exposure is off or waits for the node's update.
 */
export function exposedAddress(info: DatabaseInfo): { host: string; port: number | null } | null {
  if (!info.exposure || info.exposureWaitsFor) return null;
  const host = info.row.tlsHostname ?? (info.node ? nodeAddress(info.node) : null);
  if (!host) return null;
  return { host, port: info.exposure.listenPort > 0 ? info.exposure.listenPort : null };
}

/**
 * The exposed port as the database's node reports it (its certificate and,
 * from 0.2.16 agents, whether TLS is on inside the database); undefined
 * while exposure is off, its port is not known yet or the node does not
 * report it open.
 */
export function reportedExposedPort(agents: Pick<AgentHub, "state"> | undefined, info: DatabaseInfo): OpenPort | undefined {
  const port = info.exposure?.listenPort ?? 0;
  if (port === 0) return undefined;
  const status = agents?.state.serviceStatuses(info.service.id).find((s) => !info.node || s.nodeId === info.node.id)?.status;
  return status?.openPorts.find((p) => p.hostPort === port && !p.expiresAt);
}

/** creds: another user than the main one (databases.createUser's URLs). */
export function exposedConnection(
  info: DatabaseInfo,
  creds: Credentials = info.admin,
): (Connection & { tlsParams: string; allowPlain: boolean }) | null {
  const address = exposedAddress(info);
  if (!address || address.port === null) return null;
  // Mongo and ClickHouse speak TLS from the first byte through the agent; with no host name the
  // certificate is self-signed, so clients must be told to accept it (Postgres and MySQL "require"
  // never verifies).
  const accept = info.row.tlsHostname ? "" : (selfSignedParam[info.row.engine] ?? "");
  // The same user and password as inside: exposing only opens the port, with TLS. The URL asks for TLS
  // also where plain clients are accepted too: it keeps working, and it is the safe default to hand out.
  const url = connectionUrl(info.row.engine, creds, address.host, address.port, true);
  return {
    url: accept ? `${url}&${accept}` : url,
    host: address.host,
    port: address.port,
    ...creds,
    tlsParams: accept ? `${info.engine.tlsParams}&${accept}` : info.engine.tlsParams,
    allowPlain: plainAccepted(info),
  };
}

/** The driver option that accepts the self-signed certificate, for engines whose URLs carry one. */
const selfSignedParam: Partial<Record<DatabaseRow["engine"], string>> = {
  mongo: "tlsAllowInvalidCertificates=true",
  clickhouse: "skip_verify=true",
};
