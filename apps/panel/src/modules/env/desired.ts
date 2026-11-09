// The environment a service's containers get (ServiceSpec.env): the
// project's shared variables first, then the service's own .env with
// ${{svc.VAR}} references resolved (own keys win), and for databases the
// engine variables that create the first user (they win over both); Boxes
// get BOX_REPOSITORY.
// Unresolvable references stay as written so the problem shows in the app.

import type { MessageInitShape } from "@bufbuild/protobuf";
import { sharedTarget } from "@seylo/env-analyzer";
import type { EnvVarSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import { boxEnv } from "../boxes/desired";
import { containerEnv } from "../databases/engines";
import { findDatabase, loadDatabase } from "../databases/info";
import { databaseKinds, getService } from "../domains/lookup";
import { readSpec, type ServiceSpecJson } from "../services/spec";
import { buildEnvGraph, type EnvGraph } from "./graph";

type EnvVar = MessageInitShape<typeof EnvVarSchema>;

/**
 * The resolved env sealed for a deployment row (deployments.envSealed),
 * which the desired-state compile hands the deployment's containers, with
 * PORT for apps built from a repository (withPortEnv).
 */
export function sealDeploymentEnv(deps: Pick<Deps, "db" | "secrets">, serviceId: string): string {
  const service = getService(deps.db, serviceId);
  const vars = withPortEnv(resolveServiceEnv(deps, serviceId), service, readSpec(service.spec)).map((v) => ({
    name: v.name,
    value: v.value,
    secret: v.secret,
  }));
  return deps.secrets.seal(JSON.stringify(vars), "deployment.env");
}

/**
 * PORT=<the app's first port> for an app built from a repository (GitHub,
 * a git provider or a git URL; not a compose member, whose compose file
 * says what it needs), unless its env already has PORT (its own .env or the
 * project's shared variables): Railpack and Nixpacks start commands and
 * most frameworks listen on $PORT, so the app listens where domains and
 * health checks look. Part of the env a deploy starts with, so it takes
 * effect on the next deploy, never as a restart of a running app. Only for
 * services created from 0.2.2 on (spec.portEnv): an app deployed before
 * may run an image whose own ENV PORT points elsewhere (a proxy in front of
 * the server), so its env stays as it was.
 */
export function withPortEnv(
  env: EnvVar[],
  service: { kind: string; parentId: string | null },
  spec: Pick<ServiceSpecJson, "source" | "ports" | "portEnv">,
): EnvVar[] {
  const port = spec.ports[0]?.containerPort;
  const fromRepo = spec.source.type === "github" || spec.source.type === "provider" || spec.source.type === "git";
  if (!spec.portEnv || service.kind !== "app" || service.parentId !== null || !fromRepo || !port) return env;
  if (env.some((v) => v.name === "PORT")) return env;
  return [...env, { name: "PORT", value: String(port), secret: false }];
}

/** A deployment's env snapshot, or null when it has none (older rows, own-runtime kinds). */
export function deploymentEnv(deps: Pick<Deps, "secrets">, envSealed: string | null): EnvVar[] | null {
  if (!envSealed) return null;
  const text = deps.secrets.open(envSealed, "deployment.env");
  if (text === null) return null;
  try {
    const vars = JSON.parse(text) as { name: string; value: string; secret?: boolean }[];
    return Array.isArray(vars) ? vars.map((v) => ({ name: String(v.name), value: String(v.value), secret: v.secret !== false })) : null;
  } catch {
    return null;
  }
}

/** Kinds that receive the project's shared variables. Databases only get their own. */
export function receivesShared(kind: string): boolean {
  return !databaseKinds.has(kind) && kind !== "compose";
}

/**
 * The service's variables with a real secret flag (EnvGraph.isSecret: the
 * variable's "# @public"/"# @secret" comment, else its name, value, resolved
 * value or a reference to a secret). Secret values never reach a
 * Nixpacks build (it bakes variables into the image) and agents strip them
 * from crash reports and troubleshoot uploads; Railpack and Dockerfile
 * builds mount every variable as a BuildKit secret either way.
 */
export function resolveServiceEnv(deps: Pick<Deps, "db" | "secrets">, serviceId: string, graph?: EnvGraph): EnvVar[] {
  const service = getService(deps.db, serviceId);
  const g = graph ?? buildEnvGraph(deps, service.projectId);
  const values = new Map<string, { value: string; secret: boolean }>();
  if (receivesShared(service.kind)) {
    for (const [key, value] of g.sharedValues()) values.set(key, { value, secret: g.isSecret(sharedTarget, key) });
  }
  for (const [key, value] of g.resolveService(serviceId).values) values.set(key, { value, secret: g.isSecret(service.name, key) });
  // Boxes and databases never build; their own variables carry tokens and passwords.
  if (service.kind === "box") for (const [key, value] of Object.entries(boxEnv(deps, serviceId))) values.set(key, { value, secret: true });
  if (databaseKinds.has(service.kind) && findDatabase(deps.db, serviceId)) {
    const info = loadDatabase(deps, serviceId);
    for (const v of containerEnv(info.row.engine, info.admin)) values.set(v.name, { value: v.value, secret: true });
  }
  return [...values].map(([name, v]) => ({ name, value: v.value, secret: v.secret }));
}
