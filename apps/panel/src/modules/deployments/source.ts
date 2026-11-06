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
import { githubCommit, tokenForInstallation } from "../github/app";
import type { ServiceRow } from "../services/rows";
import { assertCredentialHost } from "../services/source-guard";
import type { ServiceSpecJson } from "../services/spec";
import { checkTarget } from "../uptime/targets";

/** Port of the panel registry relay every agent serves on loopback. */
export const registryRelay = "127.0.0.1:5755";

export function imageReference(serviceId: string, generation: number): string {
  return `${registryRelay}/${serviceId}:${generation}`;
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
      return {
        request: create(BuildRequestSchema, {
          ...base,
          source: {
            source: { case: "git", value: { url: `https://github.com/${source.repo}.git`, ref: source.branch, commit: commit.sha, token } },
          },
        }),
        builderLabel: builderLabels[builder],
        commit: { ...commit, branch: source.branch },
        cloneDetail: `${source.branch} at ${commit.sha.slice(0, 7)}`,
      };
    }
    case "git": {
      // The stored credential only ever goes to its own host, whoever saved the source.
      if (source.credentialId) assertCredentialHost(deps.db, source.credentialId, source.url, "source.credentialId");
      const auth = source.credentialId ? openCredential(deps.db, deps.secrets, source.credentialId) : null;
      let sha = input.commitSha;
      if (!sha) {
        // Best effort: the node resolves the branch itself when the panel cannot reach the host.
        try {
          // Only public addresses: the node resolves the commit itself otherwise.
          const target = await checkTarget(deps, targetUrl(source.url), { allowInternal: false });
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
                sshPrivateKey: auth?.sshPrivateKey ?? "",
                sshKnownHosts: auth?.knownHosts ?? "",
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
 * with Can build on.
 */
export function pickBuildNode(deps: Deps, spec: ServiceSpecJson, targetNodeIds: readonly string[]): { id: string; name: string } {
  const candidates = deps.db
    .select({ id: nodes.id, name: nodes.name, canBuild: nodes.canBuild, disabledAt: nodes.disabledAt })
    .from(nodes)
    .all();
  const usable = (n: (typeof candidates)[number]) =>
    n.canBuild && !n.disabledAt && deps.agents.isOnline(n.id) && deps.agents.supports(n.id, "build");

  if (spec.build.buildNodeId) {
    const chosen = candidates.find((n) => n.id === spec.build.buildNodeId);
    if (!chosen) throw new OpError("CONFLICT", "The build node in the build settings no longer exists.");
    if (!chosen.canBuild) throw new OpError("CONFLICT", `${chosen.name} does not have Can build on.`);
    if (!deps.agents.isOnline(chosen.id)) throw new OpError("UNAVAILABLE", `${chosen.name} is offline, so it cannot build.`);
    if (!deps.agents.supports(chosen.id, "build"))
      throw new OpError("NOT_IMPLEMENTED", `The agent on ${chosen.name} is too old to build. Update the node.`);
    return chosen;
  }
  for (const id of targetNodeIds) {
    const own = candidates.find((n) => n.id === id);
    if (own && usable(own)) return own;
  }
  const ready = candidates.filter(usable);
  if (ready.length === 0) {
    throw new OpError("CONFLICT", "No online node can build. Turn on Can build for a node (Nodes) or use an image source.", {
      reason: "noBuilder",
    });
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
