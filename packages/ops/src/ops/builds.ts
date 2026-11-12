// Builds turn a service's source into an image once, on a node that "can
// build", and push it to the panel registry so any node can run it. This
// file has the build settings of a service and the panel-wide build queue.
// Starting a build is a deploy (deployments.deploy); cancelling one is
// deployments.cancel.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

/** Railpack is the default; Nixpacks is in maintenance mode upstream and kept as an option. */
export const Builder = Type.Union([Type.Literal("railpack"), Type.Literal("nixpacks"), Type.Literal("dockerfile")]);

/** Path inside the repository, relative, without "..". */
export const RepoPath = Type.String({ maxLength: 300, pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).*$" });

export const BuildSettings = Type.Object({
  builder: Builder,
  /** Folder inside the source to build. "" is the repository root. */
  contextPath: RepoPath,
  /** Dockerfile path relative to contextPath, for the dockerfile builder. Ignored when inlineDockerfile is set. */
  dockerfilePath: RepoPath,
  /** Dockerfile typed in the panel. Used instead of dockerfilePath when not null. */
  inlineDockerfile: Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()]),
  /** Stage of a multi-stage Dockerfile; "" is the last one. */
  targetStage: Type.String({ maxLength: 100 }),
  /**
   * Node that builds. null = pick automatically: the target node when it
   * can build, otherwise the least busy node with "Can build" on.
   */
  buildNodeId: Type.Union([Id, Type.Null()]),
  /** Start command override for railpack/nixpacks; "" keeps the detected one. */
  startCommand: Type.String({ maxLength: 2000 }),
  /** Install/build command overrides for railpack/nixpacks; "" keeps the detected ones. */
  installCommand: Type.String({ maxLength: 2000 }),
  buildCommand: Type.String({ maxLength: 2000 }),
});

/** A node as build settings show it, so the picker can explain "us-ash-1 can't build". */
export const BuildNode = Type.Object({
  id: Id,
  name: Type.String(),
  canBuild: Type.Boolean(),
  online: Type.Boolean(),
  /**
   * False when the node's agent reports no docker buildx: automatic picks
   * skip it, builds there fail and updateSettings refuses it as the build
   * node. Agents before 0.2.1 report nothing, which counts as true. Added in
   * 0.2.1.
   */
  hasBuildx: Type.Boolean(),
  /** Builds waiting or running there now. */
  queued: Type.Integer({ minimum: 0 }),
  /**
   * Of those, the builds that hold a slot of the node's Builds at once:
   * started on the node, or about to start in a free slot. Added in 0.2.14.
   */
  running: Type.Integer({ minimum: 0 }),
  /** Of those, the builds waiting for a free slot (queued minus running). Added in 0.2.14. */
  waiting: Type.Integer({ minimum: 0 }),
});

export const BuildStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const QueuedBuild = Type.Object({
  id: Id,
  deploymentId: Id,
  serviceId: Id,
  serviceName: Type.String(),
  projectId: Id,
  projectName: Type.String(),
  /** Node that runs (or will run) the build; null once that node was removed. */
  nodeId: Type.Union([Id, Type.Null()]),
  nodeName: Type.Union([Type.String(), Type.Null()]),
  builder: Builder,
  /**
   * queued: not started on its node yet. Since 0.2.14 a build stays queued
   * while it waits for a free slot of its node's Builds at once, and is
   * running only once the node's agent really started it (it fetches the
   * source); before, it read running from the moment it was dispatched.
   */
  status: BuildStatus,
  /**
   * 1-based place among the queued builds of its node, in the order the
   * node's agent got them (1 = next to start); null once running. Builds the
   * panel is still sending to the node (fetching the source, uploading an
   * archive) come last.
   */
  position: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  /**
   * True for a queued build with no free slot: the node's running builds and
   * the queued ones ahead of it fill its Builds at once. False for a queued
   * build about to start in a free slot, and for running builds. Added in
   * 0.2.14.
   */
  waiting: Type.Boolean(),
  commitSha: Type.Union([Type.String(), Type.Null()]),
  queuedAt: Timestamp,
  startedAt: Type.Union([Timestamp, Type.Null()]),
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;

export const queue = defineOp({
  id: "builds.queue",
  kind: "query",
  summary: "List the build queue",
  description:
    "Lists builds that are queued or running on every node (or one node), in the order their nodes got them, with their place in the queue. queued = waiting for a free slot of its node's Builds at once (waiting true), or about to start in one; position is its place among the node's queued builds, in the order the node's agent got them, which is the order it starts them in (1 = next to start). running = started on the node's agent; startedAt is when it started, queuedAt when it was dispatched. Only builds of services the caller can view are returned.",
  input: Type.Object({ nodeId: Type.Optional(Id) }),
  output: Type.Object({ builds: Type.Array(QueuedBuild) }),
  // The handler filters rows by services.view.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const getSettings = defineOp({
  id: "builds.getSettings",
  kind: "query",
  summary: "Get a service's build settings",
  description:
    "Returns how a service is built (builder, paths, inline Dockerfile, command overrides, build node) and the nodes it could build on, with whether each can build.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ settings: BuildSettings, nodes: Type.Array(BuildNode) }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const updateSettings = defineOp({
  id: "builds.updateSettings",
  kind: "mutation",
  summary: "Change a service's build settings",
  description:
    "Changes how a service is built. Omitted fields keep their value. Takes effect on the next deploy. buildNodeId must name a node with Can build on whose agent does not report docker buildx missing, or be null for automatic; the node the service has already is not checked again.",
  input: Type.Object({
    serviceId: Id,
    builder: Type.Optional(Builder),
    contextPath: Type.Optional(RepoPath),
    dockerfilePath: Type.Optional(RepoPath),
    inlineDockerfile: Type.Optional(Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()])),
    targetStage: Type.Optional(Type.String({ maxLength: 100 })),
    buildNodeId: Type.Optional(Type.Union([Id, Type.Null()])),
    startCommand: Type.Optional(Type.String({ maxLength: 2000 })),
    installCommand: Type.Optional(Type.String({ maxLength: 2000 })),
    buildCommand: Type.Optional(Type.String({ maxLength: 2000 })),
  }),
  output: BuildSettings,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});
