// Compose stacks: a compose file (pasted, or read from a repo) is parsed
// with compose-go on a node and split into one member service per compose
// service, so every member gets its own logs, metrics, domains and deploy
// history. The stack is a service of kind "compose"; members point at it
// with parentId and are created, changed and deleted only with it.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id } from "../schemas";
import { RepoPath } from "./builds";
import { GitBranch, ServiceDetail, ServiceName, ServiceSummary } from "./services";

const ComposeYaml = Type.String({ minLength: 1, maxLength: 512 * 1024, description: "The compose file (docker-compose.yml)." });

/** Where the compose file comes from: pasted text, or a file in a repository. */
export const ComposeSource = Type.Union([
  Type.Object({ type: Type.Literal("inline"), yaml: ComposeYaml }),
  Type.Object({
    type: Type.Literal("github"),
    installationId: Id,
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    branch: GitBranch,
    path: RepoPath,
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("git"),
    url: Type.String({ minLength: 1, maxLength: 500, pattern: "^(https://|ssh://|git@)\\S+$" }),
    branch: GitBranch,
    path: RepoPath,
    credentialId: Type.Union([Id, Type.Null()]),
    deployOnPush: Type.Boolean(),
  }),
]);

/** What one compose service becomes, shown before anything is created. */
export const MemberPreview = Type.Object({
  /** Name in the compose file. */
  composeService: Type.String(),
  /** Service name it gets in the project (DNS-safe, unique). */
  name: ServiceName,
  /** "create", "update" or "delete" when re-applying a changed file; always "create" for a new stack. */
  action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("unchanged")]),
  /** Image, or "build: ./path" when the member builds from the repo. */
  image: Type.String(),
  ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 })),
  volumes: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String(), sharedWith: Type.Array(Type.String()) })),
  dependsOn: Type.Array(Type.String()),
  /** Variable names only; values are never echoed. */
  envKeys: Type.Array(Type.String()),
  hasHealthCheck: Type.Boolean(),
});

export const ComposePreview = Type.Object({
  members: Type.Array(MemberPreview),
  /** Things we ignore or change, in plain words: "ports: 8080:80 becomes an internal port; add a domain instead". */
  warnings: Type.Array(Type.String()),
});

const projectScope = (input: { projectId: string }) => input.projectId;
const serviceScope = (input: { serviceId: string }) => input.serviceId;

export const preview = defineOp({
  id: "compose.preview",
  kind: "mutation",
  summary: "Preview a compose stack",
  description:
    "Parses a compose file and shows the member services it would create in the project, with ports, volumes, dependencies and warnings. Creates nothing. It is a POST (mutation) only because the file is too large for a query string.",
  input: Type.Object({
    projectId: Id,
    name: ServiceName,
    nodeId: Id,
    source: ComposeSource,
  }),
  output: ComposePreview,
  permission: permission.project("services.create", projectScope),
  // Compose files often carry passwords in environment blocks.
  sensitive: { input: ["source.yaml"] },
  mcp: true,
  audit: true,
});

export const create = defineOp({
  id: "compose.create",
  kind: "mutation",
  summary: "Create a compose stack",
  description:
    "Creates a compose stack and one member service per compose service on one node (members share volumes, so they stay on the same node). Deploys every member when deployNow is true.",
  input: Type.Object({
    projectId: Id,
    name: ServiceName,
    nodeId: Id,
    source: ComposeSource,
    deployNow: Type.Optional(Type.Boolean({ default: true })),
  }),
  output: Type.Object({ stack: ServiceSummary, members: Type.Array(ServiceSummary) }),
  permission: permission.project("services.create", projectScope),
  sensitive: { input: ["source.yaml"] },
  mcp: true,
  audit: true,
});

export const get = defineOp({
  id: "compose.get",
  kind: "query",
  summary: "Get a compose stack's file",
  description: "Returns where a stack's compose file comes from (with the pasted file) and the member services it created.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ stack: ServiceDetail, source: ComposeSource, members: Type.Array(ServiceSummary) }),
  permission: permission.service("services.view", serviceScope),
  sensitive: { output: ["source.yaml"] },
  mcp: true,
  audit: false,
});

export const update = defineOp({
  id: "compose.update",
  // Destructive: members removed from the file are deleted with their volumes.
  kind: "destructive",
  summary: "Change a compose stack's file",
  description:
    "Replaces a stack's compose file. With dryRun the result is the member diff (create, update, delete) and nothing changes; without it members are created, updated or deleted to match, and changed members are deployed.",
  input: Type.Object({
    serviceId: Id,
    source: ComposeSource,
    dryRun: Type.Optional(Type.Boolean({ default: false })),
  }),
  output: ComposePreview,
  permission: permission.service("services.update", serviceScope),
  sensitive: { input: ["source.yaml"] },
  mcp: true,
  audit: true,
});
