// The per-panel GitHub App: made once with GitHub's manifest flow, then
// installed on accounts; the panel clones with one-hour installation
// tokens and GitHub posts pushes and PR events to the webhook route.
// Ported from an earlier in-house implementation by the same authors.

import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { displayName } from "@seylo/brand";
import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { githubApps, githubInstallations } from "../../db/schema";
import type { Deps } from "../../deps";
import type { SecretBox } from "../../security/secret-box";
import { getSetting } from "../../settings";
import { githubRequest } from "./api";

export const githubWebhookPath = "/api/hooks/github";
/** Web app page GitHub sends people back to after creating or installing the App. */
export const githubSettingsPage = "/settings/github";

export type GithubAppRow = typeof githubApps.$inferSelect;

export function appRow(db: PanelDb): GithubAppRow | undefined {
  return db.select().from(githubApps).limit(1).get();
}

export function requireApp(db: PanelDb): GithubAppRow {
  const row = appRow(db);
  if (!row) throw new OpError("CONFLICT", "Create the GitHub App first (Settings, GitHub).", { reason: "noGithubApp" });
  return row;
}

/** https://<panel domain>, or null while the panel is only reachable on IP:port. */
export function panelBaseUrl(db: PanelDb): string | null {
  const domain = getSetting(db, "panelDomain");
  return domain ? `https://${domain}` : null;
}

export function webhookUrl(db: PanelDb): string | null {
  const base = panelBaseUrl(db);
  return base ? `${base}${githubWebhookPath}` : null;
}

export function installUrl(row: GithubAppRow): string {
  return `https://github.com/apps/${row.slug}/installations/new`;
}

export function manifestFor(input: { baseUrl: string; webhookUrl: string | null; panelName: string }) {
  return {
    name: `${input.panelName || displayName} Deploy`.slice(0, 34),
    url: input.baseUrl,
    description: `Deploys your apps with ${displayName}: clones the repositories you pick, deploys on push and builds PR previews.`,
    // Always active, so GitHub hands back a webhook secret the panel keeps. Before the panel
    // has a domain the hook points at the address people open it at (deliveries work when
    // GitHub can reach it; polling covers the rest) and moves to the domain later
    // (syncWebhookConfig).
    hook_attributes: { url: input.webhookUrl ?? `${input.baseUrl}${githubWebhookPath}`, active: true },
    redirect_url: `${input.baseUrl}${githubSettingsPage}`,
    callback_urls: [`${input.baseUrl}${githubSettingsPage}`],
    setup_url: `${input.baseUrl}${githubSettingsPage}`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    default_events: ["push", "pull_request"],
  };
}

/** The App's own JWT (nine minutes), for its installation endpoints. */
export function appJwt(row: GithubAppRow, secrets: SecretBox): string {
  const key = secrets.open(row.privateKeySealed, "github.app");
  if (!key) throw new OpError("CONFLICT", "The GitHub App key cannot be opened. Create the App again.");
  const now = Math.floor(Date.now() / 1000);
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: String(row.appId) })}`;
  const signature = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${signature}`;
}

const tokenCache = new WeakMap<object, Map<number, { token: string; expires: number }>>();

/** A token for one installation, reused until five minutes before it expires. */
export async function installationToken(db: PanelDb, secrets: SecretBox, installationId: number): Promise<string> {
  let cache = tokenCache.get(db);
  if (!cache) {
    cache = new Map();
    tokenCache.set(db, cache);
  }
  const hit = cache.get(installationId);
  if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const row = requireApp(db);
  const { data } = await githubRequest<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    auth: appJwt(row, secrets),
  });
  cache.set(installationId, { token: data.token, expires: Date.parse(data.expires_at) });
  return data.token;
}

export function forgetTokens(db: PanelDb): void {
  tokenCache.delete(db);
}

/** The installation row by panel id, with a clear error when it is gone. */
export function installationById(db: PanelDb, id: string) {
  const row = db.select().from(githubInstallations).where(eq(githubInstallations.id, id)).get();
  if (!row) throw new OpError("NOT_FOUND", "No GitHub installation with this id.", { field: "installationId" });
  if (row.suspendedAt) throw new OpError("CONFLICT", `The GitHub App is suspended on ${row.accountLogin}.`);
  return row;
}

/** Token for the installation a service's GitHub source names. */
export async function tokenForInstallation(db: PanelDb, secrets: SecretBox, installationRowId: string): Promise<string> {
  return installationToken(db, secrets, installationById(db, installationRowId).installationId);
}

/** GitHub's X-Hub-Signature-256 over the raw body, compared in constant time. */
export function verifySignature(secret: string, raw: string | Uint8Array, header: string | null | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function webhookSecret(db: PanelDb, secrets: SecretBox): string | null {
  const row = appRow(db);
  return row ? secrets.open(row.webhookSecretSealed, "github.app") : null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string | null;
}

/** Head commit of a branch (or a given commit) through the App. */
export async function githubCommit(token: string, repo: string, ref: string): Promise<CommitInfo> {
  const { data } = await githubRequest<{
    sha: string;
    commit: { message: string; author: { name: string } | null };
    author: { login: string } | null;
  }>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, { auth: token });
  return {
    sha: data.sha,
    message: data.commit.message.split("\n")[0] ?? "",
    author: data.author?.login ?? data.commit.author?.name ?? null,
  };
}

/**
 * Points the App's webhook at the panel domain with the panel's own secret
 * (PATCH /app/hook/config), or turns it off without a domain. The manifest
 * flow can only send the hook's URL and whether it is active, never a
 * secret, so an App created before the panel had a domain would otherwise
 * keep an inactive hook (or one whose secret the panel does not know) and
 * every delivery would fail verification. Best effort: logs and returns
 * false when GitHub cannot be reached.
 */
export async function syncWebhookConfig(deps: Pick<Deps, "db" | "secrets" | "logger">): Promise<boolean> {
  const row = appRow(deps.db);
  if (!row) return false;
  const secret = deps.secrets.open(row.webhookSecretSealed, "github.app");
  const url = webhookUrl(deps.db);
  try {
    await githubRequest("/app/hook/config", {
      method: "PATCH",
      auth: appJwt(row, deps.secrets),
      body: url && secret ? { url, content_type: "json", secret, insecure_ssl: "0" } : { content_type: "json" },
    });
    return true;
  } catch (error) {
    deps.logger.warn({ err: error }, "updating the GitHub App's webhook failed; push-to-deploy falls back to polling");
    return false;
  }
}
