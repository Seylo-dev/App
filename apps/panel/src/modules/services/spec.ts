// The JSON in services.spec: a service's desired configuration. The
// services module owns this shape and is the only writer; it validates
// before every write and fills defaults on read, so rows written by an
// older panel still load.
//
// What agents run is not this JSON directly: a deploy snapshots the run
// settings into deployments.run_settings, so "applies on the next deploy"
// holds. Crash policy, stopped and replicas apply right away.

import { builds, compose, previews, services } from "@seylo/ops";
import { type Static, type TLiteral, type TObject, type TSchema, type TString, type TUnion, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type Source = Static<typeof services.Source>;
export type BuildSettings = Static<typeof builds.BuildSettings>;
export type ContainerSettings = Static<typeof services.ContainerSettings>;
export type Port = Static<typeof services.Port>;
export type HealthCheck = Static<typeof services.HealthCheck>;
export type CrashPolicy = Static<typeof services.CrashPolicy>;
export type Resources = Static<typeof services.Resources>;
export type DeployStrategy = Static<typeof services.DeployStrategy>;
export type CronSettings = Static<typeof services.CronSettings>;
export type PreviewSettings = Static<typeof previews.PreviewSettings>;
export type ComposeSource = Static<typeof compose.ComposeSource>;

/**
 * Stored rows keep the old git URL rule: ops refuse a token in a git URL
 * (GitUrl), but a source saved before that must still load and deploy, so
 * the spec schema takes any https://, ssh:// or git@ URL. Every answer that
 * shows a source drops the token (git-url.ts).
 */
const StoredGitUrl = Type.String({ minLength: 1, maxLength: 500, pattern: "^(https://|ssh://|git@)\\S+$" });

function withStoredGitUrl<T extends TSchema>(variants: readonly T[]): TSchema[] {
  return variants.map((variant) => {
    const object = variant as unknown as TObject;
    return object.properties?.type?.const === "git" ? Type.Object({ ...object.properties, url: StoredGitUrl }) : variant;
  });
}

/** A compose member: which service of the stack's file it is and what it waits for. */
export const MemberSettings = Type.Object({
  composeService: Type.String(),
  /** Service ids of members that must run first. */
  dependsOn: Type.Array(Type.String()),
  /** The compose file had a build: section; deploys build this folder of the stack's repo. */
  buildContext: Type.Union([Type.String(), Type.Null()]),
  /**
   * false: the compose file turns the member's health checks off
   * (healthcheck: disable, or test NONE), so its deploys never wait for the
   * image's own HEALTHCHECK. Not stored otherwise.
   */
  imageHealthCheck: Type.Optional(Type.Literal(false)),
});
export type MemberSettings = Static<typeof MemberSettings>;

/**
 * A compose stack (kind "compose"): where its file comes from. A pasted
 * file is stored sealed in services.compose_file_sealed, so here its yaml
 * is always "".
 */
export const StackSettings = Type.Object({
  source: Type.Union([
    Type.Object({ type: Type.Literal("inline"), yaml: Type.String({ maxLength: 0 }) }),
    ...withStoredGitUrl(compose.ComposeSource.anyOf.filter((s) => s.properties.type.const !== "inline")),
  ]) as unknown as TUnion<[TObject<{ type: TLiteral<"inline">; yaml: TString }>, ...typeof compose.ComposeSource.anyOf]>,
});
export type StackSettings = Static<typeof StackSettings>;

export const ServiceSpecJson = Type.Object({
  source: Type.Union(withStoredGitUrl(services.Source.anyOf)) as unknown as typeof services.Source,
  build: builds.BuildSettings,
  container: services.ContainerSettings,
  ports: Type.Array(services.Port),
  healthCheck: Type.Union([services.HealthCheck, Type.Null()]),
  crashPolicy: services.CrashPolicy,
  resources: services.Resources,
  deploy: services.DeployStrategy,
  cron: Type.Union([services.CronSettings, Type.Null()]),
  stickySessions: Type.Boolean(),
  /** Load balancing: the node that takes the public traffic; null = the first placement. */
  entryNodeId: Type.Union([Type.String(), Type.Null()]),
  previews: previews.PreviewSettings,
  /** Set on compose members. */
  member: Type.Union([MemberSettings, Type.Null()]),
  /** Set on compose stacks. */
  stack: Type.Union([StackSettings, Type.Null()]),
  /** Set on preview services: the service and PR they preview. */
  preview: Type.Union([Type.Object({ ofServiceId: Type.String(), prNumber: Type.Integer() }), Type.Null()]),
  /** Glob patterns a push must touch to deploy (@seylo/ops watch-paths); empty = every push deploys. */
  watchPaths: services.WatchPaths,
  /**
   * 0.2.2 gave PORT only to services created from 0.2.2 on (true here),
   * which left older apps on their framework's default (3000 for Next.js)
   * while their domains pointed at 80. Since 0.2.3 every repository build
   * gets PORT (env/desired.ts withPortEnv) and nothing reads this; it stays
   * so stored specs keep validating.
   */
  portEnv: Type.Boolean(),
});
export type ServiceSpecJson = Static<typeof ServiceSpecJson>;

/** What an app built from a repository listens on when it names no port: PORT says 80, and so does a new domain. */
export const defaultAppPort = 80;

/**
 * The port an app built from a repository (GitHub, a git provider or a git
 * URL; not a compose member, whose compose file says what it needs) listens
 * on: its first TCP port, else `fallback` (the port its domains point at,
 * domains/lookup.ts appPort), else defaultAppPort. null for any other
 * service, whose image or kind decides.
 */
export function builtAppPort(
  service: { kind: string; parentId: string | null },
  spec: Pick<ServiceSpecJson, "source" | "ports">,
  fallback: number | null = null,
): number | null {
  const fromRepo = spec.source.type === "github" || spec.source.type === "provider" || spec.source.type === "git";
  if (service.kind !== "app" || service.parentId !== null || !fromRepo) return null;
  return spec.ports.find((p) => p.protocol !== "udp")?.containerPort ?? fallback ?? defaultAppPort;
}

/** What a deploy snapshots: the settings agents run until the next deploy. */
export interface RunSettings {
  container: ContainerSettings;
  ports: Port[];
  healthCheck: HealthCheck | null;
  resources: Resources;
  deploy: DeployStrategy;
  cron: CronSettings | null;
  member: MemberSettings | null;
  /**
   * Without a check of its own (healthCheck null) the deploy waits for the
   * image's own HEALTHCHECK (HealthCheck.image in the spec). Set by deploys
   * from 0.2.14; a snapshot from before has none, so the generation it
   * describes keeps the TCP default it was deployed with.
   */
  imageHealthCheck: boolean;
}

/** DeployStrategy.healthTimeoutSeconds when the service never set one: the agent may wait longer for an image HEALTHCHECK. */
export const defaultHealthTimeoutSeconds = 300;

/** Fixed wait between crash restarts; the agent enforces it, the UI shows it. */
export const restartDelaySeconds = 5;

export const defaultBuild: BuildSettings = {
  builder: "railpack",
  contextPath: "",
  dockerfilePath: "Dockerfile",
  inlineDockerfile: null,
  targetStage: "",
  buildNodeId: null,
  startCommand: "",
  installCommand: "",
  buildCommand: "",
};

export const defaultContainer: ContainerSettings = {
  command: [],
  entrypoint: [],
  workingDir: "",
  user: "",
  stopSignal: "",
  stopGraceSeconds: 10,
};

export const defaultResources: Resources = {
  memoryLimitBytes: null,
  memoryReservationBytes: null,
  cpuWeight: null,
  pidsLimit: null,
};

export function defaultSpec(): ServiceSpecJson {
  return {
    source: { type: "none" },
    build: { ...defaultBuild },
    container: { ...defaultContainer, command: [], entrypoint: [] },
    ports: [],
    healthCheck: null,
    crashPolicy: { restart: true, stopAfterCrashes: 0 },
    resources: { ...defaultResources },
    deploy: { mode: "rolling", healthTimeoutSeconds: defaultHealthTimeoutSeconds },
    cron: null,
    stickySessions: false,
    entryNodeId: null,
    previews: { enabled: false, domainPattern: "", maxPreviews: 5 },
    member: null,
    stack: null,
    preview: null,
    watchPaths: [],
    portEnv: false,
  };
}

/**
 * Reads services.spec: missing keys get their defaults, so older rows
 * load. A value that no longer fits its schema falls back to the default
 * instead of failing the whole page.
 */
export function readSpec(raw: unknown): ServiceSpecJson {
  const base = defaultSpec();
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof ServiceSpecJson)[]) {
    if (!(key in row)) continue;
    const value = row[key];
    const schema = ServiceSpecJson.properties[key];
    const defaults = base[key];
    // Objects merge over their defaults so a new field in BuildSettings does not reset the rest.
    const merged =
      defaults && typeof defaults === "object" && !Array.isArray(defaults) && value && typeof value === "object" && !Array.isArray(value)
        ? { ...defaults, ...(value as object) }
        : value;
    if (Value.Check(schema, merged)) out[key] = merged;
  }
  return out as ServiceSpecJson;
}

/** Validates before a write; a failure is a bug in the caller, never user input (ops validate input first). */
export function checkSpec(spec: ServiceSpecJson): ServiceSpecJson {
  if (!Value.Check(ServiceSpecJson, spec)) {
    const first = [...Value.Errors(ServiceSpecJson, spec)][0];
    throw new Error(`invalid service spec at ${first?.path ?? "?"}: ${first?.message ?? "unknown"}`);
  }
  return spec;
}

/**
 * The run settings a deploy snapshots now. The init process is written out
 * ("auto" when the service never chose), so a snapshot without one is from
 * before 0.2.14 and keeps containers as they were made.
 */
export function runSettingsOf(spec: ServiceSpecJson): RunSettings {
  return {
    container: { ...spec.container, init: spec.container.init ?? "auto" },
    ports: spec.ports,
    healthCheck: spec.healthCheck,
    resources: spec.resources,
    deploy: spec.deploy,
    cron: spec.cron,
    member: spec.member,
    imageHealthCheck: true,
  };
}

/**
 * A stored snapshot, or the current settings when the deployment has none.
 * What deploys before 0.2.14 did not snapshot reads as they ran: no wait
 * for the image's HEALTHCHECK and no init process (container.init absent).
 */
export function readRunSettings(raw: unknown, fallback: ServiceSpecJson): RunSettings {
  const current = runSettingsOf(fallback);
  if (!raw || typeof raw !== "object") {
    const { init: _, ...container } = current.container;
    return { ...current, container, imageHealthCheck: false };
  }
  const row = raw as Partial<RunSettings>;
  return {
    container: { ...defaultContainer, ...row.container },
    ports: row.ports ?? current.ports,
    healthCheck: row.healthCheck === undefined ? current.healthCheck : row.healthCheck,
    resources: { ...defaultResources, ...row.resources },
    deploy: { ...current.deploy, ...row.deploy },
    cron: row.cron === undefined ? current.cron : row.cron,
    member: row.member === undefined ? current.member : row.member,
    imageHealthCheck: row.imageHealthCheck === true,
  };
}

/** Whether deploying this service builds an image first (as opposed to pulling one). */
export function needsBuild(spec: ServiceSpecJson): boolean {
  switch (spec.source.type) {
    case "github":
    case "provider":
    case "git":
    case "inline":
    case "upload":
      return true;
    case "image":
    case "none":
      return false;
  }
}
