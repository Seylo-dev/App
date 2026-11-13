// Agent-owned IP:port listeners (portgate) that reach a service without a
// domain: first-run access on node-ip:port that closes (after redirecting
// to the primary domain) once a domain is live, and timed exposes locked to
// one IP or CIDR for local development, databases included (the database's
// Connection tab). A database's permanent exposure is managed by
// databases.setExposure and only listed here.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { DatabaseEngine } from "./databases";
import { Cidr, ContainerPort } from "./domains";

/**
 * open: answering on address. redirecting: a domain is live, browsers are
 * sent to redirectTo until closeAt. closed: no listener. none: the service
 * has no HTTP port, or first-run access was never opened.
 */
export const FirstRunStatus = Type.Union([Type.Literal("open"), Type.Literal("redirecting"), Type.Literal("closed"), Type.Literal("none")]);

export const FirstRunAccess = Type.Object({
  status: FirstRunStatus,
  /** "203.0.113.10:41203"; null while closed. */
  address: Type.Union([Type.String(), Type.Null()]),
  redirectTo: Type.Union([Type.String(), Type.Null()]),
  closeAt: Type.Union([Timestamp, Type.Null()]),
  /** When the primary domain went live; null before. */
  domainLiveAt: Type.Union([Timestamp, Type.Null()]),
  /** Close IP:port once a domain is live. */
  closeWhenDomainLive: Type.Boolean(),
  /** While closing, redirect visitors to the primary domain, carrying their session cookie over (best effort). */
  redirectToPrimary: Type.Boolean(),
  /**
   * When the node's last health check found a host firewall (ufw or
   * firewalld): the command that opens this port there, for example
   * "ufw allow 41203/tcp". The agent listens itself, so the firewall applies.
   */
  firewallHint: Type.Union([Type.String(), Type.Null()]),
});

/**
 * How to connect to a database through a timed expose, without the
 * password (databases.connection timed has the URL with it). The gate
 * relays the database's port as it is, adding no TLS: "database" when the
 * database serves TLS itself (MySQL, MariaDB from 11.4, Postgres while its
 * exposed port is on, which turned TLS on in it), and url and command ask
 * for it; "none" when it has none, so the connection is not encrypted (it
 * is still locked to allowedCidrs and closes at expiresAt).
 */
export const TimedDatabaseAccess = Type.Object({
  engine: DatabaseEngine,
  /** The database's own user, as on the Connection tab. */
  user: Type.String(),
  /** Default database; empty for the Redis-like engines. */
  database: Type.String(),
  tls: Type.Union([Type.Literal("database"), Type.Literal("none")]),
  /** For example "postgresql://postgres@203.0.113.10:41000/shop"; null until the node reports the port. */
  url: Type.Union([Type.String(), Type.Null()]),
  /**
   * The engine's client, ready to run, asking for the password: psql,
   * mysql or mariadb, mongosh, redis-cli or clickhouse-client (curl for
   * ClickHouse's HTTP port). Null until the node reports the port.
   */
  command: Type.Union([Type.String(), Type.Null()]),
});

export const TimedExpose = Type.Object({
  id: Id,
  serviceId: Id,
  nodeId: Id,
  /** node-ip:port; port is null until the agent reports the one it picked. */
  host: Type.String(),
  port: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
  targetPort: ContainerPort,
  allowedCidrs: Type.Array(Cidr, { minItems: 1 }),
  expiresAt: Timestamp,
  /** As in FirstRunAccess: how to open the port in the node's host firewall, or null. */
  firewallHint: Type.Union([Type.String(), Type.Null()]),
  /** Who opened it, for "opened by Claude (MCP)". */
  openedBy: Type.Object({
    kind: Type.Union([Type.Literal("user"), Type.Literal("apiKey"), Type.Literal("mcp"), Type.Literal("ai")]),
    name: Type.String(),
  }),
  /** Set for a database: its client command and URL through this port, without the password. Null for other services. */
  database: Type.Union([TimedDatabaseAccess, Type.Null()]),
  createdAt: Timestamp,
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);

export const get = defineOp({
  id: "exposures.get",
  kind: "query",
  summary: "Get a service's IP:port access",
  description:
    "Returns the first-run IP:port access of a service (open, redirecting to the primary domain, or closed, with its auto-close settings) and its open timed exposes; a database's say how to connect (client command and URL, without the password).",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    firstRun: FirstRunAccess,
    timed: Type.Array(TimedExpose),
    /** Exposed database port, managed by databases.setExposure; null while closed (databases.get exposure.state). */
    database: Type.Union([Type.Object({ host: Type.String(), port: Type.Integer(), allowedCidrs: Type.Array(Cidr) }), Type.Null()]),
  }),
  permission: serviceScope("exposures.view"),
  mcp: true,
  audit: false,
});

export const setFirstRun = defineOp({
  id: "exposures.setFirstRun",
  kind: "mutation",
  summary: "Set first-run IP:port access",
  description:
    "Opens or closes the service's first-run IP:port access and sets whether it closes on its own (redirecting to the primary domain first) once a domain is live. Fields left out keep their value.",
  input: Type.Object({
    serviceId: Id,
    /** false closes the listener now; true opens it again. */
    open: Type.Optional(Type.Boolean()),
    closeWhenDomainLive: Type.Optional(Type.Boolean()),
    redirectToPrimary: Type.Optional(Type.Boolean()),
  }),
  output: FirstRunAccess,
  permission: serviceScope("exposures.edit"),
  mcp: true,
  audit: true,
});

export const openTimed = defineOp({
  id: "exposures.openTimed",
  kind: "mutation",
  summary: "Open a timed expose",
  description:
    "Opens a container port on node-ip:port for a limited time, only for the given IPs or CIDRs (default: the caller's IP). The agent closes it on time even if the panel is down. For local development and debugging, databases included: for a database it opens the database's port (ClickHouse also its HTTP port 8123) and the result has the client command; databases.connection gives the URL with the password. The relay adds no TLS, so a database without TLS of its own is reached unencrypted.",
  input: Type.Object({
    serviceId: Id,
    /** Defaults to a database's port, else the service's main port. A database takes only its own port (ClickHouse also 8123). */
    targetPort: Type.Optional(ContainerPort),
    /** 5 minutes to 24 hours. */
    durationMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
    /** Defaults to the caller's address as /32 or /128. Callers without an address (MCP over a socket) must pass one. */
    allowedCidrs: Type.Optional(Type.Array(Cidr, { minItems: 1, maxItems: 20 })),
    /** Node port to listen on; the agent picks a free high port when left out. */
    port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    /** For services on several nodes; defaults to the first. */
    nodeId: Type.Optional(Id),
  }),
  output: TimedExpose,
  permission: serviceScope("exposures.edit"),
  mcp: true,
  audit: true,
});

export const extendTimed = defineOp({
  id: "exposures.extendTimed",
  kind: "mutation",
  summary: "Extend a timed expose",
  description: "Moves a timed expose's end to durationMinutes from now (at most 24 hours).",
  input: Type.Object({ serviceId: Id, exposureId: Id, durationMinutes: Type.Integer({ minimum: 5, maximum: 1440 }) }),
  output: TimedExpose,
  permission: serviceScope("exposures.edit"),
  mcp: true,
  audit: true,
});

export const close = defineOp({
  id: "exposures.close",
  kind: "mutation",
  summary: "Close a timed expose",
  description: "Closes a timed expose now. Open connections are cut.",
  input: Type.Object({ serviceId: Id, exposureId: Id }),
  output: Empty,
  permission: serviceScope("exposures.edit"),
  mcp: true,
  audit: true,
});
