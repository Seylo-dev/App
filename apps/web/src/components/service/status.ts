// How service and deployment states look: chip tone, status dot and label
// key. One table per state type so every screen shows them the same way.

import { databases, type deployments, type services } from "@seylo/ops";
import type { MessageKey } from "../../i18n/t";

export type ServiceStatus = (typeof services.ServiceStatus)["static"];
export type ServiceKind = (typeof services.ServiceKind)["static"];
export type DeploymentStatus = (typeof deployments.DeploymentStatus)["static"];

export type ChipTone = "blue" | "sky" | "red" | "violet" | "gray" | "green" | "amber" | "track";
export type DotStatus = "ok" | "busy" | "error" | "off";

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
 * Whether a container of the service runs now, so a console can attach:
 * running, partly running or failing its health check, or a deploy going on
 * while the live version still runs. Not while it starts, crashes, stops or
 * was never deployed.
 */
export function hasRunningInstance(service: { status: ServiceStatus; stopped: boolean; liveDeployment: unknown }): boolean {
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
