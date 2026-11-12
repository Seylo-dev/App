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
import { databaseKinds, domainPort, getService } from "../domains/lookup";
import { builtAppPort, readSpec, type ServiceSpecJson } from "../services/spec";
import { buildEnvGraph, type EnvGraph } from "./graph";

type EnvVar = MessageInitShape<typeof EnvVarSchema>;

/**
 * The resolved env sealed for a deployment row (deployments.envSealed),
 * which the desired-state compile hands the deployment's containers, with
 * PORT for apps built from a repository (withPortEnv).
 */
export function sealDeploymentEnv(deps: Pick<Deps, "db" | "secrets">, serviceId: string): string {
  const service = getService(deps.db, serviceId);
  const vars = withPortEnv(resolveServiceEnv(deps, serviceId), service, readSpec(service.spec), domainPort(deps.db, serviceId)).map(
    (v) => ({
      name: v.name,
      value: v.value,
      secret: v.secret,
    }),
  );
  return deps.secrets.seal(JSON.stringify(vars), "deployment.env");
}

/**
 * PORT for an app built from a repository: its first port, else the port
 * its domains point at (`domainPortFallback`), else 80 (builtAppPort), so an
 * older portless app whose domain was added on 3000 keeps listening there;
 * unless its env already has PORT (its own .env or the
 * project's shared variables). Railpack and Nixpacks start commands and
 * most frameworks listen on $PORT, so the app listens where domains and
 * health checks look. Part of the env a deploy starts with, so it takes
 * effect on the next deploy, never as a restart of a running app. Every
 * built app since 0.2.3, also those created before 0.2.2 (spec.portEnv is
 * no longer read): leaving them out kept a Next.js app on 3000 behind a
 * domain on 80.
 */
export function withPortEnv(
  env: EnvVar[],
  service: { kind: string; parentId: string | null },
  spec: Pick<ServiceSpecJson, "source" | "ports">,
  domainPortFallback: number | null = null,
): EnvVar[] {
  const port = builtAppPort(service, spec, domainPortFallback);
  if (port === null || env.some((v) => v.name === "PORT")) return env;
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
 * variable's "# @public"/"# @secret" comment, else a framework public prefix
 * such as NEXT_PUBLIC_ (public unless it holds a password), else its name,
 * value, resolved value or a reference to a secret). Secret values never reach a Nixpacks build (it
 * bakes variables into the image), are no Dockerfile build arg (ARG NAME)
 * and agents strip them from crash reports and troubleshoot uploads;
 * Railpack and Dockerfile builds mount every variable as a BuildKit secret
 * either way.
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
