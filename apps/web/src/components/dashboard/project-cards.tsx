// The dashboard's projects, in the view the person picked (remembered in
// this browser, lib/dashboard-view.ts): Cards (project-sections.tsx: each
// project's services as a grid of compact service cards), List (one
// collapsible card per project with its services as rows, below) or Table
// (service-table.tsx: every service in one sortable table). Collapsing is
// the home page's own per-person flag (Project.dashboardCollapsed, saved
// with where "dashboard"), apart from the sidebar's; the order and hiding
// are the same per-person preferences the sidebar uses, and hidden projects
// come back with "Show hidden" without being unhidden. Until the projects
// load, the placeholders take the shape the home page last had
// (lib/projects-shape.ts). Right-clicking a project's header or a service
// row opens the same menu as the project's "..." or the service's
// (menus/), in every view.

import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Segmented, SegmentedItem, SegmentPill } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { type Icon, IconChevronDown, IconFolder, IconLayoutGrid, IconLayoutList, IconTable } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { t } from "../../i18n/t";
import { type DashboardView, dashboardViews, isDashboardView, useDashboardView } from "../../lib/dashboard-view";
import { formatUsage } from "../../lib/format";
import { useLiveTopic } from "../../lib/live";
import { type ShapeRow, useProjectsShape, useRememberProjectsShape } from "../../lib/projects-shape";
import { kindTag, placementLine, statusDisplay } from "../../lib/service-display";
import type { Project, ServiceSummary } from "../../lib/types";
import type { ServicesByProject } from "../../lib/use-all-services";
import { splitHidden, useHiddenProjects } from "../../lib/use-hidden-projects";
import { isCollapsedIn, useProjectPrefs } from "../../lib/use-project-prefs";
import { ServiceContextMenu } from "../menus/service-menu";
import { KindBadge } from "../new-service/kinds";
import { ProjectContextMenu, ProjectMenu } from "../project-menu";
import { ProjectTile } from "../project-tile";
import { QueryError } from "../query-error";
import { useShell } from "../shell/shell-context";
import { draggingClass, SortableGrip, SortableGroup, useSortableItem } from "../sortable";
import { ProjectSections, ProjectSectionsSkeleton } from "./project-sections";
import { ServiceTable } from "./service-table";

const viewIcons: Record<DashboardView, Icon> = { cards: IconLayoutGrid, list: IconLayoutList, table: IconTable };

export function ProjectCards({ data }: { data: ServicesByProject }) {
  const prefs = useProjectPrefs();
  const hiding = useHiddenProjects();
  const shell = useShell();
  const [view, setView] = useDashboardView();
  const [showHidden, setShowHidden] = useState(false);
  const { shown, hidden } = splitHidden(data.projects, hiding.hidden);
  const cards = showHidden ? data.projects : shown;
  const allOpen = cards.every((project) => !isCollapsedIn(project, "dashboard"));
  const allClosed = cards.length > 0 && cards.every((project) => isCollapsedIn(project, "dashboard"));
  // The grid waits for the hidden projects too, so none of them shows for a moment.
  const loading = data.projects.length === 0 ? data.pending : hiding.pending;
  const shape = useProjectsShape("dashboard");
  // Without the hidden ones: Show hidden starts off on the next visit.
  useRememberProjectsShape("dashboard", loading ? undefined : shown);
  const setHidden = (project: Project, hide: boolean) => {
    // Unhiding the last one turns "Show hidden" off, so the next hidden project leaves the grid.
    if (!hide && hidden.length === 1) setShowHidden(false);
    hiding.setHidden(project, hide);
  };
  const toggle = (project: Project) => prefs.setCollapsed(project.id, !isCollapsedIn(project, "dashboard"), "dashboard");

  return (
    <section aria-label={t("nav.projects")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("nav.projects")}</h2>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5">
          {hidden.length > 0 && (
            <div className="inline-flex rounded-control bg-track p-[3px]">
              <TrackButton active={showHidden} onClick={() => setShowHidden((on) => !on)} layoutId="dashboard-hidden">
                {t("dashboard.showHidden", { count: hidden.length })}
              </TrackButton>
            </div>
          )}
          {/* Two actions, not a choice: with some projects open and some closed neither is "selected". The table has no projects to fold. */}
          {view !== "table" && (
            <fieldset
              aria-label={t("dashboard.expandCollapse")}
              className="m-0 inline-flex min-w-0 border-0 gap-0.5 rounded-control bg-track p-[3px]"
            >
              <TrackButton active={allOpen} onClick={() => prefs.setAllCollapsed(false, "dashboard", cards)}>
                {t("dashboard.expandAll")}
              </TrackButton>
              <TrackButton active={allClosed} onClick={() => prefs.setAllCollapsed(true, "dashboard", cards)}>
                {t("dashboard.collapseAll")}
              </TrackButton>
            </fieldset>
          )}
          <Segmented
            tone="track"
            aria-label={t("dashboard.view")}
            value={view}
            onValueChange={(next) => isDashboardView(next) && setView(next)}
          >
            {dashboardViews.map((item) => {
              const ViewIcon = viewIcons[item];
              return (
                <SegmentedItem key={item} value={item} aria-label={t(`dashboard.views.${item}`)} className="text-ink-strong max-sm:px-2">
                  <ViewIcon size={14} stroke={1.8} aria-hidden="true" />
                  <span className="max-sm:hidden">{t(`dashboard.views.${item}`)}</span>
                </SegmentedItem>
              );
            })}
          </Segmented>
        </div>
      </div>

      {/* With no projects loaded, an error is projects.list's: say so instead of "No projects yet". */}
      {!data.pending && data.projects.length === 0 && data.error && <QueryError error={data.error} />}
      {!data.pending && data.projects.length === 0 && !data.error && (
        <div className="rounded-card bg-card shadow-card">
          <EmptyState
            compact
            icon={<IconFolder />}
            title={t("dashboard.noProjects")}
            description={t("dashboard.noProjectsHint")}
            action={
              <Button size="sm" variant="primary" onClick={shell.openNewProject}>
                {t("nav.newProject")}
              </Button>
            }
          />
        </div>
      )}
      {data.error && data.projects.length > 0 && data.services.size === 0 && <QueryError error={data.error} />}
      {!loading && data.projects.length > 0 && cards.length === 0 && (
        <p className="m-0 rounded-card bg-card px-4 py-3 text-[12.5px] text-muted-foreground shadow-card">{t("dashboard.allHidden")}</p>
      )}

      {/* A new view fades in; projects keep their own placeholders while their services load. No empty box under the notes above. */}
      {(loading || cards.length > 0) && (
        <EnterOnChange motionKey={view} subtle className="min-w-0">
          {view === "cards" &&
            (loading ? (
              <ProjectSectionsSkeleton shape={shape} />
            ) : (
              <ProjectSections
                projects={cards}
                services={data.services}
                hidden={hiding.hidden}
                onToggle={toggle}
                onHiddenChange={setHidden}
              />
            ))}
          {view === "list" && (
            <ProjectList
              loading={loading}
              shape={shape}
              projects={cards}
              services={data.services}
              hidden={hiding.hidden}
              onToggle={toggle}
              onHiddenChange={setHidden}
            />
          )}
          {view === "table" && (
            <ServiceTable projects={loading ? [] : cards} services={data.services} hidden={hiding.hidden} loading={loading} />
          )}
        </EnterOnChange>
      )}
    </section>
  );
}

/** The List view's placeholders before the home page has a shape of its own. */
const placeholderCards: ShapeRow[] = [3, 2, 0].map((services) => ({ open: true, services }));

/** The List view: one card per project, three to a row on a wide screen. */
function ProjectList({
  loading,
  shape,
  projects,
  services,
  hidden,
  onToggle,
  onHiddenChange,
}: {
  loading: boolean;
  /** The shape the home page last had, for the placeholders. */
  shape: readonly ShapeRow[] | null;
  projects: readonly Project[];
  services: ReadonlyMap<string, ServiceSummary[]>;
  hidden: ReadonlySet<string>;
  onToggle: (project: Project) => void;
  onHiddenChange: (project: Project, hide: boolean) => void;
}) {
  const prefs = useProjectPrefs();
  if (loading)
    return (
      <LoadingRegion label={t("common.loading")} className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {(shape && shape.length > 0 ? shape : placeholderCards).map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one placeholder per project the home page last showed.
          <ProjectCardSkeleton key={i} rows={row.open ? row.services : 0} />
        ))}
      </LoadingRegion>
    );
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
      {/* Drag a card by its header, a service by its row: the same order as the sidebar's. */}
      <SortableGroup items={projects} onMove={prefs.setProjectOrder} layout="grid">
        {(ordered) =>
          ordered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              services={services.get(project.id)}
              hidden={hidden.has(project.id)}
              onToggle={() => onToggle(project)}
              onHiddenChange={(hide) => onHiddenChange(project, hide)}
              onServiceOrder={(ids) => prefs.setServiceOrder(project.id, ids)}
            />
          ))
        }
      </SortableGroup>
    </div>
  );
}

function ProjectCard({
  project,
  services,
  hidden,
  onToggle,
  onHiddenChange,
  onServiceOrder,
}: {
  project: Project;
  services: ServiceSummary[] | undefined;
  hidden: boolean;
  onToggle: () => void;
  onHiddenChange: (hidden: boolean) => void;
  onServiceOrder: (ids: string[]) => void;
}) {
  const open = !isCollapsedIn(project, "dashboard");
  const item = useSortableItem(project.id);
  // Service changes are published on the project topic.
  useLiveTopic(`project:${project.id}`);
  const rows = services?.filter((service) => service.parentId === null) ?? [];
  return (
    <article
      ref={item.ref}
      style={item.style}
      className={cn("group/card min-w-0 overflow-hidden rounded-card bg-card shadow-card", draggingClass(item.dragging))}
    >
      <ProjectContextMenu project={project} where="dashboard" hidden={hidden} onHiddenChange={onHiddenChange}>
        <div
          {...item.handle}
          className="relative flex items-center gap-2.5 px-4 py-[15px] transition-colors duration-200 data-[state=open]:bg-raised"
        >
          {item.enabled && <SortableGrip grip={item.grip} name={project.name} className="focus-visible:left-1" />}
          <ProjectTile id={project.id} name={project.name} imageUrl={project.imageUrl} isProtected={project.protected} size="md" />
          <Link
            to="/p/$projectId"
            params={{ projectId: project.id }}
            className="flex min-w-0 flex-col gap-px text-foreground hover:text-foreground"
          >
            <span className="truncate text-sm font-semibold">{project.name}</span>
            <span className="text-xs text-muted-foreground">
              {t("sidebar.serviceCount", { count: project.serviceCount })}
              {t("format.separator")}
              {t("dashboard.nodeCount", { count: project.nodeCount })}
            </span>
          </Link>
          {hidden && (
            <Chip tone="track" className="shrink-0 px-[7px] py-0.5 text-[11.5px]">
              {t("dashboard.hiddenChip")}
            </Chip>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {/* Shows on hover or focus, so a card looks the same until then; a touch screen always shows it. */}
            <ProjectMenu
              project={project}
              where="dashboard"
              hidden={hidden}
              onHiddenChange={onHiddenChange}
              className="opacity-0 transition-opacity hover:bg-muted group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
            />
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={t(open ? "sidebar.collapse" : "sidebar.expand", { name: project.name })}
              className="flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-ink-faint hover:bg-muted"
            >
              <IconChevronDown size={14} stroke={2} aria-hidden="true" className={cn("transition-transform", !open && "-rotate-90")} />
            </button>
          </div>
        </div>
      </ProjectContextMenu>
      {open && (
        <div className="flex flex-col px-2 pb-2">
          {project.serviceCount === 0 && (
            <p className="m-0 border-t border-divider px-2 py-3 text-[12.5px] text-muted-foreground">{t("dashboard.noServices")}</p>
          )}
          {project.serviceCount > 0 && !services && (
            <LoadingRegion label={t("common.loading")}>
              {Array.from({ length: project.serviceCount }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
                <ServiceRowSkeleton key={i} />
              ))}
            </LoadingRegion>
          )}
          <SortableGroup items={rows} onMove={onServiceOrder}>
            {(ordered) =>
              ordered.map((service) => (
                <SortableRow key={service.id} id={service.id} name={service.name}>
                  <ServiceRow service={service} />
                </SortableRow>
              ))
            }
          </SortableGroup>
        </div>
      )}
    </article>
  );
}

/** A project card before the projects load: tile, name and counts, and a few service rows. */
function ProjectCardSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="min-w-0 overflow-hidden rounded-card bg-card shadow-card">
      <div className="flex items-center gap-2.5 px-4 py-[15px]">
        <Skeleton className="size-8 shrink-0" />
        <div className="flex min-w-0 flex-col gap-px">
          <SkeletonText className="w-24 text-sm" />
          <SkeletonText className="w-32 text-xs" />
        </div>
      </div>
      {rows > 0 && (
        <div className="flex flex-col px-2 pb-2">
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
            <ServiceRowSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A service row while the project's services load, in ServiceRow's line
 * boxes: the status chip is one 11.5px line plus its 2px padding, like the
 * real chip. It assumes a running service (with a usage line); a stopped
 * one is 3px shorter.
 */
function ServiceRowSkeleton() {
  return (
    <div aria-hidden="true" className="flex items-center gap-2.5 border-t border-divider px-2 py-[9px]">
      <Skeleton className="h-7 w-[34px] shrink-0 rounded-chip" />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <SkeletonText className="w-20 text-[13.5px]" />
        <SkeletonText className="w-44 text-[11.5px]" />
      </span>
      <span className="ml-auto flex shrink-0 flex-col items-end gap-[3px]">
        <Skeleton className="h-[calc(1lh+4px)] w-16 rounded-chip text-[11.5px]" />
        <SkeletonText className="w-20 text-[11.5px]" />
      </span>
    </div>
  );
}

function ServiceRow({ service }: { service: ServiceSummary }) {
  const tag = kindTag(service);
  const status = statusDisplay(service);
  const detail = [service.source.label, service.source.branch, placementLine(service)].filter(Boolean).join(t("format.separator"));
  const usage = formatUsage(service.cpuPercent, service.memoryBytes);
  return (
    <ServiceContextMenu service={service}>
      <Link
        to="/p/$projectId/s/$serviceId"
        params={{ projectId: service.projectId, serviceId: service.id }}
        className="flex items-center gap-2.5 border-t border-divider px-2 py-[9px] text-foreground transition-colors duration-200 hover:bg-raised hover:text-foreground data-[state=open]:bg-raised"
      >
        <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-[13.5px] font-semibold">{service.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">{detail}</span>
        </span>
        <span className="ml-auto flex shrink-0 flex-col items-end gap-[3px]">
          <Chip tone={status.tone} className="px-[7px] py-0.5 text-[11.5px]">
            {/* As the Table's chip: the label says what a deploy does, the dot whether the app is up. */}
            <StatusDot status={status.dot} pulse={status.dot === "busy"} />
            {status.label}
          </Chip>
          {usage && <span className="text-[11.5px] whitespace-nowrap text-muted-foreground">{usage}</span>}
        </span>
      </Link>
    </ServiceContextMenu>
  );
}

function TrackButton({
  active,
  onClick,
  children,
  layoutId = "dashboard-expand",
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  layoutId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // The kit's SegmentedItem size: 26px in a 32px track.
        "relative isolate inline-flex h-[26px] shrink-0 cursor-pointer items-center whitespace-nowrap rounded-chip border-0 bg-transparent px-[11px] text-[12.5px] transition-colors",
        active ? "text-foreground" : "text-ink-strong hover:text-foreground",
      )}
    >
      {active && <SegmentPill layoutId={layoutId} />}
      {children}
    </button>
  );
}

/** A service row of the List view in its project's order; the whole row drags (a click still opens it). */
function SortableRow({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const item = useSortableItem(id);
  return (
    <div ref={item.ref} style={item.style} {...item.handle} className={cn("relative flex flex-col bg-card", draggingClass(item.dragging))}>
      {item.enabled && <SortableGrip grip={item.grip} name={name} />}
      {children}
    </div>
  );
}
