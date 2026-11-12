// The image's own HEALTHCHECK as the nodes report it (agents from 0.2.14):
// a rollout gated on it (HealthCheck.image) sends the check and how long it
// waits with DEPLOY_STAGE_HEALTH_CHECKING, and the check again with its
// final result. The panel keeps both in the node's result, waits as long as
// the node does before it fails the rollout itself, and shows the check on
// the service's health check card.

import { durationMs } from "@bufbuild/protobuf/wkt";
import type { DeployProgress } from "@seylo/proto";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type DeployNodeResult, deployments, type StoredImageHealthCheck, type services } from "../../db/schema";

const secondsOf = (d: Parameters<typeof durationMs>[0] | undefined) => (d ? durationMs(d) / 1000 : 0);

/** What a DeployProgress adds to its node's result: the image check and the wait, when it carries them. */
export function reportedHealth(progress: DeployProgress): Pick<DeployNodeResult, "imageHealthCheck" | "healthWaitSeconds"> {
  const out: Pick<DeployNodeResult, "imageHealthCheck" | "healthWaitSeconds"> = {};
  const c = progress.imageHealthCheck;
  if (c && c.test.length > 0) {
    out.imageHealthCheck = {
      test: [...c.test],
      intervalSeconds: secondsOf(c.interval),
      timeoutSeconds: secondsOf(c.timeout),
      startPeriodSeconds: secondsOf(c.startPeriod),
      retries: c.retries,
    };
  }
  if (progress.healthTimeout) out.healthWaitSeconds = Math.ceil(secondsOf(progress.healthTimeout));
  return out;
}

/** The longest health wait a target node reported, in ms (0 when none did). */
export function reportedWaitMs(results: Record<string, DeployNodeResult>): number {
  return Math.max(0, ...Object.values(results).map((r) => (r.healthWaitSeconds ?? 0) * 1000));
}

/**
 * The image HEALTHCHECK a service's nodes reported for its live deployment,
 * else for the one rolling out (its target), or null.
 */
export function serviceImageHealthCheck(
  db: PanelDb,
  svc: Pick<typeof services.$inferSelect, "liveDeploymentId" | "targetDeploymentId">,
): StoredImageHealthCheck | null {
  for (const id of [svc.liveDeploymentId, svc.targetDeploymentId]) {
    if (!id) continue;
    const row = db.select({ nodeResults: deployments.nodeResults }).from(deployments).where(eq(deployments.id, id)).get();
    const found = Object.values(row?.nodeResults ?? {}).find((r) => r.imageHealthCheck)?.imageHealthCheck;
    if (found) return found;
  }
  return null;
}
