// What a source may point at. Git credentials, registry logins, GitHub
// App installations and git provider connections are panel-wide secrets of
// the owner, so a member must not be able to aim them anywhere they like:
//
// - a credential only ever goes to its own host (a git token for
//   github.com is never sent to git.attacker.example, a registry password
//   never to another registry);
// - attaching one to a project needs the global manage action for it
//   (git.manage, registries.manage, github.manage, gitProviders.manage)
//   unless a service of the same project already uses it, which is how an
//   admin shares it there;
// - an image may not come from the panel's registry relay
//   (127.0.0.1:5755/<service id>): those images belong to their services
//   and only deployments reference them.

import { OpError } from "@seylo/ops";
import { and, eq, or, sql } from "drizzle-orm";
import type { Access } from "../../auth/access";
import type { PanelDb } from "../../db/client";
import { gitCredentials, registryCredentials, services } from "../../db/schema";
import { urlHost } from "../git/remote";
import { registryHost } from "../registries/login";

interface Caller {
  db: PanelDb;
  access: Pick<Access, "can">;
}

/** The relay's port on every node (deployments/source.ts registryRelay). */
const relayPort = "5755";

/** Registry host of a Docker image reference ("docker.io" when it names none). */
export function imageRegistry(image: string): string {
  const first = image.split("/")[0] ?? "";
  const named = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost" || first.startsWith("["));
  return named ? first.toLowerCase() : "docker.io";
}

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || name === "::1" || name === "0.0.0.0" || /^127\./.test(name) || name.endsWith(".localhost");
}

/** BAD_REQUEST when an image source points at the node's loopback or the registry relay. */
export function assertImageAllowed(image: string, field = "source.image"): void {
  const registry = imageRegistry(image);
  if (registry === "docker.io") return;
  // Loopback is the relay (or something else of the node's); a name that resolves
  // to loopback reaches the relay through its port.
  if (isLoopbackHost(registry) || registry.endsWith(`:${relayPort}`)) {
    throw new OpError("BAD_REQUEST", "Images cannot come from the node itself or the panel's registry. Use a registry address.", {
      field,
      reason: "internalRegistry",
    });
  }
}

/** Whether a service of this project uses the credential in its source or compose source. */
type AttachPath = "credentialId" | "registryId" | "installationId" | "providerId";

function usedInProject(db: PanelDb, projectId: string, path: AttachPath, id: string): boolean {
  const source = sql`json_extract(${services.spec}, ${`$.source.${path}`})`;
  const stack = sql`json_extract(${services.spec}, ${`$.stack.source.${path}`})`;
  return (
    db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.projectId, projectId), or(sql`${source} = ${id}`, sql`${stack} = ${id}`)))
      .get() !== undefined
  );
}

function assertMayAttach(
  caller: Caller,
  projectId: string,
  action: "git.manage" | "registries.manage" | "github.manage" | "gitProviders.manage",
  path: AttachPath,
  id: string,
  field: string,
  what: string,
): void {
  if (caller.access.can(action) || usedInProject(caller.db, projectId, path, id)) return;
  throw new OpError("FORBIDDEN", `Only admins can use this ${what} in a new project. Ask one to set up the first service with it.`, {
    action,
    field,
  });
}

/** BAD_REQUEST unless the git credential is for the URL's host. */
export function assertCredentialHost(db: PanelDb, credentialId: string, url: string, field = "credentialId"): void {
  const row = db.select({ host: gitCredentials.host }).from(gitCredentials).where(eq(gitCredentials.id, credentialId)).get();
  if (!row) throw new OpError("NOT_FOUND", "No git credential with this id.", { field });
  let host: string;
  try {
    host = urlHost(url).toLowerCase();
  } catch {
    throw new OpError("BAD_REQUEST", "This is not a git URL.", { field: "url" });
  }
  if (row.host.toLowerCase() !== host) {
    throw new OpError("BAD_REQUEST", `This credential is for ${row.host}, not ${host}.`, { field });
  }
}

/** BAD_REQUEST unless the registry login is for the image's registry. */
export function assertRegistryHost(db: PanelDb, registryId: string, image: string, field = "source.registryId"): void {
  const row = db
    .select({ server: registryCredentials.server })
    .from(registryCredentials)
    .where(eq(registryCredentials.id, registryId))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "No registry login with this id.", { field });
  if (!registryMatches(row.server, image)) {
    throw new OpError("BAD_REQUEST", `This registry login is for ${row.server}, not ${imageRegistry(image)}.`, { field });
  }
}

/** Whether a registry login's server is the registry an image comes from. */
export function registryMatches(server: string, image: string): boolean {
  return registryHost(server.toLowerCase()) === registryHost(imageRegistry(image));
}

export type GuardedSource =
  | { type: "git"; url: string; credentialId?: string | null }
  | { type: "image"; image: string; registryId?: string | null }
  | { type: "github"; installationId: string }
  | { type: "provider"; providerId: string }
  | { type: string };

/** Checks a source (service or compose stack) before it is stored for a service of `projectId`. */
export function assertSourceAllowed(caller: Caller, projectId: string, source: GuardedSource, field = "source"): void {
  const at = (name: string) => (field ? `${field}.${name}` : name);
  if (source.type === "git" && "url" in source && source.credentialId) {
    assertCredentialHost(caller.db, source.credentialId, source.url, at("credentialId"));
    assertMayAttach(caller, projectId, "git.manage", "credentialId", source.credentialId, at("credentialId"), "git credential");
  }
  if (source.type === "image" && "image" in source) {
    assertImageAllowed(source.image, at("image"));
    if (source.registryId) {
      assertRegistryHost(caller.db, source.registryId, source.image, at("registryId"));
      assertMayAttach(caller, projectId, "registries.manage", "registryId", source.registryId, at("registryId"), "registry login");
    }
  }
  if (source.type === "provider" && "providerId" in source) {
    assertMayAttach(caller, projectId, "gitProviders.manage", "providerId", source.providerId, at("providerId"), "git provider connection");
  }
  if (source.type === "github" && "installationId" in source) {
    assertMayAttach(
      caller,
      projectId,
      "github.manage",
      "installationId",
      source.installationId,
      at("installationId"),
      "GitHub installation",
    );
  }
}
