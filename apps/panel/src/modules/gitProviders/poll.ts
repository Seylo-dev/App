// Polling fallback for provider sources, like GitHub's: when the provider
// cannot reach the panel (no public address, a missed delivery, a hook it
// refused to create) the panel reads the head of each followed branch once
// a minute, or every 5 minutes as a safety net once the panel has a
// domain. A new head is a push it missed: its files come from the compare
// API between the last head and the new one. The same schedule moves
// webhooks to the panel domain when it is set.

import { eq, sql } from "drizzle-orm";
import { services, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { hasActiveDeploy } from "../deployments/queue";
import { panelBaseUrl } from "../github/app";
import { readSpec } from "../services/spec";
import { clientFor } from "./client";
import { moveHooksToDomain } from "./hooks";
import { deployProviderPush } from "./push";
import { loadProvider } from "./rows";

export const pollJobType = "gitProviders.poll";
const everyMs = 60_000;

export async function pollProviderBranches(deps: Deps): Promise<number> {
  const followed = deps.db
    .select()
    .from(services)
    .where(
      sql`json_extract(${services.spec}, '$.source.type') = 'provider' and json_extract(${services.spec}, '$.source.deployOnPush') = 1`,
    )
    .all();
  let deployed = 0;
  for (const svc of followed) {
    const spec = readSpec(svc.spec);
    const source = spec.source;
    if (source.type !== "provider" || spec.preview) continue;
    const poll = deps.db.select().from(sourcePolls).where(eq(sourcePolls.serviceId, svc.id)).get();
    const sameBranch = poll?.branch === source.branch;
    try {
      const provider = loadProvider(deps.db, source.providerId);
      const client = clientFor(deps, provider);
      const head = await client.branchHead(source.repo, source.branch);
      const now = new Date();
      if (!head) {
        deps.db.update(sourcePolls).set({ checkedAt: now }).where(eq(sourcePolls.serviceId, svc.id)).run();
        continue;
      }
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: source.branch, lastSha: head.sha, checkedAt: now })
        .onConflictDoUpdate({ target: sourcePolls.serviceId, set: { branch: source.branch, lastSha: head.sha, checkedAt: now } })
        .run();
      // The first look only records the head; a change after that is a push the webhook missed.
      if (!sameBranch || !poll?.lastSha || poll.lastSha === head.sha || hasActiveDeploy(deps, svc.id)) continue;
      const outcome = await deployProviderPush(
        deps,
        svc,
        client,
        {
          branch: source.branch,
          after: head.sha,
          changes: { files: null, truncated: false, before: poll.lastSha, after: head.sha, headMessage: head.message },
          author: head.author,
          sender: null,
          trusted: true,
        },
        { source: provider.kind, id: `poll-${svc.id}-${head.sha}`, event: "push" },
      );
      if (outcome === "deployed") deployed++;
    } catch (error) {
      deps.logger.warn({ err: error, serviceId: svc.id }, "polling the provider branch failed");
    }
  }
  return deployed;
}

const lastPoll = new WeakMap<object, number>();

/** Every minute from a schedule (gitProviders/index.ts); every 5 minutes once the panel has a domain. */
export const pollJob = defineJob<Record<string, never>>({
  type: pollJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    await moveHooksToDomain(deps);
    const last = lastPoll.get(deps.db) ?? 0;
    if (panelBaseUrl(deps.db) && Date.now() - last < everyMs * 5 - 5_000) return;
    lastPoll.set(deps.db, Date.now());
    await pollProviderBranches(deps);
  },
});

export const pollSchedule = {
  key: pollJobType,
  jobType: pollJobType,
  intervalSeconds: everyMs / 1000,
  missedRun: "skip" as const,
  runNow: true,
};
