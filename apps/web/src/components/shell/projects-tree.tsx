// Projects in the sidebar (Sidebar.dc.html), each collapsible, with its
// services under it. Collapsed state and order are per person and stored
// by the panel (projects.setCollapsed, projects.reorder), so they follow
// the person across browsers. Drag a project to move it.

import { projects, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { StatusDot } from "@seylo/ui/components/chip";
import { ActiveIndicator } from "@seylo/ui/components/motion";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { useLiveTopic } from "../../lib/live";
import { isBusy, statusDisplay } from "../../lib/service-display";
import { useProjectPrefs } from "../../lib/use-project-prefs";
import { ProjectTile } from "../project-tile";
import { useShell } from "./shell-context";

export function ProjectsTree() {
  const shell = useShell();
  const { data } = useOp(projects.list, {});
  const prefs = useProjectPrefs();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-1">
        <span className="text-xs font-medium text-muted-foreground">{t("nav.projects")}</span>
        <button
          type="button"
          aria-label={t("nav.newProject")}
          onClick={shell.openNewProject}
          className="flex cursor-pointer rounded-chip border-0 bg-transparent p-[3px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <IconPlus size={15} stroke={2} aria-hidden="true" />
        </button>
      </div>

      <ul aria-label={t("nav.projects")} className="-mt-2 m-0 flex list-none flex-col gap-px p-0">
        {data?.projects.length === 0 && <li className="px-2.5 py-1.5 text-[12.5px] text-ink-ghost">{t("sidebar.noProjects")}</li>}
        {data?.projects.map((project) => {
          const open = !project.collapsed;
          const Chevron = open ? IconChevronDown : IconChevronRight;
          return (
            <li
              key={project.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragging(project.id);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                setOver(project.id);
              }}
              onDragLeave={() => setOver((id) => (id === project.id ? null : id))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) prefs.moveBefore(dragging, project.id);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                "flex flex-col rounded-control",
                over === project.id && dragging !== project.id && "shadow-[inset_0_2px_0_var(--primary)]",
              )}
            >
              <div className="flex items-center rounded-control hover:bg-muted">
                <button
                  type="button"
                  onClick={() => prefs.setCollapsed(project.id, open)}
                  aria-expanded={open}
                  aria-label={t(open ? "sidebar.collapse" : "sidebar.expand", { name: project.name })}
                  className="flex cursor-pointer border-0 bg-transparent py-[7px] pr-1 pl-2.5 text-ink-faint"
                >
                  <Chevron size={14} stroke={2} aria-hidden="true" />
                </button>
                <Link
                  to="/p/$projectId"
                  params={{ projectId: project.id }}
                  activeOptions={{ exact: true, includeSearch: false }}
                  className="flex min-w-0 flex-1 items-center gap-[9px] py-[7px] pr-2.5 pl-1 text-[13.5px] font-medium text-foreground hover:text-foreground data-[status=active]:text-accent-foreground"
                >
                  <ProjectTile id={project.id} name={project.name} isProtected={project.protected} />
                  <span className="truncate">{project.name}</span>
                  <span className="ml-auto text-xs font-normal text-muted-foreground">{project.serviceCount}</span>
                </Link>
              </div>
              {open && project.serviceCount > 0 && <ProjectServices projectId={project.id} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Service rows under an expanded project: status dot, name, and a chip while it is busy. */
function ProjectServices({ projectId }: { projectId: string }) {
  const list = useOp(services.list, { projectId });
  useLiveTopic(`project:${projectId}`);
  if (list.isError) return <p className="m-0 py-1 pr-2.5 pl-[43px] text-xs text-ink-ghost">{t("sidebar.servicesUnavailable")}</p>;
  // Compose members are reached through their stack, so only top-level services are listed.
  const rows = list.data?.services.filter((service) => service.parentId === null) ?? [];
  return (
    <ul className="m-0 flex list-none flex-col gap-px p-0">
      {rows.map((service) => {
        const status = statusDisplay(service.status);
        return (
          <li key={service.id}>
            <Link
              to="/p/$projectId/s/$serviceId"
              params={{ projectId, serviceId: service.id }}
              className="relative isolate flex items-center gap-[9px] rounded-control py-1.5 pr-2.5 pl-[43px] text-[13px] text-ink-strong hover:bg-muted hover:text-foreground data-[status=active]:text-accent-foreground"
            >
              {({ isActive }) => (
                <>
                  {/* The same sliding background as the main navigation (sidebar.tsx). */}
                  {isActive && <ActiveIndicator layoutId="sidebar-nav" className="rounded-control bg-accent" />}
                  <StatusDot status={status.dot} />
                  <span className="truncate">{service.name}</span>
                  {isBusy(service.status) && (
                    <span className="ml-auto rounded-[5px] bg-chip-amber-bg px-1.5 py-px text-[11px] font-medium text-chip-amber-fg">
                      {status.label.toLowerCase()}
                    </span>
                  )}
                </>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
