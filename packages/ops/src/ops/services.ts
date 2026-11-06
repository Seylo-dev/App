// Services are what runs in a project: apps (from GitHub, git, an image,
// an inline Dockerfile or an upload), compose stacks (split into member
// services, see compose.ts), cron jobs, and the database and Box kinds
// that their own modules create. This file has the shapes every screen
// reads and the ops that change a service's settings and run state.
// Deploys are deployments.ts, builds builds.ts, domains/env/IP:port live in
// the networking and env modules.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { BuildSettings } from "./builds";

export const ServiceName = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$",
  description: "DNS-safe; the service's host name on the project network. Unique in its project.",
});

export const ServiceKind = Type.Union(
  [
    Type.Literal("app"),
    Type.Literal("compose"),
    Type.Literal("postgres"),
    Type.Literal("mysql"),
    Type.Literal("mariadb"),
    Type.Literal("mongo"),
    Type.Literal("redis"),
    Type.Literal("valkey"),
    Type.Literal("keydb"),
    Type.Literal("dragonfly"),
    Type.Literal("clickhouse"),
    Type.Literal("box"),
    Type.Literal("cron"),
  ],
  { description: "Compose members have kind app and a parentId naming their stack." },
);

/**
 * Live state from the agents' reports, not stored. "idle" = never
 * deployed; "unknown" = its node is offline; "partial" = some replicas or
 * nodes are down while others serve.
 */
export const ServiceStatus = Type.Union([
  Type.Literal("idle"),
  Type.Literal("building"),
  Type.Literal("deploying"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("partial"),
  Type.Literal("unhealthy"),
  Type.Literal("crashed"),
  Type.Literal("stopped"),
  Type.Literal("unknown"),
]);

export const NodeRef = Type.Object({ id: Id, name: Type.String() });

/** Where a service runs: one row per node, replicas on that node. Several rows = load balanced. */
export const Placement = Type.Object({
  nodeId: Id,
  nodeName: Type.String(),
  replicas: Type.Integer({ minimum: 1, maximum: 32 }),
});

export const GitBranch = Type.String({ minLength: 1, maxLength: 250, pattern: "^[^\\s~^:?*\\[\\\\]+$" });

/**
 * Where the code or image comes from. GitHub sources go through the
 * panel's GitHub App (github.connectRepo); generic git uses a stored
 * credential (git.ts) for private repos; images may use a registry login
 * (registries.ts).
 */
export const Source = Type.Union([
  Type.Object({
    type: Type.Literal("github"),
    /** github_installations.id of the App installation that can read the repo. */
    installationId: Id,
    /** "owner/name". */
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    branch: GitBranch,
    /** Deploy automatically when the branch gets a push. */
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("git"),
    /** https://, ssh:// or git@host:path URL. */
    url: Type.String({ minLength: 1, maxLength: 500, pattern: "^(https://|ssh://|git@)\\S+$" }),
    branch: GitBranch,
    /** git_credentials.id for private repos; null for public ones. */
    credentialId: Type.Union([Id, Type.Null()]),
    /** Generic git hosts deploy on push through the deploy trigger URL (webhooks.ts). */
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("image"),
    /** For example "ghcr.io/acme/api:1.4" or "nginx:1.27". */
    image: Type.String({ minLength: 1, maxLength: 300, pattern: "^\\S+$" }),
    /** registry_credentials.id for private registries; null for public images. */
    registryId: Type.Union([Id, Type.Null()]),
  }),
  Type.Object({
    /** A Dockerfile typed in the panel (builds.inlineDockerfile), built with an empty context. */
    type: Type.Literal("inline"),
  }),
  Type.Object({
    /** An archive uploaded to the panel; each upload becomes a new deploy. */
    type: Type.Literal("upload"),
    /** Name of the last uploaded archive, for display; null before the first upload. */
    fileName: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({ type: Type.Literal("none") }),
]);

/** One line for lists: "GitHub acme/shop-web · main · Railpack", "postgres:17 · internal only". */
export const SourceSummary = Type.Object({
  type: Type.Union([
    Type.Literal("github"),
    Type.Literal("git"),
    Type.Literal("image"),
    Type.Literal("inline"),
    Type.Literal("upload"),
    Type.Literal("compose"),
    Type.Literal("database"),
    Type.Literal("none"),
  ]),
  /** "acme/shop-web", "git.example.com/team/app", "postgres:17". */
  label: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  builder: Type.Union([Type.Literal("railpack"), Type.Literal("nixpacks"), Type.Literal("dockerfile"), Type.Null()]),
});

export const Port = Type.Object({
  containerPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Union([Type.Literal("tcp"), Type.Literal("udp")]),
});

const Seconds = (min: number, max: number) => Type.Integer({ minimum: min, maximum: max });

/** Custom health check. null on a service = TCP on the first port, or "running" without ports. */
export const HealthCheck = Type.Object({
  probe: Type.Union([
    Type.Object({ type: Type.Literal("tcp"), port: Type.Integer({ minimum: 1, maximum: 65535 }) }),
    Type.Object({
      type: Type.Literal("http"),
      port: Type.Integer({ minimum: 1, maximum: 65535 }),
      path: Type.String({ minLength: 1, maxLength: 500, pattern: "^/" }),
      /** Host header to send; "" sends the container address. */
      host: Type.String({ maxLength: 253 }),
      /** 0 = any 2xx or 3xx. */
      expectedStatus: Type.Integer({ minimum: 0, maximum: 599 }),
    }),
    Type.Object({
      type: Type.Literal("command"),
      /** Exec form; exit code 0 is healthy. Use ["sh", "-c", "..."] for shell syntax. */
      command: Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 50 }),
    }),
  ]),
  intervalSeconds: Seconds(1, 3600),
  timeoutSeconds: Seconds(1, 600),
  /** Failures during this time after start do not count. */
  startPeriodSeconds: Seconds(0, 3600),
  /** Consecutive failures before an instance is unhealthy. */
  failureThreshold: Type.Integer({ minimum: 1, maximum: 100 }),
});

/** Enforced by the agent: fixed 5s wait between restarts, one alert per crash streak. */
export const CrashPolicy = Type.Object({
  restart: Type.Boolean({ description: "Off = stay stopped after the first crash." }),
  /** With restart on: give up after this many crashes in a row. 0 = never give up. */
  stopAfterCrashes: Type.Integer({ minimum: 0, maximum: 1000 }),
});

/** All off (null) by default. No hard CPU cap on purpose: CPU is shared by weight. */
export const Resources = Type.Object({
  memoryLimitBytes: Type.Union([Type.Integer({ minimum: 6 * 1024 * 1024 }), Type.Null()]),
  memoryReservationBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** cgroup v2 cpu.weight, default 100. */
  cpuWeight: Type.Union([Type.Integer({ minimum: 1, maximum: 10000 }), Type.Null()]),
  pidsLimit: Type.Union([Type.Integer({ minimum: 16, maximum: 1_000_000 }), Type.Null()]),
});

export const DeployStrategy = Type.Object({
  /** rolling = start new, health check, switch, stop old (zero downtime). recreate = stop old first. */
  mode: Type.Union([Type.Literal("rolling"), Type.Literal("recreate")]),
  /** How long a new version may take to become healthy before the deploy fails and the old one stays. */
  healthTimeoutSeconds: Seconds(10, 3600),
});

export const ContainerSettings = Type.Object({
  /** Overrides the image CMD when not empty. */
  command: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 }),
  /** Overrides the image ENTRYPOINT when not empty. */
  entrypoint: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 }),
  workingDir: Type.String({ maxLength: 500 }),
  user: Type.String({ maxLength: 100 }),
  stopSignal: Type.String({ maxLength: 20, pattern: "^(SIG[A-Z0-9]+)?$" }),
  stopGraceSeconds: Seconds(1, 3600),
});

/** Schedule of a cron service (kind "cron"); runs to completion in a one-off container. */
export const CronSettings = Type.Object({
  /** Standard 5-field cron expression. */
  schedule: Type.String({ minLength: 9, maxLength: 120 }),
  /** IANA zone, for example "Europe/Berlin". */
  timeZone: Type.String({ minLength: 1, maxLength: 64 }),
  command: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 }),
  timeoutSeconds: Seconds(1, 86_400),
  /** forbid = skip while the previous run is going; replace = stop it and start the new one. */
  concurrency: Type.Union([Type.Literal("forbid"), Type.Literal("allow"), Type.Literal("replace")]),
});

export const LiveDeployment = Type.Object({
  id: Id,
  /** Short commit, or the image tag for image sources. */
  label: Type.String(),
  createdAt: Timestamp,
});

/** One row of the project's service list. */
export const ServiceSummary = Type.Object({
  id: Id,
  projectId: Id,
  name: ServiceName,
  kind: ServiceKind,
  /** Compose members: the stack's service id. */
  parentId: Type.Union([Id, Type.Null()]),
  status: ServiceStatus,
  source: SourceSummary,
  /** Main domain, or the internal "name:port" when it has none; null without ports. */
  address: Type.Union([Type.String(), Type.Null()]),
  placements: Type.Array(Placement),
  /** Current usage summed over replicas; null when not running or the node is offline. */
  cpuPercent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  memoryBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  memoryLimitBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  liveDeployment: Type.Union([LiveDeployment, Type.Null()]),
  /** Last activity line: "a1c9e2f · 2 h ago", "building now", "created 12 days ago" are built from these. */
  lastDeployedAt: Type.Union([Timestamp, Type.Null()]),
  protected: Type.Boolean(),
  /** Template slug it was created from. */
  templateSlug: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** A volume or file mount of a service, as the Storage tab lists it. */
export const Volume = Type.Object({
  id: Id,
  /** Folder name on the node; files.* take it as `volume`. */
  name: Type.String(),
  mountPath: Type.String(),
  kind: Type.Union([Type.Literal("volume"), Type.Literal("file")]),
  readOnly: Type.Boolean(),
  /** Compose members that mount the same folder. */
  sharedWith: Type.Array(Type.Object({ id: Id, name: ServiceName })),
});

/**
 * The agent's rule for names on disk (go/internal/datadir idRe): no dots, at
 * most 63 characters. A name the agent refuses would hold up every desired
 * state sent to the node.
 */
export const volumeNamePattern = "^[a-z0-9][a-z0-9_-]*$";
export const VolumeName = Type.String({ minLength: 1, maxLength: 60, pattern: volumeNamePattern });

/** Everything the service page shows. */
export const ServiceDetail = Type.Object({
  ...ServiceSummary.properties,
  /** Desired run state: stopped services keep volumes, routes (status page) and history. */
  stopped: Type.Boolean(),
  generation: Type.Integer({ minimum: 1 }),
  sourceConfig: Source,
  build: BuildSettings,
  container: ContainerSettings,
  ports: Type.Array(Port),
  healthCheck: Type.Union([HealthCheck, Type.Null()]),
  crashPolicy: CrashPolicy,
  /** Fixed, shown next to the crash policy. */
  restartDelaySeconds: Type.Integer({ minimum: 0 }),
  resources: Resources,
  deploy: DeployStrategy,
  /** Set for kind "cron". */
  cron: Type.Union([CronSettings, Type.Null()]),
  stickySessions: Type.Boolean(),
  /**
   * Load balancing over several nodes: the node whose edge takes the public
   * traffic (point domains at it) and spreads it over every placement; the
   * other nodes serve only their own replicas. Null: no entry node, every
   * node balances its own domains' traffic over all of them.
   */
  entryNodeId: Type.Union([Id, Type.Null()]),
  notes: Type.String(),
  /** Members of a compose stack (kind "compose"); empty for other kinds. */
  members: Type.Array(Type.Object({ id: Id, name: ServiceName, status: ServiceStatus })),
  volumes: Type.Array(Volume),
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;
const projectScope = (input: { projectId: string }) => input.projectId;

export const list = defineOp({
  id: "services.list",
  kind: "query",
  summary: "List a project's services",
  description:
    "Lists the services of a project with their kind, live status, source line, address, nodes, current CPU and memory, and live version. Compose members follow their stack.",
  input: Type.Object({ projectId: Id }),
  output: Type.Object({ services: Type.Array(ServiceSummary) }),
  permission: permission.project("services.view", projectScope),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "services.get",
  kind: "query",
  summary: "Get a service",
  description: "Returns one service with its live status and every setting the service page shows.",
  input: Type.Object({ serviceId: Id }),
  output: ServiceDetail,
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "services.create",
  kind: "mutation",
  summary: "Create an app or cron service",
  description:
    "Creates an app or cron service in a project on one node. The source can be set now or later (services.setSource, github.connectRepo). Nothing runs until the first deploy, unless deployNow is true. Databases, Boxes, compose stacks and templates have their own create ops.",
  input: Type.Object({
    projectId: Id,
    name: ServiceName,
    kind: Type.Union([Type.Literal("app"), Type.Literal("cron")]),
    nodeId: Id,
    source: Type.Optional(Source),
    build: Type.Optional(Type.Partial(BuildSettings)),
    ports: Type.Optional(Type.Array(Port, { maxItems: 20 })),
    /** Required for kind "cron". */
    cron: Type.Optional(CronSettings),
    deployNow: Type.Optional(Type.Boolean({ default: false })),
  }),
  output: ServiceDetail,
  permission: permission.project("services.create", projectScope),
  mcp: true,
  audit: true,
});

export const update = defineOp({
  id: "services.update",
  kind: "mutation",
  summary: "Change a service's general settings",
  description:
    "Renames a service or changes its container settings, ports or cron schedule. Omitted fields keep their value. Changes to what runs apply on the next deploy; a rename updates the network alias on the next deploy too.",
  input: Type.Object({
    serviceId: Id,
    name: Type.Optional(ServiceName),
    container: Type.Optional(Type.Partial(ContainerSettings)),
    ports: Type.Optional(Type.Array(Port, { maxItems: 20 })),
    cron: Type.Optional(CronSettings),
  }),
  output: ServiceDetail,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setSource = defineOp({
  id: "services.setSource",
  kind: "mutation",
  summary: "Change where a service's code or image comes from",
  description:
    "Switches a service to a git URL, a Docker image, an inline Dockerfile, uploads or no source. For GitHub repositories use github.connectRepo, which checks the App can read the repo. Applies on the next deploy.",
  input: Type.Object({ serviceId: Id, source: Source }),
  output: ServiceDetail,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setNotes = defineOp({
  id: "services.setNotes",
  kind: "mutation",
  summary: "Edit a service's notes",
  description:
    "Replaces the free-text notes of a service (Markdown, shown on its Notes tab). Notes are not secret; keep secrets in the environment.",
  input: Type.Object({ serviceId: Id, notes: Type.String({ maxLength: 20_000 }) }),
  output: Type.Object({ notes: Type.String(), updatedAt: Timestamp }),
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setHealthCheck = defineOp({
  id: "services.setHealthCheck",
  kind: "mutation",
  summary: "Set a service's health check and deploy strategy",
  description:
    "Sets the custom health check (null = TCP on the first port) and how deploys roll out: rolling (zero downtime, health gated) or recreate, and how long a new version may take to become healthy. Applies on the next deploy.",
  input: Type.Object({
    serviceId: Id,
    healthCheck: Type.Union([HealthCheck, Type.Null()]),
    deploy: Type.Optional(DeployStrategy),
  }),
  output: Type.Object({ healthCheck: Type.Union([HealthCheck, Type.Null()]), deploy: DeployStrategy }),
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setCrashPolicy = defineOp({
  id: "services.setCrashPolicy",
  kind: "mutation",
  summary: "Set a service's crash policy",
  description:
    "Restart on or off after a crash, and with restart on, whether to stop after N crashes in a row (0 = never). The wait between restarts is a fixed 5 seconds. Applies to running containers right away.",
  input: Type.Object({ serviceId: Id, ...CrashPolicy.properties }),
  output: Type.Object({ crashPolicy: CrashPolicy, restartDelaySeconds: Type.Integer({ minimum: 0 }) }),
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setResources = defineOp({
  id: "services.setResources",
  kind: "mutation",
  summary: "Set a service's resource limits",
  description:
    "Sets memory limit and reservation, CPU weight and process limit. Every field is off (null) by default; there is no hard CPU cap. Applies on the next deploy.",
  input: Type.Object({ serviceId: Id, ...Resources.properties }),
  output: Resources,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setVolumes = defineOp({
  id: "services.setVolumes",
  // Destructive: a volume left out is deleted with its data on the next deploy's cleanup.
  kind: "destructive",
  summary: "Set a service's volumes",
  description:
    "Replaces a service's named volumes (persistent folders mounted into the container). Volumes are matched by name: new names are created, missing ones are removed with their data. Applies on the next deploy. Services with volumes run on one node.",
  input: Type.Object({
    serviceId: Id,
    volumes: Type.Array(
      Type.Object({
        name: VolumeName,
        mountPath: Type.String({ minLength: 1, maxLength: 500, pattern: "^/" }),
        readOnly: Type.Optional(Type.Boolean({ default: false })),
      }),
      { maxItems: 20 },
    ),
  }),
  output: Type.Object({ volumes: Type.Array(Volume) }),
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setPlacements = defineOp({
  id: "services.setPlacements",
  kind: "mutation",
  summary: "Set replicas per node",
  description:
    "Sets on which nodes a service runs and how many replicas on each. Several nodes are load balanced through each node's edge. Services with volumes run on one node only (use services.move to change it). Deploys the change right away.",
  input: Type.Object({
    serviceId: Id,
    placements: Type.Array(Type.Object({ nodeId: Id, replicas: Type.Integer({ minimum: 1, maximum: 32 }) }), {
      minItems: 1,
      maxItems: 64,
    }),
    stickySessions: Type.Optional(Type.Boolean()),
    /** Node that takes the public traffic; must be one of the placements. Null clears it; leave it out to keep it. */
    entryNodeId: Type.Optional(Type.Union([Id, Type.Null()])),
  }),
  output: Type.Object({
    placements: Type.Array(Placement),
    stickySessions: Type.Boolean(),
    entryNodeId: Type.Union([Id, Type.Null()]),
  }),
  permission: permission.service("services.scale", serviceScope),
  mcp: true,
  audit: true,
});

export const move = defineOp({
  id: "services.move",
  kind: "mutation",
  summary: "Move a service to another node",
  description:
    "Moves a single-node service to another node: deploys it there, copies its volumes while the old copy is stopped, switches traffic, then removes the old copy. Progress shows as a deployment with trigger move; on failure the service stays on the old node.",
  input: Type.Object({ serviceId: Id, toNodeId: Id }),
  output: Type.Object({ deploymentId: Id }),
  permission: permission.service("services.move", serviceScope),
  mcp: true,
  audit: true,
});

export const start = defineOp({
  id: "services.start",
  kind: "mutation",
  summary: "Start a stopped service",
  description: "Starts a stopped service with its live version on its nodes. Does not deploy new code.",
  input: Type.Object({ serviceId: Id }),
  output: Empty,
  permission: permission.service("services.control", serviceScope),
  mcp: true,
  audit: true,
});

export const stop = defineOp({
  id: "services.stop",
  kind: "mutation",
  summary: "Stop a service",
  description: "Stops every replica of a service. Volumes, domains (which show the status page) and history stay; start brings it back.",
  input: Type.Object({ serviceId: Id }),
  output: Empty,
  permission: permission.service("services.control", serviceScope),
  mcp: true,
  audit: true,
});

export const restart = defineOp({
  id: "services.restart",
  kind: "mutation",
  summary: "Restart a service",
  description:
    "Restarts the running containers of a service without deploying: same version, same settings. Use deployments.deploy to apply changed settings.",
  input: Type.Object({ serviceId: Id }),
  output: Empty,
  permission: permission.service("services.control", serviceScope),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "services.delete",
  kind: "destructive",
  summary: "Delete a service",
  description:
    "Deletes a service with its containers, volumes, files, domains, deploy history and kept images on every node. Deleting a compose stack deletes its members. Protected services cannot be deleted. The caller repeats the service name to confirm.",
  input: Type.Object({
    serviceId: Id,
    confirmName: Type.String({ description: "Must equal the service's name." }),
  }),
  output: Empty,
  permission: permission.service("services.delete", serviceScope),
  mcp: true,
  audit: true,
});
