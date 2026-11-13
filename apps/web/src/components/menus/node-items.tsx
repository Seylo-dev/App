// What a node's menus offer on the Nodes page: its "..." button and the
// right-click menu of its row. The views of the node sheet, Run health
// checks (only an online node answers), Update now as the row's button has
// it (an update there, the node online, none on its way), and the node's
// addresses and id to copy. Reboot and Remove stay in the sheet.

import { type MenuEntry, tidyEntries } from "@seylo/ui/components/menu-items";
import {
  type Icon,
  IconArrowUpRight,
  IconDownload,
  IconHash,
  IconHeart,
  IconHeartbeat,
  IconLink,
  IconSettings,
  IconSparkles,
  IconTerminal2,
} from "@tabler/icons-react";
import { t } from "../../i18n/t";
import type { NodeRow } from "../../lib/types";

export type NodeMenuSubject = Pick<NodeRow, "id" | "name" | "status" | "updateAvailable" | "publicAddress" | "publicIpv4" | "publicIpv6">;

export type NodeAction =
  | "open"
  | "health"
  | "runHealthChecks"
  | "shell"
  | "cleanup"
  | "settings"
  | "update"
  | "copyAddress"
  | "copyIpv4"
  | "copyIpv6"
  | "copyId";

export interface NodeMenuContext {
  /** An agent update of this list is on its way. */
  updatePending: boolean;
  act: (action: NodeAction) => void;
}

export function nodeMenuEntries(node: NodeMenuSubject, ctx: NodeMenuContext): MenuEntry[] {
  const item = (id: NodeAction, label: string, Glyph: Icon, extra: Partial<Extract<MenuEntry, { type: "item" }>> = {}): MenuEntry => ({
    type: "item",
    id,
    label,
    icon: <Glyph size={15} stroke={2} aria-hidden="true" />,
    onSelect: () => ctx.act(id),
    ...extra,
  });
  const online = node.status === "online";
  const offline = online ? {} : { disabled: true, disabledReason: t("menus.nodeOffline") };
  const entries: MenuEntry[] = [
    item("open", t("menus.open"), IconArrowUpRight),
    item("health", t("nodes.health"), IconHeart),
    item("runHealthChecks", t("menus.runHealthChecks"), IconHeartbeat, offline),
    item("shell", t("menus.shell"), IconTerminal2),
    item("cleanup", t("menus.cleanup"), IconSparkles),
    item("settings", t("nodes.settings"), IconSettings),
    { type: "separator", id: "sep:update" },
  ];
  if (node.updateAvailable)
    entries.push(item("update", t("nodes.updateNow"), IconDownload, ctx.updatePending ? { disabled: true } : offline));
  entries.push({ type: "separator", id: "sep:copy" });
  if (node.publicAddress && node.publicAddress !== node.publicIpv4 && node.publicAddress !== node.publicIpv6)
    entries.push(item("copyAddress", t("menus.copyAddress"), IconLink));
  if (node.publicIpv4) entries.push(item("copyIpv4", t("menus.copyIpv4"), IconLink));
  if (node.publicIpv6) entries.push(item("copyIpv6", t("menus.copyIpv6"), IconLink));
  entries.push(item("copyId", t("menus.copyId"), IconHash));
  return tidyEntries(entries);
}
