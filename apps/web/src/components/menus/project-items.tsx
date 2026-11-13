// What a project's menus offer: its "..." button in the sidebar and on the
// dashboard, and the right-click menu of the same rows and cards. The rules
// are the project page's: the protected Panel project takes no new
// services and is not renamed or deleted, and a project is deleted only
// once it has no services left.
//
//   Open (not on its own page), Open in new tab
//   New service > every kind of the New service menu
//   Rename, Collapse or Expand, Hide project or Unhide project, Settings
//   Copy ID
//   Delete

import { type MenuEntry, tidyEntries } from "@seylo/ui/components/menu-items";
import {
  type Icon,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconHash,
  IconPencil,
  IconPlus,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { t } from "../../i18n/t";
import type { Project } from "../../lib/types";
import { type NewServiceKind, newServiceKinds } from "../new-service/kinds";

export type ProjectMenuSubject = Pick<Project, "id" | "name" | "protected" | "collapsed" | "serviceCount">;

export type ProjectAction =
  | "open"
  | "openNewTab"
  | "rename"
  | "collapse"
  | "expand"
  | "hide"
  | "unhide"
  | "settings"
  | "copyId"
  | "delete"
  | `new:${NewServiceKind}`;

export interface ProjectMenuContext {
  /** The project's own page is open. */
  here: boolean;
  /** The person hid it (use-hidden-projects.ts). */
  hidden: boolean;
  act: (action: ProjectAction) => void;
}

export function projectMenuEntries(project: ProjectMenuSubject, ctx: ProjectMenuContext): MenuEntry[] {
  const item = (id: ProjectAction, label: string, Glyph: Icon, extra: Partial<Extract<MenuEntry, { type: "item" }>> = {}): MenuEntry => ({
    type: "item",
    id,
    label,
    icon: <Glyph size={15} stroke={2} aria-hidden="true" />,
    onSelect: () => ctx.act(id),
    ...extra,
  });
  const entries: MenuEntry[] = [];
  if (!ctx.here) entries.push(item("open", t("menus.open"), IconArrowUpRight));
  entries.push(item("openNewTab", t("menus.openNewTab"), IconExternalLink), { type: "separator", id: "sep:new" });
  if (!project.protected)
    entries.push({
      type: "sub",
      id: "newService",
      label: t("menus.newService"),
      icon: <IconPlus size={15} stroke={2} aria-hidden="true" />,
      entries: newServiceKinds.map(
        (kind): MenuEntry => ({ type: "item", id: `new:${kind.kind}`, label: t(kind.title), onSelect: () => ctx.act(`new:${kind.kind}`) }),
      ),
    });
  entries.push({ type: "separator", id: "sep:edit" });
  if (!project.protected) entries.push(item("rename", t("menus.rename"), IconPencil));
  entries.push(
    project.collapsed ? item("expand", t("menus.expand"), IconChevronRight) : item("collapse", t("menus.collapse"), IconChevronDown),
    ctx.hidden ? item("unhide", t("sidebar.unhideProject"), IconEye) : item("hide", t("sidebar.hideProject"), IconEyeOff),
    item("settings", t("menus.settings"), IconSettings),
    { type: "separator", id: "sep:copy" },
    item("copyId", t("menus.copyId"), IconHash),
    { type: "separator", id: "sep:delete" },
  );
  if (!project.protected)
    entries.push(
      item("delete", t("menus.delete"), IconTrash, {
        destructive: true,
        ...(project.serviceCount > 0 ? { disabled: true, disabledReason: t("project.deleteHasServices") } : {}),
      }),
    );
  return tidyEntries(entries);
}
