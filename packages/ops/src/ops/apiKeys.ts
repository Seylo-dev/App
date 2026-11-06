// API keys and MCP tokens (Settings > API keys and MCP). A key acts as the
// person who created it, narrowed to a list of actions and optionally to
// some projects; a read-only key runs queries only. MCP tokens are keys of
// kind "mcp": read-only by default, and destructive ops through them always
// wait for a person's approval. Only browser sessions create keys, so a key
// can never mint a stronger key. Tokens are shown once and stored hashed.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { ActionList, ActionName } from "../people";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const ApiKeyKind = Type.Union([Type.Literal("api"), Type.Literal("mcp")]);

export const ApiKey = Type.Object({
  id: Id,
  kind: ApiKeyKind,
  name: Type.String(),
  /** First characters of the token, for example "seylo_key_Ab3d", so people can tell keys apart. */
  prefix: Type.String(),
  actions: Type.Array(ActionName),
  /** Null: every project its owner can reach. */
  projectIds: Type.Union([Type.Array(Id), Type.Null()]),
  readOnly: Type.Boolean(),
  /** The MCP host that obtained this token through OAuth, if any. */
  mcpClient: Type.Union([Type.String(), Type.Null()]),
  owner: Type.Object({ id: Id, email: Type.String() }),
  expiresAt: Type.Union([Timestamp, Type.Null()]),
  lastUsedAt: Type.Union([Timestamp, Type.Null()]),
  revokedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

export const create = defineOp({
  id: "apiKeys.create",
  kind: "mutation",
  summary: "Create an API key",
  description:
    'Creates an API key or MCP token for the signed-in person, limited to the given actions ("*" for all of yours), optionally to some projects, read-only or not, with an optional expiry. The token is returned once. Browser sessions only, signed in or confirmed with auth.reauth in the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise).',
  input: Type.Object({
    kind: Type.Union([Type.Literal("api"), Type.Literal("mcp")], { default: "api" }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    actions: ActionList,
    projectIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 100, uniqueItems: true })),
    /** Defaults to true for MCP tokens and false for API keys. */
    readOnly: Type.Optional(Type.Boolean()),
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650, description: "Leave out for a key that never expires." })),
  }),
  output: Type.Object({
    key: ApiKey,
    /** The secret, shown once. Send it as "Authorization: Bearer <token>". */
    token: Type.String(),
  }),
  permission: permission.signedIn(),
  sensitive: { output: ["token"] },
  mcp: false,
  audit: true,
});

export const list = defineOp({
  id: "apiKeys.list",
  kind: "query",
  summary: "List API keys",
  description:
    "Lists the signed-in person's API keys and MCP tokens, newest first. Owners and admins can pass all=true to see everyone's keys.",
  input: Type.Object({
    kind: Type.Optional(ApiKeyKind),
    all: Type.Boolean({ default: false }),
    includeRevoked: Type.Boolean({ default: false }),
  }),
  output: Type.Object({ keys: Type.Array(ApiKey) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const revoke = defineOp({
  id: "apiKeys.revoke",
  kind: "mutation",
  summary: "Revoke an API key",
  description: "Makes a key or MCP token stop working right away. Your own keys, or anyone's for owners and admins.",
  input: Type.Object({ keyId: Id }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});
