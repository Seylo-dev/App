// Deployments are releases of a service. A deploy clones and builds once
// (on a node that can build), ships the image through the panel registry,
// starts the new version, health checks it and only then switches traffic;
// if it never gets healthy the old version keeps serving. The last images
// are kept, so a rollback deploys an old digest again without building.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { Builder } from "./builds";
import { NodeRef } from "./services";

export const DeploymentStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("building"),
  Type.Literal("deploying"),
  Type.Literal("live"),
  /** Succeeded earlier and was replaced by a newer live deployment. */
  Type.Literal("superseded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const DeploymentTrigger = Type.Union([
  Type.Literal("manual"),
  Type.Literal("push"),
  Type.Literal("rollback"),
  Type.Literal("api"),
  Type.Literal("preview"),
  Type.Literal("template"),
  Type.Literal("webhook"),
  Type.Literal("move"),
]);

export const StepKey = Type.Union([
  Type.Literal("clone"),
  Type.Literal("build"),
  Type.Literal("ship"),
  Type.Literal("health"),
  Type.Literal("switch"),
]);

/** One stage of the deploy timeline: Clone, Build on <node>, Ship to <node>, Health check, Switch traffic. */
export const DeploymentStep = Type.Object({
  key: StepKey,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("ok"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
  ]),
  /** Node the step ran on (build: the builder; ship: the target), null when not node-bound. */
  node: Type.Union([NodeRef, Type.Null()]),
  /** Short result line: "main at 3b8d2aa", "Railpack, 121 MB image", "GET /health 200 in 3s", "Skipped, previous version kept". */
  detail: Type.String(),
  durationMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const Deployment = Type.Object({
  id: Id,
  serviceId: Id,
  generation: Type.Integer({ minimum: 1 }),
  status: DeploymentStatus,
  /** True for the one deployment serving traffic now. */
  live: Type.Boolean(),
  trigger: DeploymentTrigger,
  /** Who started it: a panel user's email, a GitHub login for pushes, an API key name; null for system deploys. */
  actor: Type.Union([Type.String(), Type.Null()]),
  commit: Type.Union([
    Type.Object({
      sha: Type.String({ pattern: "^[0-9a-f]{7,64}$" }),
      message: Type.String(),
      branch: Type.Union([Type.String(), Type.Null()]),
      author: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  /**
   * What this deploy built from, for its title when there is no commit
   * message: the branch (also when no commit was found, for example a clone
   * that failed) or the uploaded archive's file name. null for image deploys,
   * rollbacks, moves, inline Dockerfiles, and when it was not recorded.
   */
  source: Type.Union([Type.String(), Type.Null()]),
  builder: Type.Union([Builder, Type.Null()]),
  /** null for image sources and rollbacks (nothing was built). */
  builtOn: Type.Union([NodeRef, Type.Null()]),
  /**
   * Set while the deploy's build waits for a free slot of its node's Builds
   * at once: the node and the build's place among that node's queued builds
   * (builds.queue position, 1 = next to start). The clone step then says
   * "Waiting for a build slot on <node> - 2 ahead". null otherwise, also
   * while a queued build is about to start in a free slot. Added in 0.2.15.
   */
  buildWait: Type.Union([Type.Object({ node: NodeRef, position: Type.Integer({ minimum: 1 }) }), Type.Null()]),
  shippedTo: Type.Array(NodeRef),
  image: Type.Union([
    Type.Object({
      reference: Type.String(),
      /** "sha256:..." once known; rollbacks pull exactly this. */
      digest: Type.Union([Type.String(), Type.Null()]),
      sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      /** Bytes the target nodes had to pull ("Shipped 38 MB"). */
      shippedBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
    Type.Null(),
  ]),
  steps: Type.Array(DeploymentStep),
  /** Whole deploy, from queued to switched or failed; null while running. */
  durationMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /**
   * The image is still kept and this is not the live deployment. For a
   * database also only a deployment of the image it runs: rollback refuses
   * the others (reason databaseVersion).
   */
  canRollback: Type.Boolean(),
  /** For rollbacks: the deployment whose image runs again. */
  rollbackOf: Type.Union([Id, Type.Null()]),
  /** Safe to show: "No answer on port 3001 within 60s. The previous version stayed live." */
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
  startedAt: Type.Union([Timestamp, Type.Null()]),
  finishedAt: Type.Union([Timestamp, Type.Null()]),
});

export const LogLine = Type.Object({
  /** Increasing per deployment; pass the last one as afterSeq to page. */
  seq: Type.Integer({ minimum: 0 }),
  ts: Timestamp,
  step: StepKey,
  text: Type.String(),
  error: Type.Boolean(),
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;
const DeploymentRef = { serviceId: Id, deploymentId: Id };

export const deploy = defineOp({
  id: "deployments.deploy",
  kind: "mutation",
  summary: "Deploy a service now",
  description:
    "Starts a deploy of the service's current settings: the branch head (or a given commit) for git sources, the image for image sources. Refused (CONFLICT, reason deployRunning, with the deploymentId and serviceId of the deploy in progress, a member's for a compose stack) while another deploy of the service is queued or running: wait for it or cancel it first. Pushes and trigger URLs still queue behind a running deploy. Returns the new deployment; follow it with deployments.get and deployments.log.",
  input: Type.Object({
    serviceId: Id,
    /** Build this commit instead of the branch head. */
    commitSha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{7,64}$" })),
    /** Build without the layer cache. */
    noCache: Type.Optional(Type.Boolean()),
  }),
  output: Deployment,
  permission: permission.service("services.deploy", serviceScope),
  mcp: true,
  audit: true,
});

export const list = defineOp({
  id: "deployments.list",
  kind: "query",
  summary: "List a service's deployments",
  description:
    "Lists a service's deploy history, newest first: status, who or what triggered it, commit, where it was built and shipped, image digest, step durations, and whether it can be rolled back to. With active: only the deploys that are queued or running, oldest first, so the first one is the deploy in progress (the one deployments.deploy names when it refuses); no cursor.",
  input: Type.Object({
    serviceId: Id,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    /** nextCursor from the previous page. */
    cursor: Type.Optional(Type.String({ maxLength: 100 })),
    /** Only queued and running deploys, oldest first: the first is the one in progress. */
    active: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    deployments: Type.Array(Deployment),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    /** How many recent images are kept for instant rollback ("Last 5 images kept"). */
    keptImages: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "deployments.get",
  kind: "query",
  summary: "Get a deployment",
  description:
    "Returns one deployment with its steps. While it runs, subscribe to logTopic on the live socket for new log lines, or poll deployments.log with afterSeq.",
  input: Type.Object(DeploymentRef),
  output: Type.Object({
    deployment: Deployment,
    /** Live topic that carries this deployment's log lines and step changes. */
    logTopic: Type.String(),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const log = defineOp({
  id: "deployments.log",
  kind: "query",
  summary: "Read a deployment's log",
  description:
    "Returns the build and deploy log of a deployment, oldest first, after a sequence number. done is true once the deployment finished and every line has been returned. Build logs are read from the node that built.",
  input: Type.Object({
    ...DeploymentRef,
    afterSeq: Type.Optional(Type.Integer({ minimum: -1, default: -1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, default: 1000 })),
  }),
  output: Type.Object({ lines: Type.Array(LogLine), done: Type.Boolean() }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const cancel = defineOp({
  id: "deployments.cancel",
  kind: "mutation",
  summary: "Cancel a deployment",
  description:
    "Cancels a queued, building or deploying deployment. A new version that was already started is removed; the live version keeps serving. Finished deployments cannot be cancelled.",
  input: Type.Object(DeploymentRef),
  output: Deployment,
  permission: permission.service("services.deploy", serviceScope),
  mcp: true,
  audit: true,
});

export const rollback = defineOp({
  id: "deployments.rollback",
  kind: "mutation",
  summary: "Roll back to a deployment",
  description:
    "Deploys the image of an earlier successful deployment again, by digest, without building. Settings and environment are the current ones. Fails when the image is no longer kept, (CONFLICT, reason deployRunning) while another deploy of the service is queued or running, and (CONFLICT, reason databaseVersion) for a database's deployment of another image than the one it runs: an older version may not read the files a newer one wrote.",
  input: Type.Object(DeploymentRef),
  output: Deployment,
  permission: permission.service("services.deploy", serviceScope),
  mcp: true,
  audit: true,
});

export const RecentDeployment = Type.Object({
  ...Deployment.properties,
  serviceName: Type.String(),
  projectId: Id,
});

export const recent = defineOp({
  id: "deployments.recent",
  kind: "query",
  summary: "List recent deployments",
  description:
    "Lists the latest deployments across every service the caller can view (or one project's), newest first, failed ones included. For the dashboard's Recent deploys.",
  input: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 5 })),
    projectId: Type.Optional(Id),
  }),
  output: Type.Object({ deployments: Type.Array(RecentDeployment) }),
  // The handler only returns deployments of services the caller holds services.view on.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});
