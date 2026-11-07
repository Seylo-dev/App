// Builds a panel on in-memory databases and offers shortcuts for the
// people and credentials most tests need.

import { join } from "node:path";
import { type AnyOpContract, type OpInput, opRoute, sessionCookie } from "@seylo/ops";
import { createSession } from "../src/auth/sessions";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { apiKeys, grants, type Role, users } from "../src/db/schema";
import type { ProxyTrust } from "../src/http/proxy-trust";
import { type Logger, silentLogger } from "../src/logger";
import type { PanelModule } from "../src/modules/module";
import type { RateLimiter } from "../src/ops/rate-limit";
import { createPanel, type Panel } from "../src/panel";
import { hashPassword } from "../src/security/password";
import { hashToken, prefixedToken } from "../src/security/tokens";

const packageRoot = join(import.meta.dir, "..");

export interface TestPanel extends Panel {
  close(): void;
}

export function testPanel(
  options: { modules?: readonly PanelModule[]; rateLimiter?: RateLimiter; webDist?: string; proxy?: ProxyTrust; logger?: Logger } = {},
): TestPanel {
  const config = {
    ...loadConfig({}, packageRoot),
    dataDir: "/nonexistent",
    secureCookies: false,
    ...(options.webDist ? { webDist: options.webDist } : { webDist: "/nonexistent" }),
  };
  const databases = openDatabases({ panelPath: ":memory:", metricsPath: ":memory:", migrationsDir: config.migrationsDir });
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const panel = createPanel({ config, databases, masterKey, logger: silentLogger(), ...options });
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
  const { token } = createSession(panel.deps.db, user.id, { ip: null, userAgent: null });
  return { user, password, cookie: `${sessionCookie}=${token}` };
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
  if (options.cookie) headers.cookie = options.cookie;
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
