// What a source may point at. Git credentials, registry logins, GitHub
// App installations and git provider connections are panel-wide secrets of
// the owner, so a member must not be able to aim them anywhere they like:
//
// - a credential only ever goes to its own host (a git token for
//   github.com is never sent to git.attacker.example, a registry password
//   never to another registry);
// - attaching one to a project needs the global manage action for it
//   (git.manage, registries.manage, github.manage, gitProviders.manage)
//   unless a service of the same project already uses it for the same
//   repository, git URL or image repository, which is how an admin shares
//   it there: sharing a token that reaches every repository of the owner
//   shares that one repository, not the token;
// - an image may not come from the panel's registry relay
//   (127.0.0.1:5755/<service id>): those images belong to their services
//   and only deployments reference them.

import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
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

/** The kinds of shared credential and what each one is shared for. */
const attachKinds = {
  git: { action: "git.manage", path: "credentialId", target: "url", normalize: (v: string) => normalizeGitUrl(v), what: "git credential" },
  registry: {
    action: "registries.manage",
    path: "registryId",
    target: "image",
    normalize: (v: string) => imageRepository(v),
    what: "registry login",
  },
  github: {
    action: "github.manage",
    path: "installationId",
    target: "repo",
    normalize: (v: string) => v.toLowerCase(),
    what: "GitHub installation",
  },
  provider: {
    action: "gitProviders.manage",
    path: "providerId",
    target: "repo",
    normalize: (v: string) => v.toLowerCase().replace(/\/+$/, ""),
    what: "git provider connection",
  },
  // The panel's connected GitHub account (github/account.ts), managed with the App.
  githubAccount: {
    action: "github.manage",
    path: "accountId",
    target: "repo",
    normalize: (v: string) => v.toLowerCase(),
    what: "GitHub account",
  },
} as const;
export type AttachKind = keyof typeof attachKinds;

/**
 * Whether a stored source uses the credential. The connected GitHub
 * account is one per panel and a source keeps working when it is connected
 * again under a new id, so any GitHub source read through an account counts.
 */
function usesCredential(kind: AttachKind, source: Record<string, unknown>, id: string): boolean {
  if (kind === "githubAccount") return source.type === "github" && !source.installationId && typeof source.accountId === "string";
  return source[attachKinds[kind].path] === id;
}

/** "https://Git.Example.com/a/b.git/" and "https://git.example.com/a/b" are the same repository. */
export function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/** "ghcr.io/acme/app:1.2@sha256:..." -> "ghcr.io/acme/app"; Docker Hub names get docker.io/(library/). */
export function imageRepository(image: string): string {
  const withoutDigest = image.trim().toLowerCase().split("@")[0] ?? "";
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const name = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  const registry = imageRegistry(name);
  if (registry !== "docker.io") return name;
  const path = name.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  return `docker.io/${path.includes("/") ? path : `library/${path}`}`;
}

/**
 * What a credential is already used for in a project (normalized), from its
 * services' sources and compose stacks; null when the caller manages that
 * kind and may use it for anything.
 */
export function sharedTargets(caller: Caller, projectId: string, kind: AttachKind, id: string): Set<string> | null {
  const rule = attachKinds[kind];
  if (caller.access.can(rule.action)) return null;
  const out = new Set<string>();
  const rows = caller.db.select({ spec: services.spec }).from(services).where(eq(services.projectId, projectId)).all();
  for (const { spec } of rows) {
    const record = spec as { source?: Record<string, unknown>; stack?: { source?: Record<string, unknown> } | null } | null;
    for (const source of [record?.source, record?.stack?.source]) {
      const target = source?.[rule.target];
      if (source && usesCredential(kind, source, id) && typeof target === "string") out.add(rule.normalize(target));
    }
  }
  return out;
}

function assertMayAttach(caller: Caller, projectId: string, kind: AttachKind, id: string, target: string, field: string): void {
  const shared = sharedTargets(caller, projectId, kind, id);
  if (shared === null || shared.has(attachKinds[kind].normalize(target))) return;
  const { action, what } = attachKinds[kind];
  const message =
    shared.size === 0
      ? `Only admins can use this ${what} in a new project. Ask one to set up the first service with it.`
      : `In this project the ${what} is shared for ${[...shared].join(", ")} only. Ask an admin to set up a service with it for another one.`;
  throw new OpError("FORBIDDEN", message, { action, field });
}

/** FORBIDDEN unless the caller may use the credential in this project at all (pickers before a repository is chosen). */
export function assertMayUseSomewhere(caller: Caller, projectId: string, kind: AttachKind, id: string, field: string): Set<string> | null {
  const shared = sharedTargets(caller, projectId, kind, id);
  if (shared !== null && shared.size === 0) {
    const { action, what } = attachKinds[kind];
    throw new OpError("FORBIDDEN", `Only admins can use this ${what} in a new project. Ask one to set up the first service with it.`, {
      action,
      field,
    });
  }
  return shared;
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
  | { type: "github"; installationId: string | null; accountId?: string | null; repo: string }
  | { type: "provider"; providerId: string; repo: string }
  | { type: string };

/** Checks a source (service or compose stack) before it is stored for a service of `projectId`. */
export function assertSourceAllowed(caller: Caller, projectId: string, source: GuardedSource, field = "source"): void {
  const at = (name: string) => (field ? `${field}.${name}` : name);
  if (source.type === "git" && "url" in source && source.credentialId) {
    assertCredentialHost(caller.db, source.credentialId, source.url, at("credentialId"));
    assertMayAttach(caller, projectId, "git", source.credentialId, source.url, at("credentialId"));
  }
  if (source.type === "image" && "image" in source) {
    assertImageAllowed(source.image, at("image"));
    if (source.registryId) {
      assertRegistryHost(caller.db, source.registryId, source.image, at("registryId"));
      assertMayAttach(caller, projectId, "registry", source.registryId, source.image, at("registryId"));
    }
  }
  if (source.type === "provider" && "providerId" in source) {
    assertMayAttach(caller, projectId, "provider", source.providerId, "repo" in source ? source.repo : "", at("providerId"));
  }
  if (source.type === "github" && "installationId" in source) {
    const repo = "repo" in source ? source.repo : "";
    if (source.installationId) assertMayAttach(caller, projectId, "github", source.installationId, repo, at("installationId"));
    else if ("accountId" in source && source.accountId)
      assertMayAttach(caller, projectId, "githubAccount", source.accountId, repo, at("accountId"));
    else
      throw new OpError("BAD_REQUEST", "A GitHub source needs an App installation or the connected GitHub account.", {
        field: at("installationId"),
      });
  }
}
