// Managed databases: Postgres (optionally with pgvector), MySQL, MariaDB,
// Mongo, Redis, Valkey, KeyDB, Dragonfly and ClickHouse services with
// generated credentials, internal and exposed connection URLs, an
// on-demand web UI and a pre-logged-in shell (both opened with short-lived
// edge tickets), and TLS exposure through the agent's portgate.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { Cidr } from "./domains";
import { ServiceName } from "./services";

export const DatabaseEngine = Type.Union([
  Type.Literal("postgres"),
  Type.Literal("mysql"),
  Type.Literal("mariadb"),
  Type.Literal("mongo"),
  Type.Literal("redis"),
  Type.Literal("valkey"),
  Type.Literal("keydb"),
  Type.Literal("dragonfly"),
  Type.Literal("clickhouse"),
]);

/** Every engine id, in the order screens list them; also the service kinds of databases. */
export const databaseEngineIds = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "valkey",
  "keydb",
  "dragonfly",
  "clickhouse",
] as const satisfies readonly Static<typeof DatabaseEngine>[];

/** An image with extensions on the engine's majors: "pgvector" (Postgres). */
export const DatabaseVariant = Type.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9-]+$" });

/** A service name: it is also the internal host name. */
export const DatabaseName = ServiceName;

const Identifier = Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });

/** Agent-owned listener port for exposure; 1024 and up, never the panel's or Traefik's. */
export const PublicPort = Type.Integer({ minimum: 1024, maximum: 65535 });

/** Port and URL without secrets, for overview screens. */
export const ConnectionSummary = Type.Object({
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  /** Default database; empty for the Redis-like engines. */
  database: Type.String(),
  user: Type.String(),
  /** ClickHouse's HTTP interface on the same host; null for other engines. */
  httpPort: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
});

export const DatabaseExposure = Type.Object({
  enabled: Type.Boolean(),
  /** Node public address (or tlsHostname) and the agent-owned port. Null while closed. */
  host: Type.Union([Type.String(), Type.Null()]),
  port: Type.Union([PublicPort, Type.Null()]),
  /** The separate user for exposed access; it must use TLS. Redis uses the default user with TLS. */
  user: Type.String(),
  /** Empty means anyone may connect; the UI warns about it. */
  allowedCidrs: Type.Array(Cidr),
  /**
   * The engine may be exposed only to listed source addresses (KeyDB, which
   * gets no security fixes): setExposure refuses an empty allowedCidrs.
   */
  needsAllowedCidrs: Type.Boolean(),
  /** Host name of the ACME certificate; null means a self-signed certificate. */
  tlsHostname: Type.Union([Type.String(), Type.Null()]),
  certificate: Type.Union([
    Type.Literal("none"),
    Type.Literal("selfSigned"),
    Type.Literal("pending"),
    Type.Literal("valid"),
    Type.Literal("failed"),
  ]),
  /** The certificate the exposed port serves, as the node reports it; null until it does. */
  certificateIssuer: Type.Union([Type.String(), Type.Null()]),
  certificateExpiresAt: Type.Union([Timestamp, Type.Null()]),
});

export const Database = Type.Object({
  serviceId: Id,
  projectId: Id,
  name: DatabaseName,
  engine: DatabaseEngine,
  /** Engine version as chosen, for example "17" for Postgres. */
  version: Type.String(),
  /** Image variant ("pgvector"); null for the engine's plain image. */
  variant: Type.Union([DatabaseVariant, Type.Null()]),
  nodeId: Id,
  nodeName: Type.String(),
  /** For services of the project on the same node: host = the service name. */
  internal: ConnectionSummary,
  exposure: DatabaseExposure,
  /** The pre-logged-in client the shell runs: psql, mysql, mongosh, redis-cli, valkey-cli, clickhouse-client, ... */
  shellClient: Type.String(),
  webUi: Type.Object({
    /** Tool picked by engine: pgweb, phpMyAdmin, mongo-express, Redis Commander, ClickHouse Play. */
    tool: Type.String(),
    /** Stops after this many idle minutes. */
    idleMinutes: Type.Integer({ minimum: 1 }),
    /** As the node reports it: the tool starts on the first visit and stops when idle. */
    running: Type.Boolean(),
    /** Last request through the web UI while it runs; null when stopped or unknown. */
    lastActiveAt: Type.Union([Timestamp, Type.Null()]),
  }),
  createdAt: Timestamp,
});

/** The secrets view: full URLs with passwords. */
export const DatabaseConnection = Type.Object({
  internal: Type.Object({
    url: Type.String(),
    host: Type.String(),
    port: Type.Integer(),
    database: Type.String(),
    user: Type.String(),
    password: Type.String(),
    /** ClickHouse only: the HTTP interface's URL (port 8123), with the password. */
    httpUrl: Type.Optional(Type.String()),
  }),
  /** Null while exposure is off. */
  exposed: Type.Union([
    Type.Object({
      url: Type.String(),
      host: Type.String(),
      port: Type.Integer(),
      database: Type.String(),
      user: Type.String(),
      password: Type.String(),
      /** Driver hint, for example "sslmode=require" for Postgres. */
      tlsParams: Type.String(),
    }),
    Type.Null(),
  ]),
});

/** A short-lived link through the node's edge listener; opening it sets a cookie for that tool only. */
export const EdgeTicket = Type.Object({
  url: Type.String(),
  expiresAt: Timestamp,
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);

/** One engine of the catalog: what databases.create accepts for it. */
export const EngineInfo = Type.Object({
  engine: DatabaseEngine,
  label: Type.String(),
  /** Main port inside the project network (ClickHouse: the native protocol). */
  port: Type.Integer(),
  /** Major versions, newest (the default) first. */
  versions: Type.Array(Type.Object({ version: Type.String(), image: Type.String() })),
  /** Images with extensions on some of the majors, for example pgvector for Postgres. */
  variants: Type.Array(
    Type.Object({
      id: DatabaseVariant,
      label: Type.String(),
      versions: Type.Array(Type.Object({ version: Type.String(), image: Type.String() })),
    }),
  ),
  /** The admin user when none is given; null means one is generated. */
  defaultUser: Type.Union([Type.String(), Type.Null()]),
  /** False for the Redis-like engines: one user, no database to name. */
  hasDatabase: Type.Boolean(),
  shellClient: Type.String(),
  webUiTool: Type.String(),
  /** A caution for whoever picks the engine, for example that upstream ships no security fixes; null for most. */
  notice: Type.Union([Type.String(), Type.Null()]),
});

export const engines = defineOp({
  id: "databases.engines",
  kind: "query",
  summary: "List database engines",
  description:
    "Lists the engines databases.create accepts, with their major versions, image variants (pgvector), default users, tools and a notice where an engine needs one (KeyDB is unmaintained and gets no security fixes; prefer Valkey). Images are pinned to exact versions.",
  input: Type.Object({}),
  output: Type.Object({ engines: Type.Array(EngineInfo) }),
  // A fixed catalog that holds nothing of the panel's: anyone signed in may read it.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "databases.create",
  kind: "mutation",
  summary: "Create a database",
  description:
    "Creates a Postgres, MySQL, MariaDB, Mongo, Redis, Valkey, KeyDB, Dragonfly or ClickHouse service in a project on one node, with generated credentials (or the ones given) and a data volume. Postgres takes variant pgvector for an image with the vector extension. databases.engines lists versions, variants and notices (KeyDB gets no security fixes; prefer Valkey). Other services on the same node reach it at <name>:<port>; services on other nodes need exposure. It starts right away, which needs services.deploy in the project.",
  input: Type.Object({
    projectId: Id,
    name: DatabaseName,
    engine: DatabaseEngine,
    /** Defaults to the newest supported major version. */
    version: Type.Optional(Type.String({ maxLength: 20, pattern: "^[0-9A-Za-z._-]+$" })),
    /** An image variant of the engine, for example "pgvector" for Postgres; left out for the plain image. */
    variant: Type.Optional(DatabaseVariant),
    nodeId: Id,
    /** Default database to create; defaults to the service name. Ignored for the Redis-like engines. */
    database: Type.Optional(Identifier),
    /** Defaults to the engine's usual admin user (postgres, root, ...); ClickHouse gets a generated one. */
    user: Type.Optional(Identifier),
    /** Generated (32 random characters) when left out. */
    password: Type.Optional(Type.String({ minLength: 12, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" })),
  }),
  output: Database,
  sensitive: { input: ["password"] },
  permission: permission.project("services.create", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: true,
});

export const get = defineOp({
  id: "databases.get",
  kind: "query",
  summary: "Get a database",
  description: "Returns a database's engine, node, internal address, exposure and web UI state, without passwords.",
  input: Type.Object({ serviceId: Id }),
  output: Database,
  permission: serviceScope("services.view"),
  mcp: true,
  audit: false,
});

export const connection = defineOp({
  id: "databases.connection",
  kind: "query",
  summary: "Get connection details",
  description:
    "Returns the internal connection URL and, when exposure is on, the exposed URL, with passwords. Internal URLs only work for services of the project on the same node.",
  input: Type.Object({ serviceId: Id }),
  output: DatabaseConnection,
  sensitive: { output: ["internal.url", "internal.password", "internal.httpUrl", "exposed.url", "exposed.password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: false,
});

export const resetPassword = defineOp({
  id: "databases.resetPassword",
  kind: "destructive",
  summary: "Reset a database password",
  description:
    "Sets a new password for the admin user (internal) or the exposed user. Services that reference the password get it on their next deploy or restart; anything else using the old password stops connecting. ClickHouse and Dragonfly read the admin password from their environment at start, so a new one restarts them.",
  input: Type.Object({
    serviceId: Id,
    user: Type.Union([Type.Literal("internal"), Type.Literal("exposed")]),
    /** Generated when left out. */
    password: Type.Optional(Type.String({ minLength: 12, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" })),
  }),
  output: Type.Object({
    password: Type.String(),
    /** Services that reference this database and need a restart to pick it up. */
    affectedServiceIds: Type.Array(Id),
  }),
  sensitive: { input: ["password"], output: ["password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

export const openWebUi = defineOp({
  id: "databases.openWebUi",
  kind: "mutation",
  summary: "Open the database web UI",
  description:
    "Returns a one-time link to the database's web UI (pgweb, phpMyAdmin, mongo-express, Redis Commander or ClickHouse's Play page), already signed in. The tool starts on first use and stops when idle.",
  input: Type.Object({ serviceId: Id }),
  output: EdgeTicket,
  sensitive: { output: ["url"] },
  permission: serviceScope("databases.tools"),
  mcp: false,
  audit: true,
});

export const openShell = defineOp({
  id: "databases.openShell",
  kind: "mutation",
  summary: "Open a database shell",
  description:
    "Returns a ticket for a terminal already signed in to the database (psql, mysql, mongosh, redis-cli, valkey-cli, keydb-cli, clickhouse-client). The web app passes it to the terminal socket; it works once and expires in a minute.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    /** Opaque, single use; given to the terminal socket. */
    ticket: Type.String(),
    /** Path of the terminal WebSocket on the panel. */
    socketPath: Type.String(),
    /** The client that will run, for the tab title. */
    client: Type.String(),
    expiresAt: Timestamp,
  }),
  sensitive: { output: ["ticket"] },
  permission: serviceScope("databases.tools"),
  mcp: false,
  audit: true,
});

export const setExposure = defineOp({
  id: "databases.setExposure",
  kind: "mutation",
  summary: "Expose a database",
  description:
    "Turns TLS exposure on or off. On: the agent listens on a node port with the database's own TLS for a separate user, optionally limited to source CIDRs (required where exposure.needsAllowedCidrs is true, as for KeyDB). The internal URL does not change. Fields left out keep their value.",
  input: Type.Object({
    serviceId: Id,
    enabled: Type.Boolean(),
    /** Leave out to keep the current port or let the agent pick a free one. */
    port: Type.Optional(PublicPort),
    allowedCidrs: Type.Optional(Type.Array(Cidr, { maxItems: 200 })),
    /** Host name pointing at the node for an ACME certificate; null for self-signed. */
    tlsHostname: Type.Optional(Type.Union([Type.String({ maxLength: 253 }), Type.Null()])),
  }),
  output: Database,
  permission: serviceScope("databases.expose"),
  mcp: true,
  audit: true,
});
