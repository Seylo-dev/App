// Projects in the sidebar (Sidebar.dc.html), each collapsible, with its
// services under it. Collapsed state, order and hidden projects are per
// person and stored by the panel (projects.setCollapsed, projects.reorder,
// auth.preferences), so they follow the person across browsers. The
// sidebar's collapsed flag is its own (where "sidebar"): folding a project
// here leaves it open on the home page. Until the projects load, the
// placeholders take the shape the sidebar last had (lib/projects-shape.ts).
// Drag a project to move it; its "..." menu hides it. Hidden projects wait
// under a folded "Hidden (N)" row at the end, unless the person turned that
// group off (Settings > Preferences): then only the hidden project whose
// pages are open shows there, so the sidebar still marks where they are.
// Right-clicking a project row or a service row opens the same menu as the
// project's "..." (project-menu.tsx) or the service's (menus/service-menu.tsx).

import { projects, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { StatusDot } from "@seylo/ui/components/chip";
import { ActiveIndicator } from "@seylo/ui/components/motion";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { Link, useParams } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { t } from "../../i18n/t";
import { useLiveTopic } from "../../lib/live";
import { type ShapeRow, useProjectsShape, useRememberProjectsShape } from "../../lib/projects-shape";
import { isBusy, statusDisplay } from "../../lib/service-display";
import type { Project } from "../../lib/types";
import { hiddenInSidebar, splitHidden, useHiddenProjects } from "../../lib/use-hidden-projects";
import { isCollapsedIn, useProjectPrefs } from "../../lib/use-project-prefs";
import { ServiceContextMenu } from "../menus/service-menu";
import { NewServiceMenu } from "../new-service/new-service-menu";
import { ProjectContextMenu, ProjectMenu } from "../project-menu";
import { ProjectTile } from "../project-tile";
import { draggingClass, SortableGrip, SortableGroup, useSortableItem } from "../sortable";
import { useShell } from "./shell-context";

/** The placeholder rows before the sidebar has a shape of its own: three folded projects. */
const placeholderRows: ShapeRow[] = [0, 1, 2].map(() => ({ open: false, services: 0 }));

export function ProjectsTree() {
  const shell = useShell();
  const { data, isPending } = useOp(projects.list, {});
  const prefs = useProjectPrefs();
  const hiding = useHiddenProjects();
  const [showHidden, setShowHidden] = useState(false);
  // The project of the page that is open, if any (the sidebar sits outside the project routes).
  const currentProjectId = useParams({ strict: false, select: (params) => params.projectId });
  // The list waits for the hidden projects too, so none of them shows for a moment.
  const loading = isPending || hiding.pending;
  const list = loading ? undefined : data?.projects;
  const { shown, hidden } = splitHidden(list ?? [], hiding.hidden);
  const { group, current } = hiddenInSidebar(hidden, hiding.showInSidebar, currentProjectId);
  const shape = useProjectsShape("sidebar");
  useRememberProjectsShape("sidebar", list && shown);
  const toggle = (projectId: string, collapsed: boolean) => prefs.setCollapsed(projectId, collapsed, "sidebar");
  const HiddenChevron = showHidden ? IconChevronDown : IconChevronRight;
  const setHidden = (project: Project, hide: boolean) => {
    // Unhiding the last one folds the row, so the next hidden project starts out of sight.
    if (!hide && hidden.length === 1) setShowHidden(false);
    hiding.setHidden(project, hide);
  };

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
        {list?.length === 0 && <li className="px-2.5 py-1.5 text-[12.5px] text-ink-ghost">{t("sidebar.noProjects")}</li>}
        {loading && (
          <li>
            {/* The shape the sidebar last had: folded rows, open ones with a row per service. */}
            <LoadingRegion label={t("common.loading")} className="flex flex-col gap-px">
              {(shape && shape.length > 0 ? shape : placeholderRows).map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: one placeholder per project the sidebar last showed.
                <div key={i} data-placeholder-project={row.open ? "open" : "collapsed"} className="flex flex-col">
                  <div className="flex items-center py-[7px] pr-2.5 pl-2.5">
                    <Skeleton className="mr-[9px] size-3.5 shrink-0 rounded-[4px]" />
                    <Skeleton className="mr-[9px] size-5 shrink-0 rounded-chip" />
                    <SkeletonText className="w-20 text-[13.5px]" />
                  </div>
                  {row.open && (
                    <div className="flex flex-col gap-px pb-2">
                      <ServiceRowPlaceholders count={row.services} />
                    </div>
                  )}
                </div>
              ))}
            </LoadingRegion>
          </li>
        )}
        <SortableGroup items={shown} onMove={prefs.setProjectOrder}>
          {(ordered) =>
            ordered.map((project) => (
              <SortableProject key={project.id} id={project.id}>
                {(item) => <ProjectRow project={project} hidden={false} onToggle={toggle} onHiddenChange={setHidden} sortable={item} />}
              </SortableProject>
            ))
          }
        </SortableGroup>
        {/* Hidden projects wait at the end, folded; opening the row shows them without unhiding them. */}
        {group.length > 0 && (
          <li className="flex flex-col">
            <button
              type="button"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((open) => !open)}
              className="flex cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent py-[7px] pr-2.5 pl-2.5 text-left text-[12.5px] text-muted-foreground transition-interactive hover:bg-muted hover:text-foreground"
            >
              <HiddenChevron size={14} stroke={2} aria-hidden="true" className="text-ink-faint" />
              {t("sidebar.hidden", { count: group.length })}
            </button>
            {showHidden && (
              <ul aria-label={t("sidebar.hidden", { count: group.length })} className="m-0 flex list-none flex-col gap-px p-0">
                {group.map((project) => (
                  <li key={project.id} className="flex flex-col rounded-control">
                    <ProjectRow project={project} hidden onToggle={toggle} onHiddenChange={setHidden} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
        {/* Without the group, the hidden project that is open still shows while its pages are. */}
        {current && (
          <li className="flex flex-col rounded-control">
            <ProjectRow project={current} hidden onToggle={toggle} onHiddenChange={setHidden} />
          </li>
        )}
      </ul>
    </>
  );
}

/**
 * One project: the chevron that collapses it, its link and its "..." menu.
 * The menu button sits over the service count and shows on hover or focus,
 * so the row looks the same until then; a touch screen always shows it,
 * after the count.
 */
function ProjectRow({
  project,
  hidden,
  onToggle,
  onHiddenChange,
  sortable,
}: {
  project: Project;
  hidden: boolean;
  onToggle: (projectId: string, collapsed: boolean) => void;
  onHiddenChange: (project: Project, hidden: boolean) => void;
  /** Drag to reorder (the row, not the services under it). Hidden projects have none. */
  sortable?: SortableItem;
}) {
  const open = !isCollapsedIn(project, "sidebar");
  const Chevron = open ? IconChevronDown : IconChevronRight;
  const setHidden = (hide: boolean) => onHiddenChange(project, hide);
  return (
    <>
      {/* The row is the indicator's box: it covers the chevron too. Right-click opens the "..." menu's list. */}
      <ProjectContextMenu project={project} where="sidebar" hidden={hidden} onHiddenChange={setHidden}>
        <div
          {...sortable?.handle}
          className="group/row relative isolate flex items-center rounded-control transition-interactive hover:bg-muted data-[state=open]:bg-muted"
        >
          {sortable?.enabled && <SortableGrip grip={sortable.grip} name={project.name} />}
          <button
            type="button"
            onClick={() => onToggle(project.id, open)}
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
            {({ isActive }) => (
              <>
                {/* The same sliding background as the main navigation and the service rows. It
                  follows the link's own active state, so it moves in the same commit as theirs. */}
                {isActive && <ActiveIndicator layoutId="sidebar-nav" className="rounded-control bg-accent" />}
                <ProjectTile id={project.id} name={project.name} imageUrl={project.imageUrl} isProtected={project.protected} />
                <span className={cn("truncate", hidden && "text-muted-foreground")}>{project.name}</span>
                <span className="ml-auto text-xs font-normal text-muted-foreground transition-opacity group-hover/row:opacity-0 group-has-[[data-project-menu]:focus-visible]/row:opacity-0 group-has-[[data-project-menu][data-state=open]]/row:opacity-0 pointer-coarse:opacity-100!">
                  {project.serviceCount}
                </span>
              </>
            )}
          </Link>
          {/* New service (+) and More (...): shown on hover or keyboard focus, always on touch screens. */}
          <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:static pointer-coarse:mr-1.5 pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
            {!project.protected && (
              <NewServiceMenu
                projectId={project.id}
                trigger={
                  <button
                    type="button"
                    data-project-menu=""
                    aria-label={t("sidebar.newServiceIn", { name: project.name })}
                    className="flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-ink-faint transition-interactive hover:text-foreground"
                  >
                    <IconPlus size={15} stroke={2} aria-hidden="true" />
                  </button>
                }
              />
            )}
            <ProjectMenu project={project} where="sidebar" hidden={hidden} onHiddenChange={setHidden} />
          </div>
        </div>
      </ProjectContextMenu>
      {/* Room after an open project (with its services, or none yet), so the next one reads as its own group;
          collapsed projects sit close together. */}
      {open && (
        <div className="pb-2">
          {project.serviceCount > 0 && <ProjectServices projectId={project.id} count={project.serviceCount} sortable={!hidden} />}
        </div>
      )}
    </>
  );
}

/** Service rows under an expanded project: status dot, name, and a chip while it is busy. */
function ProjectServices({ projectId, count, sortable }: { projectId: string; count: number; sortable: boolean }) {
  const list = useOp(services.list, { projectId });
  const prefs = useProjectPrefs();
  useLiveTopic(`project:${projectId}`);
  if (list.isError) return <p className="m-0 py-1 pr-2.5 pl-[43px] text-xs text-ink-ghost">{t("sidebar.servicesUnavailable")}</p>;
  if (list.isPending)
    return (
      <LoadingRegion label={t("common.loading")} className="flex flex-col gap-px">
        <ServiceRowPlaceholders count={count} />
      </LoadingRegion>
    );
  // Compose members are reached through their stack, so only top-level services are listed.
  const rows = list.data?.services.filter((service) => service.parentId === null) ?? [];
  return (
    <SortableGroup items={rows} onMove={(ids) => prefs.setServiceOrder(projectId, ids)} disabled={!sortable}>
      {(ordered) => (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {ordered.map((service) => {
            const status = statusDisplay(service.status, service.buildWaiting);
            return (
              <SortableService key={service.id} id={service.id} name={service.name}>
                {/* The link is the menu's trigger, so the sortable item around it keeps its own handlers. */}
                <ServiceContextMenu service={service}>
                  <Link
                    to="/p/$projectId/s/$serviceId"
                    params={{ projectId, serviceId: service.id }}
                    className="relative isolate flex items-center gap-[9px] rounded-control py-1.5 pr-2.5 pl-[43px] text-[13px] text-ink-strong transition-interactive hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[status=active]:text-accent-foreground"
                  >
                    {({ isActive }) => (
                      <>
                        {/* The same sliding background as the main navigation (sidebar.tsx). */}
                        {isActive && <ActiveIndicator layoutId="sidebar-nav" className="rounded-control bg-accent" />}
                        <StatusDot status={status.dot} />
                        <span className="truncate">{service.name}</span>
                        {isBusy(service.status) && (
                          <span
                            title={status.label}
                            className="ml-auto rounded-[5px] bg-chip-amber-bg px-1.5 py-px text-[11px] font-medium text-chip-amber-fg"
                          >
                            {/* "waiting for a build slot" does not fit next to a name: the badge says "waiting". */}
                            {service.status === "building" && service.buildWaiting ? t("project.waitingShort") : status.label.toLowerCase()}
                          </span>
                        )}
                      </>
                    )}
                  </Link>
                </ServiceContextMenu>
              </SortableService>
            );
          })}
        </ul>
      )}
    </SortableGroup>
  );
}

/** A placeholder row per service: a status dot and a name. */
function ServiceRowPlaceholders({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: one placeholder per service the project has.
    <div key={i} className="flex items-center gap-[9px] py-1.5 pr-2.5 pl-[43px]">
      <Skeleton className="size-1.5 shrink-0 rounded-full" />
      <SkeletonText className="w-16 text-[13px]" />
    </div>
  ));
}

type SortableItem = ReturnType<typeof useSortableItem>;

/** A project in the sidebar's order: it drags by its row, so its services can be dragged on their own. */
function SortableProject({ id, children }: { id: string; children: (item: SortableItem) => ReactNode }) {
  const item = useSortableItem(id);
  return (
    <li ref={item.ref} style={item.style} className={cn("flex flex-col rounded-control bg-sidebar", draggingClass(item.dragging))}>
      {children(item)}
    </li>
  );
}

/** A service row in its project's order. */
function SortableService({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const item = useSortableItem(id);
  return (
    <li
      ref={item.ref}
      style={item.style}
      {...item.handle}
      className={cn("relative rounded-control bg-sidebar", draggingClass(item.dragging))}
    >
      {item.enabled && <SortableGrip grip={item.grip} name={name} />}
      {children}
    </li>
  );
}
