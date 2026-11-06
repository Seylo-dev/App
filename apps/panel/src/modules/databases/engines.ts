// What differs per database engine: pinned images per major version, the
// port, the container environment that creates the first user, health
// checks, connection URLs, the commands that change a password in a
// running database (run through the agent's Exec, password on stdin), and
// the web UI and shell client names.

import type { DatabaseEngine } from "../../db/schema";

export interface EngineVersion {
  /** Major version as people pick it, for example "17". */
  version: string;
  /** Exact image tag; never a floating tag, so a redeploy runs the same bytes. */
  image: string;
  /** Where the data volume is mounted. */
  dataPath: string;
}

export interface Engine {
  engine: DatabaseEngine;
  label: string;
  port: number;
  /** Newest first; the first one is the default. */
  versions: EngineVersion[];
  defaultUser: string;
  /** Redis has no databases to create. */
  hasDatabase: boolean;
  webUiTool: string;
  shellClient: string;
  /** URL scheme for connection strings. */
  scheme: string;
  /** Driver hint for TLS connections from outside. */
  tlsParams: string;
}

export const engines: Record<DatabaseEngine, Engine> = {
  postgres: {
    engine: "postgres",
    label: "PostgreSQL",
    port: 5432,
    versions: [
      { version: "17", image: "postgres:17.6-alpine", dataPath: "/var/lib/postgresql/data" },
      { version: "16", image: "postgres:16.10-alpine", dataPath: "/var/lib/postgresql/data" },
      { version: "15", image: "postgres:15.14-alpine", dataPath: "/var/lib/postgresql/data" },
    ],
    defaultUser: "postgres",
    hasDatabase: true,
    webUiTool: "pgweb",
    shellClient: "psql",
    scheme: "postgresql",
    tlsParams: "sslmode=require",
  },
  mysql: {
    engine: "mysql",
    label: "MySQL",
    port: 3306,
    versions: [
      { version: "8.4", image: "mysql:8.4.6", dataPath: "/var/lib/mysql" },
      { version: "8.0", image: "mysql:8.0.43", dataPath: "/var/lib/mysql" },
    ],
    defaultUser: "root",
    hasDatabase: true,
    webUiTool: "Adminer",
    shellClient: "mysql",
    scheme: "mysql",
    tlsParams: "ssl-mode=REQUIRED",
  },
  mariadb: {
    engine: "mariadb",
    label: "MariaDB",
    port: 3306,
    versions: [
      { version: "11.8", image: "mariadb:11.8.2", dataPath: "/var/lib/mysql" },
      { version: "11.4", image: "mariadb:11.4.7", dataPath: "/var/lib/mysql" },
      { version: "10.11", image: "mariadb:10.11.13", dataPath: "/var/lib/mysql" },
    ],
    defaultUser: "root",
    hasDatabase: true,
    webUiTool: "Adminer",
    shellClient: "mariadb",
    scheme: "mysql",
    tlsParams: "ssl-mode=REQUIRED",
  },
  mongo: {
    engine: "mongo",
    label: "MongoDB",
    port: 27017,
    versions: [
      { version: "8.0", image: "mongo:8.0.12", dataPath: "/data/db" },
      { version: "7.0", image: "mongo:7.0.21", dataPath: "/data/db" },
    ],
    defaultUser: "root",
    hasDatabase: true,
    webUiTool: "mongo-express",
    shellClient: "mongosh",
    scheme: "mongodb",
    tlsParams: "tls=true",
  },
  redis: {
    engine: "redis",
    label: "Redis",
    port: 6379,
    versions: [
      { version: "8.2", image: "redis:8.2.1-alpine", dataPath: "/data" },
      { version: "7.4", image: "redis:7.4.5-alpine", dataPath: "/data" },
    ],
    defaultUser: "default",
    hasDatabase: false,
    webUiTool: "Redis Commander",
    shellClient: "redis-cli",
    scheme: "redis",
    tlsParams: "",
  },
};

export function engineVersion(engine: DatabaseEngine, version: string | undefined): EngineVersion | null {
  const list = engines[engine].versions;
  if (version === undefined) return list[0] ?? null;
  return list.find((v) => v.version === version) ?? null;
}

export interface Credentials {
  user: string;
  password: string;
  /** Empty for Redis. */
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
  }
}

/** Container command override; only Redis needs one (password from the environment, not the command line). */
export function containerCommand(engine: DatabaseEngine): string[] {
  return engine === "redis" ? ["sh", "-c", 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'] : [];
}

/** Health check command run inside the container. None needs the current password. */
export function healthCommand(engine: DatabaseEngine): string[] {
  switch (engine) {
    case "postgres":
      return ["sh", "-c", 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1'];
    case "mysql":
      // mysqladmin ping exits 0 whenever the server answers, even with a stale password.
      return ["sh", "-c", 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent'];
    case "mariadb":
      return ["healthcheck.sh", "--connect", "--innodb_initialized"];
    case "mongo":
      return ["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"];
    case "redis":
      // NOAUTH also proves the server answers, so the check survives a password reset before the next deploy.
      return ["sh", "-c", "redis-cli ping 2>&1 | grep -qE 'PONG|NOAUTH'"];
  }
}

/** Connection URL; credentials are URL-safe by construction (the password alphabet is restricted). */
export function connectionUrl(engine: DatabaseEngine, creds: Credentials, host: string, port: number, tls = false): string {
  const e = engines[engine];
  const auth = `${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@`;
  const path = e.hasDatabase ? `/${encodeURIComponent(creds.database)}` : "";
  const params = [engine === "mongo" ? "authSource=admin" : "", tls ? e.tlsParams : ""].filter(Boolean).join("&");
  const scheme = engine === "redis" && tls ? "rediss" : e.scheme;
  return `${scheme}://${auth}${host}:${port}${path}${params ? `?${params}` : ""}`;
}

/**
 * Exec call that changes the password of `user` in a running database. The
 * new password goes on stdin, so it never shows in a process list. The
 * container's environment still holds the old password, which is what
 * these commands sign in with.
 */
export function changePasswordExec(engine: DatabaseEngine, user: string, password: string): { command: string[]; stdin: string } {
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
      // -x takes the last argument from stdin.
      return { command: ["sh", "-c", 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" -x CONFIG SET requirepass'], stdin: password };
  }
}

/** Identifier-safe default database name from a service name ("shop-db" -> "shop_db"). */
export function defaultDatabaseName(serviceName: string): string {
  const name = serviceName.replace(/-/g, "_");
  return /^[A-Za-z_]/.test(name) ? name : `db_${name}`;
}

/** 32 characters from the password alphabet the contracts allow. */
export function generatePassword(length = 32): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = "";
  for (const b of bytes) {
    // 248 = 4 * 62: reject the top values so every character is equally likely.
    if (b < 248) out += alphabet[b % alphabet.length];
    if (out.length === length) break;
  }
  return out.length === length ? out : generatePassword(length);
}
