// Polling fallback for push-to-deploy: when GitHub cannot reach the panel
// (no public domain, or a missed webhook), the panel asks GitHub for the
// head of each followed branch once a minute. Conditional requests keep
// unchanged branches free of rate limit.

import { eq, sql } from "drizzle-orm";
import { services, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { readSpec } from "../services/spec";
import { githubRequest } from "./api";
import { appRow, tokenForInstallation, webhookUrl } from "./app";
import { handlePush } from "./push";

export const pollJobType = "github.poll";
const everyMs = 60_000;

export async function pollBranches(deps: Deps): Promise<number> {
  if (!appRow(deps.db)) return 0;
  const followed = deps.db
    .select()
    .from(services)
    .where(sql`json_extract(${services.spec}, '$.source.type') = 'github' and json_extract(${services.spec}, '$.source.deployOnPush') = 1`)
    .all();
  let deployed = 0;
  for (const svc of followed) {
    const spec = readSpec(svc.spec);
    if (spec.source.type !== "github" || spec.preview) continue;
    const poll = deps.db.select().from(sourcePolls).where(eq(sourcePolls.serviceId, svc.id)).get();
    const sameBranch = poll?.branch === spec.source.branch;
    try {
      const token = await tokenForInstallation(deps.db, deps.secrets, spec.source.installationId);
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

const lastPoll = new WeakMap<object, number>();

/**
 * Runs every minute from a schedule (github/index.ts). Polling matters most
 * without webhooks; with them it is a slower safety net, every 5 minutes.
 */
export const pollJob = defineJob<Record<string, never>>({
  type: pollJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    const last = lastPoll.get(deps.db) ?? 0;
    if (webhookUrl(deps.db) && Date.now() - last < everyMs * 5 - 5_000) return;
    lastPoll.set(deps.db, Date.now());
    await pollBranches(deps);
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
