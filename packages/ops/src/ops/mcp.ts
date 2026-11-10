// The panel's MCP server: where it is, whether it is on, its two safety
// switches, and the OAuth clients that connected through the consent
// screen. MCP tokens are API keys of kind "mcp" and are managed with
// apiKeys.create / list / revoke (kind "mcp"): read-only by default,
// narrowed to a list of actions, and destructive calls wait for a person in
// approvals while askBeforeDestructive is on.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const McpInfo = Type.Object({
  enabled: Type.Boolean(),
  /**
   * A destructive call from an MCP token waits for a person in approvals.
   * Off, it runs right away, still audited and still refused for read-only
   * tokens. On by default. The AI assistant asks either way.
   */
  askBeforeDestructive: Type.Boolean(),
  /**
   * The OAuth consent page preselects read only for a new AI tool. Off, it
   * preselects read and change. The person can pick either. On by default.
   */
  readOnlyByDefault: Type.Boolean(),
  /** Streamable HTTP endpoint to paste into a model host, for example https://panel.example.com/mcp. */
  url: Type.String(),
  /** OAuth 2.1 authorization server metadata (RFC 8414). */
  oauthMetadataUrl: Type.String(),
  /**
   * What to run or paste to add the server, keyed by host: "claude-code",
   * "claude-desktop" (the URL, for a custom connector), "cursor", "vscode",
   * "codex", "gemini-cli" and "goose".
   */
  snippets: Type.Record(Type.String(), Type.String()),
  /**
   * One-click install links, keyed like snippets, for hosts that publish a
   * format: "cursor" and "vscode" (https pages that open the app), "goose"
   * (a goose:// link) and "claude-desktop" (Claude's connectors page, where
   * the URL is pasted).
   */
  installLinks: Type.Record(Type.String(), Type.String()),
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
    "Returns whether the MCP server is on, its two safety switches, its URL, the OAuth metadata URL, config snippets and one-click install links for model hosts, and how many tools it offers.",
  input: Empty,
  output: McpInfo,
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const update = defineOp({
  id: "mcp.update",
  kind: "mutation",
  summary: "Change the MCP server settings",
  description:
    "Changes the MCP settings for the whole panel; fields left out keep their value. enabled switches the endpoint on or off: off refuses every token and OAuth flow but keeps them. " +
    "askBeforeDestructive (on by default): destructive calls from MCP tokens wait for a person in approvals; off, they run right away, still audited and still refused for read-only tokens. " +
    "readOnlyByDefault (on by default): the OAuth consent page preselects read only for a new AI tool; off, it preselects read and change.",
  input: Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    askBeforeDestructive: Type.Optional(Type.Boolean()),
    readOnlyByDefault: Type.Optional(Type.Boolean()),
  }),
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
