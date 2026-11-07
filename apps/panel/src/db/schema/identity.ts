// People and credentials: users, sessions, second factors, API and MCP
// keys, invites and the per-project/service grants that scope members.
// Every token is stored as a SHA-256 hash (security/tokens.ts); secrets
// that must be read back (TOTP seeds, GitHub tokens) are sealed.

import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";

export type Role = "owner" | "admin" | "member";

export const users = sqliteTable(
  "users",
  {
    id: id(),
    /** Stored lowercased; unique. */
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    /** argon2id (Bun.password). Null for people who only sign in with GitHub. */
    passwordHash: text("password_hash"),
    role: text("role").$type<Role>().notNull().default("member"),
    disabledAt: timestamp("disabled_at"),
    lastLoginAt: timestamp("last_login_at"),
    /** Wrong passwords in a row; reset by a successful sign-in (auth/brute-force.ts). */
    failedLogins: integer("failed_logins").notNull().default(0),
    /** Password sign-in refuses until then; passkeys and GitHub still work. */
    lockedUntil: timestamp("locked_until"),
    /** Per-person UI choices that follow them across browsers (collapsed projects, color mode). */
    preferences: json<Record<string, unknown>>("preferences").notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /**
     * SHA-256 of the session key, the half the web app keeps in its origin's
     * storage and sends in a header (auth/sessions.ts). Null on sessions made
     * before keys existed, which no longer sign anyone in.
     */
    keyHash: text("key_hash"),
    // Sessions only exist once every factor passed; a pending second factor
    // lives in auth_challenges instead.
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    /** Last auth.reauth on this session; with createdAt it decides whether a sign-in is fresh (auth/fresh.ts). */
    reauthAt: timestamp("reauth_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_hash_unique").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/** One-time link printed by the installer to create the owner account. */
export const setupTokens = sqliteTable(
  "setup_tokens",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("setup_tokens_token_hash_unique").on(t.tokenHash)],
);

export type ChallengePurpose =
  | "secondFactor"
  | "passkeyRegister"
  | "passkeyLogin"
  | "passkeyReauth"
  | "githubSignIn"
  | "githubLink"
  | "githubSetup";

/**
 * Short-lived, single-use tickets for multi-step sign-in flows: the 2FA
 * step after a password, WebAuthn ceremonies and GitHub device-flow polls.
 * The client holds the ticket; only its hash is stored. Rows are deleted
 * when used and swept after expiry.
 */
export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: id(),
    purpose: text("purpose").$type<ChallengePurpose>().notNull(),
    /** The person the flow is for; null before anyone is known (passkey or GitHub sign-in). */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Non-secret state: WebAuthn challenge, poll interval, repoAccess. */
    data: json<Record<string, unknown>>("data").notNull().default(sql`'{}'`),
    /** Secret state, sealed as "auth.challenge": the GitHub device code. */
    secretSealed: sealed("secret_sealed"),
    /** Wrong codes so far; the challenge dies after 5. */
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_challenges_token_hash_unique").on(t.tokenHash), index("auth_challenges_expires_idx").on(t.expiresAt)],
);

export const totpSecrets = sqliteTable("totp_secrets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretSealed: sealed("secret_sealed").notNull(),
  /** Set once the person typed a valid code; until then TOTP is not enforced. */
  confirmedAt: timestamp("confirmed_at"),
  /** Time step of the last accepted code, so a code works only once. */
  lastUsedStep: integer("last_used_step"),
  createdAt: createdAt(),
});

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/** WebAuthn credentials; only offered once the panel has a domain. */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    signCount: integer("sign_count").notNull().default(0),
    transports: json<string[]>("transports").notNull().default(sql`'[]'`),
    name: text("name").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("passkeys_credential_unique").on(t.credentialId), index("passkeys_user_idx").on(t.userId)],
);

/** GitHub device-flow sign-in; the token may also clone private repos (opt-in scope). */
export const githubAccounts = sqliteTable(
  "github_accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubUserId: integer("github_user_id").notNull(),
    login: text("login").notNull(),
    accessTokenSealed: sealed("access_token_sealed").notNull(),
    scopes: json<string[]>("scopes").notNull().default(sql`'[]'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("github_accounts_github_user_unique").on(t.githubUserId), index("github_accounts_user_idx").on(t.userId)],
);

export type ApiKeyKind = "api" | "mcp";

/**
 * Scoped API keys and MCP tokens. A key acts as its owner, narrowed to
 * `actions` ("*" for all of the owner's). MCP tokens are read-only unless
 * the owner turned that off, and destructive ops always need an approval.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ApiKeyKind>().notNull().default("api"),
    name: text("name").notNull(),
    /** First characters of the token, shown so people can tell keys apart. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** MCP OAuth tokens only: hash of the refresh token that rotates this key. */
    refreshTokenHash: text("refresh_token_hash"),
    actions: json<string[]>("actions").notNull(),
    /** Null: every project the owner can reach; otherwise only these (and their services). */
    projectIds: json<string[]>("project_ids"),
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    /** The MCP OAuth client that obtained this token, if any. */
    mcpClientId: text("mcp_client_id").references(() => mcpClients.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_token_hash_unique").on(t.tokenHash),
    uniqueIndex("api_keys_refresh_token_hash_unique").on(t.refreshTokenHash),
    index("api_keys_user_idx").on(t.userId),
  ],
);

/**
 * OAuth 2.1 clients registered by MCP hosts (dynamic client registration).
 * Kept here next to api_keys, which reference it; the authorization flow's
 * own tables live in mcp.ts.
 */
export const mcpClients = sqliteTable("mcp_clients", {
  id: id(),
  name: text("name").notNull(),
  redirectUris: json<string[]>("redirect_uris").notNull(),
  createdAt: createdAt(),
});

export type ScopeType = "project" | "service";

/** What a member may do on one project or service (Monday-style invites). */
export const grants = sqliteTable(
  "grants",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").$type<ScopeType>().notNull(),
    /** Project or service id; rows are deleted with their resource by the owning module. */
    scopeId: text("scope_id").notNull(),
    actions: json<string[]>("actions").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("grants_user_scope_unique").on(t.userId, t.scopeType, t.scopeId),
    index("grants_scope_idx").on(t.scopeType, t.scopeId),
  ],
);

export interface InviteGrant {
  scopeType: ScopeType;
  scopeId: string;
  actions: string[];
}

export const invites = sqliteTable(
  "invites",
  {
    id: id(),
    /** Stored lowercased. */
    email: text("email").notNull(),
    /** "admin" or "member"; owners are made with users.updateRole, never invited. */
    role: text("role").$type<Exclude<Role, "owner">>().notNull().default("member"),
    grants: json<InviteGrant[]>("grants").notNull().default(sql`'[]'`),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_hash_unique").on(t.tokenHash), index("invites_email_idx").on(t.email)],
);

export type CliLoginState = "pending" | "approved" | "denied" | "used";

/**
 * Laptop CLI sign-ins waiting for a browser approval (cliLogin.*). The
 * approved scope is kept here and the API key is created only when the CLI
 * polls, so no token is ever stored. Rows past expires_at are dead and swept.
 */
export const cliLoginRequests = sqliteTable(
  "cli_login_requests",
  {
    id: id(),
    /** "ABCDEFGH" without the dash; shown to people. */
    userCode: text("user_code").notNull(),
    deviceCodeHash: text("device_code_hash").notNull(),
    clientName: text("client_name").notNull(),
    requestedFrom: text("requested_from"),
    state: text("state").$type<CliLoginState>().notNull().default("pending"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "cascade" }),
    /** What the approver chose: { actions, projectIds, readOnly, expiresInDays }. */
    scope: json<{ actions: string[]; projectIds: string[] | null; readOnly: boolean; expiresInDays: number }>("scope"),
    keyId: text("key_id"),
    lastPolledAt: timestamp("last_polled_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cli_login_user_code_unique").on(t.userCode), uniqueIndex("cli_login_device_code_unique").on(t.deviceCodeHash)],
);
