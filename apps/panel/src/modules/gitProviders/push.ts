// What a push or a merge/pull request does to the one service a provider
// webhook belongs to: deploy the followed branch (after [skip ci] and the
// watch paths), or open, update and close its preview. Used by the webhook
// route and by branch polling.
//
// The commit that gets built is never taken from the payload alone: it is
// the branch head the provider's API reports (a GitLab secret token says
// nothing about the body, and a leaked one must not be able to make the
// panel build any commit of the repository). A push while an earlier push
// deploy still waits joins that one (it builds the newer head), so pushes
// never pile up deploys behind the running one; a push while a deploy runs
// queues behind it (deployments/queue.ts queuePushDeploy). Merge requests are read
// from the API too, so a payload cannot claim a fork is not one.

import { skipMarkerOf } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { type GitProviderKind, previews, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { queuePushDeploy } from "../deployments/queue";
import { closePreview, openOrUpdatePreview } from "../previews/preview";
import type { ServiceRow } from "../services/rows";
import { readSpec } from "../services/spec";
import { firstLine, type PushChanges } from "../webhooks/changes";
import { recordDelivery } from "../webhooks/deliveries";
import { pushGate } from "../webhooks/gate";
import { type CommitInfo, isNullSha, type ProviderClient, providerLabels } from "./client";
import type { MergeRequestEvent } from "./events";
import { describeProviderError } from "./http";

export interface ProviderPush {
  branch: string;
  /** Head after the push as the payload (or the poll) says. */
  after: string | null;
  changes: PushChanges;
  author: string | null;
  sender: string | null;
  /** The payload's body is signed (Gitea, Bitbucket) or the head came from the API (polling). */
  trusted: boolean;
}

export interface Delivery {
  source: GitProviderKind;
  id: string;
  event: string;
}

type Outcome = "deployed" | "ignored" | "failed";

function recorder(deps: Pick<Deps, "db">, delivery: Delivery, serviceId: string) {
  return (outcome: Outcome, detail: string, deploymentId: string | null = null) => {
    recordDelivery(deps.db, {
      source: delivery.source,
      deliveryId: delivery.id,
      event: delivery.event,
      serviceId,
      outcome,
      detail,
      deploymentId,
    });
    return outcome;
  };
}

/** Deploys the service for a push to its branch, when everything says it should. */
export async function deployProviderPush(
  deps: Deps,
  svc: ServiceRow,
  client: ProviderClient,
  push: ProviderPush,
  delivery: Delivery,
): Promise<Outcome> {
  const record = recorder(deps, delivery, svc.id);
  const spec = readSpec(svc.spec);
  const source = spec.source;
  if (source.type !== "provider" || spec.preview) return record("ignored", "The service no longer deploys this repository.");
  if (push.branch !== source.branch)
    return record("ignored", `Branch ${push.branch} is not deployed (the service follows ${source.branch}).`);
  if (!source.deployOnPush) return record("ignored", "Deploy on push is off.");
  try {
    const label = providerLabels[client.kind];
    const gate = await pushGate({
      watchPaths: spec.watchPaths,
      changes: push.changes,
      compare: (before, after) => client.compare(source.repo, before, after),
      providerLabel: label,
    });
    if (!gate.deploy) return record("ignored", gate.detail);

    let head: CommitInfo | null = null;
    let lookup: string | null = null;
    try {
      head = await client.branchHead(source.repo, source.branch);
    } catch (error) {
      lookup = describeProviderError(error);
    }
    const notes = [...gate.logLines];
    let sha: string | null;
    if (head) {
      sha = head.sha;
      if (push.after && !isNullSha(push.after) && head.sha !== push.after)
        notes.push(`The branch moved on: deploying its head ${head.sha.slice(0, 7)} instead of the pushed ${push.after.slice(0, 7)}.`);
    } else if (push.trusted && push.after && !isNullSha(push.after)) {
      sha = push.after;
    } else {
      // The build resolves the branch head itself.
      sha = null;
      if (lookup) notes.push(`${label} did not say the branch head (${lookup.slice(0, 200)}); the build fetches it.`);
    }
    const remember = () => {
      if (!sha) return;
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: source.branch, lastSha: sha, checkedAt: new Date() })
        .onConflictDoUpdate({ target: sourcePolls.serviceId, set: { branch: source.branch, lastSha: sha, checkedAt: new Date() } })
        .run();
    };
    const commitMessage = firstLine(head?.message ?? push.changes.headMessage);
    const commitAuthor = head?.author ?? push.author;
    // Newest head wins: a push deploy that has not started yet builds this push instead.
    const queued = queuePushDeploy(deps, {
      serviceId: svc.id,
      actor: push.sender,
      commitSha: sha,
      commitMessage,
      commitAuthor,
      branch: source.branch,
      notes,
    });
    remember();
    const what = sha ? sha.slice(0, 7) : `the head of ${source.branch}`;
    switch (queued.kind) {
      case "same":
        return record("ignored", "A deploy of this commit was already queued.", queued.deployment.id);
      case "joined":
        return record("ignored", `A deploy was already queued; it builds ${what} now.`, queued.deployment.id);
      case "queued":
        return record(
          "deployed",
          sha ? `Deploying ${sha.slice(0, 7)} from ${source.branch}.` : `Deploying the head of ${source.branch}.`,
          queued.deployment.id,
        );
    }
  } catch (error) {
    return record("failed", error instanceof Error ? error.message : String(error));
  }
}

/** Opens, updates or closes the preview of a merge/pull request. */
export async function handleProviderMergeRequest(
  deps: Deps,
  svc: ServiceRow,
  client: ProviderClient,
  event: MergeRequestEvent,
  delivery: Delivery,
): Promise<Outcome> {
  const record = recorder(deps, delivery, svc.id);
  const spec = readSpec(svc.spec);
  const source = spec.source;
  if (source.type !== "provider" || spec.preview) return record("ignored", "The service no longer deploys this repository.");
  if (svc.kind !== "app" || svc.parentId) return record("ignored", "Only app services have previews.");
  if (event.action === "other") return record("ignored", `${event.event} needs nothing.`);
  if (!Number.isInteger(event.number) || event.number < 1) return record("ignored", "The delivery names no merge request.");
  try {
    if (!spec.previews.enabled && event.action !== "close") return record("ignored", "Previews are off for this service.");
    const mr = await client.mergeRequest(source.repo, event.number);
    // Closing is checked with the provider too: a payload alone does not remove a preview.
    if (mr.state !== "open") {
      const closed = await closePreview(deps, svc, mr.number);
      return record("ignored", closed ? `Preview of #${mr.number} removed.` : `#${mr.number} is not open.`);
    }
    if (event.action === "close") return record("ignored", `#${mr.number} is still open.`);
    if (mr.baseBranch !== source.branch) return record("ignored", `#${mr.number} targets ${mr.baseBranch}, not ${source.branch}.`);
    if (mr.headRepo.toLowerCase() !== source.repo.toLowerCase()) return record("ignored", "Requests from forks are not previewed.");
    const marker = skipMarkerOf(mr.title);
    if (marker) return record("ignored", `Skipped: the title says ${marker}.`);
    const existing = deps.db
      .select({ commitSha: previews.commitSha, previewServiceId: previews.previewServiceId })
      .from(previews)
      .where(and(eq(previews.serviceId, svc.id), eq(previews.prNumber, mr.number)))
      .get();
    if (event.action === "update" && existing?.previewServiceId && existing.commitSha === mr.headSha)
      return record("ignored", `#${mr.number} has no new commits.`);
    const result = await openOrUpdatePreview(
      deps,
      svc,
      { number: mr.number, title: mr.title, headBranch: mr.headBranch, headSha: mr.headSha, headRepo: mr.headRepo },
      event.sender,
    );
    if ("ignored" in result) return record("ignored", result.ignored);
    return record("deployed", result.detail, result.deployment.id);
  } catch (error) {
    return record("failed", error instanceof Error ? error.message : String(error));
  }
}
