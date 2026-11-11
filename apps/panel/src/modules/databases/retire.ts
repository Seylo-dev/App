// The separate exposed user of a database from before 0.2.9 ("external"),
// which the agent disables once (DatabaseSpec.retired_exposed_user). A
// deployment's env is sealed when it starts (env/desired.ts
// sealDeploymentEnv), so a service that used ${{db.EXPOSED_URL}} keeps the
// old user's URL until it deploys again: the old user is named for
// retirement only once no service's live or target deployment carries its
// password, and a deployment going live in a project sends that project's
// databases with an old user again (watchRetirements).

import { and, eq, ne, or } from "drizzle-orm";
import { deployments, serviceDatabases, services } from "../../db/schema";
import type { Deps } from "../../deps";
import type { CompileMemo } from "../../desired/contributors";
import { onDeploymentChange } from "../deployments/store";
import { deploymentEnv } from "../env/desired";
import { type DatabaseInfo, readSecret, retiredExposedPasswordSecret } from "./info";

/** The values of every live and target deployment's env: what the services' containers run with. */
function runningEnvValues(deps: Pick<Deps, "db" | "secrets">): string[] {
  const rows = deps.db
    .selectDistinct({ id: deployments.id, envSealed: deployments.envSealed })
    .from(deployments)
    .innerJoin(services, or(eq(services.liveDeploymentId, deployments.id), eq(services.targetDeploymentId, deployments.id)))
    .all();
  return rows.flatMap((r) => (deploymentEnv(deps, r.envSealed) ?? []).map((v) => v.value));
}

/**
 * The old exposed user for the agent to retire, "" when there is none
 * (Redis-like engines have one user; never the admin) or while a running
 * service still has its password, as it is or in a URL. One scan of the
 * deployments per compile (memo).
 */
export function retiredExposedUser(deps: Pick<Deps, "db" | "secrets">, info: DatabaseInfo, memo?: CompileMemo): string {
  const user = info.row.exposedUser;
  if (!user || info.engine.redisLike || user === info.admin.user) return "";
  const password = readSecret(deps, info.service.id, retiredExposedPasswordSecret);
  if (!password) return user;
  const values = memo ? memo.get("running-deployment-env", () => runningEnvValues(deps)) : runningEnvValues(deps);
  const encoded = encodeURIComponent(password);
  return values.some((v) => v.includes(password) || v.includes(encoded)) ? "" : user;
}

/**
 * Once a deployment is live, its project's databases with an old exposed
 * user get their spec again, so a retirement it held goes out without
 * waiting for the node's next full sync (the kind spec is not part of the
 * container, so nothing restarts).
 */
export function watchRetirements(deps: Deps): void {
  onDeploymentChange(deps.db, (row) => {
    if (row.status !== "live") return;
    const project = deps.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, row.serviceId)).get();
    if (!project) return;
    const withOldUser = deps.db
      .select({ serviceId: serviceDatabases.serviceId })
      .from(serviceDatabases)
      .innerJoin(services, eq(services.id, serviceDatabases.serviceId))
      .where(and(eq(services.projectId, project.projectId), ne(serviceDatabases.exposedUser, "")))
      .all();
    for (const r of withOldUser) deps.agents.desired.markDirty({ serviceId: r.serviceId });
  });
}
