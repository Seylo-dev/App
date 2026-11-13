// What the rows of a service's tabs and the assistant's chats offer, one
// list per kind of row for its "..." button and its right-click menu. Each
// keeps the items, order and rules the row's menu had (the row's own
// dialogs and mutations stay in the row; `act` reaches them), plus a copy
// item where the row shows something worth copying.

import { type MenuEntry, tidyEntries } from "@seylo/ui/components/menu-items";
import {
  type Icon,
  IconArrowBackUp,
  IconGitCommit,
  IconHash,
  IconPencil,
  IconRefresh,
  IconTerminal2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { t } from "../../i18n/t";

type Item = Extract<MenuEntry, { type: "item" }>;

/** An item that calls `act(id)`; with `Glyph` it has an icon (menus that had icons keep them, the others stay plain). */
function itemOf<A extends string>(act: (action: A) => void) {
  return (id: A, label: string, Glyph?: Icon, extra: Partial<Item> = {}): MenuEntry => ({
    type: "item",
    id,
    label,
    ...(Glyph ? { icon: <Glyph size={15} stroke={2} aria-hidden="true" /> } : {}),
    onSelect: () => act(id),
    ...extra,
  });
}

// Deployments tab: one row of the history.

export type DeploymentAction =
  | "viewLog"
  | "redeployCommit"
  | "redeployNoCache"
  | "rollback"
  | "cancel"
  | "cancelMove"
  | "copyCommit"
  | "copyId";

export interface DeploymentMenuSubject {
  id: string;
  commit: { sha: string } | null;
  canRollback: boolean;
  /** Queued or running. */
  running: boolean;
  /** A move to another node (Deployment.move): Cancel move, after a confirm, only while the panel takes a cancel. */
  move?: { canCancel: boolean } | null;
}

/** One deploy at a time: while one is in progress Redeploy and Roll back wait for it, with why. */
export function deploymentMenuEntries(d: DeploymentMenuSubject, ctx: { busy: boolean; act: (action: DeploymentAction) => void }) {
  const item = itemOf(ctx.act);
  const wait = ctx.busy ? { disabled: true, disabledReason: t("service.header.deployBusyHint") } : {};
  const entries: MenuEntry[] = [item("viewLog", t("menus.viewLog"), IconTerminal2), { type: "separator", id: "sep:deploy" }];
  if (d.commit) entries.push(item("redeployCommit", t("serviceDeploys.redeployCommit"), IconRefresh, wait));
  entries.push(item("redeployNoCache", t("serviceDeploys.redeployNoCache"), IconRefresh, wait));
  if (d.canRollback) entries.push(item("rollback", t("serviceDeploys.rollback"), IconArrowBackUp, wait));
  if (d.running && d.move) {
    if (d.move.canCancel) entries.push(item("cancelMove", t("service.header.cancelMove"), IconX, { destructive: true }));
  } else if (d.running) entries.push(item("cancel", t("service.header.cancelDeploy"), IconX, { destructive: true }));
  entries.push({ type: "separator", id: "sep:copy" });
  if (d.commit) entries.push(item("copyCommit", t("menus.copyCommit"), IconGitCommit));
  entries.push(item("copyId", t("menus.copyId"), IconHash));
  return tidyEntries(entries);
}

// Domains tab: one domain.

export type DomainAction = "openNewTab" | "routing" | "access" | "certificate" | "regenerate" | "primary" | "copyDomain" | "remove";

export interface DomainMenuSubject {
  forward: unknown;
  auto: boolean;
  primary: boolean;
}

export function domainMenuEntries(
  d: DomainMenuSubject,
  ctx: {
    /** The row shows its URL as a link (it is served: not a forward, not waiting on DNS, routed). */
    linkable: boolean;
    canRegenerate: boolean;
    regenerating: boolean;
    act: (action: DomainAction) => void;
  },
) {
  const item = itemOf(ctx.act);
  const entries: MenuEntry[] = [];
  if (ctx.linkable) entries.push(item("openNewTab", t("menus.openNewTab")), { type: "separator", id: "sep:edit" });
  entries.push(item("routing", t("serviceDomains.menu.routing")));
  if (!d.forward) entries.push(item("access", t("serviceDomains.menu.access")));
  if (!d.auto) entries.push(item("certificate", t("serviceDomains.menu.certificate")));
  if (ctx.canRegenerate) entries.push(item("regenerate", t("serviceDomains.regenerate"), undefined, { disabled: ctx.regenerating }));
  if (!d.primary && !d.forward) entries.push(item("primary", t("serviceDomains.menu.primary")));
  entries.push(
    { type: "separator", id: "sep:copy" },
    item("copyDomain", t("menus.copyDomain")),
    { type: "separator", id: "sep:remove" },
    item("remove", t("service.remove"), undefined, { destructive: true }),
  );
  return tidyEntries(entries);
}

// Backups tab: a schedule, and one run of the history.

export type BackupPolicyAction = "runNow" | "edit" | "remove";

export function backupPolicyMenuEntries(ctx: { act: (action: BackupPolicyAction) => void }) {
  const item = itemOf(ctx.act);
  return [
    item("runNow", t("serviceBackups.backUpNow")),
    item("edit", t("service.edit")),
    item("remove", t("service.remove"), undefined, { destructive: true }),
  ];
}

export type BackupRunAction = "restore" | "download" | "remove" | "forget";

/**
 * The items of a run, in the order and by the rules of backups/run-row.tsx
 * runMenu: a finished backup that is still there has Restore, Download and
 * Remove; once its destination was deleted only Remove from list; other
 * runs have none.
 */
export function backupRunMenuEntries(items: readonly BackupRunAction[], ctx: { act: (action: BackupRunAction) => void }) {
  const item = itemOf(ctx.act);
  return items.map((id) =>
    id === "restore"
      ? item(id, t("serviceBackups.restore"))
      : id === "download"
        ? item(id, t("serviceBackups.download"))
        : item(id, id === "remove" ? t("service.remove") : t("serviceBackups.forgetRun"), undefined, { destructive: true }),
  );
}

// Cron jobs tab: one job.

export type CronJobAction = "runNow" | "edit" | "remove";

export function cronJobMenuEntries(ctx: { act: (action: CronJobAction) => void }) {
  const item = itemOf(ctx.act);
  return [
    item("runNow", t("serviceCron.runNow")),
    item("edit", t("service.edit")),
    item("remove", t("service.remove"), undefined, { destructive: true }),
  ];
}

// Alerts tab: one uptime check.

export type AlertCheckAction = "edit" | "toggle" | "remove";

export function alertCheckMenuEntries(check: { enabled: boolean }, ctx: { act: (action: AlertCheckAction) => void }) {
  const item = itemOf(ctx.act);
  return [
    item("edit", t("service.edit")),
    item("toggle", check.enabled ? t("serviceAlerts.pause") : t("serviceAlerts.resume")),
    item("remove", t("service.remove"), undefined, { destructive: true }),
  ];
}

// Users tab of a database: one user who is not the main one.

export type DatabaseUserAction = "password" | "rename" | "makeMain" | "copyName" | "delete";

export interface DatabaseUserMenuSubject {
  can: { passwordChange: boolean; rename: boolean; makeMain: boolean; delete: boolean };
  /** Why some of it cannot be done (the engine, the user's grants, a connection that is down). */
  why: string | null;
}

/** Each action is there, disabled when the panel says it cannot be done, and the panel's why closes the menu. */
export function databaseUserMenuEntries(
  user: DatabaseUserMenuSubject,
  ctx: { canSwitch: boolean; act: (action: DatabaseUserAction) => void },
) {
  const item = itemOf(ctx.act);
  const entries: MenuEntry[] = [
    item("password", t("serviceDatabaseUsers.changePassword"), undefined, { disabled: !user.can.passwordChange }),
    item("rename", t("serviceDatabaseUsers.rename"), undefined, { disabled: !user.can.rename }),
  ];
  if (ctx.canSwitch) entries.push(item("makeMain", t("serviceDatabaseUsers.makeMain"), undefined, { disabled: !user.can.makeMain }));
  entries.push(
    item("copyName", t("menus.copyName")),
    { type: "separator", id: "sep:delete" },
    item("delete", t("serviceDatabaseUsers.delete"), undefined, { destructive: true, disabled: !user.can.delete }),
  );
  if (user.why) entries.push({ type: "label", id: "why", label: user.why });
  return tidyEntries(entries);
}

// The assistant: one chat in the list, and the open chat's header.

export type ChatAction = "rename" | "delete";

export function chatMenuEntries(ctx: { act: (action: ChatAction) => void }) {
  const item = itemOf(ctx.act);
  return [item("rename", t("assistant.rename"), IconPencil), item("delete", t("assistant.delete"), IconTrash, { destructive: true })];
}
