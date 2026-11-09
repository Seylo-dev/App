// Push-to-deploy for GitHub repositories read through the panel's
// connected GitHub account (account.ts), which the App's webhook does not
// cover. When the repository is connected the panel creates a webhook on
// it with the account's token (POST /repos/{repo}/hooks: a classic token
// or device login needs the repo or admin:repo_hook scope, a fine-grained
// token Webhooks: Read and write, and the account must administer the
// repository) with the hook's own secret, sealed. The hook's row id is in
// its URL (POST /api/hooks/github-repo/<id>), so a delivery names the
// service and the secret to check before anything is read. Without a
// panel domain, or when GitHub refuses, the row keeps the reason and the
// panel polls the branch every minute instead (poll.ts); the poll schedule
// tries again once an hour (repairRepoHooks).

import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { gitCredentials, githubRepoWebhooks } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import type { GitCredentialRow } from "../git/credentials";
import { accountToken, mayCreateHooks } from "./account";
import { describeGithubError, GithubApiError, githubRequest } from "./api";
import { panelBaseUrl } from "./app";

export type RepoHookRow = typeof githubRepoWebhooks.$inferSelect;

export const repoHookPathPrefix = "/api/hooks/github-repo";
export const removeRepoHookJobType = "github.removeRepoHook";

export function repoHookPath(hookId: string): string {
  return `${repoHookPathPrefix}/${hookId}`;
}

export function repoHookOf(deps: Pick<Deps, "db">, serviceId: string): RepoHookRow | undefined {
  return deps.db.select().from(githubRepoWebhooks).where(eq(githubRepoWebhooks.serviceId, serviceId)).get();
}

/** Whether the service's pushes reach the panel through its repository webhook. */
export function repoHookWorks(deps: Pick<Deps, "db">, serviceId: string): boolean {
  const hook = repoHookOf(deps, serviceId);
  return Boolean(hook?.remoteId && !hook.error);
}

export const noDomainReason =
  "The panel has no domain yet, so GitHub cannot reach it: pushes are picked up by polling the branch every minute. Set the panel domain (Settings > General) and the webhook is created within the hour.";
export const noHookScopeReason =
  "The connected token may not create webhooks (a classic token needs the repo scope): pushes are picked up by polling the branch every minute.";

/** Why GitHub refused the webhook, in words that say what to change. */
function refusedReason(error: unknown): string {
  const status = error instanceof GithubApiError ? error.status : 0;
  const detail = describeGithubError(error).slice(0, 300);
  const hint =
    status === 403 || status === 404
      ? " A fine-grained token needs Webhooks: Read and write, and the account must be an admin of the repository."
      : "";
  return `GitHub did not create the webhook (${detail}).${hint} Pushes are picked up by polling the branch every minute.`;
}

/**
 * Creates the service's webhook on the repository with the account's token
 * (replacing one for another repository, account or address). A refusal
 * keeps the row with the reason, so the Source tab can say why while
 * polling covers pushes.
 */
export async function ensureRepoHook(
  deps: Pick<Deps, "db" | "secrets" | "jobs" | "logger">,
  input: { serviceId: string; account: GitCredentialRow; repo: string; force?: boolean },
): Promise<RepoHookRow> {
  const existing = repoHookOf(deps, input.serviceId);
  const base = panelBaseUrl(deps.db);
  const same = existing && existing.credentialId === input.account.id && existing.repo.toLowerCase() === input.repo.toLowerCase();
  if (same && existing.remoteId && !input.force && base && existing.url === `${base}${repoHookPath(existing.id)}`) return existing;
  if (existing) dropRepoHooks(deps, [input.serviceId]);

  const secret = randomBytes(32).toString("hex");
  const row = deps.db
    .insert(githubRepoWebhooks)
    .values({
      serviceId: input.serviceId,
      credentialId: input.account.id,
      repo: input.repo,
      secretSealed: deps.secrets.seal(secret, "git.webhook"),
    })
    .returning()
    .get();
  const fail = (error: string, url: string | null = null) =>
    deps.db.update(githubRepoWebhooks).set({ error, url }).where(eq(githubRepoWebhooks.id, row.id)).returning().get();
  if (!base) return fail(noDomainReason);
  if (mayCreateHooks(input.account) === false) return fail(noHookScopeReason);
  const url = `${base}${repoHookPath(row.id)}`;
  try {
    const { data } = await githubRequest<{ id: number }>(`/repos/${input.repo}/hooks`, {
      method: "POST",
      auth: accountToken(deps.secrets, input.account),
      body: {
        name: "web",
        active: true,
        events: ["push", "pull_request"],
        config: { url, content_type: "json", secret, insecure_ssl: "0" },
      },
    });
    return deps.db
      .update(githubRepoWebhooks)
      .set({ remoteId: String(data.id), url, error: null })
      .where(eq(githubRepoWebhooks.id, row.id))
      .returning()
      .get();
  } catch (error) {
    deps.logger.warn(
      { err: error, serviceId: input.serviceId },
      "creating the GitHub repository webhook failed; pushes are polled instead",
    );
    return fail(refusedReason(error), url);
  }
}

/** Forgets the services' repository webhooks and removes them from GitHub in the background. */
export function dropRepoHooks(deps: Pick<Deps, "db" | "jobs">, serviceIds: readonly string[]): void {
  if (serviceIds.length === 0) return;
  const rows = deps.db
    .select()
    .from(githubRepoWebhooks)
    .where(inArray(githubRepoWebhooks.serviceId, [...serviceIds]))
    .all();
  for (const row of rows) {
    if (row.remoteId && row.credentialId)
      deps.jobs.enqueue(
        removeRepoHookJobType,
        { credentialId: row.credentialId, repo: row.repo, remoteId: row.remoteId },
        { dedupeKey: `${removeRepoHookJobType}:${row.repo}:${row.remoteId}` },
      );
    deps.db.delete(githubRepoWebhooks).where(eq(githubRepoWebhooks.id, row.id)).run();
  }
}

/**
 * Removes every webhook the account created, now: its token is about to be
 * deleted, so a job could not do it later. Best effort, a few seconds at most.
 */
export async function removeAccountHooks(deps: Pick<Deps, "db" | "secrets" | "logger">, account: GitCredentialRow): Promise<void> {
  const rows = deps.db.select().from(githubRepoWebhooks).where(eq(githubRepoWebhooks.credentialId, account.id)).all();
  let token: string | null = null;
  try {
    token = accountToken(deps.secrets, account);
  } catch {
    token = null;
  }
  await Promise.allSettled(
    rows
      .filter((row) => row.remoteId && token)
      .map((row) => githubRequest(`/repos/${row.repo}/hooks/${row.remoteId}`, { method: "DELETE", auth: token })),
  );
  if (rows.length > 0)
    deps.db
      .delete(githubRepoWebhooks)
      .where(
        inArray(
          githubRepoWebhooks.id,
          rows.map((r) => r.id),
        ),
      )
      .run();
}

/** Removes a webhook from GitHub; retried while GitHub is unreachable. */
export const removeRepoHookJob = defineJob<{ credentialId: string; repo: string; remoteId: string }>({
  type: removeRepoHookJobType,
  maxAttempts: 6,
  async run(payload, deps) {
    const account = deps.db.select().from(gitCredentials).where(eq(gitCredentials.id, payload.credentialId)).get();
    if (!account) {
      deps.logger.warn({ repo: payload.repo }, "a GitHub repository webhook could not be removed: its account was disconnected");
      return;
    }
    try {
      await githubRequest(`/repos/${payload.repo}/hooks/${payload.remoteId}`, {
        method: "DELETE",
        auth: accountToken(deps.secrets, account),
      });
    } catch (error) {
      // Already gone on GitHub: nothing left to do.
      if (error instanceof GithubApiError && error.status === 404) return;
      throw error;
    }
  },
});

const lastRepair = new WeakMap<object, Map<string, number>>();
const repairEveryMs = 60 * 60_000;

/**
 * Creates webhooks again, at most once an hour per service; runs with the
 * poll schedule. A hook that is missing or not on the current panel domain
 * (the domain was set or changed, GitHub refused it before) is created
 * again, while the service still reads the repository through the account.
 */
export async function repairRepoHooks(deps: Deps, now = Date.now()): Promise<number> {
  const base = panelBaseUrl(deps.db);
  if (!base) return 0;
  let tries = lastRepair.get(deps.db);
  if (!tries) {
    tries = new Map();
    lastRepair.set(deps.db, tries);
  }
  let repaired = 0;
  for (const row of deps.db.select().from(githubRepoWebhooks).all()) {
    if (row.remoteId && row.url?.startsWith(`${base}/`)) continue;
    if (now - (tries.get(row.serviceId) ?? 0) < repairEveryMs) continue;
    tries.set(row.serviceId, now);
    const account = row.credentialId
      ? deps.db.select().from(gitCredentials).where(eq(gitCredentials.id, row.credentialId)).get()
      : undefined;
    if (!account) continue;
    try {
      const next = await ensureRepoHook(deps, { serviceId: row.serviceId, account, repo: row.repo, force: true });
      if (next.remoteId) repaired++;
    } catch (error) {
      deps.logger.warn({ err: error, serviceId: row.serviceId }, "repairing a GitHub repository webhook failed");
    }
  }
  return repaired;
}
