// Panel configuration from environment variables. Names are prefixed with
// the brand slug in upper case (SEYLO_PORT, ...), so a white-label build
// keeps its own names. Defaults suit the panel container on a node.

import { join, resolve } from "node:path";
import { dataDir as nodeDataDir, siteUrl, slug } from "@seylo/brand";

export interface Config {
  /** Holds panel.db, metrics.db and master.key. */
  dataDir: string;
  host: string;
  port: number;
  /** Built web app (apps/web/dist); served at / when the folder exists. */
  webDist: string;
  /** drizzle/ with the panel and metrics migrations. */
  migrationsDir: string;
  version: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * Believe X-Forwarded-* from every peer. Development only (a local proxy
   * in front of the panel): on a node the panel's port is published too, so
   * anyone could pick their own IP for rate limits and the audit log.
   * Installs trust `trustedProxies` instead (http/proxy-trust.ts).
   */
  trustProxy: boolean;
  /**
   * Proxies whose X-Forwarded-* headers are believed, as container names
   * resolved on the panel's network or literal addresses
   * (SEYLO_TRUSTED_PROXIES, comma separated). Defaults to the agent's Traefik.
   */
  trustedProxies: string[];
  /**
   * Always send cookies with Secure. Off on installs, where the panel is
   * first reached over plain-HTTP IP:port; cookies still get Secure on every
   * response to an HTTPS request (http/ops-http.ts).
   */
  secureCookies: boolean;
  /**
   * How people reach the panel when it has no domain yet, for links in
   * alerts and the MCP URL, for example http://203.0.113.7:3000. Null
   * falls back to the panel node's public IP and the port.
   */
  publicUrl: string | null;
  /** Where telemetry reports go; derived from the brand's site. */
  telemetryUrl: string;
  /**
   * What turns telemetry off on this container whatever the setting says:
   * "SEYLO_TELEMETRY" (set to off, 0, false or no) or "DO_NOT_TRACK" (set to
   * 1, true or yes). Unset or null: the setting decides.
   */
  telemetryOffBy?: string | null;
  /**
   * Client id of an own GitHub OAuth App for device-flow sign-in; unset uses
   * the brand's app (auth/github-device.ts).
   */
  githubClientId?: string;
  /**
   * The image this panel container was started from (SEYLO_IMAGE, set by the
   * installer, for example ghcr.io/seylo-dev/seylo:0.1.0). Present only when
   * the installer runs the panel as the protected panel service on a node;
   * the panel then keeps that service's rows (modules/nodes/panel-service.ts).
   */
  image: string | null;
  /** Host port the installer published the panel on (SEYLO_HOST_PORT); null when unknown. */
  hostPort: number | null;
  /**
   * Port of the agents' TLS listener (SEYLO_AGENT_TLS_PORT; the same number
   * on the host). The panel serves /api/agent/connect there with a
   * self-signed certificate from the data dir, and join commands for a panel
   * without a domain use https://<address>:<port> with --pin. Null: agents
   * join a domain-less panel over plain HTTP (the join card warns).
   */
  agentTlsPort: number | null;
}

export const envPrefix = `${slug.toUpperCase().replaceAll("-", "_")}_`;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * `packageRoot` is apps/panel; main.ts passes it so paths resolve the same
 * from src/ (development) and dist/ (bundled).
 */
export function loadConfig(env: Record<string, string | undefined>, packageRoot: string): Config {
  const read = (name: string) => {
    const value = env[envPrefix + name]?.trim();
    return value === "" ? undefined : value;
  };

  return {
    dataDir: read("DATA_DIR") ?? join(nodeDataDir, "panel"),
    host: read("HOST") ?? "0.0.0.0",
    port: parsePort(read("PORT") ?? "3000"),
    webDist: read("WEB_DIST") ?? resolve(packageRoot, "../web/dist"),
    migrationsDir: read("MIGRATIONS_DIR") ?? resolve(packageRoot, "drizzle"),
    version: read("VERSION") ?? "dev",
    logLevel: oneOf("LOG_LEVEL", read("LOG_LEVEL") ?? "info", ["debug", "info", "warn", "error"] as const),
    trustProxy: parseBool("TRUST_PROXY", read("TRUST_PROXY") ?? "false"),
    trustedProxies: (read("TRUSTED_PROXIES") ?? `${slug}-traefik`)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    secureCookies: parseBool("SECURE_COOKIES", read("SECURE_COOKIES") ?? "true"),
    publicUrl: parseUrl("PUBLIC_URL", read("PUBLIC_URL")),
    telemetryUrl: parseUrl("TELEMETRY_URL", read("TELEMETRY_URL")) ?? defaultTelemetryUrl(),
    telemetryOffBy: telemetryOffBy(read("TELEMETRY"), env.DO_NOT_TRACK),
    ...githubClientId(read("GITHUB_CLIENT_ID")),
    image: parseImage(read("IMAGE")),
    hostPort: read("HOST_PORT") === undefined ? null : parsePort(read("HOST_PORT") as string, "HOST_PORT"),
    agentTlsPort: read("AGENT_TLS_PORT") === undefined ? null : parsePort(read("AGENT_TLS_PORT") as string, "AGENT_TLS_PORT"),
  };
}

/** SEYLO_TELEMETRY=off (0, false, no) or the DO_NOT_TRACK=1 convention: the variable that turns telemetry off, else null. */
function telemetryOffBy(value: string | undefined, doNotTrack: string | undefined): string | null {
  if (value !== undefined && ["off", "0", "false", "no"].includes(value.toLowerCase())) return `${envPrefix}TELEMETRY`;
  if (doNotTrack !== undefined && ["1", "true", "yes"].includes(doNotTrack.trim().toLowerCase())) return "DO_NOT_TRACK";
  return null;
}

function githubClientId(value: string | undefined): { githubClientId?: string } {
  if (value === undefined) return {};
  if (!/^[A-Za-z0-9._-]{4,100}$/.test(value)) throw new ConfigError(`${envPrefix}GITHUB_CLIENT_ID does not look like an OAuth client id`);
  return { githubClientId: value };
}

/** api.<site host>/telemetry, the collector of the site repo. */
function defaultTelemetryUrl(): string {
  return `https://api.${new URL(siteUrl).host}/telemetry`;
}

function parseUrl(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value.replace(/\/+$/, "");
  } catch {
    // reported below
  }
  throw new ConfigError(`${envPrefix}${name} must be an http(s) URL, got "${value}"`);
}

function parsePort(value: string, name = "PORT"): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${envPrefix}${name} must be a port number, got "${value}"`);
  }
  return port;
}

/** An image reference without spaces, optionally pinned with @sha256:<64 hex>. */
function parseImage(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[a-z0-9][a-z0-9._/:-]*(@sha256:[0-9a-f]{64})?$/i.test(value) || value.length > 300) {
    throw new ConfigError(`${envPrefix}IMAGE must be an image reference, got "${value}"`);
  }
  return value;
}

function parseBool(name: string, value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigError(`${envPrefix}${name} must be true or false, got "${value}"`);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${envPrefix}${name} must be one of ${allowed.join(", ")}, got "${value}"`);
}
