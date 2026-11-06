// The panel's MCP server: where it is, whether it is on, and the OAuth
// clients that connected through the consent screen. MCP tokens are API
// keys of kind "mcp" and are managed with apiKeys.create / list / revoke
// (kind "mcp"): read-only by default, narrowed to a list of actions, and
// destructive calls wait for a person in approvals.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const McpInfo = Type.Object({
  enabled: Type.Boolean(),
  /** Streamable HTTP endpoint to paste into a model host, for example https://panel.example.com/mcp. */
  url: Type.String(),
  /** OAuth 2.1 authorization server metadata (RFC 8414). */
  oauthMetadataUrl: Type.String(),
  /** Ready-made config snippets for common hosts, keyed by host name ("claude-code", "claude-desktop", "cursor"). */
  snippets: Type.Record(Type.String(), Type.String()),
  tools: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    readOnly: Type.Integer({ minimum: 0 }),
    destructive: Type.Integer({ minimum: 0 }),
  }),
});

export const info = defineOp({
  id: "mcp.info",
  kind: "query",
  summary: "Get MCP server information",
  description:
    "Returns whether the MCP server is on, its URL, the OAuth metadata URL, config snippets for model hosts and how many tools it offers.",
  input: Empty,
  output: McpInfo,
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const update = defineOp({
  id: "mcp.update",
  kind: "mutation",
  summary: "Turn the MCP server on or off",
  description: "Switches the MCP endpoint on or off for the whole panel. Off refuses every token and OAuth flow but keeps them.",
  input: Type.Object({ enabled: Type.Boolean() }),
  output: McpInfo,
  permission: permission.global("mcp.manage"),
  mcp: false,
  audit: true,
});

export const McpClient = Type.Object({
  id: Id,
  name: Type.String(),
  redirectUris: Type.Array(Type.String()),
  /** Live tokens this client holds. */
  activeTokens: Type.Integer({ minimum: 0 }),
  lastUsedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

export const clients = defineOp({
  id: "mcp.clients",
  kind: "query",
  summary: "List MCP OAuth clients",
  description: "Lists the model hosts that registered through OAuth, with how many live tokens each holds.",
  input: Empty,
  output: Type.Object({ clients: Type.Array(McpClient) }),
  permission: permission.global("mcp.manage"),
  mcp: false,
  audit: false,
});

export const revokeClient = defineOp({
  id: "mcp.revokeClient",
  kind: "destructive",
  summary: "Revoke an MCP OAuth client",
  description:
    "Deletes an OAuth client registration and revokes every token it obtained. The host has to register and ask for consent again.",
  input: Type.Object({ clientId: Id }),
  output: Empty,
  permission: permission.global("mcp.manage"),
  mcp: false,
  audit: true,
});
