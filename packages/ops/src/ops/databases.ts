// Managed databases: Postgres, MySQL, MariaDB, Mongo and Redis services
// with generated credentials, internal and exposed connection URLs, an
// on-demand web UI and a pre-logged-in shell (both opened with short-lived
// edge tickets), and TLS exposure through the agent's portgate.

import { Type } from "@sinclair/typebox";
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
]);

/** A service name: it is also the internal host name. */
export const DatabaseName = ServiceName;

const Identifier = Type.String({ minLength: 1, maxLength: 63, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });

/** Agent-owned listener port for exposure; 1024 and up, never the panel's or Traefik's. */
export const PublicPort = Type.Integer({ minimum: 1024, maximum: 65535 });

/** Port and URL without secrets, for overview screens. */
export const ConnectionSummary = Type.Object({
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  /** Default database; empty for Redis. */
  database: Type.String(),
  user: Type.String(),
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
  nodeId: Id,
  nodeName: Type.String(),
  /** For services of the project on the same node: host = the service name. */
  internal: ConnectionSummary,
  exposure: DatabaseExposure,
  webUi: Type.Object({
    /** Tool picked by engine: pgweb, Adminer, mongo-express, Redis Commander. */
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

export const create = defineOp({
  id: "databases.create",
  kind: "mutation",
  summary: "Create a database",
  description:
    "Creates a Postgres, MySQL, MariaDB, Mongo or Redis service in a project on one node, with generated credentials (or the ones given) and a data volume. Other services on the same node reach it at <name>:<port>; services on other nodes need exposure.",
  input: Type.Object({
    projectId: Id,
    name: DatabaseName,
    engine: DatabaseEngine,
    /** Defaults to the newest supported major version. */
    version: Type.Optional(Type.String({ maxLength: 20, pattern: "^[0-9A-Za-z._-]+$" })),
    nodeId: Id,
    /** Default database to create; defaults to the service name. Ignored for Redis. */
    database: Type.Optional(Identifier),
    /** Defaults to the engine's usual admin user (postgres, root, ...). */
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
  sensitive: { output: ["internal.url", "internal.password", "exposed.url", "exposed.password"] },
  permission: serviceScope("databases.credentials"),
  mcp: true,
  audit: false,
});

export const resetPassword = defineOp({
  id: "databases.resetPassword",
  kind: "destructive",
  summary: "Reset a database password",
  description:
    "Sets a new password for the admin user (internal) or the exposed user. Services that reference the password get it on their next deploy or restart; anything else using the old password stops connecting.",
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
    "Returns a one-time link to the database's web UI (pgweb, Adminer, mongo-express or Redis Commander), already signed in. The tool starts on first use and stops when idle.",
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
    "Returns a ticket for a terminal already signed in to the database (psql, mysql, mongosh, redis-cli). The web app passes it to the terminal socket; it works once and expires in a minute.",
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
    "Turns TLS exposure on or off. On: the agent listens on a node port with the database's own TLS for a separate user, optionally limited to source CIDRs. The internal URL does not change. Fields left out keep their value.",
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
