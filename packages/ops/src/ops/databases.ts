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
  /** The user for exposed access: the database's own (internal.user), over TLS (also without, with allowPlain). */
  user: Type.String(),
  /** Empty means anyone may connect; the UI warns about it. */
  allowedCidrs: Type.Array(Cidr),
  /**
   * The owner allowed clients without TLS too (0.2.16, databases.setExposure
   * allowPlain): the node relays a client that does not ask for TLS to the
   * database instead of refusing it, and TLS clients connect as before.
   * Their queries, data and, for some sign-in methods, the password travel
   * unencrypted; allowedCidrs still applies. Off by default, and off again
   * after exposure is turned off. While plainNeedsNodeUpdate is true the
   * port stays TLS only whatever this says.
   */
  allowPlain: Type.Boolean(),
  /**
   * The node's agent is older than 0.2.16 and cannot take clients without
   * TLS: the port stays TLS only, also with allowPlain on (it applies by
   * itself once the node is updated), and setExposure refuses allowPlain
   * true (CONFLICT agentTooOld).
   */
  plainNeedsNodeUpdate: Type.Boolean(),
  /**
   * The engine may be exposed only to listed source addresses (KeyDB, which
   * gets no security fixes): setExposure refuses an empty allowedCidrs.
   */
  needsAllowedCidrs: Type.Boolean(),
  /** Host name of the ACME certificate; null means a self-signed certificate. */
  tlsHostname: Type.Union([Type.String(), Type.Null()]),
  /**
   * "selfSigned" without tlsHostname (and for MariaDB, which serves its
   * own); with one "pending" until the node reports its Let's Encrypt
   * certificate, then "valid", or "failed" while the node serves the
   * self-signed one and reports an ACME error for it (0.2.13).
   */
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
  /**
   * Why the exposed port serves a self-signed certificate (0.2.13), which
   * clients that check certificates refuse: "noHostname" (no tlsHostname),
   * "acmeMissing" (the node has no Let's Encrypt certificate for
   * tlsHostname yet, as nodes from 0.2.13 report; certificateError says why
   * when the node knows), "engine" (MariaDB serves the one it makes itself,
   * whatever tlsHostname says). Null while the port serves an ACME
   * certificate, while exposure is off, or when the node does not say.
   */
  selfSignedReason: Type.Union([Type.Literal("noHostname"), Type.Literal("acmeMissing"), Type.Literal("engine"), Type.Null()]),
  /**
   * With selfSignedReason "acmeMissing": the node's last ACME error for
   * tlsHostname (the CA's message, for example that it could not reach
   * port 80 on the node); null while it knows none.
   */
  certificateError: Type.Union([Type.String(), Type.Null()]),
  /**
   * The self-signed certificate the port serves, PEM, as nodes from 0.2.13
   * report it (it is public: every client sees it), so a client can trust
   * that file; null otherwise.
   */
  certificatePem: Type.Union([Type.String(), Type.Null()]),
});

export const Database = Type.Object({
  serviceId: Id,
  projectId: Id,
  name: DatabaseName,
  engine: DatabaseEngine,
  /**
   * Engine version as chosen, for example "17" for Postgres. For an image
   * outside the catalog (0.2.11), the line its tag names, which the catalog
   * may not have ("8.2"), or "custom" when the tag names none (latest, a digest).
   */
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
      /**
       * Clients without TLS are accepted too: exposure.allowPlain is on and
       * the node applies it (0.2.16). url still asks for TLS, which keeps
       * working; a client that leaves TLS off signs in with the same user
       * and password.
       */
      allowPlain: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  /**
   * The open timed exposes of the database (exposures.openTimed) whose port
   * the node reported: the URL exposures.get has, with the password (the
   * same user and password as inside). Empty without one.
   */
  timed: Type.Array(
    Type.Object({
      exposureId: Id,
      host: Type.String(),
      port: Type.Integer({ minimum: 1, maximum: 65535 }),
      url: Type.String(),
    }),
  ),
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
    "Creates a Postgres, MySQL, MariaDB, Mongo, Redis, Valkey, KeyDB, Dragonfly or ClickHouse service in a project on one node, with generated credentials (or the ones given) and a data volume. Postgres takes variant pgvector for an image with the vector extension. databases.engines lists versions, variants and notices (KeyDB gets no security fixes; prefer Valkey). image runs any tag or digest of the engine's own repository instead of the catalog's image (not tested by Seylo; a floating tag such as latest can change on the next deploy); its version is the line the tag names, or custom. Other services on the same node reach it at <name>:<port>; services on other nodes need exposure. It starts right away, which needs services.deploy in the project.",
  input: Type.Object({
    projectId: Id,
    name: DatabaseName,
    engine: DatabaseEngine,
    /** Defaults to the newest supported major version. */
    version: Type.Optional(Type.String({ maxLength: 20, pattern: "^[0-9A-Za-z._-]+$" })),
    /** An image variant of the engine, for example "pgvector" for Postgres; left out for the plain image. */
    variant: Type.Optional(DatabaseVariant),
    /**
     * Any tag or digest of the engine's (or variant's) own repository
     * instead of the catalog's image (0.2.11), for example "mongo:8.2.12",
     * "mongo:latest" or "docker.io/library/postgres:17.7-alpine": mongo,
     * postgres (pgvector/pgvector with pgvector), mysql, mariadb, redis,
     * valkey/valkey, eqalpha/keydb, ghcr.io/dragonflydb/dragonfly or
     * clickhouse/clickhouse-server. Not tested by Seylo. The version
     * recorded is the line its tag names ("8.2"), or "custom"; version is
     * not used then. A Postgres image whose tag names no release also gets
     * PGDATA=/var/lib/postgresql/docker in the database's own variables,
     * so an image older than 18 keeps its data on the volume.
     */
    image: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
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
   * (MariaDB 11.4 to 11.8), also when the release that runs is unknown
   * (latest, a digest). major: a newer major (MongoDB 7.0 to 8.0).
   * downgrade: an older line or an older image (taken with acceptRisk
   * since 0.2.11).
   */
  kind: Type.Union([
    Type.Literal("current"),
    Type.Literal("patch"),
    Type.Literal("upgrade"),
    Type.Literal("downgrade"),
    Type.Literal("major"),
  ]),
  /** databases.setVersion takes it: right away, or with acceptRisk when risk is set. */
  allowed: Type.Boolean(),
  /**
   * Why not, when allowed is false: current (nothing to change). Before
   * 0.2.11 also downgrade, olderImage, postgresMajor, oneStep, patchOnly
   * and dataPath, which are risks now.
   */
  reason: Type.Optional(Type.String()),
  /**
   * What can go wrong, when setVersion needs acceptRisk for it (0.2.11),
   * the most serious one: downgrade (an older line), olderImage (an older
   * release of the line), postgresMajor (pg_upgrade is not run), dataPath
   * (the line keeps its data in another folder), patchOnly (KeyDB and
   * Dragonfly beyond patches), oneStep (a skipped MongoDB, MariaDB or
   * MySQL line), otherLine (a line outside the catalog), postgresBase
   * (another base system: text indexes may need REINDEX), floatingTag or
   * digest (the release that runs or would run is unknown).
   */
  risk: Type.Optional(Type.String()),
  /** Every risk the change takes, the most serious (risk) first: what setVersion's riskNotAccepted names as details.risks (0.2.11). */
  risks: Type.Optional(Type.Array(Type.String())),
  /** The reason or the risks in sentences. */
  message: Type.Optional(Type.String()),
});

export const versionChoices = defineOp({
  id: "databases.versionChoices",
  kind: "query",
  summary: "List the versions a database can change to",
  description:
    "Lists the catalog versions of a database's engine (and variant) with what databases.setVersion does with each: a patch update to a newer pinned image, an upgrade, or the risk it takes, which setVersion needs acceptRisk for (downgrades, Postgres majors, more than one MongoDB, MariaDB or MySQL step at a time, KeyDB and Dragonfly beyond patches, a release that runs which Seylo cannot tell); the image that runs is refused as current. anyImage says that setVersion also takes any tag or digest of repository as image, and release is the release of the image that runs. blocked says why no change can start now (not placed, stopped, a deploy running); recentBackupAt is the newest successful database backup, which every change but a newer patch of the line it runs needs from the last 24 hours unless confirmNoBackup; nativePassword (MySQL only) says whether the database runs with mysql_native_password logins on and which lines take setVersion's keepNativePassword.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    engine: DatabaseEngine,
    version: Type.String(),
    variant: Type.Union([DatabaseVariant, Type.Null()]),
    /** The image the database runs (its live deployment's). */
    image: Type.String(),
    /** The release that image's tag names ("8.0.38"); null for latest, a digest and other tags without one (0.2.11). */
    release: Type.Union([Type.String(), Type.Null()]),
    /** The repository whose tags and digests setVersion's image takes (0.2.11): mongo, postgres, pgvector/pgvector, ... */
    repository: Type.Union([Type.String(), Type.Null()]),
    /** setVersion takes any image of repository, not only the catalog's (0.2.11). */
    anyImage: Type.Boolean(),
    /** The image it is set to run when that is not what runs: a change whose deploy is running or failed. */
    pendingImage: Type.Union([Type.String(), Type.Null()]),
    /** Newest first, like databases.engines. */
    choices: Type.Array(VersionChoice),
    /** Why no change can start now (noNode, stopped, deployRunning); null when one can. */
    blocked: Type.Union([Type.Object({ reason: Type.String(), message: Type.String() }), Type.Null()]),
    /**
     * Deprecated (0.2.11): anyImage while not blocked, since setVersion
     * takes any image. It said that setVersion takes another exact release
     * tag (image) of the version line the database runs, even when no
     * catalog choice of that line is allowed; false while blocked.
     */
    customOnCurrent: Type.Boolean(),
    /** When the newest successful database backup finished; null when there is none. */
    recentBackupAt: Type.Union([Timestamp, Type.Null()]),
    /** That backup is from the last 24 hours: a change of version line needs no confirmNoBackup. */
    backupFresh: Type.Boolean(),
    /**
     * MySQL only, null for the other engines (0.2.11). MySQL 8.4 ships the
     * mysql_native_password plugin off, so accounts made with it cannot
     * sign in there unless the database runs with
     * --mysql-native-password=ON (setVersion keepNativePassword).
     */
    nativePassword: Type.Union([
      Type.Object({
        /** The database is set to run with mysql_native_password on; later deploys and patch updates keep it. */
        on: Type.Boolean(),
        /** The catalog lines whose setVersion takes keepNativePassword: "8.4". */
        lines: Type.Array(Type.String()),
      }),
      Type.Null(),
    ]),
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
    "Moves a database to another version line of its engine, to the newest pinned image of its own line (a patch update), or to any image of its engine's own repository (image: any tag or digest, not tested by Seylo), and deploys it: the database restarts on the same data, a short outage. Check databases.versionChoices first. Refused outright: another repository, a database not placed, stopped or deploying, and the image that runs (nothing to change) unless keepNativePassword changes alone. Every other change the rules would not make by themselves is a risk the caller takes with acceptRisk: true, else it is refused with reason riskNotAccepted (details.risk, details.risks, details.message): downgrades and older releases, Postgres majors (pg_upgrade is not run), skipped MongoDB, MariaDB or MySQL lines, KeyDB and Dragonfly beyond patches, lines outside the catalog, another Postgres base system (text indexes may need REINDEX), floating tags (latest, 8.2) and digests. A new version that never gets healthy brings the old container back on the same data. MongoDB's featureCompatibilityVersion is raised to the running version first for a one-step upgrade between catalog lines, never for other moves. Every change but a newer patch of the line it runs needs a successful backup from the last 24 hours, or confirmNoBackup: true. MySQL 8.4 ships mysql_native_password off (9.0 removed it): before a change from 8.0 to 8.4 or later the panel lists the running database's accounts that sign in with it, and refuses (reason nativePasswordUsers, details.accounts and details.count) when there are any, unless keepNativePassword: true, which runs 8.4 with --mysql-native-password=ON (kept by later deploys and patch updates; false turns it off, after the same check). On an 8.4 database, version 8.4 with the image it runs and keepNativePassword turns the option on or off alone: the same image deploys again with the new command. Before a Postgres move to another line (or from or to a tag that names no release) on a volume at /var/lib/postgresql, PGDATA is set in the database's own variables to the folder of the data that runs (from 18 on each major keeps its own folder there, and an older image looks in an anonymous volume), so a version that cannot read the data fails and the old container comes back, instead of starting an empty database; reason pgdataFailed when that folder cannot be read from the running container.",
  input: Type.Object({
    serviceId: Id,
    /** A catalog version of the database's engine, for example "8.0". Not needed with image (0.2.11). */
    version: Type.Optional(Type.String({ maxLength: 20, pattern: "^[0-9A-Za-z._-]+$" })),
    /**
     * Any tag or digest of the engine's (or variant's) own repository, for
     * example "mongo:8.2.12", "mongo:latest" or "mongo@sha256:..." (0.2.11;
     * before, an exact release tag of version). The line recorded is the
     * one its tag names, or "custom"; version is not used then.
     */
    image: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    /** Make a change whose risk (versionChoices, or a riskNotAccepted refusal) says what can go wrong (0.2.11). */
    acceptRisk: Type.Optional(Type.Boolean()),
    /** Change without a backup from the last 24 hours. */
    confirmNoBackup: Type.Optional(Type.Boolean()),
    /**
     * MySQL 8.4 only (versionChoices nativePassword.lines, 0.2.11): true
     * runs it with --mysql-native-password=ON, so accounts made with
     * mysql_native_password keep signing in; false runs it without. Left
     * out, the database keeps what it runs with. With the image that runs,
     * a change of this alone is allowed (not refused as current).
     */
    keepNativePassword: Type.Optional(Type.Boolean()),
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
    "Returns the internal connection URL and, when exposure is on, the exposed URL, with passwords, and the URL of each open timed expose (exposures.openTimed). All use the database's own user and password. The exposed URL asks for TLS; exposed.allowPlain says whether clients without TLS are accepted too. Internal URLs only work for services of the project on the same node.",
  input: Type.Object({ serviceId: Id }),
  output: DatabaseConnection,
  sensitive: { output: ["internal.url", "internal.password", "internal.httpUrl", "exposed.url", "exposed.password", "timed.*.url"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: false,
});

export const resetPassword = defineOp({
  id: "databases.resetPassword",
  kind: "destructive",
  summary: "Reset a database password",
  description:
    "Sets a new password for the database's user, the one used inside and through the exposed port alike. The user value exposed is still accepted for older callers and changes the same password as internal: there is no separate exposed user. Services that reference the password (PASSWORD, INTERNAL_URL, INTERNAL_HTTP_URL or EXPOSED_URL) get it on their next deploy (a restart keeps the old one); anything else using the old password stops connecting. ClickHouse and Dragonfly read the admin password from their environment at start, so a new one restarts them (Redis, Valkey and KeyDB too, which would start with the old one again); a stopped database is refused (notRunning). MySQL and MariaDB give root the same password as the admin, also an admin other than root (MYSQL_ROOT_PASSWORD, MARIADB_ROOT_PASSWORD); warning says when root kept an older password because it could not sign in to change it.",
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
    /**
     * Set when the password changed but not everywhere (0.2.11): a MySQL or
     * MariaDB root user that kept an older password, with how to fix it.
     * Null otherwise.
     */
    warning: Type.Union([Type.String(), Type.Null()]),
    /**
     * The deploy that restarts the database with the new password (0.2.13):
     * ClickHouse and Dragonfly read it at start, and Redis, Valkey and KeyDB
     * would start with the old one again. Null for the other engines.
     */
    deploymentId: Type.Optional(Type.Union([Id, Type.Null()])),
  }),
  sensitive: { input: ["password"], output: ["password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

/** A password Seylo sets: the same alphabet as every database password (URL-safe, no quoting). */
const UserPassword = Type.String({ minLength: 12, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" });

/** A MySQL or MariaDB account's host: "%", an address, a name or a pattern. */
const UserHost = Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9.%_:/-]+$" });

/**
 * What a new user may do (databases.createUser). readOnly reads the
 * database, readWrite also writes and changes its tables, databaseAdmin
 * does everything in the database and may grant it, serverAdmin
 * everything on the server, like the main user. Engines offer some of
 * them (databases.users presets).
 */
export const DatabaseUserPreset = Type.Union([
  Type.Literal("readOnly"),
  Type.Literal("readWrite"),
  Type.Literal("databaseAdmin"),
  Type.Literal("serverAdmin"),
]);

/** A login user of the database, as databases.users lists it. */
export const DatabaseUserRef = Type.Object({
  /** As the engine names it; users made outside Seylo may have names Seylo would not make. */
  name: Type.String({ minLength: 1, maxLength: 128 }),
  /** MySQL and MariaDB: the account's host; "%" when left out. */
  host: Type.Optional(UserHost),
  /** MongoDB: the user's authentication database; "admin" when left out. */
  authDatabase: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

export const DatabaseUser = Type.Object({
  name: Type.String(),
  /** MySQL and MariaDB: the account's host; null for the other engines. */
  host: Type.Union([Type.String(), Type.Null()]),
  /** MongoDB: the user's authentication database; null for the other engines. */
  authDatabase: Type.Union([Type.String(), Type.Null()]),
  /** The user Seylo signs in with: the shell, the web UI, backups, the env references and the URLs. */
  main: Type.Boolean(),
  /** A user the database or its image needs (MySQL's root@localhost, Postgres's bootstrap role): no rename or delete. */
  system: Type.Boolean(),
  /** What it may do, read from its rights; custom for anything else, none for no rights on this database. */
  access: Type.Union([
    Type.Literal("readOnly"),
    Type.Literal("readWrite"),
    Type.Literal("databaseAdmin"),
    Type.Literal("serverAdmin"),
    Type.Literal("custom"),
    Type.Literal("none"),
  ]),
  /** Its rights as the engine says them: Postgres role memberships, MongoDB role@db, MySQL and ClickHouse grants. */
  roles: Type.Array(Type.String()),
  /** It cannot sign in now (an expired Postgres role, a locked MySQL account). */
  locked: Type.Boolean(),
  /** Postgres: how many tables and other objects it owns, in every database of the server; null for the other engines. */
  ownsObjects: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** MySQL and MariaDB: views, routines, triggers and events that run as it (DEFINER); null for the other engines. */
  definerObjects: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** A rename needs a new password: MongoDB (a new user with the same roles) and Postgres md5 passwords. */
  passwordForRename: Type.Boolean(),
  /** What the Users tab may do with it. */
  can: Type.Object({
    passwordChange: Type.Boolean(),
    rename: Type.Boolean(),
    delete: Type.Boolean(),
    /** databases.switchMainUser with existing: true. */
    makeMain: Type.Boolean(),
  }),
  /** Why an action is not offered, when one is not. */
  why: Type.Union([Type.String(), Type.Null()]),
});

const UserChangeOutput = {
  /** Services of the project whose env uses the main user's name or password: they get the new one on their next deploy. */
  affectedServiceIds: Type.Array(Id),
  /** The deploy that restarts the database with what changed; null when none was needed. */
  deploymentId: Type.Union([Id, Type.Null()]),
  /** Set when the change happened but something else did not (a MySQL root out of step, an old user Seylo could not remove). */
  warning: Type.Union([Type.String(), Type.Null()]),
};

export const users = defineOp({
  id: "databases.users",
  kind: "query",
  summary: "List a database's users",
  description:
    "Lists the users that can sign in to a running database, read from the engine itself: the main user (the one Seylo signs in with for the shell, the web UI, backups and the URLs), users made here or by hand, with their access and what the Users tab may do with each. presets are the access presets databases.createUser takes on this engine; main.rename says how the main user's name changes (inPlace, restart: a short restart, switch: databases.switchMainUser, none). Redis, Valkey, KeyDB and Dragonfly have one user, default, whose password is the only thing to change (notice says why). signIn is offline while the database is stopped or its node is away (only the main user, from what Seylo stores), and failed when Seylo's stored login no longer signs in. Seylo stores only the main user's password.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    engine: DatabaseEngine,
    /** At most 500, sorted by name. */
    users: Type.Array(DatabaseUser),
    /** More than 500 users: the rest are not listed. */
    truncated: Type.Boolean(),
    presets: Type.Array(DatabaseUserPreset),
    /** MySQL and MariaDB: users have a host. */
    hosts: Type.Boolean(),
    /** databases.createUser works on this engine. */
    canCreate: Type.Boolean(),
    /** Why users cannot be made or changed here, for the engines where they cannot (Redis and the like). */
    notice: Type.Union([Type.String(), Type.Null()]),
    main: Type.Object({
      user: Type.String(),
      /** inPlace: databases.renameUser; restart: renameUser restarts the database; switch: databases.switchMainUser; none. */
      rename: Type.Union([Type.Literal("inPlace"), Type.Literal("restart"), Type.Literal("switch"), Type.Literal("none")]),
      /** databases.switchMainUser works on this engine. */
      canSwitch: Type.Boolean(),
    }),
    /** ok, offline (stopped or node away: only the stored main user) or failed (the stored login does not sign in). */
    signIn: Type.Union([Type.Literal("ok"), Type.Literal("failed"), Type.Literal("offline")]),
    /** What is wrong when signIn is not ok, or what is out of step (a MySQL root user). */
    message: Type.Union([Type.String(), Type.Null()]),
  }),
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: false,
});

export const createUser = defineOp({
  id: "databases.createUser",
  kind: "mutation",
  summary: "Create a database user",
  description:
    "Creates a user that signs in with its own password, with one access preset of databases.users presets: readOnly, readWrite, databaseAdmin or serverAdmin, on the database's own database (the server for serverAdmin). Postgres readOnly and readWrite use pg_read_all_data and pg_write_all_data, which cover every database of the server. MySQL and MariaDB take a host (default %, which services and the exposed port use). The password is generated when left out and returned once: Seylo does not keep it. The URLs are this user's internal and exposed connection URLs. Not on Redis, Valkey, KeyDB or Dragonfly (CONFLICT notOffered).",
  input: Type.Object({
    serviceId: Id,
    name: Identifier,
    host: Type.Optional(UserHost),
    access: DatabaseUserPreset,
    /** Generated (32 random characters) when left out. */
    password: Type.Optional(UserPassword),
  }),
  output: Type.Object({
    user: DatabaseUser,
    password: Type.String(),
    internalUrl: Type.String(),
    /** Null while exposure is off. */
    exposedUrl: Type.Union([Type.String(), Type.Null()]),
  }),
  sensitive: { input: ["password"], output: ["password", "internalUrl", "exposedUrl"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

export const setUserPassword = defineOp({
  id: "databases.setUserPassword",
  kind: "destructive",
  summary: "Set a database user's password",
  description:
    "Sets a new password for one user of the database (generated when left out). Anything signed in with the old password stops connecting. For the main user it is databases.resetPassword: Seylo stores it, the services that reference it get it on their next deploy (affectedServiceIds), and ClickHouse, Dragonfly, Redis, Valkey and KeyDB restart with it (deploymentId); a stopped database is refused (notRunning), since that deploy would start it. known: true only stores a main user's password that already works (when the stored one stopped signing in), after a sign-in test, without changing the database.",
  input: Type.Object({
    serviceId: Id,
    user: DatabaseUserRef,
    password: Type.Optional(UserPassword),
    known: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({ password: Type.String(), ...UserChangeOutput }),
  sensitive: { input: ["password"], output: ["password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

export const renameUser = defineOp({
  id: "databases.renameUser",
  kind: "destructive",
  summary: "Rename a database user",
  description:
    "Gives a user a new name (MySQL and MariaDB: and host). Clients signed in with the old name stop connecting. Postgres keeps ownership and grants; an md5 password is cleared by Postgres, so it needs password. MySQL and MariaDB refuse while views, routines, triggers or events run as the user (definerObjects), unless acceptOrphanDefiners. MongoDB has no rename: a new user with the same roles and the given password replaces the old one. The main user: Postgres renames it in place and restarts the database (deploy: false leaves that for later, with failed sign-ins in its log until then), MySQL and MariaDB rename an admin other than root in place, ClickHouse restarts with the new name (not while it is stopped: notRunning); MySQL's root and MongoDB refuse with useSwitchMainUser (databases.switchMainUser). Seylo stores the new name: services that reference the database get it on their next deploy (affectedServiceIds).",
  input: Type.Object({
    serviceId: Id,
    user: DatabaseUserRef,
    name: Identifier,
    /** MySQL and MariaDB: the new host; the old one when left out. */
    host: Type.Optional(UserHost),
    /** Sets this password with the rename; needed where passwordForRename. */
    password: Type.Optional(UserPassword),
    acceptOrphanDefiners: Type.Optional(Type.Boolean()),
    /** Postgres main user: false skips the restart. */
    deploy: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    user: DatabaseUserRef,
    /** The password set with the rename, else null. */
    password: Type.Union([Type.String(), Type.Null()]),
    ...UserChangeOutput,
  }),
  sensitive: { input: ["password"], output: ["password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

export const deleteUser = defineOp({
  id: "databases.deleteUser",
  kind: "destructive",
  summary: "Delete a database user",
  description:
    "Deletes a user that is not the main one; the data stays. Clients signed in with it stop connecting. Postgres refuses while the user owns tables or other objects (ownsObjects, details.count) unless reassignOwned, which gives them to the main user first in every database. MySQL and MariaDB refuse while views, routines, triggers or events run as it unless acceptOrphanDefiners. Refused for the main user (mainUser), the users the database needs (systemUser) and MongoDB's last user with root (lastAdmin).",
  input: Type.Object({
    serviceId: Id,
    user: DatabaseUserRef,
    reassignOwned: Type.Optional(Type.Boolean()),
    acceptOrphanDefiners: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    deleted: Type.Literal(true),
    /** Postgres: objects given to the main user. */
    reassignedObjects: Type.Integer({ minimum: 0 }),
  }),
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: true,
});

export const switchMainUser = defineOp({
  id: "databases.switchMainUser",
  kind: "destructive",
  summary: "Use another user as a database's main user",
  description:
    "Makes another user the one Seylo signs in with (the shell, the web UI, backups, the env references and the URLs): a new one with full rights, or an existing one (existing: true), which gets a new password since Seylo does not know its own, and full rights with grantAdmin when it lacks them (else notAdmin); a locked one is refused (locked). Seylo signs in as it before storing anything or giving it rights; a new user is removed again when that fails, and an existing one keeps the new password, which the error says. oldUser keep (default) leaves the old main user as it is; delete removes it (MySQL and MariaDB root: only root@%, root@localhost stays for the image), which MySQL and MariaDB refuse while views, routines, triggers or events run as it (definerObjects) unless acceptOrphanDefiners. MySQL and MariaDB give root the new main user's password, as they always have the main user's. Services that reference the database get the new name and password on their next deploy (affectedServiceIds). Not on ClickHouse, Redis, Valkey, KeyDB or Dragonfly (notOffered).",
  input: Type.Object({
    serviceId: Id,
    name: Identifier,
    existing: Type.Optional(Type.Boolean()),
    password: Type.Optional(UserPassword),
    grantAdmin: Type.Optional(Type.Boolean()),
    oldUser: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("delete")])),
    /** MySQL and MariaDB with oldUser delete: remove it although objects run as it (DEFINER). */
    acceptOrphanDefiners: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({ user: Type.String(), password: Type.String(), ...UserChangeOutput }),
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
    "Turns TLS exposure on or off. On: the agent opens a node port to the database, TLS only, for the database's own user and password (nothing changes inside the database), optionally limited to source CIDRs (required where exposure.needsAllowedCidrs is true, as for KeyDB). Postgres, MySQL and MariaDB need a node agent from 0.2.9 or later (CONFLICT agentTooOld otherwise). MariaDB 10.11 has no TLS and cannot be exposed (CONFLICT noTls; 11.4 and later can). allowPlain true also accepts clients that do not ask for TLS (off by default): their queries, data and, for some sign-in methods, the password travel unencrypted, so tell the person, more strongly when allowedCidrs is empty (open to every IP), and prefer TLS or a timed expose; TLS clients keep working and allowedCidrs still applies. Model callers (MCP, AI) need a person's approval to turn it on and to empty allowedCidrs while it stays on (APPROVAL_REQUIRED; MCP tokens skip it while Ask before destructive actions is off); their other changes run as usual. It needs a node agent from 0.2.16 (CONFLICT agentTooOld) and exposure on (BAD_REQUEST otherwise); turning it off closes the plain sessions, not the TLS ones, and turning exposure off resets it. The internal URL does not change. Fields left out keep their value.",
  input: Type.Object({
    serviceId: Id,
    enabled: Type.Boolean(),
    /** Leave out to keep the current port or let the agent pick a free one. */
    port: Type.Optional(PublicPort),
    allowedCidrs: Type.Optional(Type.Array(Cidr, { maxItems: 200 })),
    /** Host name pointing at the node for an ACME certificate; null for self-signed. */
    tlsHostname: Type.Optional(Type.Union([Type.String({ maxLength: 253 }), Type.Null()])),
    /** Accept clients without TLS too (0.2.16); off by default. See exposure.allowPlain. */
    allowPlain: Type.Optional(Type.Boolean()),
  }),
  output: Database,
  permission: serviceScope("databases.expose"),
  // Turning allowPlain on, or emptying allowedCidrs while it stays on: modules/databases/ops.ts weakensTls.
  modelApproval: "conditional",
  mcp: true,
  audit: true,
});
