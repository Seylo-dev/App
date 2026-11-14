// How a service looks in lists (dashboard, project grid, sidebar, palette):
// the kind tag, the status chip and the one-line source. One place, so
// every list reads the same.

import { databases } from "@seylo/ops";
import type { ChipProps } from "@seylo/ui/components/chip";
import { type DotSource, type DotStatus, serviceDot } from "../components/service/status";
import { t } from "../i18n/t";
import { formatAgo } from "./format";
import type { ServiceKind, ServiceStatus, ServiceSummary } from "./types";

type Summary = ServiceSummary;
type Status = ServiceStatus;
type Tone = NonNullable<ChipProps["tone"]>;
type Dot = DotStatus;

export interface KindTag {
  label: string;
  tone: Tone;
}

const kindTags: Record<ServiceKind, KindTag> = {
  app: { label: "APP", tone: "blue" },
  compose: { label: "CMP", tone: "green" },
  postgres: { label: "PG", tone: "sky" },
  mysql: { label: "MY", tone: "sky" },
  mariadb: { label: "MDB", tone: "sky" },
  mongo: { label: "MGO", tone: "green" },
  redis: { label: "RDS", tone: "red" },
  valkey: { label: "VK", tone: "red" },
  keydb: { label: "KDB", tone: "red" },
  dragonfly: { label: "DF", tone: "red" },
  clickhouse: { label: "CH", tone: "amber" },
  box: { label: "BOX", tone: "amber" },
  cron: { label: "CRON", tone: "gray" },
};

/** Short mono tag for the kind; template installs and the Panel project's services get their own. */
export function kindTag(service: Pick<Summary, "kind" | "templateSlug" | "protected">): KindTag {
  if (service.protected) return { label: "SYS", tone: "gray" };
  if (service.templateSlug && service.kind === "app") return { label: "TPL", tone: "violet" };
  return kindTags[service.kind];
}

export const databaseKinds: ReadonlySet<ServiceKind> = new Set(databases.databaseEngineIds);

const statusTones: Record<Status, Tone> = {
  idle: "gray",
  building: "amber",
  deploying: "amber",
  starting: "amber",
  running: "green",
  partial: "amber",
  unhealthy: "red",
  crashed: "red",
  stopped: "gray",
  unknown: "gray",
};

/**
 * A service's status in a list. The label and tone say what it does, a
 * deploy in progress first (building, waiting for a build slot when
 * buildWaiting, deploying); the dot says whether it is up (serviceDot: what
 * runs while a live version exists).
 */
export function statusDisplay(service: DotSource): { label: string; tone: Tone; dot: Dot } {
  const { dot } = serviceDot(service);
  if (service.status === "building" && service.buildWaiting) return { label: t("project.status.waitingForBuild"), tone: "gray", dot };
  return { label: t(`project.status.${service.status}`), tone: statusTones[service.status], dot };
}

/** Statuses that mean work in progress (the dashboard's "1 deploying"). */
export function isBusy(status: Status): boolean {
  return status === "building" || status === "deploying" || status === "starting";
}

/** "GitHub acme/shop-web · main · Railpack", "GitLab acme/platform/shop · main", "postgres:17 · internal only". */
export function sourceLine(service: Pick<Summary, "source" | "address">): string {
  const { source } = service;
  const parts: string[] = [];
  if (source.type === "github" || source.type === "gitlab" || source.type === "gitea" || source.type === "bitbucket")
    parts.push(t(`project.source.${source.type}`, { label: source.label }));
  else if (source.type === "inline") parts.push(t("project.source.inline"));
  else if (source.type === "upload") parts.push(t("project.source.upload"));
  else if (source.type === "none") parts.push(t("project.source.none"));
  else parts.push(source.label);
  if (source.branch) parts.push(source.branch);
  if (source.builder) parts.push(t(`project.builder.${source.builder}`));
  // "db:5432" is the project-network address, so nothing outside the project reaches it.
  const internal = service.address === null || /^[a-z0-9-]+:\d+$/.test(service.address);
  if (internal && source.type === "database") parts.push(t("project.internalOnly"));
  return parts.join(t("format.separator"));
}

/** The address is the project-network "<name>:<port>" the panel writes for a service with a port but no domain. */
export function isInternalAddress(service: Pick<Summary, "name" | "address">): boolean {
  const { address, name } = service;
  return address?.startsWith(`${name}:`) === true && /^\d+$/.test(address.slice(name.length + 1));
}

/** Where it runs: "de-fsn-1", or "de-fsn-1 +1" when load balanced. */
export function placementLine(service: Pick<Summary, "placements">): string {
  const [first, ...rest] = service.placements;
  if (!first) return t("project.notPlaced");
  return rest.length > 0 ? t("project.placedMore", { node: first.nodeName, count: rest.length }) : first.nodeName;
}

/** "a1c9e2f · 2 h ago", "building now", "waiting for a build slot", "created 12 days ago". */
export function lastActivity(
  service: Pick<Summary, "status" | "liveDeployment" | "lastDeployedAt" | "createdAt"> & { buildWaiting?: boolean },
): string {
  if (service.status === "building") return t(service.buildWaiting ? "project.waitingNow" : "project.buildingNow");
  if (service.status === "deploying") return t("project.deployingNow");
  if (service.liveDeployment && service.lastDeployedAt) {
    return `${service.liveDeployment.label}${t("format.separator")}${formatAgo(service.lastDeployedAt)}`;
  }
  return t("project.createdAgo", { when: formatAgo(service.createdAt) });
}

/**
 * The panel's own service (reserved id, the same as go/internal/docker
 * PanelServiceID and apps/panel modules/nodes/panel-service.ts). Deploy,
 * stop and replicas are refused for it (CONFLICT reason "panel"): the panel
 * updates through Settings > Updates.
 */
export const panelServiceId = "panel00000000000";

export function isPanelService(service: { id: string }): boolean {
  return service.id === panelServiceId;
}

/**
 * Whether pushes to the source deploy it: GitHub, generic git and provider
 * (GitLab, Gitea, Bitbucket) sources have the switch; null for the others.
 */
export function deploysOnPush(source: { type: string; deployOnPush?: boolean }): boolean | null {
  return "deployOnPush" in source && typeof source.deployOnPush === "boolean" ? source.deployOnPush : null;
}
