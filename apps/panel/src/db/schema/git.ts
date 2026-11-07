// Where source code and images come from: the per-panel GitHub App (manifest
// flow), git and registry credentials, and the webhook deliveries that
// trigger push-to-deploy and previews.

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { projects, services } from "./projects";

/** The GitHub App created for this panel with the manifest flow. */
export const githubApps = sqliteTable("github_apps", {
  id: id(),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  htmlUrl: text("html_url").notNull(),
  ownerLogin: text("owner_login").notNull(),
  clientId: text("client_id").notNull(),
  clientSecretSealed: sealed("client_secret_sealed").notNull(),
  privateKeySealed: sealed("private_key_sealed").notNull(),
  webhookSecretSealed: sealed("webhook_secret_sealed").notNull(),
  createdAt: createdAt(),
});

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: id(),
    githubAppId: text("github_app_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").$type<"User" | "Organization">().notNull(),
    repositorySelection: text("repository_selection").$type<"all" | "selected">().notNull().default("all"),
    suspendedAt: timestamp("suspended_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("github_installations_installation_unique").on(t.installationId),
    index("github_installations_app_idx").on(t.githubAppId),
  ],
);

/** A started manifest flow; the state comes back on GitHub's redirect. Single use. */
export const githubManifestFlows = sqliteTable("github_manifest_flows", {
  /** SHA-256 of the state handed to GitHub. */
  stateHash: text("state_hash").primaryKey(),
  organization: text("organization"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: createdAt(),
});

/** A running device flow for the private-repo token (github.deviceStart / devicePoll). */
export const githubDeviceFlows = sqliteTable("github_device_flows", {
  id: id(),
  deviceCodeSealed: sealed("device_code_sealed").notNull(),
  userCode: text("user_code").notNull(),
  verificationUri: text("verification_uri").notNull(),
  intervalSeconds: integer("interval_seconds").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: createdAt(),
});

export type GitCredentialKind = "token" | "ssh_key";
export type GitCredentialOrigin = "manual" | "generated" | "device";

/**
 * Credentials for git hosts other than the GitHub App: a personal access
 * token (global or picked per service) or an SSH deploy key. Services
 * reference one by id in their source spec.
 */
export const gitCredentials = sqliteTable("git_credentials", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").$type<GitCredentialKind>().notNull(),
  /** Host the credential is for, for example "github.com" or "git.example.com". */
  host: text("host").notNull(),
  /** HTTPS user name for token credentials; some hosts need one. */
  username: text("username"),
  /** The token or the OpenSSH private key. */
  secretSealed: sealed("secret_sealed").notNull(),
  /** known_hosts lines for SSH keys on hosts without built-in keys. */
  knownHosts: text("known_hosts"),
  /** OpenSSH public key and its SHA256 fingerprint, for SSH credentials. */
  publicKey: text("public_key"),
  fingerprint: text("fingerprint"),
  origin: text("origin").$type<GitCredentialOrigin>().notNull().default("manual"),
  /** For origin "device": the GitHub login and granted scopes (comma separated). */
  githubLogin: text("github_login"),
  scopes: text("scopes"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Logins for private Docker registries (image sources). */
export const registryCredentials = sqliteTable("registry_credentials", {
  id: id(),
  name: text("name").notNull(),
  /** Registry host, for example "ghcr.io". */
  server: text("server").notNull(),
  username: text("username").notNull(),
  passwordSealed: sealed("password_sealed").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type GitProviderKind = "gitlab" | "gitea" | "bitbucket";
/** "token": a personal, group, project or workspace access token; "appPassword": Bitbucket user + app password. */
export type GitProviderAuth = "token" | "appPassword";

/**
 * A connection to GitLab (gitlab.com or self-managed), Gitea/Forgejo or
 * Bitbucket Cloud: the token the panel lists repositories, clones, creates
 * repository webhooks and posts commit statuses with. Services reference
 * one by id in a "provider" source.
 */
export const gitProviders = sqliteTable("git_providers", {
  id: id(),
  kind: text("kind").$type<GitProviderKind>().notNull(),
  name: text("name").notNull(),
  /** Web address without a trailing slash: https://gitlab.com, https://git.example.com, https://bitbucket.org. */
  url: text("url").notNull(),
  /** Bitbucket: the workspace whose repositories the connection lists. */
  workspace: text("workspace"),
  authKind: text("auth_kind").$type<GitProviderAuth>().notNull().default("token"),
  /** Bitbucket app passwords: the account's user name. */
  username: text("username"),
  tokenSealed: sealed("token_sealed").notNull(),
  /** Who the token acts as, read from the provider when it was saved. */
  account: text("account"),
  /** Post commit statuses (shown on merge and pull requests) for deploys and previews. */
  statusNotes: integer("status_notes", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The repository webhook the panel created for one service with a
 * provider source. Its id is in the webhook URL; the secret is per hook.
 */
export const gitProviderWebhooks = sqliteTable(
  "git_provider_webhooks",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => gitProviders.id, { onDelete: "cascade" }),
    /** Repository path at the provider ("group/sub/project", "owner/name", "workspace/slug"). */
    repo: text("repo").notNull(),
    secretSealed: sealed("secret_sealed").notNull(),
    /** The provider's id of the hook; null while it could not be created. */
    remoteId: text("remote_id"),
    /** The URL the provider posts to. */
    url: text("url"),
    /** Why creating the hook failed, for the Source tab. */
    error: text("error"),
    lastDeliveryAt: timestamp("last_delivery_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("git_provider_webhooks_service_unique").on(t.serviceId),
    index("git_provider_webhooks_provider_idx").on(t.providerId),
  ],
);

export type WebhookSource = "github" | "trigger" | GitProviderKind;
export type WebhookOutcome = "deployed" | "ignored" | "rejected" | "failed";

/**
 * Every webhook received, for dedupe (GitHub redelivers) and for the "why
 * did my push not deploy?" view. Bodies are not stored.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: id(),
    source: text("source").$type<WebhookSource>().notNull(),
    /** X-GitHub-Delivery, or the trigger request id. */
    deliveryId: text("delivery_id").notNull(),
    /** For example "push" or "pull_request.opened". */
    event: text("event").notNull(),
    serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
    outcome: text("outcome").$type<WebhookOutcome>().notNull(),
    detail: text("detail").notNull().default(""),
    /** Deployment it started, when it started one. */
    deploymentId: text("deployment_id"),
    receivedAt: timestamp("received_at").notNull(),
  },
  (t) => [
    // One delivery can deploy several services: one row per service it touched.
    uniqueIndex("webhook_deliveries_source_delivery_service_unique").on(t.source, t.deliveryId, t.serviceId),
    index("webhook_deliveries_service_idx").on(t.serviceId, t.receivedAt),
    index("webhook_deliveries_received_idx").on(t.receivedAt),
  ],
);

/**
 * Signed webhook bodies already handled, by hash, for replay protection
 * (modules/webhooks/replay.ts): the same body under another delivery id
 * is a replay. Kept 3 days (GitHub redelivers for 3), at most 10,000.
 */
export const webhookBodies = sqliteTable(
  "webhook_bodies",
  {
    source: text("source").$type<WebhookSource>().notNull(),
    /** The provider hook the body came to; "" for GitHub's one App hook. */
    hookId: text("hook_id").notNull(),
    /** sha256 of the raw body, hex. */
    bodyHash: text("body_hash").notNull(),
    deliveryId: text("delivery_id").notNull(),
    seenAt: timestamp("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.hookId, t.bodyHash] }), index("webhook_bodies_seen_idx").on(t.seenAt)],
);

/**
 * Polling fallback for push-to-deploy: the last commit seen on a
 * service's branch, for panels GitHub cannot reach with webhooks.
 */
export const sourcePolls = sqliteTable("source_polls", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  lastSha: text("last_sha"),
  /** ETag of the last answer, so unchanged branches cost no rate limit. */
  etag: text("etag"),
  checkedAt: timestamp("checked_at"),
});

/**
 * Internal git hosts (private, loopback or link-local addresses, or names
 * the panel cannot resolve) a project's services may clone from. Nodes
 * clone as root in their own network, so only an admin (git.manage) can
 * add one, by saving a git source with that host in the project; members
 * of the project may then use it too (modules/git/targets.ts).
 */
export const gitInternalHosts = sqliteTable(
  "git_internal_hosts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** urlHost() of the git URL, lowercased: "10.0.0.7:3000", "gitea.lan". */
    host: text("host").notNull(),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("git_internal_hosts_project_host_unique").on(t.projectId, t.host)],
);
