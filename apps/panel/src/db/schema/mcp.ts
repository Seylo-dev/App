// The MCP server's OAuth 2.1 authorization flow (PKCE). Registered clients
// (mcp_clients) and the tokens they end up with (api_keys of kind "mcp")
// live in identity.ts; this file holds the short-lived steps in between.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, timestamp } from "./columns";
import { mcpClients, users } from "./identity";

/** Authorization codes: single use, a few minutes long, bound to the PKCE challenge. */
export const mcpAuthCodes = sqliteTable(
  "mcp_auth_codes",
  {
    id: id(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    /** S256 code challenge; plain challenges are refused. */
    codeChallenge: text("code_challenge").notNull(),
    /** Actions the person approved on the consent screen; read-only unless they chose otherwise. */
    actions: json<string[]>("actions").notNull(),
    readOnly: integer("read_only", { mode: "boolean" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_auth_codes_code_hash_unique").on(t.codeHash), index("mcp_auth_codes_client_idx").on(t.clientId)],
);
