// Timed exposes of a database (exposures.openTimed, offered on its
// Connection tab): the agent's portgate relays the database's own port to
// node-ip:port for the allowed addresses until it ends, adding no TLS. This
// says whether the database serves TLS itself, and builds the URL and the
// client command people connect with, with the database's own user.

import type { exposures as exposureOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { connectionUrl, exposureRefusal, httpUrl } from "./engines";
import { type DatabaseInfo, exposureState } from "./info";

type TimedDatabaseAccess = Static<typeof exposureOps.TimedDatabaseAccess>;

/** The container ports a timed expose of the database may open: its own, and ClickHouse's HTTP interface. */
export function timedPorts(info: DatabaseInfo): number[] {
  return info.engine.httpPort === null ? [info.engine.port] : [info.engine.port, info.engine.httpPort];
}

/**
 * "database" when the database serves TLS itself on targetPort, so clients
 * can ask for it through the gate: MySQL makes its own certificate at its
 * first start, MariaDB from 11.4 too (10.11 has none: exposureRefusal), and
 * Postgres has TLS on while its exposed port is open (dbtools.ExposedTLS
 * turned it on). Mongo, ClickHouse and the Redis-like engines get TLS from
 * the gate on the exposed port only, so through a timed expose they are
 * plain ("none").
 */
export function timedTls(info: DatabaseInfo, targetPort: number): "database" | "none" {
  if (targetPort !== info.engine.port) return "none";
  switch (info.row.engine) {
    case "mysql":
      return "database";
    case "mariadb":
      return exposureRefusal(info.row) === null ? "database" : "none";
    case "postgres":
      return exposureState(info) === "open" ? "database" : "none";
    default:
      return "none";
  }
}

/** The connection URL through host:port; password null leaves it out. */
export function timedUrl(info: DatabaseInfo, host: string, port: number, targetPort: number, password: string | null): string {
  const creds = { ...info.admin, password };
  if (targetPort !== info.engine.port) return httpUrl(info.row.engine, creds, host, port) ?? "";
  return connectionUrl(info.row.engine, creds, host, port, timedTls(info, targetPort) === "database");
}

/** A shell word: as it is when it is plain, else in single quotes. */
function sh(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The engine's client through host:port, with the database's user, asking
 * for the password (never in the command, so it stays out of shell
 * history).
 */
export function timedCommand(info: DatabaseInfo, host: string, port: number, targetPort: number): string {
  const { user, database } = info.admin;
  const tls = timedTls(info, targetPort) === "database";
  // Flags take the bare address; URLs keep an IPv6 address in brackets.
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (targetPort !== info.engine.port) {
    const query = `http://${host}:${port}/?database=${encodeURIComponent(database)}`;
    return `curl --user ${sh(user)} ${sh(query)} --data-binary 'SELECT version()'`;
  }
  switch (info.row.engine) {
    case "postgres":
      return `psql ${sh(timedUrl(info, host, port, targetPort, null))}`;
    case "mongo":
      return `mongosh ${sh(timedUrl(info, host, port, targetPort, null))}`;
    case "mysql":
      return `mysql -h ${sh(bare)} -P ${port} -u ${sh(user)} -p${tls ? " --ssl-mode=REQUIRED" : ""} ${sh(database)}`;
    case "mariadb":
      return `mariadb -h ${sh(bare)} -P ${port} -u ${sh(user)} -p${tls ? " --ssl" : ""} ${sh(database)}`;
    case "clickhouse":
      // --password last, without a value: the client asks for it.
      return `clickhouse-client --host ${sh(bare)} --port ${port} --user ${sh(user)} --database ${sh(database)} --password`;
    default:
      // Every Redis-like engine speaks the protocol redis-cli does; AUTH with one argument is the default user.
      return `redis-cli -h ${sh(bare)} -p ${port} --askpass`;
  }
}

/** exposures TimedExpose.database: how to connect through the port, without the password. */
export function timedAccess(info: DatabaseInfo, host: string, port: number | null, targetPort: number): TimedDatabaseAccess {
  return {
    engine: info.row.engine,
    user: info.admin.user,
    database: info.admin.database,
    tls: timedTls(info, targetPort),
    url: port === null ? null : timedUrl(info, host, port, targetPort, null),
    command: port === null ? null : timedCommand(info, host, port, targetPort),
  };
}
