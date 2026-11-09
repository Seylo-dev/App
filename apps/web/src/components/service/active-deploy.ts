// The service's deploy that is in progress, for the buttons that start one.
// The panel runs one deploy of a service at a time and refuses Deploy,
// Redeploy and Roll back while one is queued or running, so those buttons
// wait for it instead of failing. Pushes still queue behind a running
// deploy; the one in progress is the oldest queued or running one, which
// deployments.list with active: true answers first, however many newer
// deploys there are.

import { deployments } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import type { Deployment } from "./deploy-steps";
import { retryOp } from "./op-state";
import { isActiveDeployment } from "./status";

/**
 * The deploy of the service in progress, or null. `enabled`: false for
 * services that never deploy (databases, the panel). Every screen asks the
 * same query, so it is one request; deploy, cancel and the service's live
 * events refresh it with the rest of deployments.list.
 */
export function useActiveDeploy(serviceId: string, enabled = true): Deployment | null {
  const active = useOp(deployments.list, { serviceId, active: true, limit: 1 }, { enabled, retry: retryOp });
  return active.data?.deployments.find((d) => isActiveDeployment(d.status)) ?? null;
}
