// Builds a panel on in-memory databases and offers shortcuts for the
// people and credentials most tests need.

import { join } from "node:path";
import {
  type AnyOpContract,
  type OpInput,
  opRoute,
  secureSessionCookie,
  sessionCookie,
  sessionCookieName,
  sessionKeyHeader,
} from "@seylo/ops";
import { createSession } from "../src/auth/sessions";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { apiKeys, grants, type Role, users } from "../src/db/schema";
import type { ProxyTrust } from "../src/http/proxy-trust";
import { type Logger, silentLogger } from "../src/logger";
import type { PanelModule } from "../src/modules/module";
import { type GeoFetch, setGeoFetch } from "../src/modules/nodes/location";
import type { RateLimiter } from "../src/ops/rate-limit";
import { createPanel, type Panel } from "../src/panel";
import { hashPassword } from "../src/security/password";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { getSetting } from "../src/settings";

const packageRoot = join(import.meta.dir, "..");

/**
 * No test asks the real geolocation API: a node that connects with a public
 * address gets a failed lookup at once (modules/nodes/location.ts), unless a
 * test answers lookups itself with setGeoFetch and puts this back after.
 */
export const refuseGeoLookups: GeoFetch = async () => {
  throw new Error("tests never ask the geolocation API");
};
setGeoFetch(refuseGeoLookups);

export interface TestPanel extends Panel {
  close(): void;
}

export function testPanel(
  options: {
    modules?: readonly PanelModule[];
    rateLimiter?: RateLimiter;
    webDist?: string;
    proxy?: ProxyTrust;
    logger?: Logger;
    /** panel.db on disk, for a test that starts a second panel on it (a restart, with the same masterKey); in memory by default. */
    panelPath?: string;
    masterKey?: Uint8Array;
    /** The data folder, for a test whose modules read it at start (a moved panel's commit marker). */
    dataDir?: string;
  } = {},
): TestPanel {
  const config = {
    ...loadConfig({}, packageRoot),
    dataDir: options.dataDir ?? "/nonexistent",
    secureCookies: false,
    ...(options.webDist ? { webDist: options.webDist } : { webDist: "/nonexistent" }),
  };
  const { panelPath = ":memory:", masterKey = crypto.getRandomValues(new Uint8Array(32)), dataDir: _dataDir, ...rest } = options;
  const databases = openDatabases({ panelPath, metricsPath: ":memory:", migrationsDir: config.migrationsDir });
  const panel = createPanel({ config, databases, masterKey, logger: silentLogger(), ...rest });
  return { ...panel, close: () => databases.close() };
}

export async function createUser(
  panel: Panel,
  role: Role,
  email = `${role}-${crypto.randomUUID().slice(0, 8)}@example.com`,
  password = "correct horse battery",
) {
  const user = panel.deps.db
    .insert(users)
    .values({ email, name: role, role, passwordHash: await hashPassword(password) })
    .returning()
    .get();
  const { token, key } = createSession(panel.deps.db, user.id, { ip: null, userAgent: null });
  // callOp talks to host panel.test: when that is the panel domain, the panel serves it as HTTPS and reads the __Host- cookie.
  const secure = getSetting(panel.deps.db, "panelDomain") === "panel.test";
  return { user, password, cookie: sessionCookieFor(token, key, secure) };
}

/**
 * Session keys of the cookies tests hold, by token. A browser session is the
 * cookie plus its key header (src/auth/sessions.ts); tests pass the cookie
 * around and callOp / sessionHeaders add the key, as the web app does.
 */
const sessionKeys = new Map<string, string>();

/** The Cookie header value for a session, remembering its key for callOp. */
export function sessionCookieFor(token: string, key: string, secure = false): string {
  sessionKeys.set(token, key);
  return `${sessionCookieName(secure)}=${token}`;
}

/** The key of the session in a Cookie header value, when a test made or saw it. */
export function sessionKeyOf(cookie: string): string | undefined {
  for (const pair of cookie.split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name === sessionCookie || name === secureSessionCookie) return sessionKeys.get(value ?? "");
  }
  return undefined;
}

/** Cookie and session key headers for a request a test builds by hand. */
export function sessionHeaders(cookie: string): Record<string, string> {
  const key = sessionKeyOf(cookie);
  return { cookie, ...(key ? { [sessionKeyHeader]: key } : {}) };
}

export function grant(panel: Panel, userId: string, scopeType: "project" | "service", scopeId: string, actions: string[]) {
  panel.deps.db.insert(grants).values({ userId, scopeType, scopeId, actions }).run();
}

export function createApiKey(
  panel: Panel,
  userId: string,
  options: { actions?: string[]; readOnly?: boolean; projectIds?: string[] | null; kind?: "api" | "mcp" } = {},
) {
  const token = prefixedToken("key");
  panel.deps.db
    .insert(apiKeys)
    .values({
      userId,
      name: "test",
      prefix: token.slice(0, 12),
      tokenHash: hashToken(token),
      actions: options.actions ?? ["*"],
      readOnly: options.readOnly ?? false,
      projectIds: options.projectIds ?? null,
      ...(options.kind ? { kind: options.kind } : {}),
    })
    .run();
  return token;
}

export interface CallOptions {
  cookie?: string;
  bearer?: string;
  origin?: string;
  headers?: Record<string, string>;
}

/** Calls an op over HTTP the way the web client does and returns status and JSON. */
export async function callOp<C extends AnyOpContract>(panel: Panel, op: C, input: OpInput<C>, options: CallOptions = {}) {
  const { method, path } = opRoute(op);
  const url = new URL(`http://panel.test${path}`);
  const headers: Record<string, string> = { host: "panel.test", ...options.headers };
  if (options.cookie) {
    headers.cookie = options.cookie;
    // The web app sends the session key with every call; a test can send its own (or none) in headers.
    const key = sessionKeyOf(options.cookie);
    if (key && !Object.keys(headers).some((name) => name.toLowerCase() === sessionKeyHeader)) headers[sessionKeyHeader] = key;
  }
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.origin) headers.origin = options.origin;
  let body: string | undefined;
  if (method === "GET") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) url.searchParams.set(k, String(v));
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input);
  }
  const response = await panel.app.handle(new Request(url.toString(), { method, headers, body }));
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}
