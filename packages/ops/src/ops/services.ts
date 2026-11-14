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
import { Empty, GitUrl, Id, Timestamp } from "../schemas";
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
 * nodes are down while others serve. In ServiceSummary.status a deploy in
 * progress wins ("building" while queued or building, "deploying" while it
 * rolls out); ServiceSummary.runtimeStatus is what runs meanwhile.
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

/** The git hosts with a native connection besides GitHub (gitProviders.ts). */
export const GitProviderKind = Type.Union([Type.Literal("gitlab"), Type.Literal("gitea"), Type.Literal("bitbucket")], {
  description: '"gitea" covers Forgejo too.',
});

/** A repository path at a git provider: "group/sub/project" (GitLab), "owner/name" (Gitea), "workspace/slug" (Bitbucket). */
export const RepoFullPath = Type.String({
  minLength: 3,
  maxLength: 300,
  pattern: "^(?!(.*/)?\\.{1,2}(/|$))[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$",
});

/** Watch paths: glob patterns (*, **, ?, ! excludes; the last match wins) a push must touch to deploy. */
export const WatchPaths = Type.Array(Type.String({ minLength: 1, maxLength: 300, pattern: "^[^\\n\\r\\t]+$" }), { maxItems: 50 });

/**
 * Where the code or image comes from. GitHub sources go through the
 * panel's GitHub App or its connected GitHub account (github.connectRepo);
 * GitLab, Gitea/Forgejo and Bitbucket through a stored connection
 * (gitProviders.connectRepo); generic git uses a stored credential (git.ts)
 * for private repos; images may use a registry login (registries.ts).
 */
export const Source = Type.Union([
  Type.Object({
    type: Type.Literal("github"),
    /** github_installations.id of the App installation that can read the repo; null when the connected GitHub account reads it (accountId). */
    installationId: Type.Union([Id, Type.Null()]),
    /**
     * git_credentials.id of the panel's connected GitHub account (Settings >
     * GitHub: a device login or a pasted token) when it reads the repo instead
     * of an App installation. Its token lists, clones and creates the repository
     * webhook; when the account was connected again under a new id, the current
     * one is used.
     */
    accountId: Type.Optional(Type.Union([Id, Type.Null()])),
    /** "owner/name". */
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    branch: GitBranch,
    /** Deploy automatically when the branch gets a push. */
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("git"),
    /** https://, ssh:// or git@host:path URL. */
    url: GitUrl,
    branch: GitBranch,
    /** git_credentials.id for private repos; null for public ones. */
    credentialId: Type.Union([Id, Type.Null()]),
    /** Generic git hosts deploy on push through the deploy trigger URL (webhooks.ts). */
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("provider"),
    /** git_providers.id: the GitLab, Gitea/Forgejo or Bitbucket connection (gitProviders.ts). */
    providerId: Id,
    /** The connection's kind, for display; gitProviders.connectRepo sets it. */
    provider: GitProviderKind,
    repo: RepoFullPath,
    branch: GitBranch,
    /** Deploy automatically when the branch gets a push (through the repository webhook the panel creates). */
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
    Type.Literal("gitlab"),
    Type.Literal("gitea"),
    Type.Literal("bitbucket"),
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

/**
 * Custom health check. null on a service = the image's own HEALTHCHECK when it declares one (apps and
 * compose members, from their next deploy), else TCP on the first port, or "running" without ports.
 */
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

/**
 * The HEALTHCHECK a service's image declares, as its node reported it on
 * the last deploy (Docker's defaults filled in). Deploys and the health
 * watch follow Docker's status of it when the service has no check of its
 * own.
 */
export const ImageHealthCheck = Type.Object({
  /** Docker's form: ["CMD", program, args...] or ["CMD-SHELL", command]. */
  test: Type.Array(Type.String()),
  intervalSeconds: Type.Number({ minimum: 0 }),
  timeoutSeconds: Type.Number({ minimum: 0 }),
  startPeriodSeconds: Type.Number({ minimum: 0 }),
  /** Failed checks in a row before Docker calls the container unhealthy. */
  retries: Type.Integer({ minimum: 0 }),
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
  /**
   * How long a new version may take to become healthy before the deploy fails and the old one stays.
   * The default, 300, grows to fit the image's own HEALTHCHECK (its start period and retries) when that applies.
   */
  healthTimeoutSeconds: Seconds(10, 3600),
});

/** A service's init process (ContainerConfig.init on the node); the rule for auto is the agent's docker.OwnInit. */
export const InitProcess = Type.Union([Type.Literal("auto"), Type.Literal("on"), Type.Literal("off")], {
  description:
    "Init process. auto (default): Docker's init (Tini) as PID 1, forwarding stop signals to the app and reaping zombies, unless the image runs its own init as PID 1 (its entrypoint, or command without one, is s6-overlay's /init, another init or systemd, tini, dumb-init, docker-init, catatonit or s6-*). on: always. off: never. Applies on the next deploy.",
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
  /** Missing reads as "auto" (services.get always says). Compose members take it from the file's init:, else auto. */
  init: Type.Optional(InitProcess),
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
  /**
   * True while status is building and the deploy's build waits for a free
   * slot of its node's Builds at once (Deployment.buildWait). Added in 0.2.15.
   */
  buildWaiting: Type.Boolean(),
  /**
   * What runs now, whatever a deploy in progress does: status without the
   * deploy's "building" and "deploying" (the live version's running,
   * partial, unhealthy, crashed, stopped or unknown; "idle" before anything
   * was deployed), and on a node that rolls a new version out next to the
   * one that serves, the state of that one. The same as status while no
   * deploy runs. Screens show it as the status dot while a live version
   * exists; status and buildWaiting say what the deploy does. Added in
   * 0.2.17.
   */
  runtimeStatus: ServiceStatus,
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

/**
 * A clone's data copy (services.clone with data "copy"): the source's
 * volumes are copied into the clone's folders on its node. The clone
 * cannot deploy until it ended.
 */
export const DataCopy = Type.Object({
  id: Id,
  status: Type.Union([Type.Literal("queued"), Type.Literal("copying"), Type.Literal("done"), Type.Literal("failed")]),
  /** Name of the service the data comes from. */
  fromName: Type.String(),
  volumes: Type.Array(Type.String()),
  bytesCopied: Type.Integer({ minimum: 0 }),
  /** Why it failed; the clone keeps whatever arrived and can still start empty. */
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Union([Timestamp, Type.Null()]),
  finishedAt: Type.Union([Timestamp, Type.Null()]),
});

/**
 * A service export whose download runs or just ended, or an import that
 * still receives the file's data (modules/serviceTransfer). Shown under the
 * service's header.
 */
export const ServiceTransfer = Type.Object({
  kind: Type.Union([Type.Literal("export"), Type.Literal("import")]),
  id: Id,
  /** export: ready, streaming, done, failed, cancelled. import: receiving, done, failed. */
  status: Type.String(),
  /** export: bytes of the .zip sent; import: bytes received of the entries. */
  bytes: Type.Integer({ minimum: 0 }),
  /** import: every entry's size together; null for exports (the size is known at the end). */
  totalBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** export: the download stopped the service and starts it again when it ends. */
  stopped: Type.Boolean(),
  /** export: the volumes in the file. */
  volumes: Type.Array(Type.String()),
  /** export, once done: the .zip's sha256, to compare with `shasum -a 256`. */
  sha256: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Union([Timestamp, Type.Null()]),
  finishedAt: Type.Union([Timestamp, Type.Null()]),
});

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
  /**
   * The port the service listens on as far as the panel can tell: its first
   * TCP port; for an app built from a repository without one, the port its
   * domains point at, else 80, which is also the PORT it gets. null for any
   * other service without a port. What port fields start with.
   */
  appPort: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
  healthCheck: Type.Union([HealthCheck, Type.Null()]),
  /**
   * Without a check of its own (healthCheck null), apps and compose members
   * deployed from 0.2.15 wait for their image's own HEALTHCHECK: what the
   * node reported for the live deployment (else the one rolling out). Null
   * when the image declares none, before such a deploy and on nodes before
   * 0.2.15: then TCP on the first port applies.
   */
  imageHealthCheck: Type.Optional(Type.Union([ImageHealthCheck, Type.Null()])),
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
  members: Type.Array(
    Type.Object({
      id: Id,
      name: ServiceName,
      status: ServiceStatus,
      /** As ServiceSummary.buildWaiting. Added in 0.2.15. */
      buildWaiting: Type.Boolean(),
      /** As ServiceSummary.runtimeStatus. Added in 0.2.17. */
      runtimeStatus: ServiceStatus,
      /** As ServiceSummary.liveDeployment: whether a live version exists for runtimeStatus to describe. Added in 0.2.17. */
      liveDeployment: Type.Union([LiveDeployment, Type.Null()]),
    }),
  ),
  volumes: Type.Array(Volume),
  /** Patterns a push must touch to deploy (services.setWatchPaths); empty = every push deploys. */
  watchPaths: WatchPaths,
  /** Clones: the newest copy of the source's data, while it runs and after. */
  dataCopy: Type.Optional(Type.Union([DataCopy, Type.Null()])),
  /** An export download that runs or ended in the last 10 minutes, or an import that still receives data. */
  transfer: Type.Optional(Type.Union([ServiceTransfer, Type.Null()])),
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

export const reorder = defineOp({
  id: "services.reorder",
  kind: "mutation",
  summary: "Reorder a project's services",
  description:
    "Sets the order of a project's services in the caller's own sidebar, dashboard and project page. serviceIds lists the project's services top to bottom; compose members follow their stack, ids of other projects or members are ignored, and unlisted services follow by name. Other people's order does not change.",
  input: Type.Object({ projectId: Id, serviceIds: Type.Array(Id, { maxItems: 1000, uniqueItems: true }) }),
  output: Type.Object({ projectId: Id, serviceIds: Type.Array(Id) }),
  permission: permission.project("services.view", projectScope),
  mcp: false,
  audit: true,
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
    "Creates an app or cron service in a project on one node. The source can be set now or later (services.setSource, github.connectRepo). Nothing runs until the first deploy, unless deployNow is true (which needs services.deploy in the project). Databases, Boxes, compose stacks and templates have their own create ops.",
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
    "Renames a service or changes its container settings (command, entrypoint, working directory, user, stop signal and timeout, init process), ports or cron schedule. Omitted fields keep their value. container.init: auto (default) runs Docker's init (Tini) as PID 1 to forward stop signals and reap zombies, unless the image runs its own init (s6-overlay's /init, tini, dumb-init, s6); on always; off never. Changes to what runs apply on the next deploy; a rename updates the network alias on the next deploy too. Changing the main port (the first TCP port) to one that was not among the ports moves what sent traffic to the old one, as services.usePort does: the domains whose target port it was (a domain on another port stays), the first-run IP:port port and open timed exposes on it, and the Cloudflare tunnel on it. They move at once when no live version listens on the old port (nothing deployed, or the port was never deployed); otherwise when the next deploy rolls out, with its new containers, and back to the live version's port if that deploy fails or is cancelled (the port stays as set).",
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
    "Switches a service to a git URL, a Docker image, an inline Dockerfile, uploads or no source. For GitHub repositories use github.connectRepo, which checks the App can read the repo; for GitLab, Gitea/Forgejo and Bitbucket use gitProviders.connectRepo, which also creates the repository webhook. Applies on the next deploy.",
  input: Type.Object({ serviceId: Id, source: Source }),
  output: ServiceDetail,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const setWatchPaths = defineOp({
  id: "services.setWatchPaths",
  kind: "mutation",
  summary: "Set a service's watch paths",
  description:
    'Sets the glob patterns a push must touch to deploy the service (for monorepos), in order: * (not across "/"), ** (across folders), ?, and ! to exclude; the last pattern that matches a file decides. Patterns start at the repository root: one with a "." or ".." segment (such as apps/docs/..) never matches and is refused; to watch a folder, write apps/docs/**. A push deploys when at least one changed file counts; when the changed files cannot be known it deploys. An empty list deploys on every push. Applies to GitHub, GitLab, Gitea/Forgejo and Bitbucket pushes, branch polling and the deploy trigger URL.',
  input: Type.Object({ serviceId: Id, watchPaths: WatchPaths }),
  output: Type.Object({ watchPaths: WatchPaths }),
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
    "Sets the custom health check and how deploys roll out: rolling (zero downtime, health gated) or recreate, and how long a new version may take to become healthy. null = the default: the image's own HEALTHCHECK when it declares one (apps and compose members; deploys wait for Docker to call the container healthy, through its start period), else TCP on the first port. With the image's HEALTHCHECK the default health timeout (300) grows to its start period plus retries x (interval + timeout) plus a minute; any other timeout is used as set. Applies on the next deploy.",
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
    "Sets on which nodes a service runs and how many replicas on each. Several nodes are load balanced through each node's edge. Services with volumes run on one node only (use services.move to change it). Deploys the change right away. A change of nodes (replica counts alone are fine) is refused (CONFLICT, reason deployRunning, with the deploymentId and serviceId of that deploy) while a deploy of the service is queued, building or rolling out: it rolls out on the nodes it started with, so wait for it or cancel it (deployments.cancel) first.",
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
    "Moves a single-node service to another node: deploys it there, copies its volumes while the old copy is stopped, switches traffic, then removes the old copy. Its IP:port access (a database's exposed port, timed exposes, the first-run port) moves to the new node once it is live, on the same port unless another service has it there. Progress shows as a deployment with trigger move; on failure the service stays on the old node. services.moveImpact says beforehand what changes and which nodes can take it. Refused (CONFLICT, reason deployRunning, with the deploymentId and serviceId of that deploy) while a deploy of the service is queued or running, and (reason backupRunning or restoreRunning) while one of its backups or restores runs; with volumes, refused while either node is offline (UNAVAILABLE, reason offline) or its agent cannot copy volumes (NOT_IMPLEMENTED, reason agentTooOld); a database also needs a target whose agent runs its engine and, while exposed, keeps its port TLS only and takes clients without TLS when it allows them (CONFLICT, reason agentTooOld).",
  input: Type.Object({ serviceId: Id, toNodeId: Id }),
  output: Type.Object({ deploymentId: Id }),
  permission: permission.service("services.move", serviceScope),
  mcp: true,
  audit: true,
});

/** Why services.move refuses: the reason it answers with (CONFLICT, UNAVAILABLE or NOT_IMPLEMENTED) and its message. */
export const NodeMoveRefusal = Type.Object({
  /**
   * compose, protected, panel, placements (not on exactly one node),
   * notDeployed, noImage, deployRunning, copying, exporting, importing,
   * backupRunning, restoreRunning, disabled, offline, agentTooOld.
   */
  reason: Type.String(),
  message: Type.String(),
});

/** A service of the same project that uses the moving service's address. */
export const NodeMoveReferrer = Type.Object({
  serviceId: Id,
  name: ServiceName,
  /** Their variables that do; empty when you cannot read their environment. */
  keys: Type.Array(Type.String()),
  /** The nodes it runs on. */
  nodeIds: Type.Array(Id),
});

/** What moving a service to another node does (Added in 0.2.16). */
export const NodeMoveImpact = Type.Object({
  /** Why it cannot move to any node now; null when it can (to a target without a refusal of its own). */
  blocker: Type.Union([NodeMoveRefusal, Type.Null()]),
  /** Every other node, with why the service cannot move there (null when it can). */
  targets: Type.Array(
    Type.Object({
      id: Id,
      name: Type.String(),
      online: Type.Boolean(),
      /** Its public address (IPv4, else IPv6), what a database's EXPOSED_HOST is there without a TLS host name; null when unknown. */
      address: Type.Union([Type.String(), Type.Null()]),
      refusal: Type.Union([NodeMoveRefusal, Type.Null()]),
    }),
  ),
  /** Its data volumes. With any it is stopped while they are copied (downtime grows with their size); without, both nodes run until the new one is live. */
  volumes: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
  /** A database's size inside the engine at its newest whole backup that measured it; null when the panel does not know. */
  dataSize: Type.Union([Type.Object({ bytes: Type.Integer({ minimum: 0 }), measuredAt: Timestamp }), Type.Null()]),
  /** The newest successful backup; a fresh one before moving is recommended. */
  lastBackupAt: Type.Union([Timestamp, Type.Null()]),
  /** Its backup schedules: they keep their times and run on the new node (one due during the move runs once it ends). */
  backupSchedules: Type.Integer({ minimum: 0 }),
  /** What listens on the node's own address: it moves to the new node's (the port too, unless another service has it there). */
  exposure: Type.Object({
    /** A database's exposed port: on with TLS, its allowed IPs and allowPlain, at the new node's address (the same TLS host name, whose DNS must then point there). */
    database: Type.Union([
      Type.Object({
        port: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
        tlsHostname: Type.Union([Type.String(), Type.Null()]),
        allowPlain: Type.Boolean(),
      }),
      Type.Null(),
    ]),
    /** Open timed exposes; they keep their end and allowed IPs. */
    timed: Type.Integer({ minimum: 0 }),
    /** The first-run IP:port is open. */
    firstRun: Type.Boolean(),
  }),
  /** Services of its project that read its EXPOSED_URL, EXPOSED_HOST or EXPOSED_PORT: they get the new address on their next deploy. */
  exposedReferrers: Type.Array(NodeMoveReferrer),
  /**
   * Services of its project that use its internal address (INTERNAL_URL,
   * INTERNAL_HOST, its name as a host): it stays the same, but there is no
   * private network between nodes, so only those on the new node reach it.
   */
  internalReferrers: Type.Array(NodeMoveReferrer),
  /** Services that reference it which you cannot see. */
  hiddenReferrers: Type.Integer({ minimum: 0 }),
});

export const moveImpact = defineOp({
  id: "services.moveImpact",
  kind: "query",
  summary: "Show what moving a service to another node does",
  description:
    "Lists what services.move would do and where it can go: why it cannot move now (blocker) and, per other node, why it cannot go there (offline, disabled, an agent too old to copy volumes or to run the database's engine and exposure); its volumes (copied while it is stopped) and a database's size at its last backup; its backups (they keep their schedules and run on the new node); what listens on the node's address and moves to the new node's (a database's exposed port, timed exposes, the first-run IP:port); and the services of its project that use its exposed address (they need a deploy) or its internal one (only those on the new node reach it). Names and keys only where you may see them. Added in 0.2.16.",
  input: Type.Object({ serviceId: Id }),
  output: NodeMoveImpact,
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const usePort = defineOp({
  id: "services.usePort",
  kind: "mutation",
  summary: "Switch a service to the port its app listens on",
  description:
    "For a deploy that failed because the app listens on another port than the service's (Deployment.portHint, \"The app listens on port 6000, not 80.\"): sets the service's first TCP port to port (replacing fromPort, the one the failed deploy checked), moves what sent traffic to fromPort there (its domains, its first-run IP:port access and open timed exposes, its Cloudflare tunnel), and starts a deploy, which returns. A built app's PORT follows the port as usual. When a live version serves, those move when the new deployment rolls out, so the live one keeps its routes and addresses meanwhile, and they and the port go back to fromPort if that deployment fails or is cancelled; when the live version listens on yet another port (one set by hand with services.update since), what points at that port moves with them and goes back there. Needs services.deploy too. Refused (CONFLICT) for compose members (their ports come from the stack's compose file) and services other than apps, with reason portChanged when the service's first port is no longer fromPort, and with reason deployRunning (deploymentId, serviceId) while a deploy of it is queued or running.",
  input: Type.Object({
    serviceId: Id,
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    /** The port the failed deploy checked (Deployment.portHint.port); refused when the service's port is no longer this one. */
    fromPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  }),
  output: Type.Object({
    deploymentId: Id,
    ports: Type.Array(Port),
    /** Domains whose target port moves to port: now, or when the deployment rolls out (domainsMove "rollout"). */
    domainIds: Type.Array(Id),
    domainsMove: Type.Union([Type.Literal("now"), Type.Literal("rollout")]),
  }),
  permission: permission.service("services.update", serviceScope),
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

/** Variables of a service that point at something its project provides. */
export const ReferenceEffect = Type.Object({
  /** The variable that holds it. */
  key: Type.String(),
  /** "db.URL" for ${{db.URL}}, "project.API_KEY" for a shared variable, "db:5432" for a host name in a value. */
  target: Type.String(),
  via: Type.Union([Type.Literal("reference"), Type.Literal("hostname")]),
  /**
   * unresolved: the new project has nothing by that name. retargeted: it now means the new project's
   * service or variable. renamed (clones only): it named the source itself and names the clone instead.
   */
  effect: Type.Union([Type.Literal("unresolved"), Type.Literal("retargeted"), Type.Literal("renamed")]),
});

export const CloneDataMode = Type.Union([Type.Literal("empty"), Type.Literal("copy")], {
  description: "empty: the clone's volumes start empty. copy: the source's volume data is copied into them.",
});

/** Why copying data is not offered. */
export const CloneDataBlock = Type.Union([
  Type.Literal("noVolumes"),
  /** Databases copy their files and logins together, which needs databases.credentials on the source. */
  Type.Literal("databaseLogins"),
  /** Needs files.read on the source. */
  Type.Literal("files"),
  Type.Literal("offline"),
  Type.Literal("agentTooOld"),
  /** A running database stops for its copy, which needs services.control on it. */
  Type.Literal("control"),
]);

export const clonePreview = defineOp({
  id: "services.clonePreview",
  kind: "query",
  summary: "Show what a clone of a service would get",
  description:
    "Says what services.clone would copy for you into the given project and node: the suggested name, whether the environment comes along (only when you can read it on the source and edit it in the target project), the volumes and whether their data can be copied, the automatic domain the clone can get, and the variables that change meaning: ones that named the source itself (renamed to the clone) and ones that would point at nothing or at another service in the target project.",
  input: Type.Object({
    serviceId: Id,
    /** Target project; defaults to the source's. */
    projectId: Type.Optional(Id),
    /** Target node; defaults to the source's first node. */
    nodeId: Type.Optional(Id),
  }),
  output: Type.Object({
    name: ServiceName,
    kind: ServiceKind,
    projectId: Id,
    nodeId: Id,
    /**
     * copied: the .env and file mounts come along. hidden: you cannot read them, so the clone starts without.
     * noWrite: you cannot edit env (env.edit), or files for file mounts (files.write), in the target project,
     * so the clone starts without. none: there are none.
     */
    env: Type.Union([Type.Literal("copied"), Type.Literal("hidden"), Type.Literal("noWrite"), Type.Literal("none")]),
    volumes: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
    data: Type.Object({
      available: Type.Boolean(),
      blockedBy: Type.Union([CloneDataBlock, Type.Null()]),
      /** Databases always stop while their files are read (a running database's files are not a usable copy). */
      alwaysStops: Type.Boolean(),
    }),
    /** Host of the automatic domain the clone can get on the target node; null when it cannot get one. */
    autoDomain: Type.Union([Type.String(), Type.Null()]),
    /** The source's main domain has access rules (basic auth, IP allowlist, rate limit, redirects) that go to the automatic domain. */
    middlewares: Type.Boolean(),
    /**
     * Variables of the copied .env that change meaning: references and host names that named the source
     * itself (renamed), a value that is just the source's name (it now reaches the source, or the target
     * project's service of that name), and in another project what would point at nothing or at something else.
     */
    references: Type.Array(ReferenceEffect),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const clone = defineOp({
  id: "services.clone",
  kind: "mutation",
  summary: "Clone a service",
  description:
    "Copies a service (app, cron, database, Box, or a compose member as a standalone app) into the same or another project and node: source, build settings, environment (only when you can read it and may edit env, and files for file mounts, in the target project; its references to the source itself name the clone), health check, resources, crash policy, notes, and the main domain's access rules onto a new automatic domain. Domains, deploy history, cron jobs, backups, alerts and exposed ports are not copied. Volumes start empty or get a copy of the source's data (the source stops during the copy when stopSource is set, always for databases). A repository source (GitHub, a git URL, GitLab, Gitea or Bitbucket) keeps its Deploy on push setting unless deployOnPush says otherwise; while it is on, pushes to the branch deploy the clone too (through a repository webhook of its own when the connected GitHub account or a provider connection reads the repository). The clone is created stopped and named <name>-copy unless named. Needs services.view on the source and services.create in the target project.",
  input: Type.Object({
    serviceId: Id,
    projectId: Id,
    nodeId: Id,
    name: Type.Optional(ServiceName),
    data: Type.Optional(CloneDataMode),
    /** With data "copy": stop the source while its files are read, then start it again. Databases always stop. Default true. */
    stopSource: Type.Optional(Type.Boolean()),
    /** Add an automatic domain from the target node's wildcard record (needs domains.edit there). */
    autoDomain: Type.Optional(Type.Boolean()),
    /**
     * Deploy the clone on each push to its branch: repository sources only (github, git, provider), the
     * others have no such setting and ignore it. Left out, the clone keeps the source's setting.
     */
    deployOnPush: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    service: ServiceDetail,
    /** What came along for you. */
    copied: Type.Object({
      env: Type.Boolean(),
      fileMounts: Type.Boolean(),
      /** Database logins (copied with the data; a clone that starts empty gets new ones). */
      databaseLogins: Type.Boolean(),
      middlewares: Type.Boolean(),
      autoDomain: Type.Union([Type.String(), Type.Null()]),
    }),
    dataCopy: Type.Union([DataCopy, Type.Null()]),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: true,
});

export const MoveBlock = Type.Union([
  Type.Literal("sameProject"),
  Type.Literal("protected"),
  Type.Literal("compose"),
  Type.Literal("preview"),
  Type.Literal("previews"),
  Type.Literal("nameTaken"),
  Type.Literal("deploying"),
  Type.Literal("copying"),
  /** An export downloads its data, or an import still sends it its files. */
  Type.Literal("exporting"),
  Type.Literal("importing"),
  /** Moving needs every service action on it: the new project may give you more than you hold now. */
  Type.Literal("access"),
  /** A service of the new project already references its name for more than an address. */
  Type.Literal("references"),
]);

/** What moving a service to another project changes. */
export const MoveImpact = Type.Object({
  /** Reasons the move cannot run; services.moveProject answers CONFLICT or FORBIDDEN with the same reason. */
  blockers: Type.Array(Type.Object({ reason: MoveBlock, message: Type.String() })),
  /** Services of the old project that reach this one by ${{name.VAR}} or its host name, and lose it. */
  referencedBy: Type.Array(
    Type.Object({
      serviceId: Id,
      name: ServiceName,
      /** Their variables that do; empty when you cannot read their environment. */
      keys: Type.Array(Type.String()),
    }),
  ),
  /** Services of the old project you cannot see that reference it. */
  hiddenReferrers: Type.Integer({ minimum: 0 }),
  /**
   * Services of the new project that already use its name: their
   * references start reading its variables and their host names start
   * reaching it.
   */
  targetReferrers: Type.Array(Type.Object({ serviceId: Id, name: ServiceName, keys: Type.Array(Type.String()) })),
  /** Services of the new project you cannot see that already use its name. */
  hiddenTargetReferrers: Type.Integer({ minimum: 0 }),
  /** The service's own variables that point into the old project. */
  ownReferences: Type.Array(ReferenceEffect),
  /** Shared variables of the old project it receives now that the new project does not have. Names only when you can read them. */
  sharedLost: Type.Object({ count: Type.Integer({ minimum: 0 }), names: Type.Array(Type.String()) }),
  /** Grants on the service itself go: access follows the new project. Names only when you may see who has access. */
  grants: Type.Object({ count: Type.Integer({ minimum: 0 }), names: Type.Array(Type.String()) }),
  /** Pending invites that would have given access to the service. */
  invites: Type.Integer({ minimum: 0 }),
  /** Running copies switch to the new project network like a deploy (health checked, no rebuild). */
  switches: Type.Boolean(),
});

export const moveProjectImpact = defineOp({
  id: "services.moveProjectImpact",
  kind: "query",
  summary: "Show what moving a service to another project changes",
  description:
    "Lists what services.moveProject would change: services of the old project that reference the service or use its host name (they lose access), the service's own references and host names that point into the old project, shared variables it would no longer receive, grants and invites that go, and anything that blocks the move. Needs services.create in the target project.",
  input: Type.Object({ serviceId: Id, projectId: Id }),
  output: MoveImpact,
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const moveProject = defineOp({
  id: "services.moveProject",
  // Others lose access: services of the old project and people with grants on the service.
  kind: "destructive",
  summary: "Move a service to another project",
  description:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{svc.VAR}} is the reference syntax, not a template
    "Re-homes a service in another project: its private network, shared variables, ${{svc.VAR}} references and internal host name follow the new project, and grants on the service itself are removed (access follows the new project). Running copies switch to the new project network like a deploy, health checked and without a rebuild; if the switch fails the service goes back. Check services.moveProjectImpact first and pass confirm: true when it lists anything. Needs every service action on the service and services.create in the target project.",
  input: Type.Object({
    serviceId: Id,
    projectId: Id,
    /** Required when services.moveProjectImpact lists references, grants or invites. */
    confirm: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    /** The switch's deployment; null when nothing runs, so the move took effect at once. */
    deploymentId: Type.Union([Id, Type.Null()]),
    impact: MoveImpact,
  }),
  permission: permission.service("services.move", serviceScope),
  mcp: true,
  audit: true,
});
