// Commit statuses back to the provider: each deploy of a service with a
// provider source (push deploys, previews, manual ones of a known commit)
// shows as a check on the commit, and so on its merge or pull request:
// pending while queued, running while it builds and rolls out, then
// success or failed. Optional per connection (statusNotes). One job per
// deployment posts whatever the deployment's state is when it runs and
// repeats until nothing changed, so states never arrive out of order.

import { slug } from "@seylo/brand";
import { eq } from "drizzle-orm";
import { deployments, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import type { DeploymentRow } from "../deployments/store";
import { panelBaseUrl } from "../github/app";
import { readSpec } from "../services/spec";
import { type CommitStatusState, clientFor } from "./client";
import { loadProvider } from "./rows";

export const commitStatusJobType = "gitProviders.commitStatus";

/** The status a deployment shows, or null for states that post nothing. */
export function statusFor(row: Pick<DeploymentRow, "status">): CommitStatusState | null {
  switch (row.status) {
    case "queued":
      return "pending";
    case "building":
    case "deploying":
      return "running";
    case "live":
      return "success";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

const descriptions: Record<CommitStatusState, string> = {
  pending: "Deploy queued",
  running: "Building and deploying",
  success: "Deployed",
  failed: "Deploy failed",
  cancelled: "Deploy cancelled",
};

/** What was posted per deployment (bounded; a panel restart posts the current state once more). */
const posted = new WeakMap<object, Map<string, string>>();
function postedFor(deps: Pick<Deps, "db">): Map<string, string> {
  let map = posted.get(deps.db);
  if (!map) {
    map = new Map();
    posted.set(deps.db, map);
  }
  if (map.size > 2000) map.delete(map.keys().next().value as string);
  return map;
}

/** Deployment listener: queues a status post when a provider deploy of a known commit changes state. */
export function observeDeployment(deps: Pick<Deps, "db" | "jobs">, row: DeploymentRow): void {
  const state = statusFor(row);
  if (!state || !row.commitSha) return;
  if (postedFor(deps).get(row.id) === `${state}:${row.commitSha}`) return;
  const svc = deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, row.serviceId)).get();
  if (!svc || readSpec(svc.spec).source.type !== "provider") return;
  deps.jobs.enqueue(commitStatusJobType, { deploymentId: row.id }, { dedupeKey: `${commitStatusJobType}:${row.id}` });
}

/** Posts the deployment's current state; loops while it keeps changing (at most a few times). */
export async function postCommitStatus(deps: Deps, deploymentId: string): Promise<number> {
  let sent = 0;
  for (let round = 0; round < 5; round++) {
    const row = deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
    const state = row ? statusFor(row) : null;
    if (!row || !state || !row.commitSha) return sent;
    const key = `${state}:${row.commitSha}`;
    const done = postedFor(deps);
    if (done.get(row.id) === key) return sent;
    const svc = deps.db.select().from(services).where(eq(services.id, row.serviceId)).get();
    if (!svc) return sent;
    const source = readSpec(svc.spec).source;
    if (source.type !== "provider") return sent;
    let provider: ReturnType<typeof loadProvider>;
    try {
      provider = loadProvider(deps.db, source.providerId);
    } catch {
      return sent;
    }
    if (!provider.statusNotes) {
      done.set(row.id, key);
      return sent;
    }
    const base = panelBaseUrl(deps.db);
    await clientFor(deps, provider).setStatus(source.repo, row.commitSha, {
      state,
      context: `${slug}/${svc.name}`,
      description: state === "failed" && row.error ? `Deploy failed: ${row.error}` : descriptions[state],
      targetUrl: base ? `${base}/p/${svc.projectId}/s/${svc.id}/deployments` : null,
    });
    done.set(row.id, key);
    sent++;
  }
  return sent;
}

export const commitStatusJob = defineJob<{ deploymentId: string }>({
  type: commitStatusJobType,
  // A status is a courtesy: a provider that refuses (token without the scope) is not retried for long.
  maxAttempts: 3,
  async run(payload, deps) {
    await postCommitStatus(deps, payload.deploymentId);
  },
});
