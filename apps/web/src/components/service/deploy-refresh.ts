// How the screens that show a service's deploys stay current besides the
// live socket, which invalidates deployments.list on service:<id> whenever
// a deploy moves. An update the socket missed (it went silent before the
// panel's heartbeats noticed, or the tab was hidden while the deploy ended)
// must not leave an old deploy on screen: while a listed deploy moves the
// list polls (15 s with the socket up, 2 s while it is down), it refetches
// as soon as the tab is shown again (TanStack skips interval refetches
// while the tab is hidden), and the Overview's card also polls slowly
// while nothing moves, so it finds a deploy that started without it.

import { type DeploymentStatus, isActiveDeployment } from "./status";

/** Poll while a listed deploy is queued or running: with the live socket up, and while it is down. */
export const activePollMs = { up: 15_000, down: 2000 } as const;
/** The Overview card's poll while nothing moves. */
export const idlePollMs = { up: 60_000, down: 15_000 } as const;

/** The part of a deployments.list query these options read. */
interface ListQuery {
  state: { data: { deployments: readonly { status: DeploymentStatus }[] } | undefined };
}

export function hasActiveDeploy(data: ListQuery["state"]["data"]): boolean {
  return data?.deployments.some((d) => isActiveDeployment(d.status)) ?? false;
}

/**
 * refetchInterval and refetchOnWindowFocus for a deployments.list query.
 * idle: also poll (idlePollMs) and refetch on every show while nothing
 * moves; otherwise a list with nothing moving refetches on a show only once
 * its data is stale (30 s).
 */
export function deployListRefresh(liveUp: boolean, idle = false) {
  return {
    refetchInterval: (query: ListQuery): number | false =>
      hasActiveDeploy(query.state.data)
        ? liveUp
          ? activePollMs.up
          : activePollMs.down
        : idle
          ? liveUp
            ? idlePollMs.up
            : idlePollMs.down
          : false,
    refetchOnWindowFocus: (query: ListQuery): boolean | "always" => (idle || hasActiveDeploy(query.state.data) ? "always" : true),
  };
}
