// The repository webhook of a service with a provider source: created when
// the repository is connected (with its own secret, sealed), removed from
// the provider when the service is deleted or its source changes, and
// pointed at the panel domain once one is set. The webhook's row id is in
// its URL (POST /api/hooks/<kind>/<id>), so a delivery names the service
// and the secret to check before anything in it is read.

import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { type GitProviderKind, gitProviderWebhooks } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { panelBaseUrl } from "../github/app";
import { clientFor } from "./client";
import { describeProviderError } from "./http";
import { loadProvider, type ProviderRow } from "./rows";

export type WebhookRow = typeof gitProviderWebhooks.$inferSelect;

export const hookPathPrefix = "/api/hooks";
export const removeHookJobType = "gitProviders.removeHook";

export function hookPath(kind: GitProviderKind, hookId: string): string {
  return `${hookPathPrefix}/${kind}/${hookId}`;
}

/**
 * Where providers reach the panel: its domain, else the address the person
 * connecting the repository opened it at (a provider on the same network
 * can reach that), else nothing.
 */
export function hookBase(deps: Pick<Deps, "db">, origin?: string | null): string | null {
  const domain = panelBaseUrl(deps.db);
  if (domain) return domain;
  if (origin && /^https?:\/\/[^/\s]+$/.test(origin.replace(/\/$/, ""))) return origin.replace(/\/$/, "");
  return null;
}

export function webhookOf(deps: Pick<Deps, "db">, serviceId: string): WebhookRow | undefined {
  return deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, serviceId)).get();
}

/**
 * Creates the service's webhook on the repository (replacing one for
 * another repository or address). A provider that refuses keeps the row
 * with the reason, so the Source tab can say why and polling covers pushes.
 */
export async function ensureHook(
  deps: Pick<Deps, "db" | "secrets" | "jobs" | "logger">,
  input: { serviceId: string; provider: ProviderRow; repo: string; origin?: string | null; force?: boolean },
): Promise<WebhookRow> {
  const existing = webhookOf(deps, input.serviceId);
  const base = hookBase(deps, input.origin) ?? (existing?.url ? new URL(existing.url).origin : null);
  const same = existing && existing.providerId === input.provider.id && existing.repo.toLowerCase() === input.repo.toLowerCase();
  if (same && existing.remoteId && !input.force && base && existing.url === `${base}${hookPath(input.provider.kind, existing.id)}`)
    return existing;
  if (existing) dropHook(deps, input.serviceId);

  const secret = randomBytes(32).toString("hex");
  const row = deps.db
    .insert(gitProviderWebhooks)
    .values({
      serviceId: input.serviceId,
      providerId: input.provider.id,
      repo: input.repo,
      secretSealed: deps.secrets.seal(secret, "git.webhook"),
    })
    .returning()
    .get();
  if (!base) {
    return deps.db
      .update(gitProviderWebhooks)
      .set({ error: "The panel has no public address yet: set its domain (Settings > General), then create the webhook again." })
      .where(eq(gitProviderWebhooks.id, row.id))
      .returning()
      .get();
  }
  const url = `${base}${hookPath(input.provider.kind, row.id)}`;
  try {
    const remoteId = await clientFor(deps, input.provider).createHook(input.repo, { url, secret });
    return deps.db
      .update(gitProviderWebhooks)
      .set({ remoteId, url, error: null })
      .where(eq(gitProviderWebhooks.id, row.id))
      .returning()
      .get();
  } catch (error) {
    deps.logger.warn({ err: error, serviceId: input.serviceId }, "creating the repository webhook failed; pushes are polled instead");
    return deps.db
      .update(gitProviderWebhooks)
      .set({ url, error: describeProviderError(error).slice(0, 500) })
      .where(eq(gitProviderWebhooks.id, row.id))
      .returning()
      .get();
  }
}

/** Forgets the services' webhooks and removes them from the provider in the background. */
export function dropHooks(deps: Pick<Deps, "db" | "jobs">, serviceIds: readonly string[]): void {
  if (serviceIds.length === 0) return;
  const rows = deps.db
    .select()
    .from(gitProviderWebhooks)
    .where(inArray(gitProviderWebhooks.serviceId, [...serviceIds]))
    .all();
  for (const row of rows) {
    if (row.remoteId)
      deps.jobs.enqueue(
        removeHookJobType,
        { providerId: row.providerId, repo: row.repo, remoteId: row.remoteId },
        { dedupeKey: `${removeHookJobType}:${row.providerId}:${row.remoteId}` },
      );
    deps.db.delete(gitProviderWebhooks).where(eq(gitProviderWebhooks.id, row.id)).run();
  }
}

export function dropHook(deps: Pick<Deps, "db" | "jobs">, serviceId: string): void {
  dropHooks(deps, [serviceId]);
}

/** Removes a webhook from the provider; retried while the provider is unreachable. */
export const removeHookJob = defineJob<{ providerId: string; repo: string; remoteId: string }>({
  type: removeHookJobType,
  maxAttempts: 6,
  async run(payload, deps) {
    let provider: ProviderRow;
    try {
      provider = loadProvider(deps.db, payload.providerId);
    } catch {
      // The connection is gone, and its token with it: nothing can remove the hook now.
      deps.logger.warn({ repo: payload.repo }, "a repository webhook could not be removed: its connection was deleted");
      return;
    }
    await clientFor(deps, provider).deleteHook(payload.repo, payload.remoteId);
  },
});

const lastRepair = new WeakMap<object, Map<string, number>>();
const repairEveryMs = 60 * 60_000;

/**
 * Points webhooks at the panel domain once it is set (or changes): each
 * hook whose URL is not on the current domain is created again, at most
 * once an hour per service. Runs with the poll schedule.
 */
export async function moveHooksToDomain(deps: Deps): Promise<number> {
  const base = panelBaseUrl(deps.db);
  if (!base) return 0;
  let tries = lastRepair.get(deps.db);
  if (!tries) {
    tries = new Map();
    lastRepair.set(deps.db, tries);
  }
  let moved = 0;
  for (const row of deps.db.select().from(gitProviderWebhooks).all()) {
    if (row.url?.startsWith(`${base}/`)) continue;
    if (Date.now() - (tries.get(row.serviceId) ?? 0) < repairEveryMs) continue;
    tries.set(row.serviceId, Date.now());
    try {
      const provider = loadProvider(deps.db, row.providerId);
      const next = await ensureHook(deps, { serviceId: row.serviceId, provider, repo: row.repo, force: true });
      if (next.remoteId) moved++;
    } catch (error) {
      deps.logger.warn({ err: error, serviceId: row.serviceId }, "moving a repository webhook to the panel domain failed");
    }
  }
  return moved;
}
