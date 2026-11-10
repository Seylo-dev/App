// OAuth 2.1 for MCP clients (authorization code + PKCE S256, public
// clients only): server metadata (RFC 8414), protected resource metadata
// (RFC 9728), dynamic client registration (RFC 7591), the consent page
// served by the panel, the token endpoint with rotating refresh tokens, and
// revocation (RFC 7009). Tokens are api_keys rows of kind "mcp", read-only
// unless the person allows changes on the consent page (which preselects
// read only unless "New AI tools start read-only" is off).

import { createHash, timingSafeEqual } from "node:crypto";
import { slug } from "@seylo/brand";
import { readBodyText } from "@seylo/ops/elysia";
import { and, asc, count, eq, gt, inArray, isNull, lt, notExists, or } from "drizzle-orm";
import { authenticate, credentialsFrom } from "../../auth/authenticate";
import { freshUntil } from "../../auth/fresh";
import { apiKeys, mcpAuthCodes, mcpClients } from "../../db/schema";
import type { Deps } from "../../deps";
import { bodyRefused } from "../../http/body";
import { clientIp } from "../../http/client-ip";
import { secureSession } from "../../http/https";
import { addressKey } from "../../http/ip-ranges";
import { isSameOrigin } from "../../http/origin";
import { requestOrigin } from "../../http/request-origin";
import { writeAuditEvent } from "../../ops/audit";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { hashToken, prefixedToken, randomToken } from "../../security/tokens";
import { readPanelName } from "../settings/keys";
import { readMcpEnabled, readMcpSafety } from "./keys";
import { bridgePage, consentPage, messagePage, sessionKeyField } from "./pages";
import { mcpPath } from "./server";

export const codeLifetimeMs = 5 * 60 * 1000;
export const accessTokenLifetimeMs = 24 * 60 * 60 * 1000;
/** A token family (refreshes included) lives at most this long; then the person consents again. */
export const refreshLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const maxClients = 500;
const consentPurpose = "mcp.consent";

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${mcpPath}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
}

const oauthError = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });

/** https anywhere, http only to loopback, or a private-use scheme of a native app (RFC 8252). */
export function validRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  // Private-use schemes look like reverse domain names (com.example.app:) or app names (cursor:).
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(url.protocol)
  );
}

/**
 * Audit event id (not an op): the activity log shows who let which app in.
 * Registration itself is anonymous and only goes to the panel log, so a
 * flood of registrations cannot fill the activity log.
 */
export const authorizeClientEvent = "mcp.authorizeClient";

/** A client nobody authorized is forgotten after a day, and may make room for a new one after ten minutes. */
const unusedClientTtlMs = 24 * 60 * 60 * 1000;
const unusedClientGraceMs = 10 * 60 * 1000;
const registerLimiters = new WeakMap<object, RateLimiter>();

/** Clients with no token and no pending code, oldest first. */
function unusedClients(db: Deps["db"], olderThan: Date, limit: number) {
  return db
    .select({ id: mcpClients.id })
    .from(mcpClients)
    .where(
      and(
        lt(mcpClients.createdAt, olderThan),
        notExists(db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.mcpClientId, mcpClients.id))),
        notExists(db.select({ id: mcpAuthCodes.id }).from(mcpAuthCodes).where(eq(mcpAuthCodes.clientId, mcpClients.id))),
      ),
    )
    .orderBy(asc(mcpClients.createdAt))
    .limit(limit)
    .all();
}

export async function register(deps: Deps, request: Request, ip: string | null = null): Promise<Response> {
  if (!readMcpEnabled(deps.db)) return oauthError("access_denied", "The MCP server is turned off on this panel.", 403);
  // Public by design (RFC 7591), so limited per address like sign-in.
  let limiter = registerLimiters.get(deps.db);
  if (!limiter) {
    limiter = createRateLimiter();
    registerLimiters.set(deps.db, limiter);
  }
  // An IPv6 /64 counts as one address, like the sign-in limits.
  const wait = limiter.take(`mcp-register:${addressKey(clientIp(request, ip, deps.proxy.trusts(ip)))}`, "strict");
  if (wait > 0) return oauthError("invalid_client_metadata", `Too many registrations. Try again in ${wait} seconds.`, 429);
  const text = await readOAuthBody(request);
  if (typeof text !== "string") return text;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "The body must be JSON.");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000)) {
    return oauthError("invalid_redirect_uri", "Send 1 to 10 redirect_uris.");
  }
  if (!uris.every((u) => validRedirectUri(u as string))) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must be https, http on localhost, or an app scheme.");
  }
  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none")
    return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
  const now = Date.now();
  const stale = unusedClients(deps.db, new Date(now - unusedClientTtlMs), 1000).map((c) => c.id);
  if (stale.length > 0) deps.db.delete(mcpClients).where(inArray(mcpClients.id, stale)).run();
  const total = deps.db.select({ n: count() }).from(mcpClients).get()?.n ?? 0;
  if (total >= maxClients) {
    // Junk registrations never block a real one: the oldest client nobody authorized makes room.
    const room = unusedClients(deps.db, new Date(now - unusedClientGraceMs), 1).map((c) => c.id);
    if (room.length === 0) {
      return oauthError("invalid_client_metadata", "This panel has too many MCP clients. Revoke unused ones first.", 429);
    }
    deps.db.delete(mcpClients).where(inArray(mcpClients.id, room)).run();
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "MCP client";
  const client = deps.db
    .insert(mcpClients)
    .values({ name, redirectUris: uris as string[] })
    .returning()
    .get();
  deps.logger.info(
    { mcpClientId: client.id, ip: clientIp(request, ip, deps.proxy.trusts(ip)), redirectUris: client.redirectUris },
    "MCP client registered",
  );
  return Response.json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
}

/** Errors before the redirect URI is trusted are shown as a page; later ones go back to the client. */
function readAuthorize(
  deps: Deps,
  params: URLSearchParams,
): { ok: true; value: AuthorizeParams; clientName: string } | { ok: false; response: Response } {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const client = /^[a-z0-9]{16}$/.test(clientId) ? deps.db.select().from(mcpClients).where(eq(mcpClients.id, clientId)).get() : undefined;
  if (!client)
    return { ok: false, response: messagePage(readPanelName(deps.db), "Unknown app", "This app is not registered with the panel.", 400) };
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      response: messagePage(readPanelName(deps.db), "Wrong redirect", "The app asked to return to an address it did not register.", 400),
    };
  }
  const state = params.get("state");
  const back = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return { ok: false as const, response: Response.redirect(url.toString(), 302) };
  };
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  return {
    ok: true,
    value: { clientId, redirectUri, state, codeChallenge: challenge, scope: params.get("scope") ?? "" },
    clientName: client.name,
  };
}

function consentToken(deps: Deps, sessionId: string, params: AuthorizeParams): string {
  return deps.secrets.sign(
    `${sessionId}|${params.clientId}|${params.redirectUri}|${params.codeChallenge}|${params.state ?? ""}`,
    consentPurpose,
  );
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed in or confirmed with auth.reauth in the last 15 minutes (auth/fresh.ts). */
function isFresh(deps: Deps, sessionId: string): boolean {
  const until = freshUntil(deps.db, sessionId);
  return until !== null && until.getTime() > Date.now();
}

/**
 * The browser session behind a consent form. The page is plain HTML, so the
 * session key comes in the form (the bridge page's script copies it from
 * the web app's storage) instead of a header; the cookie alone is not
 * enough, as everywhere else.
 */
function sessionPrincipal(deps: Deps, request: Request, form: URLSearchParams, socketIp: string | null) {
  const credentials = credentialsFrom(request, {
    secure: secureSession(deps, request, socketIp),
    sessionKey: form.get(sessionKeyField),
  });
  if (!credentials.sessionToken) return null;
  const principal = authenticate(deps.db, { ...credentials, bearerToken: undefined });
  return principal.type === "session" ? principal : null;
}

/** Hidden form fields that carry the authorize request through the bridge and the consent form. */
function authorizeFields(params: AuthorizeParams): [string, string][] {
  return [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["response_type", "code"],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", "S256"],
    ["scope", params.scope],
    ...(params.state !== null ? [["state", params.state] as [string, string]] : []),
  ];
}

/** The GET URL of this authorize request, for the sign-in and re-auth pages to come back to. */
function authorizePath(params: AuthorizeParams): string {
  return `/oauth/authorize?${new URLSearchParams(authorizeFields(params)).toString()}`;
}

/**
 * GET /oauth/authorize: checks the request, then serves the bridge page,
 * which posts it back with the session key from the web app's storage (or
 * goes to sign-in when there is none). Nothing here reads the session, so
 * a copied cookie learns nothing from this page.
 */
export function authorizePage(deps: Deps, request: Request): Response {
  const panelName = readPanelName(deps.db);
  if (!readMcpEnabled(deps.db)) return messagePage(panelName, "MCP is off", "The MCP server is turned off on this panel.", 403);
  const read = readAuthorize(deps, new URL(request.url).searchParams);
  if (!read.ok) return read.response;
  return bridgePage({ panelName, fields: authorizeFields(read.value), back: authorizePath(read.value) });
}

function redirectLabel(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || url.protocol.replace(":", "");
  } catch {
    return uri;
  }
}

/**
 * POST /oauth/authorize: the bridge's post (no decision yet) renders the
 * consent page for a signed-in, fresh session; the consent form's post
 * (decision allow or deny) answers the client.
 */
export async function authorizeDecision(deps: Deps, request: Request, ip: string | null = null): Promise<Response> {
  const panelName = readPanelName(deps.db);
  if (!readMcpEnabled(deps.db)) return messagePage(panelName, "MCP is off", "The MCP server is turned off on this panel.", 403);
  if (!isSameOrigin(request, deps.proxy.trusts(ip))) {
    return messagePage(panelName, "Not allowed", "This form can only be sent from the panel itself.", 403);
  }
  const text = await readOAuthBody(request);
  if (typeof text !== "string") return text;
  const form = new URLSearchParams(text);
  const read = readAuthorize(deps, form);
  if (!read.ok) return read.response;
  const principal = sessionPrincipal(deps, request, form, ip);
  const origin = requestOrigin(request, deps.proxy.trusts(ip));
  const back = encodeURIComponent(authorizePath(read.value));
  const decision = form.get("decision");

  if (decision === null) {
    // The bridge's post: sign in, or confirm it's you, then come back to the GET.
    if (!principal) return Response.redirect(`${origin}/login?redirect=${back}`, 303);
    // A token acting as this person is a new way in: a session left open
    // confirms it's them on the web app's /reauth page first.
    if (!isFresh(deps, principal.sessionId)) return Response.redirect(`${origin}/reauth?redirect=${back}`, 303);
    const safety = readMcpSafety(deps.db);
    return consentPage({
      panelName,
      clientName: read.clientName,
      redirectHost: redirectLabel(read.value.redirectUri),
      userLabel: principal.user.email,
      fields: authorizeFields(read.value),
      requestedScope: read.value.scope,
      preselect: safety.readOnlyByDefault ? "read" : "write",
      askBeforeDestructive: safety.askBeforeDestructive,
      csrf: consentToken(deps, principal.sessionId, read.value),
      sessionKey: form.get(sessionKeyField) ?? "",
    });
  }

  if (!principal) return messagePage(panelName, "Signed out", "Sign in to the panel and start again from the app.", 401);
  if (!isFresh(deps, principal.sessionId)) {
    return messagePage(panelName, "Confirm it's you", "Your sign-in is too old to connect an app. Start again from the app.", 403);
  }
  if (!sameToken(form.get("csrf") ?? "", consentToken(deps, principal.sessionId, read.value))) {
    return messagePage(panelName, "Expired form", "Start again from the app.", 403);
  }
  const target = new URL(read.value.redirectUri);
  if (read.value.state) target.searchParams.set("state", read.value.state);
  target.searchParams.set("iss", origin);
  const client = deps.db.select({ name: mcpClients.name }).from(mcpClients).where(eq(mcpClients.id, read.value.clientId)).get();
  const audit = (decision: "allow" | "deny", access: "read" | "write" | null) =>
    writeAuditEvent(deps.db, {
      eventId: authorizeClientEvent,
      principal,
      input: { clientId: read.value.clientId, clientName: client?.name ?? null, redirectUri: read.value.redirectUri, decision, access },
      ip: clientIp(request, ip, deps.proxy.trusts(ip)),
      userAgent: request.headers.get("user-agent"),
    });
  if (decision !== "allow") {
    audit("deny", null);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The person declined.");
    return Response.redirect(target.toString(), 302);
  }
  // Changes only when the person picked them: a missing choice is read only,
  // whatever the page preselected.
  const readOnly = form.get("access") !== "write";
  const code = randomToken();
  deps.db
    .insert(mcpAuthCodes)
    .values({
      codeHash: hashToken(code),
      clientId: read.value.clientId,
      userId: principal.user.id,
      redirectUri: read.value.redirectUri,
      codeChallenge: read.value.codeChallenge,
      actions: ["*"],
      readOnly,
      expiresAt: new Date(Date.now() + codeLifetimeMs),
    })
    .run();
  deps.logger.info({ mcpClientId: read.value.clientId, userId: principal.user.id, readOnly }, "MCP client authorized");
  audit("allow", readOnly ? "read" : "write");
  target.searchParams.set("code", code);
  return Response.redirect(target.toString(), 302);
}

/**
 * The OAuth endpoints are public, so their bodies (small forms and JSON)
 * go through the capped reader before anything else: at most
 * oauthBodyBytes each, counted against the panel's shared body budget.
 */
export const oauthBodyBytes = 64 * 1024;

async function readOAuthBody(request: Request): Promise<string | Response> {
  const read = await readBodyText(request, oauthBodyBytes);
  return read.ok ? read.text : bodyRefused(read.reason);
}

async function readForm(request: Request): Promise<URLSearchParams | Response> {
  const text = await readOAuthBody(request);
  if (typeof text !== "string") return text;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // An unreadable body is an empty form: the checks below answer for it.
    }
    return new URLSearchParams(Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  return new URLSearchParams(text);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function issue(deps: Deps, keyId: string) {
  const access = prefixedToken("mcp");
  const refresh = `${slug}_mcprefresh_${randomToken()}`;
  deps.db
    .update(apiKeys)
    .set({
      tokenHash: hashToken(access),
      prefix: access.slice(0, 12),
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + accessTokenLifetimeMs),
    })
    .where(eq(apiKeys.id, keyId))
    .run();
  return { access, refresh };
}

function tokenResponse(tokens: { access: string; refresh: string }, readOnly: boolean): Response {
  return Response.json(
    {
      access_token: tokens.access,
      token_type: "Bearer",
      expires_in: Math.floor(accessTokenLifetimeMs / 1000),
      refresh_token: tokens.refresh,
      scope: readOnly ? "mcp:read" : "mcp:read mcp:write",
    },
    { headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

export async function token(deps: Deps, request: Request): Promise<Response> {
  if (!readMcpEnabled(deps.db)) return oauthError("access_denied", "The MCP server is turned off on this panel.", 403);
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const clientId = form.get("client_id") ?? "";
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_request", "code_verifier is missing or malformed.");
    const now = new Date();
    // Single use: claim the code before anything else.
    const row = deps.db
      .update(mcpAuthCodes)
      .set({ usedAt: now })
      .where(and(eq(mcpAuthCodes.codeHash, hashToken(code)), isNull(mcpAuthCodes.usedAt), gt(mcpAuthCodes.expiresAt, now)))
      .returning()
      .get();
    if (!row) return oauthError("invalid_grant", "The code is unknown, used or expired.");
    if (row.clientId !== clientId || row.redirectUri !== (form.get("redirect_uri") ?? "")) {
      return oauthError("invalid_grant", "The code was issued to another client or redirect URI.");
    }
    if (!sameToken(s256(verifier), row.codeChallenge)) return oauthError("invalid_grant", "The code verifier does not match.");
    const client = deps.db.select().from(mcpClients).where(eq(mcpClients.id, row.clientId)).get();
    if (!client) return oauthError("invalid_client", "The client no longer exists.");
    const placeholder = `pending_${randomToken()}`;
    const key = deps.db
      .insert(apiKeys)
      .values({
        userId: row.userId,
        kind: "mcp",
        name: client.name,
        prefix: "",
        tokenHash: hashToken(placeholder),
        actions: row.actions,
        readOnly: row.readOnly,
        mcpClientId: client.id,
      })
      .returning({ id: apiKeys.id })
      .get();
    return tokenResponse(issue(deps, key.id), row.readOnly);
  }

  if (grant === "refresh_token") {
    const refresh = form.get("refresh_token") ?? "";
    const key = deps.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.refreshTokenHash, hashToken(refresh)), isNull(apiKeys.revokedAt)))
      .get();
    if (key?.kind !== "mcp" || !key.mcpClientId) return oauthError("invalid_grant", "The refresh token is unknown or revoked.");
    if (key.mcpClientId !== clientId) return oauthError("invalid_grant", "The refresh token belongs to another client.");
    if (Date.now() - key.createdAt.getTime() > refreshLifetimeMs) {
      return oauthError("invalid_grant", "This authorization is too old. Connect the app again.");
    }
    return tokenResponse(issue(deps, key.id), key.readOnly);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export async function revoke(deps: Deps, request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const hash = hashToken(form.get("token") ?? "");
  deps.db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.kind, "mcp"), isNull(apiKeys.revokedAt), or(eq(apiKeys.tokenHash, hash), eq(apiKeys.refreshTokenHash, hash))))
    .run();
  // RFC 7009: the answer is the same whether or not the token existed.
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
