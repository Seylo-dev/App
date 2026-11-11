// Section tabs of a service page. Each kind shows its own set: apps and
// cron services (Service.dc.html), compose stacks, databases
// (Database.dc.html) and Boxes. The layout picks the set from
// services.get's kind; while that loads it shows the app set.

import type { MessageKey } from "../i18n/t";
import type { ServiceKind } from "./service/status";

export type TabPath =
  | ""
  | "deployments"
  | "source"
  | "environment"
  | "domains"
  | "console"
  | "logs"
  | "metrics"
  | "storage"
  | "backups"
  | "previews"
  | "cron"
  | "alerts"
  | "advanced"
  | "notes"
  | "settings"
  | "connection";

export interface ServiceTab {
  /** Path below /p/$projectId/s/$serviceId; "" is the overview. */
  path: TabPath;
  label: MessageKey;
}

const tab = (path: TabPath, label: MessageKey): ServiceTab => ({ path, label });

export const appTabs: readonly ServiceTab[] = [
  tab("", "service.tabs.overview"),
  tab("deployments", "service.tabs.deployments"),
  tab("source", "service.tabs.source"),
  tab("environment", "service.tabs.environment"),
  tab("domains", "service.tabs.domains"),
  // Console and shell are two modes of this one tab (?mode=shell); /shell redirects here.
  tab("console", "service.tabs.console"),
  tab("logs", "service.tabs.logs"),
  tab("metrics", "service.tabs.metrics"),
  tab("storage", "service.tabs.storage"),
  tab("backups", "service.tabs.backups"),
  tab("previews", "service.tabs.previews"),
  tab("cron", "service.tabs.cron"),
  tab("alerts", "service.tabs.alerts"),
  tab("advanced", "service.tabs.advanced"),
  tab("notes", "service.tabs.notes"),
  tab("settings", "service.tabs.settings"),
];

/** Cron services run to completion on a schedule: no domains, console, previews or cron jobs of their own. */
export const cronTabs: readonly ServiceTab[] = [
  tab("", "service.tabs.overview"),
  tab("deployments", "service.tabs.deployments"),
  tab("source", "service.tabs.source"),
  tab("environment", "service.tabs.environment"),
  tab("logs", "service.tabs.logs"),
  tab("metrics", "service.tabs.metrics"),
  tab("storage", "service.tabs.storage"),
  tab("alerts", "service.tabs.alerts"),
  tab("advanced", "service.tabs.advanced"),
  tab("notes", "service.tabs.notes"),
  tab("settings", "service.tabs.settings"),
];

/** A compose stack is a folder of members; each member has its own full page. */
export const composeTabs: readonly ServiceTab[] = [
  tab("", "service.tabs.overview"),
  tab("source", "service.tabs.composeFile"),
  tab("notes", "service.tabs.notes"),
  tab("settings", "service.tabs.settings"),
];

export const databaseTabs: readonly ServiceTab[] = [
  tab("connection", "service.tabs.connection"),
  tab("backups", "service.tabs.backups"),
  tab("logs", "service.tabs.logs"),
  tab("metrics", "service.tabs.metrics"),
  tab("storage", "service.tabs.storage"),
  tab("alerts", "service.tabs.alerts"),
  tab("notes", "service.tabs.notes"),
  tab("settings", "service.tabs.settings"),
];

export const boxTabs: readonly ServiceTab[] = [
  tab("", "service.tabs.overview"),
  tab("logs", "service.tabs.logs"),
  tab("metrics", "service.tabs.metrics"),
  tab("storage", "service.tabs.storage"),
  tab("notes", "service.tabs.notes"),
  tab("settings", "service.tabs.settings"),
];

export function tabsFor(kind: ServiceKind | undefined): readonly ServiceTab[] {
  switch (kind) {
    case "cron":
      return cronTabs;
    case "compose":
      return composeTabs;
    case "postgres":
    case "mysql":
    case "mariadb":
    case "mongo":
    case "redis":
    case "valkey":
    case "keydb":
    case "dragonfly":
    case "clickhouse":
      return databaseTabs;
    case "box":
      return boxTabs;
    default:
      return appTabs;
  }
}
