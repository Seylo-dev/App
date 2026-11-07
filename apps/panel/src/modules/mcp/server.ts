// The MCP endpoint (Streamable HTTP transport, stateless): POST /mcp with
// one JSON-RPC message (or a batch) and a JSON reply. No server-initiated
// stream is offered, so GET and DELETE answer 405. Every request needs an
// MCP token (Authorization: Bearer); without one the 401 points the client
// at the OAuth metadata.

import { displayName, slug } from "@seylo/brand";
import { authenticate, credentialsFrom } from "../../auth/authenticate";
import type { Principal } from "../../auth/principal";
import type { Deps } from "../../deps";
import { clientIp } from "../../http/client-ip";
import { requestOrigin } from "../../http/request-origin";
import { readPanelName } from "../settings/keys";
import { readMcpEnabled } from "./keys";
import { callTool, toolsFor } from "./tools";

export const mcpPath = "/mcp";

/** Newest first; the first one is offered when the client asks for something else. */
export const supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${mcpPath}`;
}

function unauthorized(origin: string, message: string): Response {
  return Response.json(rpcError(null, -32001, message), {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}"` },
  });
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.jsonrpc === "2.0" && typeof v.method === "string" && (v.params === undefined || (typeof v.params === "object" && v.params !== null))
  );
}

export async function handleMcp(deps: Deps, request: Request, socketIp: string | null): Promise<Response> {
  const origin = requestOrigin(request, deps.proxy.trusts(socketIp));
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (!readMcpEnabled(deps.db)) {
    return Response.json(rpcError(null, -32002, "The MCP server is turned off on this panel."), { status: 403 });
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version && !supportedProtocolVersions.includes(version)) {
    return Response.json(rpcError(null, -32600, `Unsupported MCP protocol version ${version}.`), { status: 400 });
  }

  // Bearer tokens only: the MCP endpoint never reads the session cookie.
  const credentials = credentialsFrom(request, { secure: false });
  if (!credentials.bearerToken) return unauthorized(origin, "Sign in through OAuth or send an MCP token.");
  const principal = authenticate(deps.db, { bearerToken: credentials.bearerToken });
  if (principal.type !== "apiKey" || principal.keyKind !== "mcp") {
    return unauthorized(origin, "This token is not a valid MCP token.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "The body is not JSON."), { status: 400 });
  }

  const ip = clientIp(request, socketIp, deps.proxy.trusts(socketIp));
  const context = { deps, principal, bearerToken: credentials.bearerToken, ip, userAgent: request.headers.get("user-agent") };
  if (Array.isArray(body)) {
    if (body.length === 0) return Response.json(rpcError(null, -32600, "Empty batch."), { status: 400 });
    const replies = (await Promise.all(body.map((message) => handleMessage(context, message)))).filter((r) => r !== null);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const reply = await handleMessage(context, body);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}

interface MessageContext {
  deps: Deps;
  principal: Extract<Principal, { type: "apiKey" }>;
  bearerToken: string;
  ip: string | null;
  userAgent: string | null;
}

async function handleMessage(ctx: MessageContext, message: unknown) {
  if (!isRequest(message)) {
    // Responses from the client (we never send requests) and malformed messages.
    const id = (message as { id?: JsonRpcId })?.id ?? null;
    return (message as { result?: unknown; error?: unknown })?.result !== undefined || (message as { error?: unknown })?.error !== undefined
      ? null
      : rpcError(id, -32600, "Not a JSON-RPC 2.0 request.");
  }
  // Notifications (no id) get no reply.
  if (message.id === undefined) return null;
  const id = message.id;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const panelName = readPanelName(ctx.deps.db);
      return rpcResult(id, {
        protocolVersion: supportedProtocolVersions.includes(asked) ? asked : supportedProtocolVersions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: slug, title: panelName, version: ctx.deps.config.version },
        instructions:
          `Tools of the ${panelName} deploy panel (${displayName}): projects, services, deployments, domains, logs and more. ` +
          "Tools that change things may be refused for this token (read-only by default). Destructive actions are queued for a person to approve; " +
          "use approvals_get to follow them.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolsFor(ctx.principal) });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return rpcError(id, -32602, "tools/call needs a tool name.");
      const result = await callTool(ctx.deps, {
        name,
        args: params.arguments,
        bearerToken: ctx.bearerToken,
        principal: ctx.principal,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
