// How traffic reaches services: domains with their middlewares, agent-owned
// IP:port listeners (first-run access, timed exposes, exposed databases),
// Cloudflare tunnels and per-service maintenance pages. All of it compiles
// into the Routing, PublicPort and DevAccess messages of ServiceSpec.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { nodes } from "./infra";
import { services } from "./projects";

export interface DomainMiddlewares {
  /** Users with bcrypt hashes; the hashes are not secrets but are never shown again. */
  basicAuth?: { users: { username: string; hash: string }[] };
  ipAllowList?: string[];
  rateLimit?: { average: number; burst: number; periodSeconds?: number };
  redirects?: { from: string; to: string; permanent: boolean }[];
}

export type DnsStatus = "unknown" | "ok" | "wrongTarget" | "missing" | "proxied";

export type CertificateStatus = "none" | "pending" | "valid" | "failed";

/** The origin check's answer (modules/domains/origin.ts). */
export type OriginStatus = "node" | "elsewhere" | "unknown";

/** acme: Let's Encrypt (default). custom: certificate_sealed. off: plain HTTP only. */
export type HttpsMode = "acme" | "custom" | "off";

/** A redirect-only domain (www to apex): every request goes to url. */
export interface DomainForward {
  url: string;
  permanent: boolean;
  keepPath: boolean;
}

export const domains = sqliteTable(
  "domains",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    pathPrefix: text("path_prefix").notNull().default("/"),
    stripPrefix: integer("strip_prefix", { mode: "boolean" }).notNull().default(false),
    targetPort: integer("target_port").notNull(),
    https: text("https").$type<HttpsMode>().notNull().default("acme"),
    redirectToHttps: integer("redirect_to_https", { mode: "boolean" }).notNull().default(true),
    /** Custom certificate as sealed JSON { certPem, keyPem }; set with https "custom". */
    certificateSealed: sealed("certificate_sealed"),
    /** Generated from a node's wildcard domain rather than typed by a person. */
    auto: integer("auto", { mode: "boolean" }).notNull().default(false),
    middlewares: json<DomainMiddlewares>("middlewares").notNull().default(sql`'{}'`),
    /** The service's primary domain; at most one per service (partial unique index). */
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** Set for redirect-only domains. */
    forward: json<DomainForward>("forward"),
    /** Last certificate state the agent reported. */
    certStatus: text("cert_status").$type<CertificateStatus>().notNull().default("none"),
    certExpiresAt: timestamp("cert_expires_at"),
    certIssuer: text("cert_issuer"),
    /** Why the last ACME issue or renewal failed, as the agent reported it; cleared once valid. */
    certError: text("cert_error"),
    dnsStatus: text("dns_status").$type<DnsStatus>().notNull().default("unknown"),
    dnsCheckedAt: timestamp("dns_checked_at"),
    /**
     * Whether the domain reaches the service's node (the origin check, run
     * while DNS is ok or proxied); null before the first check and after DNS
     * left those states.
     */
    originStatus: text("origin_status").$type<OriginStatus>(),
    originCheckedAt: timestamp("origin_checked_at"),
    /**
     * While the origin is unknown: the first check of the run that has not
     * learned where requests go (the re-check's pacing and the Domains
     * tab's 30 minutes start there). Null with any other origin.
     */
    originUnknownSince: timestamp("origin_unknown_since"),
    /**
     * When the domain's route was first allowed to ask Let's Encrypt
     * (modules/domains/acme-hold.ts): a check proved the domain reaches a
     * node of the service, or nothing could prove it. Set once, never
     * cleared; null while the hold may apply. Domains from before 0.2.8
     * whose DNS was not missing or pointing elsewhere got it in the
     * migration, so an update never takes HTTPS away from one.
     */
    acmeReleasedAt: timestamp("acme_released_at"),
    /** First time the route served with a valid certificate; starts the IP:port redirect-then-close. */
    liveAt: timestamp("live_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("domains_host_path_unique").on(t.host, t.pathPrefix),
    index("domains_service_idx").on(t.serviceId),
    uniqueIndex("domains_service_primary_unique").on(t.serviceId).where(sql`${t.isPrimary} = 1`),
  ],
);

export type ExposureKind = "first_run" | "timed" | "database";
export type ExposureMode = "forward" | "redirect";

/** How an exposure was opened, for "opened by Claude (MCP)". */
export type OpenedVia = "user" | "apiKey" | "mcp" | "ai";

/** Agent-owned IP:port listeners (portgate), never Docker-published ports. */
export const portExposures = sqliteTable(
  "port_exposures",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ExposureKind>().notNull(),
    /** "redirect" once a domain is live: browsers are sent to redirectUrl until closeAt. */
    mode: text("mode").$type<ExposureMode>().notNull().default("forward"),
    redirectUrl: text("redirect_url"),
    /** 0 until the agent reports the port it picked (timed exposes may ask for any free port). */
    listenPort: integer("listen_port").notNull(),
    targetPort: integer("target_port").notNull(),
    /** Source CIDRs allowed to connect; timed exposes are locked to the IP that opened them. Empty = anyone. */
    allowedCidrs: json<string[]>("allowed_cidrs").notNull().default(sql`'[]'`),
    tls: integer("tls", { mode: "boolean" }).notNull().default(false),
    /**
     * Database exposure (0.2.16): the owner allowed clients without TLS too
     * (databases.setExposure allowPlain). Off by default; turning exposure
     * off deletes the row, so it starts off again.
     */
    allowPlain: integer("allow_plain", { mode: "boolean" }).notNull().default(false),
    /** Timed exposes end at expiresAt; redirecting first-run ports close at closeAt. The agent enforces both. */
    expiresAt: timestamp("expires_at"),
    closeAt: timestamp("close_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    openedVia: text("opened_via").$type<OpenedVia>().notNull().default("user"),
    /** Display name of the opener at the time (user, API key or MCP client name). */
    openedByLabel: text("opened_by_label").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("port_exposures_service_idx").on(t.serviceId), index("port_exposures_node_port_idx").on(t.nodeId, t.listenPort)],
);

/**
 * Cloudflare Tunnel per service. Without a token the agent runs a
 * temporary trycloudflare.com tunnel and reports its URL; with a scoped
 * tunnel token the hostname is permanent.
 */
export const cloudflareTunnels = sqliteTable("cloudflare_tunnels", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** quick = trycloudflare.com; token = this row's token or the global one from settings. */
  mode: text("mode").$type<"quick" | "token">().notNull().default("quick"),
  tokenSealed: sealed("token_sealed"),
  /** Public URL the agent reported (quick tunnels get a new one on every start). */
  url: text("url"),
  targetPort: integer("target_port").notNull(),
  /** Permanent hostname configured in Cloudflare for the token, shown in the UI. */
  hostname: text("hostname"),
  /** Temporary tunnels turn themselves off at this time. */
  expiresAt: timestamp("expires_at"),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/**
 * Per-service maintenance mode and page. The global page and switch live
 * in settings (key maintenanceGlobal). A missing row means off, no own page.
 */
export const maintenancePages = sqliteTable("maintenance_pages", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  message: text("message").notNull().default(""),
  /** Own page; null falls back to the global page. */
  html: text("html"),
  updatedAt: updatedAt(),
});

/** First-run IP:port access settings per service; a missing row means the defaults (both true). */
export const serviceAccess = sqliteTable("service_access", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  closeWhenDomainLive: integer("close_when_domain_live", { mode: "boolean" }).notNull().default(true),
  redirectToPrimary: integer("redirect_to_primary", { mode: "boolean" }).notNull().default(true),
  updatedAt: updatedAt(),
});
