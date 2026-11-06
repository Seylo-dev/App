// Polling fallback for provider sources, like GitHub's: when the provider
// cannot reach the panel (no public address, a missed delivery, a hook it
// refused to create) the panel reads the head of each followed branch. How
// often depends on the service's webhook, not on the panel: once a minute
// while it has none that works, every 5 minutes as a safety net while it
// does, and not at all while it delivered within that window. Providers
// count API calls per token (Bitbucket Cloud about 1000 an hour), so
// services with working webhooks must not spend them every minute. A new
// head is a push the panel missed: its files come from the compare API
// between the last head and the new one. The same schedule repairs
// webhooks (hooks.ts repairHooks).

import { eq, sql } from "drizzle-orm";
import { services, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { readSpec } from "../services/spec";
import { clientFor } from "./client";
import { repairHooks, webhookOf } from "./hooks";
import { deployProviderPush } from "./push";
import { loadProvider } from "./rows";

export const pollJobType = "gitProviders.poll";
const everyMs = 60_000;
/** With a working webhook polling is only a safety net. */
const safetyNetMs = 5 * everyMs;
/** The schedule fires about every minute; a check a little early still counts as due. */
const slackMs = 5_000;

/** How often this service's branch is read, or null when its webhook just proved it works. */
function cadenceFor(deps: Pick<Deps, "db">, serviceId: string, now: number): number | null {
  const hook = webhookOf(deps, serviceId);
  if (!hook?.remoteId || hook.error) return everyMs;
  if (hook.lastDeliveryAt && now - hook.lastDeliveryAt.getTime() < safetyNetMs) return null;
  return safetyNetMs;
}

export async function pollProviderBranches(deps: Deps, now = Date.now()): Promise<number> {
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
    const cadence = cadenceFor(deps, svc.id, now);
    if (cadence === null) continue;
    if (poll?.checkedAt && now - poll.checkedAt.getTime() < cadence - slackMs) continue;
    const sameBranch = poll?.branch === source.branch;
    const checkedAt = new Date(now);
    // Failed looks count too: a provider that refuses is not asked again before the next turn.
    const touch = () =>
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: source.branch, lastSha: null, checkedAt })
        .onConflictDoUpdate({ target: sourcePolls.serviceId, set: { checkedAt } })
        .run();
    try {
      const provider = loadProvider(deps.db, source.providerId);
      const client = clientFor(deps, provider);
      const head = await client.branchHead(source.repo, source.branch);
      if (!head) {
        touch();
        continue;
      }
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: source.branch, lastSha: head.sha, checkedAt })
        .onConflictDoUpdate({ target: sourcePolls.serviceId, set: { branch: source.branch, lastSha: head.sha, checkedAt } })
        .run();
      // The first look only records the head; a change after that is a push the webhook missed. It
      // deploys even while a deploy runs (after it, newest head wins): the head is recorded now, so a
      // push skipped here would never deploy.
      if (!sameBranch || !poll?.lastSha || poll.lastSha === head.sha) continue;
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
      touch();
      deps.logger.warn({ err: error, serviceId: svc.id }, "polling the provider branch failed");
    }
  }
  return deployed;
}

/** Every minute from a schedule (gitProviders/index.ts); each service is read at its own cadence. */
export const pollJob = defineJob<Record<string, never>>({
  type: pollJobType,
  maxAttempts: 1,
  async run(_payload, deps) {
    await repairHooks(deps);
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
