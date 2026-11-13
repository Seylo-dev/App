// What the Overview's Deploys card shows (owner request, 0.2.16). With a
// deploy in progress or waiting: that one, with its step strip (a Queued
// step first while its build waits for a slot), and under it, on one
// compact line, the deploy that is live now (or the newest finished one
// when none of the listed ones is live). With nothing in progress: the
// newest deploy, and "Live: ..." when the live one is another.
//
// The deploy in progress is the oldest queued or running one, as the
// panel runs them (pushes queue behind it). It comes from the card's
// newest deploys and from the header's active query (useActiveDeploy):
// that one also finds a deploy older than the card's few rows, and a new
// one the card's list does not hold yet. A row the list holds wins over
// the active query's copy of it, so a list that already says "Live" is
// never put back to "Building" by the other answer.

import type { Deployment } from "../deploy-steps";
import { isActiveDeployment } from "../status";

export interface LatestDeployView {
  /** The deploy the card is about: the one in progress or waiting, else the newest. */
  main: Deployment;
  /** main is queued or running. */
  inProgress: boolean;
  /** Listed deploys queued behind main. */
  queuedBehind: number;
  /** In progress: the live deploy, or the newest finished one. Otherwise: the live one when it is not main. */
  other: Deployment | null;
}

const createdBefore = (a: Deployment, b: Deployment) => {
  const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return at !== 0 ? at < 0 : a.id < b.id;
};

/** rows: the newest deploys, newest first (deployments.list); active: the deploy in progress per useActiveDeploy. */
export function latestDeployView(rows: readonly Deployment[], active: Deployment | null): LatestDeployView | null {
  const moving = rows.filter((d) => isActiveDeployment(d.status));
  if (active && isActiveDeployment(active.status) && !rows.some((d) => d.id === active.id)) moving.push(active);
  if (moving.length > 0) {
    const main = moving.reduce((oldest, d) => (createdBefore(d, oldest) ? d : oldest));
    const other = rows.find((d) => d.live) ?? rows.find((d) => !isActiveDeployment(d.status)) ?? null;
    return { main, inProgress: true, queuedBehind: moving.length - 1, other };
  }
  const main = rows[0];
  if (!main) return null;
  const live = rows.find((d) => d.live);
  return { main, inProgress: false, queuedBehind: 0, other: live && live.id !== main.id ? live : null };
}
