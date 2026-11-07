// The MCP server: the Streamable HTTP endpoint (server.ts), its OAuth 2.1
// routes (oauth.ts) and the settings ops. MCP tokens themselves are
// api_keys of kind "mcp" (apiKeys.* ops, or the OAuth flow).
// Contracts: packages/ops/src/ops/mcp.ts.

import { slug } from "@seylo/brand";
import { mcp, OpError } from "@seylo/ops";
import { and, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { apiKeys, mcpClients } from "../../db/schema";
import type { Deps } from "../../deps";
import { requestOrigin } from "../../http/request-origin";
import { implement } from "../../ops/implement";
import { setSetting } from "../../settings";
import { defineModule } from "../module";
import { panelPublicUrl } from "../settings/public-url";
import { readMcpEnabled } from "./keys";
import {
  authorizationServerMetadata,
  authorizeDecision,
  authorizePage,
  protectedResourceMetadata,
  refreshLifetimeMs,
  register,
  revoke,
  token,
} from "./oauth";
import { handleMcp, mcpPath } from "./server";
import { toolCounts } from "./tools";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };

function info(deps: Pick<Deps, "db" | "config">) {
  const base = panelPublicUrl(deps);
  const url = `${base}${mcpPath}`;
  return {
    enabled: readMcpEnabled(deps.db),
    url,
    oauthMetadataUrl: `${base}/.well-known/oauth-authorization-server`,
    snippets: {
      "claude-code": `claude mcp add --transport http ${slug} ${url}`,
      "claude-desktop": JSON.stringify({ mcpServers: { [slug]: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2),
      cursor: JSON.stringify({ mcpServers: { [slug]: { url } } }, null, 2),
    },
    tools: toolCounts(),
  };
}

const infoOp = implement(mcp.info, (_input, ctx) => info(ctx));

const update = implement(mcp.update, (input, ctx) => {
  setSetting(ctx.db, "mcpEnabled", input.enabled);
  ctx.live.publish("panel", { type: "invalidate", ops: ["mcp.info", "system.features"] });
  return info(ctx);
});

const clients = implement(mcp.clients, (_input, ctx) => {
  const rows = ctx.db.select().from(mcpClients).orderBy(mcpClients.createdAt).all();
  const now = new Date();
  return {
    clients: rows.map((client) => {
      const keys = ctx.db
        .select({ expiresAt: apiKeys.expiresAt, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(and(eq(apiKeys.mcpClientId, client.id), isNull(apiKeys.revokedAt)))
        .all();
      // A token still counts while its refresh token works, even after the access token expired.
      const live = keys.filter((key) => now.getTime() - key.createdAt.getTime() < refreshLifetimeMs);
      const last = keys.reduce<Date | null>(
        (latest, key) => (key.lastUsedAt && (!latest || key.lastUsedAt > latest) ? key.lastUsedAt : latest),
        null,
      );
      return {
        id: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        activeTokens: live.length,
        lastUsedAt: last?.toISOString() ?? null,
        createdAt: client.createdAt.toISOString(),
      };
    }),
  };
});

const revokeClient = implement(mcp.revokeClient, (input, ctx) => {
  // Tokens reference the client with ON DELETE CASCADE, so they go with it.
  const removed = ctx.db.delete(mcpClients).where(eq(mcpClients.id, input.clientId)).returning({ id: mcpClients.id }).get();
  if (!removed) throw new OpError("NOT_FOUND", "There is no such MCP client.");
  ctx.live.publish("panel", { type: "invalidate", ops: ["mcp.clients", "apiKeys.list"] });
  return {};
});

function routes(deps: Deps) {
  const origin = (request: Request, socketIp: string | null) => requestOrigin(request, deps.proxy.trusts(socketIp));
  const peer = (request: Request, server: { requestIP(r: Request): { address: string } | null } | null) =>
    server?.requestIP(request)?.address ?? null;
  const metadata = (request: Request, socketIp: string | null) =>
    Response.json(authorizationServerMetadata(origin(request, socketIp)), { headers: cors });
  const resource = (request: Request, socketIp: string | null) =>
    Response.json(protectedResourceMetadata(origin(request, socketIp)), { headers: cors });
  const withCors = async (response: Promise<Response>) => {
    const out = await response;
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  };
  const preflight = () => new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS" } });
  return new Elysia({ name: "mcp" })
    .post(mcpPath, ({ request, server }) => handleMcp(deps, request, server?.requestIP(request)?.address ?? null))
    .get(mcpPath, ({ request, server }) => handleMcp(deps, request, server?.requestIP(request)?.address ?? null))
    .delete(mcpPath, ({ request, server }) => handleMcp(deps, request, server?.requestIP(request)?.address ?? null))
    .get("/.well-known/oauth-authorization-server", ({ request, server }) => metadata(request, peer(request, server)))
    .get("/.well-known/oauth-authorization-server/mcp", ({ request, server }) => metadata(request, peer(request, server)))
    .get("/.well-known/oauth-protected-resource", ({ request, server }) => resource(request, peer(request, server)))
    .get("/.well-known/oauth-protected-resource/mcp", ({ request, server }) => resource(request, peer(request, server)))
    .options("/oauth/register", preflight)
    .options("/oauth/token", preflight)
    .options("/oauth/revoke", preflight)
    .post("/oauth/register", ({ request, server }) => withCors(register(deps, request, server?.requestIP(request)?.address ?? null)))
    .get("/oauth/authorize", ({ request }) => authorizePage(deps, request))
    .post("/oauth/authorize", ({ request, server }) => authorizeDecision(deps, request, server?.requestIP(request)?.address ?? null))
    .post("/oauth/token", ({ request }) => withCors(token(deps, request)))
    .post("/oauth/revoke", ({ request }) => withCors(revoke(deps, request)));
}

export default defineModule({ name: "mcp", ops: [infoOp, update, clients, revokeClient], http: routes });
