// Turns a compose project (compose-go's normalized JSON from an agent's
// ParseCompose) into member service plans, and diffs them against a
// stack's existing members. Pure functions: tested without a database.

import { posix } from "node:path";
import { stringifyEnv } from "@seylo/env-analyzer";
import type { ComposeSource, ContainerSettings, HealthCheck, Port, Resources, ServiceSpecJson } from "../services/spec";
import { defaultContainer, defaultResources } from "../services/spec";

export interface MemberPlan {
  composeService: string;
  /** Service name in the project. */
  name: string;
  image: string | null;
  /** Folder (relative to the repo root) and Dockerfile for members with build:. */
  build: { contextPath: string; dockerfilePath: string; target: string } | null;
  ports: Port[];
  /** The file publishes a port (ports: "8080:80"): the member gets first-run IP:port access when created. */
  published: boolean;
  volumes: { name: string; mountPath: string; readOnly: boolean }[];
  dependsOn: string[];
  env: Record<string, string>;
  container: ContainerSettings;
  healthCheck: HealthCheck | null;
  /** false: the file turns health checks off (healthcheck: disable, test NONE), the image's HEALTHCHECK included. */
  imageHealthCheck: boolean;
  resources: Resources;
  replicas: number;
  restart: boolean;
}

export interface StackPlan {
  members: MemberPlan[];
  warnings: string[];
}

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; target?: string };
  ports?: { target: number; published?: string; protocol?: string }[];
  expose?: (string | number)[];
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
  depends_on?: Record<string, unknown>;
  environment?: Record<string, string | null>;
  healthcheck?: { test?: string[]; interval?: unknown; timeout?: unknown; start_period?: unknown; retries?: number; disable?: boolean };
  command?: string[] | null;
  entrypoint?: string[] | null;
  working_dir?: string;
  user?: string;
  stop_signal?: string;
  stop_grace_period?: unknown;
  init?: boolean;
  restart?: string;
  deploy?: { replicas?: number; resources?: { limits?: { memory?: number }; reservations?: { memory?: number } } } | null;
  mem_limit?: number;
  network_mode?: string;
  privileged?: boolean;
  pid?: string;
  cap_add?: string[];
}

interface ComposeProject {
  services?: Record<string, ComposeService>;
}

/** compose-go durations: "1m30s" strings, or nanoseconds as numbers. Returns whole seconds. */
export function durationSeconds(value: unknown, fallback: number): number {
  if (typeof value === "number") return Math.max(0, Math.round(value / 1e9));
  if (typeof value !== "string" || value === "") return fallback;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === "h" ? n * 3600 : unit === "m" ? n * 60 : unit === "s" ? n : unit === "ms" ? n / 1000 : 0;
  }
  return matched ? Math.round(total) : fallback;
}

/** "stack" + "web_1" -> "stack-web-1", DNS-safe and at most 40 characters. */
export function memberName(stack: string, composeService: string): string {
  const clean = composeService
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${stack}-${clean || "svc"}`.slice(0, 40).replace(/-+$/, "");
  return name;
}

function healthCheckOf(h: ComposeService["healthcheck"]): HealthCheck | null {
  if (!h || h.disable || !h.test || h.test.length === 0) return null;
  const [kind, ...rest] = h.test;
  let command: string[];
  if (kind === "NONE") return null;
  if (kind === "CMD") command = rest;
  else if (kind === "CMD-SHELL") command = ["sh", "-c", rest.join(" ")];
  else command = ["sh", "-c", h.test.join(" ")];
  if (command.length === 0) return null;
  return {
    probe: { type: "command", command },
    intervalSeconds: Math.min(3600, Math.max(1, durationSeconds(h.interval, 30))),
    timeoutSeconds: Math.min(600, Math.max(1, durationSeconds(h.timeout, 30))),
    startPeriodSeconds: Math.min(3600, durationSeconds(h.start_period, 0)),
    failureThreshold: Math.min(100, Math.max(1, h.retries ?? 3)),
  };
}

/**
 * The file's init: wins (true on, false off); without one the key stays
 * out, so the member gets the default (auto) and members from before
 * compare as they did.
 */
function initOf(init: ComposeService["init"]): Pick<ContainerSettings, "init"> {
  return init === true ? { init: "on" } : init === false ? { init: "off" } : {};
}

/** The file turns the service's health checks off, as docker compose does with HEALTHCHECK NONE. */
function healthChecksOff(h: ComposeService["healthcheck"]): boolean {
  return h?.disable === true || h?.test?.[0] === "NONE";
}

/**
 * Agents before 0.2.0-rc.2 warn "build sections are not built" for every
 * build: section. Whether a stack builds is the panel's call (below): it
 * builds repository stacks and warns for pasted files, so that line goes.
 */
const legacyBuildWarning = /: build sections are not built for compose stacks; give the service an image$/;

/**
 * Member plans from a normalized compose project. `composePath` is the
 * compose file's path in the repo ("" for pasted files), so build contexts
 * resolve relative to it.
 */
export function planStack(
  stackName: string,
  projectJson: unknown,
  source: ComposeSource,
  agentWarnings: readonly string[] = [],
): StackPlan {
  const project = (projectJson ?? {}) as ComposeProject;
  const warnings = agentWarnings.filter((w) => !legacyBuildWarning.test(w));
  const entries = Object.entries(project.services ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) warnings.push("The compose file has no services.");
  const composeDir = source.type === "inline" ? "" : posix.dirname(source.path || "docker-compose.yml");
  const names = new Map<string, string>();
  for (const [composeName] of entries) names.set(composeName, memberName(stackName, composeName));

  const members = entries.map(([composeName, svc]): MemberPlan => {
    const name = names.get(composeName) as string;
    let build: MemberPlan["build"] = null;
    if (svc.build) {
      if (source.type === "inline") {
        if (!svc.image) warnings.push(`${composeName}: build: needs a repository; pasted files must use image:.`);
      } else {
        const context = posix.normalize(posix.join(composeDir === "." ? "" : composeDir, svc.build.context ?? "."));
        build = {
          contextPath: context === "." ? "" : context.replace(/^\.\//, ""),
          dockerfilePath: svc.build.dockerfile ?? "Dockerfile",
          target: svc.build.target ?? "",
        };
        if (build.contextPath.startsWith("..")) {
          warnings.push(`${composeName}: the build context is outside the repository; it builds from the root instead.`);
          build.contextPath = "";
        }
      }
    }
    if (!build && !svc.image) warnings.push(`${composeName}: no image and nothing to build; it will not start.`);

    const ports: Port[] = [];
    for (const p of svc.ports ?? []) {
      if (!ports.some((q) => q.containerPort === p.target))
        ports.push({ containerPort: p.target, protocol: p.protocol === "udp" ? "udp" : "tcp" });
    }
    for (const e of svc.expose ?? []) {
      const port = Number(String(e).split("/")[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.some((q) => q.containerPort === port))
        ports.push({ containerPort: port, protocol: "tcp" });
    }

    const volumes: MemberPlan["volumes"] = [];
    for (const v of svc.volumes ?? []) {
      if (v.type === "volume" && v.source)
        volumes.push({ name: volumeName(v.source), mountPath: v.target, readOnly: v.read_only ?? false });
      else if (v.type === "volume")
        volumes.push({
          name: volumeName(`${composeName}-${volumes.length}`),
          mountPath: v.target,
          readOnly: false,
        });
      else if (v.type === "bind")
        warnings.push(`${composeName}: the bind mount ${v.source ?? ""}:${v.target} is ignored; use a named volume.`);
    }

    if (svc.network_mode && svc.network_mode !== "bridge")
      warnings.push(`${composeName}: network_mode ${svc.network_mode} is ignored; members share the project network.`);
    if (svc.privileged) warnings.push(`${composeName}: privileged mode is not supported and is ignored.`);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(svc.environment ?? {})) env[key] = value ?? "";

    const memory = svc.deploy?.resources?.limits?.memory ?? svc.mem_limit ?? null;
    const reservation = svc.deploy?.resources?.reservations?.memory ?? null;
    return {
      composeService: composeName,
      name,
      image: svc.image ?? null,
      build,
      ports,
      published: (svc.ports ?? []).some((p) => !!p.published && (p.protocol ?? "tcp") === "tcp"),
      volumes,
      dependsOn: Object.keys(svc.depends_on ?? {})
        .filter((d) => names.has(d))
        .sort(),
      env,
      container: {
        ...defaultContainer,
        command: svc.command ?? [],
        entrypoint: svc.entrypoint ?? [],
        workingDir: svc.working_dir ?? "",
        user: svc.user ?? "",
        stopSignal: /^SIG[A-Z0-9]+$/.test(svc.stop_signal ?? "") ? (svc.stop_signal as string) : "",
        stopGraceSeconds: Math.min(3600, Math.max(1, durationSeconds(svc.stop_grace_period, 10))),
        ...initOf(svc.init),
      },
      healthCheck: healthCheckOf(svc.healthcheck),
      imageHealthCheck: !healthChecksOff(svc.healthcheck),
      resources: {
        ...defaultResources,
        memoryLimitBytes: memory && memory >= 6 * 1024 * 1024 ? memory : null,
        memoryReservationBytes: reservation && reservation > 0 ? reservation : null,
      },
      replicas: Math.min(32, Math.max(1, svc.deploy?.replicas ?? 1)),
      restart: svc.restart !== "no",
    };
  });
  return { members, warnings };
}

/** Volumes several members mount: name -> member names, for the preview's sharedWith. */
export function sharedVolumes(members: readonly MemberPlan[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of members) for (const v of m.volumes) out.set(v.name, [...(out.get(v.name) ?? []), m.name]);
  return out;
}

/** The spec a member gets (without ids of other members, which apply.ts fills in). */
export function memberSpec(plan: MemberPlan, stackSource: ComposeSource, base: ServiceSpecJson): ServiceSpecJson {
  const source: ServiceSpecJson["source"] =
    plan.build && stackSource.type === "github"
      ? {
          type: "github",
          installationId: stackSource.installationId,
          repo: stackSource.repo,
          branch: stackSource.branch,
          deployOnPush: false,
        }
      : plan.build && stackSource.type === "git"
        ? { type: "git", url: stackSource.url, branch: stackSource.branch, credentialId: stackSource.credentialId, deployOnPush: false }
        : plan.image
          ? { type: "image", image: plan.image, registryId: null }
          : { type: "none" };
  return {
    ...base,
    source,
    build: plan.build
      ? {
          ...base.build,
          builder: "dockerfile",
          contextPath: plan.build.contextPath,
          dockerfilePath: plan.build.dockerfilePath,
          targetStage: plan.build.target,
        }
      : base.build,
    container: plan.container,
    ports: plan.ports,
    healthCheck: plan.healthCheck,
    crashPolicy: { ...base.crashPolicy, restart: plan.restart },
    resources: plan.resources,
    member: {
      composeService: plan.composeService,
      dependsOn: [],
      buildContext: plan.build?.contextPath ?? null,
      ...(plan.imageHealthCheck ? {} : { imageHealthCheck: false as const }),
    },
  };
}

/** Comparable view of what a member runs, to tell "update" from "unchanged". */
export function fingerprint(
  spec: ServiceSpecJson,
  env: string,
  volumes: readonly { name: string; mountPath: string; readOnly: boolean }[],
): string {
  const member = spec.member
    ? {
        composeService: spec.member.composeService,
        dependsOn: [...spec.member.dependsOn].sort(),
        // Only when set, so members from before it compare as they did.
        ...(spec.member.imageHealthCheck === false ? { imageHealthCheck: false } : {}),
      }
    : null;
  return JSON.stringify({
    source: spec.source,
    build: spec.source.type === "image" ? null : { c: spec.build.contextPath, d: spec.build.dockerfilePath, t: spec.build.targetStage },
    container: spec.container,
    ports: spec.ports,
    healthCheck: spec.healthCheck,
    restart: spec.crashPolicy.restart,
    resources: spec.resources,
    member,
    env,
    volumes: [...volumes].sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/** .env text for a member's environment block, keys sorted. */
export function envText(env: Record<string, string>): string {
  return stringifyEnv(
    Object.keys(env)
      .sort()
      .map((key) => ({ key, value: env[key] ?? "" })),
  );
}

/**
 * A compose volume name the agent accepts (services.VolumeName): lower case,
 * letters, digits, "_" and "-" only (no dots), starting with a letter or
 * digit, at most 60 characters. "pgdata.v2" becomes "pgdata-v2".
 */
export function volumeName(source: string): string {
  const cleaned = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 60);
  return cleaned || "data";
}
