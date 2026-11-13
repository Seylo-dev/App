// What a service's menus offer: one list for its "..." button on the
// service page and its right-click menu in the sidebar, on the dashboard
// and on the project page, so they never differ. Plain data from the
// service and what the screen knows (here, busy, stopped, terminal
// modes); the rules are the service header's and the service menu's:
//
//   Open (not on its own page), Open in new tab
//   Deploy (apps and cron, not the panel; waits while a deploy runs),
//   Cancel deploy while one runs, else Restart, Stop or Start (a Box:
//   Stop and Open editor)
//   Logs, Console (the kinds whose page has those tabs; Console only with
//   a terminal mode the viewer may open)
//   Clone, Move to project, Move to another node (not the panel, protected
//   services or compose stacks; members move with their stack)
//   Copy address (or the internal name:port), Copy ID
//   Delete (not protected services or compose members)

import type { MenuEntry } from "@seylo/ui/components/menu-items";
import { tidyEntries } from "@seylo/ui/components/menu-items";
import {
  type Icon,
  IconArrowsExchange,
  IconArrowUpRight,
  IconCode,
  IconCopy,
  IconExternalLink,
  IconFileText,
  IconHash,
  IconLink,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconRocket,
  IconServer2,
  IconTerminal2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { isInternalAddress, isPanelService } from "../../lib/service-display";
import type { ServiceSummary } from "../../lib/types";
import type { TerminalMode } from "../service/terminal/access";
import { type TabPath, tabsFor } from "../service-tabs";

/** What a menu needs of a service: every list row has it (services.list), and services.get adds `stopped`. */
export type ServiceMenuSubject = Pick<
  ServiceSummary,
  "id" | "projectId" | "name" | "kind" | "parentId" | "status" | "address" | "protected" | "placements"
> & { stopped?: boolean };

export type ServiceAction =
  | "open"
  | "openNewTab"
  | "deploy"
  | "cancelDeploy"
  | "restart"
  | "stop"
  | "start"
  | "stopBox"
  | "openBox"
  | "logs"
  | "console"
  | "clone"
  | "moveProject"
  | "moveNode"
  | "copyAddress"
  | "copyInternalAddress"
  | "copyId"
  | "delete";

export interface ServiceMenuContext {
  /** The service's own page is open: Open would go nowhere. */
  here: boolean;
  /** A deploy of it is queued or running. */
  busy: boolean;
  /**
   * Its desired run state from a live services.get (its own page is open);
   * without it, status "stopped" says so (the panel reports "stopped" for a
   * stopped service that is deployed and not deploying).
   */
  stopped?: boolean;
  /** The terminal modes the viewer may open on it (terminal/access.ts); null while not known. */
  terminalModes: readonly TerminalMode[] | null;
  act: (action: ServiceAction) => void;
}

export function serviceMenuEntries(service: ServiceMenuSubject, ctx: ServiceMenuContext): MenuEntry[] {
  const item = (id: ServiceAction, label: string, Glyph: Icon, extra: Partial<Extract<MenuEntry, { type: "item" }>> = {}): MenuEntry => ({
    type: "item",
    id,
    label,
    icon: <Glyph size={15} stroke={2} aria-hidden="true" />,
    onSelect: () => ctx.act(id),
    ...extra,
  });
  const panel = isPanelService(service);
  const tabs = tabsFor(service.kind);
  const hasTab = (path: TabPath) => tabs.some((tab) => tab.path === path);
  const stopped = service.stopped ?? ctx.stopped ?? service.status === "stopped";
  // The panel's own service updates through Settings > Updates, never by a deploy or a stop.
  const deploys = (service.kind === "app" || service.kind === "cron") && !panel;
  const busy = deploys && ctx.busy;
  const entries: MenuEntry[] = [];

  if (!ctx.here) entries.push(item("open", t("menus.open"), IconArrowUpRight));
  entries.push(item("openNewTab", t("menus.openNewTab"), IconExternalLink), { type: "separator", id: "sep:run" });

  if (service.kind === "box") {
    entries.push(item("stopBox", t("service.header.stop"), IconPlayerStop), item("openBox", t("service.header.openBox"), IconCode));
  } else {
    if (deploys)
      entries.push(
        item(
          "deploy",
          t("service.header.deploy"),
          IconRocket,
          busy ? { disabled: true, disabledReason: t("service.header.deployBusyHint") } : {},
        ),
      );
    if (busy) entries.push(item("cancelDeploy", t("service.header.cancelDeploy"), IconX));
    else {
      if (!stopped && service.status !== "idle") entries.push(item("restart", t("service.header.restart"), IconRefresh));
      if (stopped) entries.push(item("start", t("service.header.start"), IconPlayerPlay));
      else if (service.status !== "idle" && !panel) entries.push(item("stop", t("service.header.stop"), IconPlayerStop));
    }
  }

  entries.push({ type: "separator", id: "sep:tabs" });
  if (hasTab("logs")) entries.push(item("logs", t("menus.logs"), IconFileText));
  if (hasTab("console") && ctx.terminalModes && ctx.terminalModes.length > 0)
    entries.push(item("console", t("menus.console"), IconTerminal2));

  entries.push({ type: "separator", id: "sep:copy-move" });
  // A compose stack is not cloned or moved as a whole, and its members move with it.
  const copyable = !panel && !service.protected && service.kind !== "compose";
  if (copyable) entries.push(item("clone", t("serviceCopy.menu.clone"), IconCopy));
  if (copyable && service.parentId === null) entries.push(item("moveProject", t("serviceCopy.menu.moveProject"), IconArrowsExchange));
  // The Move card on Advanced: services on one node, not the panel's.
  if (hasTab("advanced") && !panel && service.placements.length === 1) entries.push(item("moveNode", t("menus.moveNode"), IconServer2));

  entries.push({ type: "separator", id: "sep:copy" });
  if (service.address)
    entries.push(
      isInternalAddress(service)
        ? item("copyInternalAddress", t("menus.copyInternalAddress"), IconLink)
        : item("copyAddress", t("menus.copyAddress"), IconLink),
    );
  entries.push(item("copyId", t("menus.copyId"), IconHash));

  entries.push({ type: "separator", id: "sep:delete" });
  // As the Settings tab: protected services and compose members show why there instead.
  if (!service.protected && !panel && service.parentId === null)
    entries.push(item("delete", t("menus.delete"), IconTrash, { destructive: true }));

  return tidyEntries(entries);
}
