// A project's menu: the "..." button of its sidebar row and its home page
// card or section, and the right-click menu of the same rows (the list of
// what it offers is menus/project-items.tsx). Both render ProjectMenuItems,
// so they never differ. Hiding is the person's own choice
// (use-hidden-projects.ts); nobody else's view changes. The surface passes
// its own hide callback, which also folds its "Hidden" group when the last
// hidden project comes back, and its view (`where`): Collapse and Expand
// fold the project there only, the sidebar or the home page, like that
// view's own chevron (lib/use-project-prefs.ts).

import { ActionsMenu, type MenuEntry, MenuItems } from "@seylo/ui/components/menu-items";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots } from "@tabler/icons-react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { t } from "../i18n/t";
import type { CollapseWhere, Project } from "../lib/types";
import { isCollapsedIn, useProjectPrefs } from "../lib/use-project-prefs";
import { useObjectActions } from "./menus/object-actions";
import { type ProjectMenuSubject, projectMenuEntries } from "./menus/project-items";
import { copyWithToast, RowMenu } from "./menus/row-menu";
import type { NewServiceKind } from "./new-service/kinds";
import { useStartNewService } from "./new-service/new-service-menu";

interface ProjectMenuProps {
  project: ProjectMenuSubject & Pick<Project, "dashboardCollapsed">;
  /** The view the menu is in: its Collapse or Expand is that view's flag. */
  where: CollapseWhere;
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}

export function useProjectMenu({ project, where, hidden, onHiddenChange }: ProjectMenuProps): MenuEntry[] {
  const objects = useObjectActions();
  const navigate = useNavigate();
  const router = useRouter();
  const prefs = useProjectPrefs();
  const startNewService = useStartNewService();
  const here = useRouterState({ select: (state) => state.location.pathname === `/p/${project.id}` });
  const params = { projectId: project.id };
  return projectMenuEntries(
    { ...project, collapsed: isCollapsedIn(project, where) },
    {
      here,
      hidden,
      act: (action) => {
        if (action.startsWith("new:")) return startNewService(action.slice("new:".length) as NewServiceKind, project.id);
        switch (action) {
          case "open":
            return void navigate({ to: "/p/$projectId", params });
          case "openNewTab":
            return void window.open(router.buildLocation({ to: "/p/$projectId", params }).href, "_blank", "noopener");
          case "rename":
            return objects.openDialog({ kind: "project-rename", project });
          case "collapse":
            return prefs.setCollapsed(project.id, true, where);
          case "expand":
            return prefs.setCollapsed(project.id, false, where);
          case "hide":
            return onHiddenChange(true);
          case "unhide":
            return onHiddenChange(false);
          case "settings":
            return void navigate({ to: "/p/$projectId", params, search: { tab: "settings" } });
          case "copyId":
            return void copyWithToast(project.id);
          case "delete":
            return objects.openDialog({ kind: "project-delete", project });
        }
      },
    },
  );
}

export function ProjectMenuItems({ as, ...props }: ProjectMenuProps & { as: "dropdown" | "context" }) {
  return <MenuItems as={as} entries={useProjectMenu(props)} />;
}

/** The "..." button. */
export function ProjectMenu({ className, ...props }: ProjectMenuProps & { className?: string }) {
  return (
    <ActionsMenu
      trigger={
        <button
          type="button"
          data-project-menu=""
          aria-label={t("sidebar.projectMenu", { name: props.project.name })}
          className={cn("flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-ink-faint hover:text-foreground", className)}
        >
          <IconDots size={15} stroke={2} aria-hidden="true" />
        </button>
      }
      items={<ProjectMenuItems as="dropdown" {...props} />}
    />
  );
}

/** `children` (the project's row or title row) opens the same menu on right-click, long-press or Shift+F10. */
export function ProjectContextMenu({ children, ...props }: ProjectMenuProps & { children: ReactElement }) {
  return (
    <RowMenu items={<ProjectMenuItems as="context" {...props} />} aria-label={t("menus.actionsFor", { name: props.project.name })}>
      {children}
    </RowMenu>
  );
}
