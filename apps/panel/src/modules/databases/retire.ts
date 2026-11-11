// The separate exposed user of a database from before 0.2.9 ("external"),
// which the agent disables once (DatabaseSpec.retired_exposed_user). A
// deployment's env is sealed when it starts (env/desired.ts
// sealDeploymentEnv), so a service that used ${{db.EXPOSED_URL}} keeps the
// old user's URL until it deploys again: the old user is named for
// retirement only once no running service's live or target deployment
// carries its password. A retirement a compile held back goes out without
// waiting for the node's next full sync: whenever a deployment goes live or
// a service is stopped or deleted, in any project, and every minute
// (databases.retirements), releaseHeldRetirements checks those databases
// again and sends the ones nothing holds any more.

import { eq, or } from "drizzle-orm";
import { deployments, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { type CompileMemo, compileMemo } from "../../desired/contributors";
import { onDeploymentChange } from "../deployments/store";
import { deploymentEnv } from "../env/desired";
import { type DatabaseInfo, findDatabase, loadDatabase, readSecret, retiredExposedPasswordSecret } from "./info";

/**
 * The values of every live and target deployment's env of the services
 * that run: what their containers run with. A stopped service runs none
 * (it starts again with the env it deployed with).
 */
function runningEnvValues(deps: Pick<Deps, "db" | "secrets">): string[] {
  const rows = deps.db
    .selectDistinct({ id: deployments.id, envSealed: deployments.envSealed })
    .from(deployments)
    .innerJoin(services, or(eq(services.liveDeploymentId, deployments.id), eq(services.targetDeploymentId, deployments.id)))
    .where(eq(services.stopped, false))
    .all();
  return rows.flatMap((r) => (deploymentEnv(deps, r.envSealed) ?? []).map((v) => v.value ?? ""));
}

/**
 * The old exposed user, "" when there is none (Redis-like engines have one
 * user; never the admin), and whether a running service still has its
 * password, as it is or in a URL. One scan of the deployments per memo.
 */
function retirement(deps: Pick<Deps, "db" | "secrets">, info: DatabaseInfo, memo?: CompileMemo): { user: string; held: boolean } {
  const user = info.row.exposedUser;
  if (!user || info.engine.redisLike || user === info.admin.user) return { user: "", held: false };
  const password = readSecret(deps, info.service.id, retiredExposedPasswordSecret);
  if (!password) return { user, held: false };
  const values = memo ? memo.get("running-deployment-env", () => runningEnvValues(deps)) : runningEnvValues(deps);
  const encoded = encodeURIComponent(password);
  return { user, held: values.some((v) => v.includes(password) || v.includes(encoded)) };
}

/** Per panel: the databases whose last compiled spec held their old user's retirement back. */
const heldBack = new WeakMap<object, Set<string>>();

function heldBackOf(db: object): Set<string> {
  let set = heldBack.get(db);
  if (!set) {
    set = new Set();
    heldBack.set(db, set);
  }
  return set;
}

/**
 * The old exposed user for the agent to retire, "" when there is none or
 * while a running service still has its password. One scan of the
 * deployments per compile (memo). Remembers a held one for
 * releaseHeldRetirements.
 */
export function retiredExposedUser(deps: Pick<Deps, "db" | "secrets">, info: DatabaseInfo, memo?: CompileMemo): string {
  const { user, held } = retirement(deps, info, memo);
  if (held) heldBackOf(deps.db).add(info.service.id);
  else heldBackOf(deps.db).delete(info.service.id);
  return held ? "" : user;
}

/**
 * Marks dirty the databases whose last compiled spec held their old user's
 * retirement back and that no running service holds any more, so the
 * agent gets it now (the kind spec is not part of the container, so
 * nothing restarts). A database is marked once per release: the compile
 * that follows remembers it again only if it is held again, and a node
 * that is offline gets it with its full sync on connect. With nothing
 * held back this reads nothing. Never throws. Returns the marked database
 * ids.
 */
export function releaseHeldRetirements(deps: Pick<Deps, "db" | "secrets" | "agents" | "logger">): string[] {
  const held = heldBack.get(deps.db);
  if (!held || held.size === 0) return [];
  const memo = compileMemo();
  const released: string[] = [];
  for (const serviceId of [...held]) {
    try {
      const deleted = !findDatabase(deps.db, serviceId);
      if (!deleted && retirement(deps, loadDatabase(deps, serviceId), memo).held) continue;
      held.delete(serviceId);
      if (deleted) continue;
      released.push(serviceId);
      deps.agents.desired.markDirty({ serviceId });
    } catch (error) {
      deps.logger.warn({ err: error, serviceId }, "checking a held exposed user retirement failed");
    }
  }
  return released;
}

/** Once a deployment is live anywhere, the retirements it may have released go out (releaseHeldRetirements). */
export function watchRetirements(deps: Deps): void {
  onDeploymentChange(deps.db, (row) => {
    if (row.status === "live") releaseHeldRetirements(deps);
  });
}
