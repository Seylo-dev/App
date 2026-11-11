// Managed databases: Postgres (optionally with pgvector), MySQL, MariaDB,
// Mongo, Redis, Valkey, KeyDB, Dragonfly and ClickHouse services with
// generated credentials, internal and exposed connection URLs, an
// on-demand web UI and a pre-logged-in shell (both opened with short-lived
// edge tickets), and TLS exposure through the agent's portgate with the
// database's own user and password.

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
  /**
   * "off" while exposure is off, "open" while the node keeps the port open.
   * "waitingForNodeUpdate" while exposure is on but the node's agent cannot
   * keep this engine's port TLS only yet (Postgres, MySQL and MariaDB need
   * an agent from 0.2.9): the port stays closed and host, port and the
   * exposed URL are null, and the setting is kept, so the port opens by
   * itself once the node is updated.
   */
  state: Type.Union([Type.Literal("off"), Type.Literal("open"), Type.Literal("waitingForNodeUpdate")]),
  /** Node public address (or tlsHostname) and the agent-owned port. Null while closed (state is not "open"). */
  host: Type.Union([Type.String(), Type.Null()]),
  port: Type.Union([PublicPort, Type.Null()]),
  /** The user for exposed access: the database's own (internal.user), over TLS only. */
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
  /** Null while exposure is off or waits for the node's update (Database exposure.state). */
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

/** A catalog version as databases.setVersion would take it, and whether it may. */
export const VersionChoice = Type.Object({
  /** The catalog's version line, for example "8.0". */
  version: Type.String(),
  /** The pinned image of that line in this panel's catalog. */
  image: Type.String(),
  /**
   * current: the database runs this very image. patch: the same version
   * line, a newer pinned image. upgrade: a newer line of the same major
   * (MariaDB 11.4 to 11.8). major: a newer major (MongoDB 7.0 to 8.0).
   * downgrade: an older line, never allowed.
   */
  kind: Type.Union([
    Type.Literal("current"),
    Type.Literal("patch"),
    Type.Literal("upgrade"),
    Type.Literal("downgrade"),
    Type.Literal("major"),
  ]),
  allowed: Type.Boolean(),
  /**
   * Why not, when allowed is false: current, downgrade, olderImage,
   * postgresMajor, oneStep (one version line at a time), patchOnly or
   * dataPath.
   */
  reason: Type.Optional(Type.String()),
  /** The reason in a sentence. */
  message: Type.Optional(Type.String()),
});

export const versionChoices = defineOp({
  id: "databases.versionChoices",
  kind: "query",
  summary: "List the versions a database can change to",
  description:
    "Lists the catalog versions of a database's engine (and variant) with what databases.setVersion does with each: a patch update to a newer pinned image, an upgrade, or why it is refused (downgrades, Postgres majors, more than one MongoDB, MariaDB or MySQL step at a time, KeyDB and Dragonfly beyond patches). blocked says why no change can start now (not placed, stopped, a deploy running); recentBackupAt is the newest successful database backup, which a change of version line needs from the last 24 hours unless confirmNoBackup.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    engine: DatabaseEngine,
    version: Type.String(),
    variant: Type.Union([DatabaseVariant, Type.Null()]),
    /** The image the database runs (its live deployment's). */
    image: Type.String(),
    /** The image it is set to run when that is not what runs: a change whose deploy is running or failed. */
    pendingImage: Type.Union([Type.String(), Type.Null()]),
    /** Newest first, like databases.engines. */
    choices: Type.Array(VersionChoice),
    /** Why no change can start now (noNode, stopped, deployRunning); null when one can. */
    blocked: Type.Union([Type.Object({ reason: Type.String(), message: Type.String() }), Type.Null()]),
    /** When the newest successful database backup finished; null when there is none. */
    recentBackupAt: Type.Union([Timestamp, Type.Null()]),
    /** That backup is from the last 24 hours: a change of version line needs no confirmNoBackup. */
    backupFresh: Type.Boolean(),
  }),
  permission: serviceScope("services.view"),
  mcp: true,
  audit: false,
});

export const setVersion = defineOp({
  id: "databases.setVersion",
  // A newer version rewrites the data files: the only way back is a restore.
  kind: "destructive",
  summary: "Change a database's version",
  description:
    "Moves a database to another version line of its engine, or to the newest pinned image of its own line (a patch update), and deploys it: the database restarts on the same data, a short outage. Check databases.versionChoices first. Downgrades are refused for every engine, and so are Postgres majors (dump and restore into a new database instead); MongoDB, MariaDB and MySQL go one line at a time, and MongoDB's featureCompatibilityVersion is raised to the running version first. A change of version line needs a successful backup from the last 24 hours, or confirmNoBackup: true. image takes the engine's own official image with an explicit tag or digest instead of the catalog's (not tested by Seylo), judged by the version line it claims.",
  input: Type.Object({
    serviceId: Id,
    /** A catalog version of the database's engine, for example "8.0". */
    version: Type.String({ maxLength: 20, pattern: "^[0-9A-Za-z._-]+$" }),
    /** The engine's official image with an explicit tag or digest, for example "mongo:8.0.40"; never latest. */
    image: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    /** Change the version line without a backup from the last 24 hours. */
    confirmNoBackup: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    database: Database,
    /** The deploy that starts the new version. */
    deploymentId: Type.Union([Id, Type.Null()]),
  }),
  permission: serviceScope("services.deploy"),
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
    "Returns the internal connection URL and, when exposure is on, the exposed URL, with passwords. Both use the database's own user and password; the exposed one only over TLS. Internal URLs only work for services of the project on the same node.",
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
    "Sets a new password for the database's user, the one used inside and through the exposed port alike. The user value exposed is still accepted for older callers and changes the same password as internal: there is no separate exposed user. Services that reference the password (PASSWORD, INTERNAL_URL, INTERNAL_HTTP_URL or EXPOSED_URL) get it on their next deploy or restart; anything else using the old password stops connecting. ClickHouse and Dragonfly read the admin password from their environment at start, so a new one restarts them.",
  input: Type.Object({
    serviceId: Id,
    /** Both mean the database's one user; "exposed" is kept for older callers. */
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
    "Turns TLS exposure on or off. On: the agent opens a node port to the database, TLS only, for the database's own user and password (nothing changes inside the database), optionally limited to source CIDRs (required where exposure.needsAllowedCidrs is true, as for KeyDB). Postgres, MySQL and MariaDB need a node agent from 0.2.9 or later (CONFLICT agentTooOld otherwise). MariaDB 10.11 has no TLS and cannot be exposed (CONFLICT noTls; 11.4 and later can). The internal URL does not change. Fields left out keep their value.",
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
