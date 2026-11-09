// What a deploy builds: the clone URL with its credential and exact commit
// for git sources, the inline Dockerfile, or an uploaded archive; and which
// node builds it.

import { create } from "@bufbuild/protobuf";
import { OpError } from "@seylo/ops";
import { Builder, type BuildRequest, BuildRequestSchema } from "@seylo/proto";
import { and, count, inArray } from "drizzle-orm";
import { builds, nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { resolveServiceEnv } from "../env/desired";
import { openCredential } from "../git/credentials";
import { listRemoteRefs, targetUrl } from "../git/remote";
import { assertGitTarget, gitHostRecorded, providerGitVerdict } from "../git/targets";
import { githubCommit, tokenForInstallation } from "../github/app";
import { type CommitInfo, clientFor } from "../gitProviders/client";
import { loadProvider, openToken } from "../gitProviders/rows";
import type { ServiceRow } from "../services/rows";
import { assertCredentialHost } from "../services/source-guard";
import type { ServiceSpecJson } from "../services/spec";
import { checkTarget } from "../uptime/targets";

/** Port of the panel registry relay every agent serves on loopback. */
export const registryRelay = "127.0.0.1:5755";

export function imageReference(serviceId: string, generation: number): string {
  return `${registryRelay}/${serviceId}:${generation}`;
}

/** A user name the agent accepts for its credential helper (go/internal/build gitUserRe); anything else sends its default. */
function gitUser(name: string | null | undefined): string {
  return name && /^[A-Za-z0-9._@+-]{1,100}$/.test(name) ? name : "";
}

export interface ResolvedBuild {
  request: BuildRequest;
  builderLabel: string;
  commit: { sha: string; message: string | null; author: string | null; branch: string | null } | null;
  /** Shown on the clone step: "main at 3b8d2aa". */
  cloneDetail: string;
}

const builderEnum = { railpack: Builder.RAILPACK, nixpacks: Builder.NIXPACKS, dockerfile: Builder.DOCKERFILE } as const;
const builderLabels = { railpack: "Railpack", nixpacks: "Nixpacks", dockerfile: "Dockerfile" } as const;

function buildEnv(deps: Deps, serviceId: string) {
  try {
    return resolveServiceEnv(deps, serviceId);
  } catch (error) {
    deps.logger.warn({ err: error, serviceId }, "the service env could not be resolved for its build");
    return [];
  }
}

/** The branch a repository source builds (GitHub, a provider connection, a plain clone URL); null for the others. */
export function sourceBranch(source: ServiceSpecJson["source"]): string | null {
  return source.type === "github" || source.type === "provider" || source.type === "git" ? source.branch : null;
}

export async function resolveBuild(
  deps: Deps,
  input: {
    service: ServiceRow;
    spec: ServiceSpecJson;
    buildId: string;
    generation: number;
    commitSha: string | null;
    uploadId: string | null;
  },
): Promise<ResolvedBuild> {
  const { service, spec } = input;
  const source = spec.source;
  const builder = source.type === "inline" ? "dockerfile" : spec.build.builder;
  const base = {
    buildId: input.buildId,
    serviceId: service.id,
    // Each project builds in its own BuildKit builder, so caches never cross projects.
    projectId: service.projectId,
    builder: builderEnum[builder],
    contextPath: spec.build.contextPath,
    dockerfilePath: spec.build.dockerfilePath || "Dockerfile",
    targetStage: spec.build.targetStage,
    imageReference: imageReference(service.id, input.generation),
    // The service's variables at build time (frameworks bake some in); secret ones become BuildKit
    // secrets with Railpack and Dockerfile builds (Nixpacks bakes them into the image, see CONTRACTS).
    env: buildEnv(deps, service.id),
    // Railpack/Nixpacks overrides; empty keeps what the builder detects.
    installCommand: spec.build.installCommand,
    buildCommand: spec.build.buildCommand,
    startCommand: spec.build.startCommand,
    // A Dockerfile typed in the panel, used with the repository or upload as the context.
    dockerfileContent: builder === "dockerfile" && source.type !== "inline" ? (spec.build.inlineDockerfile ?? "") : "",
    // Local copies of this service's images the build node keeps (rollbacks pull by digest from the registry).
    keepImages: 3,
  };

  switch (source.type) {
    case "github": {
      const token = await tokenForInstallation(deps.db, deps.secrets, source.installationId);
      const commit = await githubCommit(token, source.repo, input.commitSha ?? source.branch);
      // github.com is public: internal answers at the node only when an admin recorded it for the project
      // (git.allowInternalHost), for example on a node behind a proxy that cannot resolve it itself.
      const allowInternalHost = await gitHostRecorded(deps.db, service.projectId, "github.com");
      return {
        request: create(BuildRequestSchema, {
          ...base,
          source: {
            source: {
              case: "git",
              value: { url: `https://github.com/${source.repo}.git`, ref: source.branch, commit: commit.sha, token, allowInternalHost },
            },
          },
        }),
        builderLabel: builderLabels[builder],
        commit: { ...commit, branch: source.branch },
        cloneDetail: `${source.branch} at ${commit.sha.slice(0, 7)}`,
      };
    }
    case "provider": {
      // The connection's token goes only to its own host: the clone URL is built from the
      // connection's address, never taken from the source.
      const provider = loadProvider(deps.db, source.providerId, "source.providerId");
      const client = clientFor(deps, provider);
      let commit: CommitInfo | null;
      try {
        commit = input.commitSha ? await client.commit(source.repo, input.commitSha) : await client.branchHead(source.repo, source.branch);
      } catch (error) {
        // A known commit still builds when the provider's API is down; the clone needs only git.
        if (!input.commitSha) throw error;
        commit = { sha: input.commitSha, message: "", author: null };
      }
      if (!commit) throw new OpError("BAD_REQUEST", `${source.repo} has no branch ${source.branch}.`);
      const cloneUrl = client.cloneUrl(source.repo);
      const { allowInternalHost } = await providerGitVerdict(deps.db, { projectId: service.projectId, url: cloneUrl });
      return {
        request: create(BuildRequestSchema, {
          ...base,
          source: {
            source: {
              case: "git",
              value: {
                url: cloneUrl,
                ref: source.branch,
                commit: commit.sha,
                token: openToken(deps.secrets, provider),
                username: gitUser(client.gitUsername()),
                // The connection's address is set by gitProviders.manage (an admin): a self-hosted Gitea
                // or GitLab on the LAN keeps building; a public host only when recorded for the project.
                allowInternalHost,
              },
            },
          },
        }),
        builderLabel: builderLabels[builder],
        commit: { sha: commit.sha, message: commit.message.split("\n")[0] || null, author: commit.author, branch: source.branch },
        cloneDetail: `${source.branch} at ${commit.sha.slice(0, 7)}`,
      };
    }
    case "git": {
      // The stored credential only ever goes to its own host, whoever saved the source.
      if (source.credentialId) assertCredentialHost(deps.db, source.credentialId, source.url, "source.credentialId");
      // The node clones in its own network: a public address, or an internal host an admin allowed for the project.
      const { allowInternalHost } = await assertGitTarget(deps.db, { projectId: service.projectId, url: source.url, caller: null });
      const auth = source.credentialId ? openCredential(deps.db, deps.secrets, source.credentialId) : null;
      let sha = input.commitSha;
      if (!sha) {
        // Best effort: the node resolves the branch itself when the panel cannot reach the host.
        try {
          // Only public addresses: the node resolves the commit itself otherwise.
          const target = await checkTarget(deps, targetUrl(source.url), { allowInternal: false, ownNodes: false });
          sha = target.ok
            ? ((await listRemoteRefs(source.url, auth ?? {}, { address: target.address, byName: target.byName })).heads.get(
                source.branch,
              ) ?? null)
            : null;
        } catch {
          sha = null;
        }
      }
      return {
        request: create(BuildRequestSchema, {
          ...base,
          source: {
            source: {
              case: "git",
              value: {
                url: source.url,
                ref: source.branch,
                commit: sha ?? "",
                token: auth?.token ?? "",
                // Some hosts want a user name with the token (Bitbucket); empty keeps the agent's default.
                username: auth?.token ? gitUser(auth.username) : "",
                sshPrivateKey: auth?.sshPrivateKey ?? "",
                sshKnownHosts: auth?.knownHosts ?? "",
                // The node checks every address it connects to; internal ones only for an allowed host.
                allowInternalHost,
              },
            },
          },
        }),
        builderLabel: builderLabels[builder],
        commit: sha ? { sha, message: null, author: null, branch: source.branch } : null,
        cloneDetail: sha ? `${source.branch} at ${sha.slice(0, 7)}` : source.branch,
      };
    }
    case "inline": {
      if (!spec.build.inlineDockerfile?.trim()) throw new OpError("BAD_REQUEST", "Write the Dockerfile first (Source tab).");
      return {
        request: create(BuildRequestSchema, {
          ...base,
          source: { source: { case: "inlineDockerfile", value: spec.build.inlineDockerfile } },
        }),
        builderLabel: "Dockerfile",
        commit: null,
        cloneDetail: "Inline Dockerfile",
      };
    }
    case "upload": {
      if (!input.uploadId) throw new OpError("BAD_REQUEST", "Upload an archive first.");
      return {
        request: create(BuildRequestSchema, { ...base, source: { source: { case: "uploadId", value: input.uploadId } } }),
        builderLabel: builderLabels[builder],
        commit: null,
        cloneDetail: source.fileName ?? "Uploaded archive",
      };
    }
    default:
      throw new OpError("BAD_REQUEST", "This service has no source to build.");
  }
}

/**
 * Picks the build node: the one set in the build settings, else the
 * service's own node when it can build, else the least busy online node
 * with Can build on. Automatic picks skip nodes whose agent reports no
 * docker buildx (every build needs it); agents that report nothing about
 * buildx (before 0.2.1) count as able to build.
 */
export function pickBuildNode(deps: Deps, spec: ServiceSpecJson, targetNodeIds: readonly string[]): { id: string; name: string } {
  const candidates = deps.db
    .select({ id: nodes.id, name: nodes.name, canBuild: nodes.canBuild, disabledAt: nodes.disabledAt })
    .from(nodes)
    .all();
  const builder = (n: (typeof candidates)[number]) =>
    n.canBuild && !n.disabledAt && deps.agents.isOnline(n.id) && deps.agents.supports(n.id, "build");
  const usable = (n: (typeof candidates)[number]) => builder(n) && hasBuildx(deps, n.id);

  if (spec.build.buildNodeId) {
    const chosen = candidates.find((n) => n.id === spec.build.buildNodeId);
    if (!chosen) throw new OpError("CONFLICT", "The build node in the build settings no longer exists.");
    if (!chosen.canBuild) throw new OpError("CONFLICT", `${chosen.name} does not have Can build on.`);
    if (!deps.agents.isOnline(chosen.id)) throw new OpError("UNAVAILABLE", `${chosen.name} is offline, so it cannot build.`);
    if (!deps.agents.supports(chosen.id, "build"))
      throw new OpError("NOT_IMPLEMENTED", `The agent on ${chosen.name} is too old to build. Update the node.`);
    if (!hasBuildx(deps, chosen.id))
      throw new OpError("CONFLICT", `${chosen.name} has no docker buildx. Install docker-buildx-plugin on it.`);
    return chosen;
  }
  for (const id of targetNodeIds) {
    const own = candidates.find((n) => n.id === id);
    if (own && usable(own)) return own;
  }
  const ready = candidates.filter(usable);
  if (ready.length === 0) {
    // Builders that are up but lack buildx would otherwise read as "no builder at all".
    const missing = candidates.filter((n) => builder(n) && !hasBuildx(deps, n.id)).map((n) => n.name);
    const message =
      missing.length > 0
        ? `No online node can build: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no docker buildx. Install docker-buildx-plugin there, turn on Can build for another node (Nodes) or use an image source.`
        : "No online node can build. Turn on Can build for a node (Nodes) or use an image source.";
    throw new OpError("CONFLICT", message, { reason: "noBuilder" });
  }
  const busy = new Map(
    deps.db
      .select({ nodeId: builds.nodeId, n: count() })
      .from(builds)
      .where(
        and(
          inArray(builds.status, ["queued", "running"]),
          inArray(
            builds.nodeId,
            ready.map((n) => n.id),
          ),
        ),
      )
      .groupBy(builds.nodeId)
      .all()
      .map((r) => [r.nodeId, r.n]),
  );
  return [...ready].sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0) || a.name.localeCompare(b.name))[0] as {
    id: string;
    name: string;
  };
}

/** The agent's last word on docker buildx; unset (agents before 0.2.1) counts as installed. */
export function hasBuildx(deps: Pick<Deps, "agents">, nodeId: string): boolean {
  return deps.agents.state.get(nodeId)?.facts?.buildx?.installed !== false;
}
