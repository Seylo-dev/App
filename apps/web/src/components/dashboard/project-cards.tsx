// The dashboard's project grid (Main.dc.html): one collapsible card per
// project with its services, their status and current usage. Collapsing
// is the same per-person preference the sidebar uses.

import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SegmentPill } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconFolder } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { formatUsage } from "../../lib/format";
import { useLiveTopic } from "../../lib/live";
import { kindTag, placementLine, statusDisplay } from "../../lib/service-display";
import type { Project, ServiceSummary } from "../../lib/types";
import type { ServicesByProject } from "../../lib/use-all-services";
import { useProjectPrefs } from "../../lib/use-project-prefs";
import { KindBadge } from "../new-service/kinds";
import { ProjectTile } from "../project-tile";
import { QueryError } from "../query-error";
import { useShell } from "../shell/shell-context";

export function ProjectCards({ data }: { data: ServicesByProject }) {
  const prefs = useProjectPrefs();
  const shell = useShell();
  const allOpen = data.projects.every((project) => !project.collapsed);
  const allClosed = data.projects.length > 0 && data.projects.every((project) => project.collapsed);

  return (
    <section aria-label={t("nav.projects")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("nav.projects")}</h2>
        {/* Two actions, not a choice: with some projects open and some closed neither is "selected". */}
        <fieldset
          aria-label={t("dashboard.expandCollapse")}
          className="m-0 ml-auto inline-flex min-w-0 border-0 gap-0.5 rounded-control bg-track p-[3px]"
        >
          <TrackButton active={allOpen} onClick={() => prefs.setAllCollapsed(false)}>
            {t("dashboard.expandAll")}
          </TrackButton>
          <TrackButton active={allClosed} onClick={() => prefs.setAllCollapsed(true)}>
            {t("dashboard.collapseAll")}
          </TrackButton>
        </fieldset>
      </div>

      {data.pending && data.projects.length === 0 && (
        <LoadingRegion label={t("common.loading")} className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <ProjectCardSkeleton rows={3} />
          <ProjectCardSkeleton rows={2} />
          <ProjectCardSkeleton rows={0} />
        </LoadingRegion>
      )}
      {!data.pending && data.projects.length === 0 && (
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

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {data.projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            services={data.services.get(project.id)}
            onToggle={() => prefs.setCollapsed(project.id, !project.collapsed)}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectCard({ project, services, onToggle }: { project: Project; services: ServiceSummary[] | undefined; onToggle: () => void }) {
  const open = !project.collapsed;
  // Service changes are published on the project topic.
  useLiveTopic(`project:${project.id}`);
  const rows = services?.filter((service) => service.parentId === null) ?? [];
  return (
    <article className="min-w-0 overflow-hidden rounded-card bg-card shadow-card">
      <div className="flex items-center gap-2.5 px-4 py-[15px]">
        <ProjectTile id={project.id} name={project.name} isProtected={project.protected} size="md" />
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
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={t(open ? "sidebar.collapse" : "sidebar.expand", { name: project.name })}
          className="ml-auto flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-ink-faint hover:bg-muted"
        >
          <IconChevronDown size={14} stroke={2} aria-hidden="true" className={cn("transition-transform", !open && "-rotate-90")} />
        </button>
      </div>
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
          {rows.map((service) => (
            <ServiceRow key={service.id} service={service} />
          ))}
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
  const status = statusDisplay(service.status);
  const detail = [service.source.label, service.source.branch, placementLine(service)].filter(Boolean).join(t("format.separator"));
  const usage = formatUsage(service.cpuPercent, service.memoryBytes);
  return (
    <Link
      to="/p/$projectId/s/$serviceId"
      params={{ projectId: service.projectId, serviceId: service.id }}
      className="flex items-center gap-2.5 border-t border-divider px-2 py-[9px] text-foreground hover:bg-raised hover:text-foreground"
    >
      <KindBadge tag={tag.label} tone={tag.tone} className="w-[34px]" />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-[13.5px] font-semibold">{service.name}</span>
        <span className="truncate text-[11.5px] text-muted-foreground">{detail}</span>
      </span>
      <span className="ml-auto flex shrink-0 flex-col items-end gap-[3px]">
        <Chip tone={status.tone} className="px-[7px] py-0.5 text-[11.5px]">
          {status.label}
        </Chip>
        {usage && <span className="text-[11.5px] whitespace-nowrap text-muted-foreground">{usage}</span>}
      </span>
    </Link>
  );
}

function TrackButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "relative isolate cursor-pointer rounded-chip border-0 bg-transparent px-[11px] py-[5px] text-[12.5px]",
        active ? "text-foreground" : "text-ink-strong hover:text-foreground",
      )}
    >
      {active && <SegmentPill layoutId="dashboard-expand" />}
      {children}
    </button>
  );
}
