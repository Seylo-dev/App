// What differs per database engine: pinned images per major version (and
// per variant, such as pgvector), the ports, the container command and
// environment that create the first user, health checks, connection URLs,
// the commands that change a password in a running database (run through
// the agent's Exec, password on stdin), and the web UI and shell client
// names.

import type { services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import type { DatabaseEngine } from "../../db/schema";
import { defaultContainer } from "../services/spec";

export interface EngineVersion {
  /** Major version as people pick it, for example "17". */
  version: string;
  /** Exact image tag (or digest); never a floating tag, so a redeploy runs the same bytes. */
  image: string;
  /** Where the data volume is mounted. */
  dataPath: string;
  /**
   * Why the version cannot be exposed, when it has no TLS of its own and the
   * agent installs none (MariaDB 10.11; MariaDB makes its own certificate
   * from 11.4): the exposed port is TLS only, so setExposure refuses it with
   * this, and an exposure from before 0.2.9 reads as closed (loadDatabase).
   */
  noExposure?: string;
  /**
   * MySQL 8.4: mysql_native_password ships off, and mysqlNativePasswordFlag
   * turns it on (databases.setVersion keepNativePassword). Lines before it
   * have it on; 9.0 removed it.
   */
  nativePasswordOption?: boolean;
}

/** The engine with extensions in its image, on the same majors. */
export interface EngineVariant {
  id: string;
  label: string;
  versions: EngineVersion[];
}

export interface Engine {
  engine: DatabaseEngine;
  label: string;
  /** Main port; ClickHouse's native protocol. */
  port: number;
  /** ClickHouse's HTTP interface; null for the others. */
  httpPort: number | null;
  /** Newest first; the first one is the default. */
  versions: EngineVersion[];
  variants: EngineVariant[];
  /** The admin user when none is given; null generates one (ClickHouse). */
  defaultUser: string | null;
  /** The Redis-like engines have no databases to create. */
  hasDatabase: boolean;
  /** Redis protocol with one user, "default"; exposed access uses it over TLS. */
  redisLike: boolean;
  webUiTool: string;
  shellClient: string;
  /** URL scheme for connection strings. */
  scheme: string;
  /** Driver hint for TLS connections from outside. */
  tlsParams: string;
  /**
   * How a new admin password takes effect: "exec" changes it in the running
   * database first (changePasswordExec); "restart" means the server reads it
   * from its environment at every start, so the new env (which recreates the
   * container) is the change.
   */
  passwordChange: "exec" | "restart";
  /** Only agents that advertise database.engines.v2 run it (database.proto). */
  needsAgentCapability: boolean;
  /** A caution for whoever picks the engine (databases.engines); null for most. */
  notice: string | null;
  /**
   * Exposure only to listed source addresses, never to anyone: for an engine
   * that gets no security fixes, so its known holes are not one password
   * away from the internet.
   */
  exposureNeedsAllowlist: boolean;
  /**
   * Exposed only through agents that advertise database.exposure.v2: the
   * engine negotiates TLS inside its protocol, and only such an agent's
   * portgate refuses clients that do not ask for it (an older one relays
   * the port plainly). Postgres, MySQL and MariaDB.
   */
  exposureNeedsCapability: boolean;
}

/**
 * KeyDB 6.3.4 (2023) is its last release. It forked Redis 6.2 before the
 * 2025 Lua advisories (fixed in Redis 6.2.20 and Valkey), so it still has
 * them, and its one user may run scripts.
 */
export const keydbNotice =
  "Unmaintained: KeyDB has had no release since 6.3.4 (2023), so it gets no security fixes, including the 2025 Redis Lua scripting advisories (CVE-2025-49844, CVE-2025-46817, CVE-2025-46818, CVE-2025-46819). Prefer Valkey. Exposure needs allowed source addresses.";

/** The agent capability for the engines added in 0.2 (go/internal/dbengine). */
export const enginesCapability = "database.engines.v2";

/**
 * The agent capability for exposure with the database's own user, TLS only
 * (0.2.9, go/internal/dbengine ExposureCapability).
 */
export const exposureCapability = "database.exposure.v2";

const pg = (version: string, image: string): EngineVersion => ({
  version,
  image,
  // Postgres 18 images keep data in /var/lib/postgresql/18/docker and refuse a mount at the old path.
  dataPath: Number(version) >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data",
});

export const engines: Record<DatabaseEngine, Engine> = {
  postgres: {
    engine: "postgres",
    label: "PostgreSQL",
    port: 5432,
    httpPort: null,
    versions: [
      pg("18", "postgres:18.6-alpine"),
      pg("17", "postgres:17.6-alpine"),
      pg("16", "postgres:16.10-alpine"),
      pg("15", "postgres:15.14-alpine"),
    ],
    variants: [
      {
        id: "pgvector",
        label: "pgvector",
        // Debian-based (the plain images are Alpine): a database cannot switch between them in place.
        versions: [
          pg("18", "pgvector/pgvector:0.8.7-pg18-trixie"),
          pg("17", "pgvector/pgvector:0.8.7-pg17-trixie"),
          pg("16", "pgvector/pgvector:0.8.7-pg16-trixie"),
          pg("15", "pgvector/pgvector:0.8.7-pg15-trixie"),
        ],
      },
    ],
    defaultUser: "postgres",
    hasDatabase: true,
    redisLike: false,
    webUiTool: "pgweb",
    shellClient: "psql",
    scheme: "postgresql",
    tlsParams: "sslmode=require",
    passwordChange: "exec",
    needsAgentCapability: false,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: true,
  },
  mysql: {
    engine: "mysql",
    label: "MySQL",
    port: 3306,
    httpPort: null,
    versions: [
      { version: "8.4", image: "mysql:8.4.6", dataPath: "/var/lib/mysql", nativePasswordOption: true },
      { version: "8.0", image: "mysql:8.0.43", dataPath: "/var/lib/mysql" },
    ],
    variants: [],
    defaultUser: "root",
    hasDatabase: true,
    redisLike: false,
    webUiTool: "phpMyAdmin",
    shellClient: "mysql",
    scheme: "mysql",
    tlsParams: "ssl-mode=REQUIRED",
    passwordChange: "exec",
    needsAgentCapability: false,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: true,
  },
  mariadb: {
    engine: "mariadb",
    label: "MariaDB",
    port: 3306,
    httpPort: null,
    versions: [
      { version: "11.8", image: "mariadb:11.8.2", dataPath: "/var/lib/mysql" },
      { version: "11.4", image: "mariadb:11.4.7", dataPath: "/var/lib/mysql" },
      {
        version: "10.11",
        image: "mariadb:10.11.13",
        dataPath: "/var/lib/mysql",
        noExposure:
          "MariaDB 10.11 has no TLS, so it cannot be exposed: the exposed port only takes TLS connections. MariaDB 11.4 and later can.",
      },
    ],
    variants: [],
    defaultUser: "root",
    hasDatabase: true,
    redisLike: false,
    webUiTool: "phpMyAdmin",
    shellClient: "mariadb",
    scheme: "mysql",
    tlsParams: "ssl-mode=REQUIRED",
    passwordChange: "exec",
    needsAgentCapability: false,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: true,
  },
  mongo: {
    engine: "mongo",
    label: "MongoDB",
    port: 27017,
    httpPort: null,
    versions: [
      { version: "9.0", image: "mongo:9.0.4", dataPath: "/data/db" },
      { version: "8.0", image: "mongo:8.0.34", dataPath: "/data/db" },
      { version: "7.0", image: "mongo:7.0.45", dataPath: "/data/db" },
    ],
    variants: [],
    defaultUser: "root",
    hasDatabase: true,
    redisLike: false,
    webUiTool: "mongo-express",
    shellClient: "mongosh",
    scheme: "mongodb",
    tlsParams: "tls=true",
    passwordChange: "exec",
    needsAgentCapability: false,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: false,
  },
  redis: {
    engine: "redis",
    label: "Redis",
    port: 6379,
    httpPort: null,
    versions: [
      { version: "8.2", image: "redis:8.2.1-alpine", dataPath: "/data" },
      { version: "7.4", image: "redis:7.4.5-alpine", dataPath: "/data" },
    ],
    variants: [],
    defaultUser: "default",
    hasDatabase: false,
    redisLike: true,
    webUiTool: "Redis Commander",
    shellClient: "redis-cli",
    scheme: "redis",
    tlsParams: "",
    passwordChange: "exec",
    needsAgentCapability: false,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: false,
  },
  valkey: {
    engine: "valkey",
    label: "Valkey",
    port: 6379,
    httpPort: null,
    versions: [
      { version: "9.1", image: "valkey/valkey:9.1.3-alpine", dataPath: "/data" },
      { version: "9.0", image: "valkey/valkey:9.0.7-alpine", dataPath: "/data" },
      { version: "8.1", image: "valkey/valkey:8.1.11-alpine", dataPath: "/data" },
    ],
    variants: [],
    defaultUser: "default",
    hasDatabase: false,
    redisLike: true,
    webUiTool: "Redis Commander",
    shellClient: "valkey-cli",
    scheme: "redis",
    tlsParams: "",
    passwordChange: "exec",
    needsAgentCapability: true,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: false,
  },
  keydb: {
    engine: "keydb",
    label: "KeyDB",
    port: 6379,
    httpPort: null,
    versions: [
      // KeyDB publishes no multi-arch version tag: this is the index of x86_64_v6.3.4 and arm64_v6.3.4.
      {
        version: "6.3",
        image: "eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac",
        dataPath: "/data",
      },
    ],
    variants: [],
    defaultUser: "default",
    hasDatabase: false,
    redisLike: true,
    webUiTool: "Redis Commander",
    shellClient: "keydb-cli",
    scheme: "redis",
    tlsParams: "",
    passwordChange: "exec",
    needsAgentCapability: true,
    notice: keydbNotice,
    exposureNeedsAllowlist: true,
    exposureNeedsCapability: false,
  },
  dragonfly: {
    engine: "dragonfly",
    label: "Dragonfly",
    port: 6379,
    httpPort: null,
    versions: [{ version: "2.0", image: "ghcr.io/dragonflydb/dragonfly:v2.0.2", dataPath: "/data" }],
    variants: [],
    defaultUser: "default",
    hasDatabase: false,
    redisLike: true,
    webUiTool: "Redis Commander",
    shellClient: "redis-cli",
    scheme: "redis",
    tlsParams: "",
    // CONFIG SET requirepass leaves the old password working on Dragonfly.
    passwordChange: "restart",
    needsAgentCapability: true,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: false,
  },
  clickhouse: {
    engine: "clickhouse",
    label: "ClickHouse",
    port: 9000,
    httpPort: 8123,
    versions: [
      { version: "26.8", image: "clickhouse/clickhouse-server:26.8.36.3", dataPath: "/var/lib/clickhouse" },
      { version: "26.3", image: "clickhouse/clickhouse-server:26.3.62.3", dataPath: "/var/lib/clickhouse" },
    ],
    variants: [],
    defaultUser: null,
    hasDatabase: true,
    redisLike: false,
    webUiTool: "ClickHouse Play",
    shellClient: "clickhouse-client",
    scheme: "clickhouse",
    tlsParams: "secure=true",
    // The image writes the user from CLICKHOUSE_USER/PASSWORD into a read-only users.d file at every start.
    passwordChange: "restart",
    needsAgentCapability: true,
    notice: null,
    exposureNeedsAllowlist: false,
    exposureNeedsCapability: false,
  },
};

/**
 * What a database service runs, derived from its engine and version only:
 * the image, command, port, health probe and the recreate strategy (two
 * copies must never share one data folder). databases.create and imports
 * build it here; nothing of it comes from a person or a file.
 */
export function databaseSpec(engine: DatabaseEngine, version: EngineVersion) {
  const e = engines[engine];
  return {
    source: { type: "image" as const, image: version.image, registryId: null },
    container: { ...defaultContainer, command: containerCommand(engine), entrypoint: [], stopGraceSeconds: 30 },
    ports: [{ containerPort: e.port, protocol: "tcp" as const }],
    healthCheck: {
      probe: healthProbe(engine),
      intervalSeconds: 10,
      timeoutSeconds: 5,
      startPeriodSeconds: 60,
      failureThreshold: 6,
    },
    deploy: { mode: "recreate" as const, healthTimeoutSeconds: 300 },
  };
}

/** The image list of an engine or of one of its variants; null for a variant it does not have. */
export function engineVersions(engine: DatabaseEngine, variant: string | null | undefined): EngineVersion[] | null {
  const e = engines[engine];
  if (!variant) return e.versions;
  return e.variants.find((v) => v.id === variant)?.versions ?? null;
}

export function engineVersion(engine: DatabaseEngine, version: string | undefined, variant?: string | null): EngineVersion | null {
  const list = engineVersions(engine, variant);
  if (!list) return null;
  if (version === undefined) return list[0] ?? null;
  return list.find((v) => v.version === version) ?? null;
}

/** Why the database's version cannot be exposed (EngineVersion.noExposure); null when it can. */
export function exposureRefusal(row: { engine: DatabaseEngine; version: string; variant: string | null }): string | null {
  return engineVersion(row.engine, row.version, row.variant)?.noExposure ?? null;
}

export interface Credentials {
  user: string;
  password: string;
  /** Empty for the Redis-like engines. */
  database: string;
}

/** Environment that makes the official image create the user and database on first start. */
export function containerEnv(engine: DatabaseEngine, creds: Credentials): { name: string; value: string; secret: boolean }[] {
  const env = (name: string, value: string, secret = false) => ({ name, value, secret });
  switch (engine) {
    case "postgres":
      return [env("POSTGRES_USER", creds.user), env("POSTGRES_PASSWORD", creds.password, true), env("POSTGRES_DB", creds.database)];
    case "mysql":
    case "mariadb": {
      const p = engine === "mysql" ? "MYSQL" : "MARIADB";
      const out = [env(`${p}_ROOT_PASSWORD`, creds.password, true), env(`${p}_DATABASE`, creds.database)];
      if (creds.user !== "root") out.push(env(`${p}_USER`, creds.user), env(`${p}_PASSWORD`, creds.password, true));
      // MariaDB upgrades its system tables on the first start of a newer version (databases.setVersion); MySQL does by itself.
      if (engine === "mariadb") out.push(env("MARIADB_AUTO_UPGRADE", "1"));
      return out;
    }
    case "mongo":
      return [
        env("MONGO_INITDB_ROOT_USERNAME", creds.user),
        env("MONGO_INITDB_ROOT_PASSWORD", creds.password, true),
        env("MONGO_INITDB_DATABASE", creds.database),
      ];
    case "redis":
      return [env("REDIS_PASSWORD", creds.password, true)];
    case "valkey":
      return [env("VALKEY_PASSWORD", creds.password, true)];
    case "keydb":
      return [env("KEYDB_PASSWORD", creds.password, true)];
    case "dragonfly":
      // Dragonfly reads every flag from DFLY_<flag>, so the password stays off its command line.
      return [env("DFLY_requirepass", creds.password, true)];
    case "clickhouse":
      return [
        env("CLICKHOUSE_USER", creds.user),
        env("CLICKHOUSE_PASSWORD", creds.password, true),
        env("CLICKHOUSE_DB", creds.database),
        // Lets the admin manage users with SQL (the agent retires the exposed user of databases from before 0.2.9).
        env("CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "1"),
      ];
  }
}

/**
 * Container command override. Redis-like engines take the password from the
 * environment, not the command line (Redis, Valkey and KeyDB hide their
 * arguments behind their process title). Valkey and KeyDB go through the
 * image's entrypoint so the server drops root like it does by default;
 * Dragonfly's entrypoint does that for "dragonfly" itself. Dragonfly writes
 * RDB snapshots as dump.rdb (what backups restore), on shutdown and every
 * five minutes, since it has no append-only file. MySQL runs the image's
 * own command, except with `nativePassword` (databases.setVersion
 * keepNativePassword, MySQL 8.4 only): mysqld through the image's
 * entrypoint with the mysql_native_password plugin on, which 8.4 ships off.
 * New databases never get it.
 */
export function containerCommand(engine: DatabaseEngine, options: { nativePassword?: boolean } = {}): string[] {
  switch (engine) {
    case "mysql":
      return options.nativePassword ? ["mysqld", mysqlNativePasswordFlag] : [];
    case "redis":
      return ["sh", "-c", 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'];
    case "valkey":
      return ["sh", "-c", 'exec docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes'];
    case "keydb":
      return ["sh", "-c", 'exec docker-entrypoint.sh keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD" --appendonly yes'];
    case "dragonfly":
      return [
        "dragonfly",
        "--logtostderr",
        "--dir",
        "/data",
        "--dbfilename",
        "dump",
        "--df_snapshot_format=false",
        "--snapshot_cron",
        "*/5 * * * *",
      ];
    default:
      return [];
  }
}

/**
 * mysqld's option that turns the mysql_native_password plugin on. MySQL 8.4
 * ships it off, so accounts made with it cannot sign in there without this;
 * MySQL 9.0 removed the plugin.
 */
export const mysqlNativePasswordFlag = "--mysql-native-password=ON";

/** Whether a MySQL database's container command turns mysql_native_password on. */
export function hasNativePassword(command: readonly string[]): boolean {
  return command.includes(mysqlNativePasswordFlag);
}

/**
 * A MySQL container command with mysql_native_password on or off. On adds
 * the option to the panel's command (containerCommand) or to a mysqld
 * command set by hand; off takes it out again, back to the image's own
 * command when nothing else is left. Null when the command is not mysqld's,
 * so the option has nowhere to go.
 */
export function withNativePassword(command: readonly string[], on: boolean): string[] | null {
  const rest = command.filter((arg) => arg !== mysqlNativePasswordFlag);
  if (!on) return rest.length === 1 && rest[0] === "mysqld" ? [] : rest;
  if (rest.length === 0) return containerCommand("mysql", { nativePassword: true });
  // The image's entrypoint runs mysqld for a command that starts with an option.
  if (rest[0] !== "mysqld" && !rest[0]?.startsWith("-")) return null;
  return [...rest, mysqlNativePasswordFlag];
}

/**
 * The command that 0.2.0-rc.2 and older panels gave Mongo databases as their
 * health check. mongosh is a Node.js program: every probe (every 10 s) cost
 * about 0.2 s of CPU and a 265 MB process inside the database's container,
 * enough to push a memory-limited database into the OOM killer. Migration
 * 0003 turns it into healthProbe("mongo") on existing databases.
 */
export const legacyMongoHealthCommand = ["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"];

type HealthProbe = Static<typeof serviceOps.HealthCheck>["probe"];

/** The health check probe of a new database. None needs the current password. */
export function healthProbe(engine: DatabaseEngine): HealthProbe {
  // The agent connects to the container's address. mongod's first start
  // creates the user on 127.0.0.1 only, so the port answers there once the
  // real server is up.
  if (engine === "mongo") return { type: "tcp", port: engines.mongo.port };
  return { type: "command", command: healthCommand(engine) };
}

/** Health check command run inside the container (every engine but Mongo, see healthProbe). */
export function healthCommand(engine: Exclude<DatabaseEngine, "mongo">): string[] {
  switch (engine) {
    case "postgres":
      return ["sh", "-c", 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1'];
    case "mysql":
      // mysqladmin ping exits 0 whenever the server answers, even with a stale password.
      return ["sh", "-c", 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent'];
    case "mariadb":
      return ["healthcheck.sh", "--connect", "--innodb_initialized"];
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
      // NOAUTH also proves the server answers, so the check survives a password reset before the next deploy.
      return ["sh", "-c", `${engines[engine].shellClient} ping 2>&1 | grep -qE 'PONG|NOAUTH'`];
    case "clickhouse":
      // On the container's own address: the image's first start serves 127.0.0.1 only while it creates the database.
      return ["sh", "-c", `wget -qO- "http://$(hostname -i | cut -d' ' -f1):8123/ping" | grep -q Ok`];
  }
}

/** Connection URL; credentials are URL-safe by construction (the password alphabet is restricted). */
export function connectionUrl(engine: DatabaseEngine, creds: Credentials, host: string, port: number, tls = false): string {
  const e = engines[engine];
  const auth = `${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@`;
  const path = e.hasDatabase ? `/${encodeURIComponent(creds.database)}` : "";
  const params = [engine === "mongo" ? "authSource=admin" : "", tls ? e.tlsParams : ""].filter(Boolean).join("&");
  const scheme = e.redisLike && tls ? "rediss" : e.scheme;
  return `${scheme}://${auth}${host}:${port}${path}${params ? `?${params}` : ""}`;
}

/**
 * ClickHouse's HTTP interface on the project network, in the form its HTTP
 * clients take (the database as the path): http://user:password@host:8123/db.
 * Null for the other engines.
 */
export function httpUrl(engine: DatabaseEngine, creds: Credentials, host: string): string | null {
  const port = engines[engine].httpPort;
  if (port === null) return null;
  return `http://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${host}:${port}/${encodeURIComponent(creds.database)}`;
}

/**
 * Exec call that changes the password of `user` in a running database. The
 * new password goes on stdin, so it never shows in a process list. The
 * container's environment still holds the old password, which is what
 * these commands sign in with. Null for engines whose password changes by
 * restarting with the new environment (passwordChange "restart").
 */
export function changePasswordExec(engine: DatabaseEngine, user: string, password: string): { command: string[]; stdin: string } | null {
  switch (engine) {
    case "postgres":
      return {
        command: ["sh", "-c", 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
        stdin: `ALTER USER "${user}" WITH PASSWORD '${password}';\n`,
      };
    case "mysql":
    case "mariadb": {
      const p = engine === "mysql" ? "MYSQL" : "MARIADB";
      const client = engine === "mysql" ? "mysql" : "mariadb";
      const hosts = user === "root" ? ["%", "localhost"] : ["%"];
      return {
        command: ["sh", "-c", `${client} -uroot -p"$${p}_ROOT_PASSWORD"`],
        stdin: `${hosts.map((h) => `ALTER USER '${user}'@'${h}' IDENTIFIED BY '${password}';`).join("\n")}\nFLUSH PRIVILEGES;\n`,
      };
    }
    case "mongo":
      return {
        command: [
          "sh",
          "-c",
          'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin admin',
        ],
        stdin: `db.changeUserPassword("${user}", "${password}")\n`,
      };
    case "redis":
    case "valkey":
    case "keydb": {
      // -x takes the last argument from stdin; the old password signs in through REDISCLI_AUTH, not argv.
      const variable = { redis: "REDIS_PASSWORD", valkey: "VALKEY_PASSWORD", keydb: "KEYDB_PASSWORD" }[engine];
      const cli = engines[engine].shellClient;
      return { command: ["sh", "-c", `REDISCLI_AUTH="$${variable}" ${cli} --no-auth-warning -x CONFIG SET requirepass`], stdin: password };
    }
    case "dragonfly":
    case "clickhouse":
      return null;
  }
}

/** Identifier-safe default database name from a service name ("shop-db" -> "shop_db"). */
export function defaultDatabaseName(serviceName: string): string {
  const name = serviceName.replace(/-/g, "_");
  return /^[A-Za-z_]/.test(name) ? name : `db_${name}`;
}

/** 32 characters from the password alphabet the contracts allow. */
export function generatePassword(length = 32): string {
  return randomFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", length);
}

/** A generated admin user name, "<prefix>_" and 10 lowercase letters and digits, for engines without a usual one. */
export function generateUserName(prefix: string): string {
  return `${prefix}_${randomFrom("abcdefghijklmnopqrstuvwxyz0123456789", 10)}`;
}

function randomFrom(alphabet: string, length: number): string {
  // Reject the top byte values so every character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = "";
  for (const b of bytes) {
    if (b < limit) out += alphabet[b % alphabet.length];
    if (out.length === length) break;
  }
  return out.length === length ? out : randomFrom(alphabet, length);
}
