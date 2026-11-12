// GIT_SHA (0.2.14): a deployment built from a repository runs with the full
// id of the commit its image was built from, as on Easypanel. The node
// passes the same commit to the build (go/internal/build withGitSHA); this
// side puts it in the env the deployment's containers get. It is sealed
// into the deployment's env (deployments.envSealed) while the deployment
// builds, once the commit is known, so it follows the deployment: a restart
// keeps it, a rollback or a move to another project runs with the commit
// of the deployment whose image it runs again, and a deployment from
// before keeps the env it had, so no running app is recreated for it when
// the panel updates.

import { eq } from "drizzle-orm";
import { deployments } from "../../db/schema";
import type { Deps } from "../../deps";
import type { DeploymentRow } from "../deployments/store";

export const gitShaVar = "GIT_SHA";

/** A full commit id: 40 hex characters (SHA-1), or 64 in a SHA-256 repository. */
const fullCommitRe = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One variable of a sealed deployment env; builtCommit marks the GIT_SHA sealGitSha added. */
interface SealedVar {
  name: string;
  value: string;
  secret?: boolean;
  builtCommit?: boolean;
}

function openVars(deps: Pick<Deps, "secrets">, envSealed: string | null): SealedVar[] | null {
  if (!envSealed) return null;
  const text = deps.secrets.open(envSealed, "deployment.env");
  if (text === null) return null;
  try {
    const vars = JSON.parse(text) as SealedVar[];
    return Array.isArray(vars) ? vars : null;
  } catch {
    return null;
  }
}

/**
 * A sealed deployment env with GIT_SHA=<commit> added, unless it has a
 * GIT_SHA already: the service's own .env or the project's shared
 * variables set one, and theirs wins, also an empty one. The entry is
 * marked as the built commit (builtCommit), so a rollback can tell it from
 * a GIT_SHA of the service's own; deploymentEnv drops the mark, and
 * containers get a plain GIT_SHA.
 */
export function sealGitSha(deps: Pick<Deps, "secrets">, envSealed: string, commit: string): string {
  const vars = openVars(deps, envSealed);
  if (!vars || !fullCommitRe.test(commit) || vars.some((v) => v.name === gitShaVar)) return envSealed;
  return deps.secrets.seal(
    JSON.stringify([...vars, { name: gitShaVar, value: commit, secret: false, builtCommit: true }]),
    "deployment.env",
  );
}

/**
 * The commit sealGitSha put into a deployment's env, the one its image was
 * built from; null when it has none: not built from a repository (an
 * image, an upload, an inline Dockerfile), a GIT_SHA of the service's own
 * won, or the deployment is from before 0.2.14.
 */
export function builtCommit(deps: Pick<Deps, "secrets">, envSealed: string | null): string | null {
  const entry = openVars(deps, envSealed)?.find((v) => v.name === gitShaVar && v.builtCommit === true);
  return entry && fullCommitRe.test(entry.value) ? entry.value : null;
}

/**
 * Seals GIT_SHA into a building deployment's env once the commit its
 * build checks out is known in full: from the panel's own lookup (GitHub,
 * a provider connection, a branch the panel could list) and from the
 * node's BuildSourceInfo, which every agent sends for git sources (also
 * 0.2.11 to 0.2.13, which pass no GIT_SHA to the build itself), and from
 * the successful build result (BuildProgress.commit, agents from 0.2.14)
 * when the stream with BuildSourceInfo was lost. Only while it builds:
 * once a deployment rolls out its env is what its containers run, and a
 * late report must not change it.
 */
export function recordBuiltCommit(deps: Pick<Deps, "db" | "secrets">, deploymentId: string, commit: string): void {
  if (!fullCommitRe.test(commit)) return;
  const row = deps.db
    .select({ status: deployments.status, envSealed: deployments.envSealed })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .get();
  if (row?.status !== "building" || !row.envSealed) return;
  const next = sealGitSha(deps, row.envSealed, commit);
  if (next !== row.envSealed) deps.db.update(deployments).set({ envSealed: next }).where(eq(deployments.id, deploymentId)).run();
}

/**
 * The deployment whose image `d` runs again, without a build of its own: a
 * rollback's target, or the live deployment a move to another project
 * switches (its env is sealed afresh in the new project). Null for the
 * rest, which build or copy the live env (a move between nodes).
 */
export function reusedImageOf(d: Pick<DeploymentRow, "rollbackOf" | "projectMove">): string | null {
  return d.rollbackOf ?? d.projectMove?.fromDeploymentId ?? null;
}

/**
 * The env a deployment that runs an older image again starts with (a
 * rollback, a move to another project): the service's env now, plus
 * GIT_SHA of the deployment whose image it runs (a GIT_SHA of the
 * service's own still wins). That one may have run an image again too,
 * with its own GIT_SHA winning: then the one it ran again says. Other
 * deployments get theirs from their build.
 */
export function withReusedCommit(deps: Pick<Deps, "db" | "secrets">, from: string | null, envSealed: string): string {
  let next = from;
  for (let hops = 0; next && hops < 50; hops++) {
    const target = deps.db
      .select({ envSealed: deployments.envSealed, rollbackOf: deployments.rollbackOf, projectMove: deployments.projectMove })
      .from(deployments)
      .where(eq(deployments.id, next))
      .get();
    const commit = builtCommit(deps, target?.envSealed ?? null);
    if (commit) return sealGitSha(deps, envSealed, commit);
    next = target ? reusedImageOf(target) : null;
  }
  return envSealed;
}
