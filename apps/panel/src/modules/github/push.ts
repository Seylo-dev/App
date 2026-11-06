// What a push or pull request does: deploy the services that follow the
// branch, open/update/close PR previews. Used by the webhook route and by
// the polling fallback.

import { sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { services, sourcePolls } from "../../db/schema";
import type { Deps } from "../../deps";
import { queueDeploy } from "../deployments/queue";
import { closePreview, openOrUpdatePreview, type PullRequestInfo } from "../previews/preview";
import type { ServiceRow } from "../services/rows";
import { readSpec } from "../services/spec";
import { recordDelivery } from "../webhooks/deliveries";

export interface PushInfo {
  repo: string;
  branch: string;
  sha: string;
  message: string | null;
  author: string | null;
  /** GitHub login of who pushed. */
  sender: string | null;
}

/** Services (and stacks) whose GitHub source is this repo, any branch. */
export function servicesForRepo(db: PanelDb, repo: string): ServiceRow[] {
  const sourceRepo = sql<string | null>`lower(json_extract(${services.spec}, '$.source.repo'))`;
  const stackRepo = sql<string | null>`lower(json_extract(${services.spec}, '$.stack.source.repo'))`;
  const key = repo.toLowerCase();
  return db
    .select()
    .from(services)
    .where(
      sql`(${sourceRepo} = ${key} and json_extract(${services.spec}, '$.source.type') = 'github') or (${stackRepo} = ${key} and json_extract(${services.spec}, '$.stack.source.type') = 'github')`,
    )
    .all();
}

export type StackRefresher = (
  deps: Deps,
  stack: ServiceRow,
  push: PushInfo,
) => Promise<{ outcome: "deployed" | "ignored" | "failed"; detail: string }>;

/** Set by the compose module at start, so a push re-reads stacks' compose files. */
let refreshStack: StackRefresher | null = null;
export function setStackRefresher(fn: StackRefresher): void {
  refreshStack = fn;
}

export async function handlePush(deps: Deps, push: PushInfo, delivery: { id: string; event: string; source: "github" }): Promise<number> {
  let deployed = 0;
  const matches = servicesForRepo(deps.db, push.repo);
  if (matches.length === 0) {
    recordDelivery(deps.db, {
      ...delivery,
      deliveryId: delivery.id,
      serviceId: null,
      outcome: "ignored",
      detail: `No service deploys ${push.repo}.`,
    });
    return 0;
  }
  for (const svc of matches) {
    const spec = readSpec(svc.spec);
    const record = (outcome: "deployed" | "ignored" | "failed", detail: string, deploymentId: string | null = null) =>
      recordDelivery(deps.db, {
        source: delivery.source,
        deliveryId: delivery.id,
        event: delivery.event,
        serviceId: svc.id,
        outcome,
        detail,
        deploymentId,
      });
    try {
      if (svc.kind === "compose") {
        const source = spec.stack?.source;
        if (source?.type !== "github") continue;
        if (source.branch !== push.branch) {
          record("ignored", `Branch ${push.branch} is not deployed (the stack follows ${source.branch}).`);
          continue;
        }
        if (!source.deployOnPush) {
          record("ignored", "Deploy on push is off.");
          continue;
        }
        if (!refreshStack) {
          record("failed", "Compose stacks cannot be refreshed yet.");
          continue;
        }
        const result = await refreshStack(deps, svc, push);
        record(result.outcome, result.detail);
        if (result.outcome === "deployed") deployed++;
        continue;
      }
      if (spec.source.type !== "github" || spec.preview) continue;
      if (spec.source.branch !== push.branch) {
        record("ignored", `Branch ${push.branch} is not deployed (the service follows ${spec.source.branch}).`);
        continue;
      }
      if (!spec.source.deployOnPush) {
        record("ignored", "Deploy on push is off.");
        continue;
      }
      const d = queueDeploy(deps, {
        serviceId: svc.id,
        trigger: "push",
        actor: push.sender,
        commitSha: push.sha,
        commitMessage: push.message,
        commitAuthor: push.author,
        branch: push.branch,
      });
      deps.db
        .insert(sourcePolls)
        .values({ serviceId: svc.id, branch: push.branch, lastSha: push.sha, checkedAt: new Date() })
        .onConflictDoUpdate({ target: sourcePolls.serviceId, set: { branch: push.branch, lastSha: push.sha, checkedAt: new Date() } })
        .run();
      record("deployed", `Deploying ${push.sha.slice(0, 7)} from ${push.branch}.`, d.id);
      deployed++;
    } catch (error) {
      record("failed", error instanceof Error ? error.message : String(error));
    }
  }
  return deployed;
}

export async function handlePullRequest(
  deps: Deps,
  action: string,
  baseRepo: string,
  baseBranch: string,
  pr: PullRequestInfo,
  sender: string | null,
  delivery: { id: string; event: string },
): Promise<void> {
  const matches = servicesForRepo(deps.db, baseRepo).filter((s) => s.kind === "app");
  for (const svc of matches) {
    const spec = readSpec(svc.spec);
    if (spec.source.type !== "github" || spec.preview) continue;
    const record = (outcome: "deployed" | "ignored" | "failed", detail: string, deploymentId: string | null = null) =>
      recordDelivery(deps.db, {
        source: "github",
        deliveryId: delivery.id,
        event: delivery.event,
        serviceId: svc.id,
        outcome,
        detail,
        deploymentId,
      });
    try {
      if (spec.source.branch !== baseBranch) {
        record("ignored", `The pull request targets ${baseBranch}, not ${spec.source.branch}.`);
        continue;
      }
      if (action === "closed") {
        const closed = await closePreview(deps, svc, pr.number);
        record("ignored", closed ? `Preview of PR #${pr.number} removed.` : "No preview to remove.");
        continue;
      }
      if (!["opened", "reopened", "synchronize", "edited"].includes(action)) {
        record("ignored", `Pull request action ${action} needs nothing.`);
        continue;
      }
      if (action === "edited") continue;
      const result = await openOrUpdatePreview(deps, svc, pr, sender);
      if ("ignored" in result) record("ignored", result.ignored);
      else record("deployed", result.detail, result.deployment.id);
    } catch (error) {
      record("failed", error instanceof Error ? error.message : String(error));
    }
  }
}
