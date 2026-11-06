// Where source code and images come from: the per-panel GitHub App (manifest
// flow), git and registry credentials, and the webhook deliveries that
// trigger push-to-deploy and previews.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { services } from "./projects";

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

export type WebhookSource = "github" | "trigger";
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
