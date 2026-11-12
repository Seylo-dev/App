// Commit statuses back to the provider: each deploy of a service with a
// provider source (push deploys, previews, manual ones of a known commit)
// shows as a check on the commit, and so on its merge or pull request:
// pending while queued and while its build waits for a free slot of its
// node's Builds at once, running while it builds and rolls out, then
// success or failed. Optional per connection (statusNotes). One job per
// deployment posts whatever the deployment's state is when it runs and
// repeats until nothing changed, so states never arrive out of order.
// Descriptions are fixed texts: every collaborator of the repository sees
// them, and a deploy's error can name nodes and builder output that only
// panel members should read (the target URL leads there). A queued deploy
// that a newer push took over marks its old commit as superseded.

import { slug } from "@seylo/brand";
import { eq } from "drizzle-orm";
import { deployments, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { waitingBuilds } from "../builds/slots";
import type { DeploymentRow } from "../deployments/store";
import { panelBaseUrl } from "../github/app";
import { readSpec } from "../services/spec";
import { type CommitStatusState, clientFor } from "./client";
import { loadProvider } from "./rows";

export const commitStatusJobType = "gitProviders.commitStatus";

/**
 * Where a deployment stands for its commit status: its state, or "waiting"
 * while it builds but its build waits for a free build slot on its node
 * (builds/slots.ts, Deployment.buildWait), which posts as pending.
 */
export type StatusPhase = CommitStatusState | "waiting";

/** The phase a deployment shows, or null for states that post nothing. */
export function statusFor(row: Pick<DeploymentRow, "status">, buildWaiting = false): StatusPhase | null {
  switch (row.status) {
    case "queued":
      return "pending";
    case "building":
      return buildWaiting ? "waiting" : "running";
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

/** What each phase posts. */
const statusPosts: Record<StatusPhase, { state: CommitStatusState; description: string }> = {
  pending: { state: "pending", description: "Deploy queued" },
  waiting: { state: "pending", description: "Waiting for a build slot" },
  running: { state: "running", description: "Building and deploying" },
  success: { state: "success", description: "Deployed" },
  failed: { state: "failed", description: "Deploy failed" },
  cancelled: { state: "cancelled", description: "Deploy cancelled" },
};

/** The deployment's phase now: a building one asks the build queue whether its build waits. */
function phaseOf(deps: Pick<Deps, "db">, row: DeploymentRow): StatusPhase | null {
  return statusFor(row, row.status === "building" && waitingBuilds(deps.db, [row.id]).has(row.id));
}

const supersededDescription = "Superseded by a newer push";

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

/** What was shown for a deployment: "<state>:<sha>". */
function shownOf(deps: Pick<Deps, "db">, deploymentId: string): { key: string; state: string; sha: string } | null {
  const key = postedFor(deps).get(deploymentId);
  if (!key) return null;
  const at = key.indexOf(":");
  return { key, state: key.slice(0, at), sha: key.slice(at + 1) };
}

/** The key a deployment shows now ("<phase>:<sha>"), or null when it shows nothing. */
function keyOf(phase: StatusPhase | null, row: DeploymentRow): string | null {
  return phase && row.commitSha ? `${phase}:${row.commitSha}` : null;
}

/** A queued deploy that a newer push took over: the commit it showed as queued is not deployed by it any more. */
function supersededSha(row: DeploymentRow, shown: { state: string; sha: string } | null): string | null {
  return shown?.state === "pending" && shown.sha !== row.commitSha ? shown.sha : null;
}

/** Deployment listener: queues a status post when a provider deploy of a known commit changes state. */
export function observeDeployment(deps: Pick<Deps, "db" | "jobs">, row: DeploymentRow): void {
  const key = keyOf(phaseOf(deps, row), row);
  const shown = shownOf(deps, row.id);
  if (key === null ? !supersededSha(row, shown) : shown?.key === key) return;
  const svc = deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, row.serviceId)).get();
  if (!svc || readSpec(svc.spec).source.type !== "provider") return;
  deps.jobs.enqueue(commitStatusJobType, { deploymentId: row.id }, { dedupeKey: `${commitStatusJobType}:${row.id}` });
}

/**
 * Posts the deployment's current state; loops while it keeps changing (at
 * most a few times). A commit shown as queued that the deployment no longer
 * builds (a newer push took the deploy over) is marked superseded first.
 */
export async function postCommitStatus(deps: Deps, deploymentId: string): Promise<number> {
  let sent = 0;
  for (let round = 0; round < 5; round++) {
    const row = deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
    if (!row) return sent;
    const phase = phaseOf(deps, row);
    const key = keyOf(phase, row);
    const done = postedFor(deps);
    const shown = shownOf(deps, row.id);
    const superseded = supersededSha(row, shown);
    if (!superseded && (key === null || shown?.key === key)) return sent;
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
    const remember = () => (key ? done.set(row.id, key) : done.delete(row.id));
    if (!provider.statusNotes) {
      remember();
      return sent;
    }
    const client = clientFor(deps, provider);
    const base = { context: `${slug}/${svc.name}`, targetUrl: targetUrlFor(deps, svc) };
    if (superseded) {
      await client.setStatus(source.repo, superseded, { ...base, state: "cancelled", description: supersededDescription });
      sent++;
    }
    if (key && phase && row.commitSha) {
      // Never the deploy's error: the repository's collaborators are not necessarily panel members.
      await client.setStatus(source.repo, row.commitSha, { ...base, ...statusPosts[phase] });
      sent++;
    }
    remember();
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

/** Where a status links to: the service's deployments, when the panel has a public address. */
function targetUrlFor(deps: Pick<Deps, "db">, svc: { id: string; projectId: string }): string | null {
  const base = panelBaseUrl(deps.db);
  return base ? `${base}/p/${svc.projectId}/s/${svc.id}/deployments` : null;
}
