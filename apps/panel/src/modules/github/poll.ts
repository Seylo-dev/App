// Polling fallback for push-to-deploy: when GitHub cannot reach the panel
// (no public domain, a missed webhook, or a repository read through the
// connected account whose webhook GitHub refused), the panel asks GitHub
// for the head of each followed branch. How often depends on how the
// service's pushes arrive: every minute while nothing delivers them (no
// App webhook URL, or an account source without a working repository
// webhook), every 5 minutes as a safety net otherwise. Conditional
// requests keep unchanged branches free of rate limit. The same schedule
// creates account repository webhooks again (repo-hooks.ts).

import { eq, sql } from "drizzle-orm";
import { services, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { readSpec } from "../services/spec";
import { githubSourceAuth } from "./account";
import { githubRequest } from "./api";
import { appRow, webhookUrl } from "./app";
import { handlePush } from "./push";
import { repairRepoHooks, repoHookWorks } from "./repo-hooks";

export const pollJobType = "github.poll";
const everyMs = 60_000;
/** With a webhook that delivers, polling is only a safety net. */
const safetyNetMs = 5 * everyMs;

/**
 * Reads the followed branches. `safetyNet`: also the ones whose pushes a
 * webhook delivers (every 5 minutes); otherwise only those nothing
 * delivers. Returns how many deploys it started.
 */
export async function pollBranches(deps: Deps, options: { safetyNet?: boolean } = {}): Promise<number> {
  const safetyNet = options.safetyNet ?? true;
  const hasApp = appRow(deps.db) !== undefined;
  const appHook = webhookUrl(deps.db) !== null;
  const followed = deps.db
    .select()
    .from(services)
    .where(sql`json_extract(${services.spec}, '$.source.type') = 'github' and json_extract(${services.spec}, '$.source.deployOnPush') = 1`)
    .all();
  let deployed = 0;
  for (const svc of followed) {
    const spec = readSpec(svc.spec);
    if (spec.source.type !== "github" || spec.preview) continue;
    const viaApp = spec.source.installationId !== null;
    if (viaApp && !hasApp) continue;
    const delivered = viaApp ? appHook : repoHookWorks(deps, svc.id);
    if (delivered && !safetyNet) continue;
    const poll = deps.db.select().from(sourcePolls).where(eq(sourcePolls.serviceId, svc.id)).get();
    const sameBranch = poll?.branch === spec.source.branch;
    try {
      const { token } = await githubSourceAuth(deps, spec.source);
      const res = await githubRequest<{
        sha: string;
        commit: { message: string; author: { name: string } | null };
        author: { login: string } | null;
      }>(`/repos/${spec.source.repo}/commits/${encodeURIComponent(spec.source.branch)}`, {
        auth: token,
        etag: sameBranch ? poll?.etag : null,
      });
      const now = new Date();
      if (res.status === 304) {
        deps.db.update(sourcePolls).set({ checkedAt: now }).where(eq(sourcePolls.serviceId, svc.id)).run();
        continue;
      }
      const sha = res.data.sha;
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: spec.source.branch, lastSha: sha, etag: res.etag, checkedAt: now })
        .onConflictDoUpdate({
          target: sourcePolls.serviceId,
          set: { branch: spec.source.branch, lastSha: sha, etag: res.etag, checkedAt: now },
        })
        .run();
      // The first look only records the head; a change after that is a push we missed. It deploys
      // even while a deploy runs (after it, newest head wins): the head is recorded now, so a push
      // skipped here would never deploy.
      if (!sameBranch || !poll?.lastSha || poll.lastSha === sha) continue;
      deployed += await handlePush(
        deps,
        {
          repo: spec.source.repo,
          branch: spec.source.branch,
          sha,
          message: res.data.commit.message.split("\n")[0] ?? null,
          author: res.data.author?.login ?? res.data.commit.author?.name ?? null,
          sender: null,
          // A missed push: the files come from the compare API between the last seen head and this one.
          changes: { files: null, truncated: false, before: poll.lastSha, after: sha, headMessage: res.data.commit.message },
        },
        { id: `poll-${svc.id}-${sha}`, event: "push", source: "github" },
      );
    } catch (error) {
      deps.logger.warn({ err: error, serviceId: svc.id }, "polling the branch failed");
    }
  }
  return deployed;
}

const lastSafetyNet = new WeakMap<object, number>();

/**
 * Runs every minute from a schedule (github/index.ts): the branches no
 * webhook delivers every time, the rest every 5 minutes.
 */
export const pollJob = defineJob<Record<string, never>>({
  type: pollJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    const last = lastSafetyNet.get(deps.db) ?? 0;
    const safetyNet = Date.now() - last >= safetyNetMs - 5_000;
    if (safetyNet) lastSafetyNet.set(deps.db, Date.now());
    await pollBranches(deps, { safetyNet });
    await repairRepoHooks(deps);
  },
});

/** The schedule the module ensures at start. */
export const pollSchedule = {
  key: pollJobType,
  jobType: pollJobType,
  intervalSeconds: everyMs / 1000,
  missedRun: "skip" as const,
  runNow: true,
};
