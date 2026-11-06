// The panel's Docker Hub login, from the registries module: the oldest
// registry login whose server is Docker Hub (docker.io, index.docker.io,
// registry.hub.docker.com or registry-1.docker.io).

import { asc } from "drizzle-orm";
import { registryCredentials } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { openRegistryLogin } from "../registries";
import { registryHost } from "../registries/login";
import type { CallerAccess, HubLogin } from "./client";

const dockerHubRegistry = "registry-1.docker.io";

export function isDockerHubServer(server: string): boolean {
  return registryHost(server) === dockerHubRegistry;
}

export function dockerHubLogin(ctx: Pick<OpContext, "db" | "secrets">): HubLogin | null {
  const rows = ctx.db
    .select({ id: registryCredentials.id, server: registryCredentials.server })
    .from(registryCredentials)
    .orderBy(asc(registryCredentials.createdAt), asc(registryCredentials.id))
    .all();
  for (const row of rows) {
    if (!isDockerHubServer(row.server)) continue;
    const login = openRegistryLogin(ctx.db, ctx.secrets, row.id);
    if (login) return { id: row.id, username: login.username, password: login.password };
  }
  return null;
}

/** The login, and whether this caller may read its private repositories. */
export function callerAccess(ctx: Pick<OpContext, "db" | "secrets" | "access">): CallerAccess {
  return { login: dockerHubLogin(ctx), privateAccess: ctx.access.can("registries.manage") };
}
