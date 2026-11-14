// How service and deployment states look: chip tone, status dot and label
// key. One table per state type so every screen shows them the same way.
// A service's dot says whether it is up and its label what a deploy does
// (serviceDot), so a live version that runs through a deploy stays green.

import { databases, type deployments, type services } from "@seylo/ops";
import type { MessageKey } from "../../i18n/t";

export type ServiceStatus = (typeof services.ServiceStatus)["static"];
export type ServiceKind = (typeof services.ServiceKind)["static"];
export type DeploymentStatus = (typeof deployments.DeploymentStatus)["static"];

export type ChipTone = "blue" | "sky" | "red" | "violet" | "gray" | "green" | "amber" | "track";
/** StatusDot's tones; "pending" is a hollow ring for a first deploy that waits for a build slot. */
export type DotStatus = "ok" | "busy" | "error" | "off" | "pending";

export interface StatusLook {
  tone: ChipTone;
  dot: DotStatus;
  /** Pulsing dot for things happening right now. */
  pulse: boolean;
  label: MessageKey;
}

export const serviceStatusLook: Record<ServiceStatus, StatusLook> = {
  idle: { tone: "gray", dot: "off", pulse: false, label: "service.status.idle" },
  building: { tone: "amber", dot: "busy", pulse: true, label: "service.status.building" },
  deploying: { tone: "amber", dot: "busy", pulse: true, label: "service.status.deploying" },
  starting: { tone: "amber", dot: "busy", pulse: true, label: "service.status.starting" },
  running: { tone: "green", dot: "ok", pulse: false, label: "service.status.running" },
  partial: { tone: "amber", dot: "busy", pulse: false, label: "service.status.partial" },
  unhealthy: { tone: "red", dot: "error", pulse: false, label: "service.status.unhealthy" },
  crashed: { tone: "red", dot: "error", pulse: false, label: "service.status.crashed" },
  stopped: { tone: "gray", dot: "off", pulse: false, label: "service.status.stopped" },
  unknown: { tone: "gray", dot: "off", pulse: false, label: "service.status.unknown" },
};

export const deploymentStatusLook: Record<DeploymentStatus, StatusLook> = {
  queued: { tone: "gray", dot: "off", pulse: true, label: "serviceDeploys.status.queued" },
  building: { tone: "amber", dot: "busy", pulse: true, label: "serviceDeploys.status.building" },
  deploying: { tone: "amber", dot: "busy", pulse: true, label: "serviceDeploys.status.deploying" },
  live: { tone: "green", dot: "ok", pulse: false, label: "serviceDeploys.status.live" },
  superseded: { tone: "green", dot: "ok", pulse: false, label: "serviceDeploys.status.superseded" },
  failed: { tone: "red", dot: "error", pulse: false, label: "serviceDeploys.status.failed" },
  cancelled: { tone: "gray", dot: "off", pulse: false, label: "serviceDeploys.status.cancelled" },
};

/**
 * A deploy whose build waits for a free slot of its node's Builds at once
 * (Deployment.buildWait, ServiceSummary.buildWaiting): it looks like a
 * queued deploy and says "Waiting for a build slot" where it would say
 * "Building".
 */
export const waitingForBuildLook: StatusLook = {
  tone: "gray",
  dot: "off",
  pulse: true,
  label: "serviceDeploys.status.waitingForBuild",
};

/** How a service's status looks; buildWaiting turns "Building" into "Waiting for a build slot". */
export function serviceLook(status: ServiceStatus, buildWaiting = false): StatusLook {
  return status === "building" && buildWaiting
    ? { ...waitingForBuildLook, label: "service.status.waitingForBuild" }
    : serviceStatusLook[status];
}

/**
 * What a service's status dot reads: a ServiceSummary, a ServiceDetail or
 * one of ServiceDetail.members.
 */
export interface DotSource {
  status: ServiceStatus;
  buildWaiting?: boolean;
  /** What runs now (ServiceSummary.runtimeStatus); panels before 0.2.17 leave it out. */
  runtimeStatus?: ServiceStatus;
  /** Set while a live version exists (ServiceSummary.liveDeployment). */
  liveDeployment?: unknown;
}

type Dot = Pick<StatusLook, "dot" | "pulse">;

const dotOf = (look: StatusLook): Dot => ({ dot: look.dot, pulse: look.pulse });

/**
 * The status dot says whether the app is up; the label next to it says what
 * a deploy does. While a deploy builds, waits for a build slot or rolls out
 * on top of a live version, the dot is what runs (runtimeStatus): green
 * running, amber partial or starting, red crashed or unhealthy, gray
 * stopped or unknown. A first deploy (nothing live yet) has the busy dot,
 * or the pending ring while its build waits for a slot. Otherwise, and in
 * answers without runtimeStatus (panels before 0.2.17), the status's own dot.
 */
export function serviceDot(service: DotSource): Dot {
  const { status, runtimeStatus } = service;
  if ((status === "building" || status === "deploying") && runtimeStatus !== undefined) {
    if (service.liveDeployment != null && runtimeStatus !== "idle") return dotOf(serviceStatusLook[runtimeStatus]);
    if (status === "building" && service.buildWaiting) return { dot: "pending", pulse: true };
    return dotOf(serviceStatusLook[status]);
  }
  return dotOf(serviceLook(status, service.buildWaiting));
}

/** A service's chip (the header, a stack's members): serviceLook's label and tone with serviceDot's dot. */
export function serviceChipLook(service: DotSource): StatusLook {
  return { ...serviceLook(service.status, service.buildWaiting), ...serviceDot(service) };
}

/** How a deployment's status looks; a building one whose build waits for a slot says so. */
export function deploymentLook(status: DeploymentStatus, buildWaiting = false): StatusLook {
  return status === "building" && buildWaiting ? waitingForBuildLook : deploymentStatusLook[status];
}

/** What a console reads of a service: a ServiceSummary or ServiceDetail. */
export interface RunSource {
  status: ServiceStatus;
  /** What runs now (ServiceSummary.runtimeStatus); panels before 0.2.17 leave it out. */
  runtimeStatus?: ServiceStatus;
  stopped: boolean;
  liveDeployment: unknown;
}

/** The states in which a container of the service runs. */
const runs = (status: ServiceStatus) => status === "running" || status === "partial" || status === "unhealthy";

/**
 * Whether a container of the service runs now, so a console can attach:
 * running, partly running or failing its health check. While a deploy
 * builds, waits for a build slot or rolls out, that is what runs
 * (runtimeStatus): the live version while it runs, not once it crashed or
 * stopped, and a new container that already runs. Not while it starts,
 * crashes, stops or was never deployed. Answers without runtimeStatus
 * (panels before 0.2.17): a deploy going on counts as running while a live
 * version exists and the service was not stopped.
 */
export function hasRunningInstance(service: RunSource): boolean {
  if (service.runtimeStatus !== undefined) return runs(service.runtimeStatus);
  switch (service.status) {
    case "running":
    case "partial":
    case "unhealthy":
      return true;
    case "building":
    case "deploying":
      return !service.stopped && service.liveDeployment !== null;
    default:
      return false;
  }
}

/** A deployment that is still moving: the header offers Cancel deploy, the page polls. */
export function isActiveDeployment(status: DeploymentStatus): boolean {
  return status === "queued" || status === "building" || status === "deploying";
}

export interface KindLook {
  /** Short badge text: APP, PG, RDS. Product abbreviations, the same in every language. */
  badge: string;
  tone: ChipTone;
  label: MessageKey;
}

export const kindLook: Record<ServiceKind, KindLook> = {
  app: { badge: "APP", tone: "blue", label: "service.kind.app" },
  compose: { badge: "STK", tone: "violet", label: "service.kind.compose" },
  postgres: { badge: "PG", tone: "sky", label: "service.kind.postgres" },
  mysql: { badge: "MY", tone: "sky", label: "service.kind.mysql" },
  mariadb: { badge: "MDB", tone: "sky", label: "service.kind.mariadb" },
  mongo: { badge: "MGO", tone: "green", label: "service.kind.mongo" },
  redis: { badge: "RDS", tone: "red", label: "service.kind.redis" },
  valkey: { badge: "VK", tone: "red", label: "service.kind.valkey" },
  keydb: { badge: "KDB", tone: "red", label: "service.kind.keydb" },
  dragonfly: { badge: "DF", tone: "red", label: "service.kind.dragonfly" },
  clickhouse: { badge: "CH", tone: "amber", label: "service.kind.clickhouse" },
  box: { badge: "BOX", tone: "violet", label: "service.kind.box" },
  cron: { badge: "CRN", tone: "amber", label: "service.kind.cron" },
};

const databaseKinds: ReadonlySet<string> = new Set(databases.databaseEngineIds);

export function isDatabaseKind(kind: string): boolean {
  return databaseKinds.has(kind);
}
