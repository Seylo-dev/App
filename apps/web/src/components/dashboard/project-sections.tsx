// The dashboard's Cards view: each project is a section on the page ground,
// a title row (tile, name, counts, open, settings, + and the "..." menu)
// over a grid of compact service cards, the project page's cards made
// smaller so four or five fit a row on a wide screen. Collapsed projects
// show only their title row.

import { Chip } from "@seylo/ui/components/chip";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconArrowUpRight, IconChevronDown, IconPlus, IconSettings } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useLiveTopic } from "../../lib/live";
import type { Project, ServiceSummary } from "../../lib/types";
import { useProjectPrefs } from "../../lib/use-project-prefs";
import { NewServiceMenu } from "../new-service/new-service-menu";
import { ServiceCard, ServiceCardSkeleton, useMemoryTotals } from "../project/service-card";
import { ProjectMenu } from "../project-menu";
import { ProjectTile } from "../project-tile";
import { draggingClass, SortableCard, SortableGrip, SortableGroup, useSortableItem } from "../sortable";

/**
 * Columns by the width the sections get (a container query, so the sidebar
 * and the window both count): one on a phone, up to five on a wide screen.
 */
export const cardGrid =
  "grid grid-cols-1 gap-3 @min-[480px]:grid-cols-2 @min-[760px]:grid-cols-3 @min-[1040px]:grid-cols-4 @min-[1360px]:grid-cols-5";

/** The quiet icon buttons of a title row. */
const action =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent p-0 text-ink-faint transition-colors duration-200 hover:bg-track hover:text-foreground data-[state=open]:bg-track data-[state=open]:text-foreground";

export function ProjectSections({
  projects,
  services,
  hidden,
  onToggle,
  onHiddenChange,
}: {
  projects: readonly Project[];
  services: ReadonlyMap<string, ServiceSummary[]>;
  hidden: ReadonlySet<string>;
  onToggle: (project: Project) => void;
  onHiddenChange: (project: Project, hide: boolean) => void;
}) {
  // One nodes.list for every card's memory bar.
  const memoryTotals = useMemoryTotals();
  const prefs = useProjectPrefs();
  return (
    <div className="@container flex flex-col gap-6">
      {/* Drag a project by its title row, a service by its card: the same order as the sidebar's. */}
      <SortableGroup ids={projects.map((project) => project.id)} onMove={prefs.setProjectOrder}>
        {projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            services={services.get(project.id)}
            hidden={hidden.has(project.id)}
            memoryTotals={memoryTotals}
            onToggle={() => onToggle(project)}
            onHiddenChange={(hide) => onHiddenChange(project, hide)}
            onServiceOrder={(ids) => prefs.setServiceOrder(project.id, ids)}
          />
        ))}
      </SortableGroup>
    </div>
  );
}

function ProjectSection({
  project,
  services,
  hidden,
  memoryTotals,
  onToggle,
  onHiddenChange,
  onServiceOrder,
}: {
  project: Project;
  services: ServiceSummary[] | undefined;
  hidden: boolean;
  memoryTotals: ReadonlyMap<string, number>;
  onToggle: () => void;
  onHiddenChange: (hidden: boolean) => void;
  onServiceOrder: (ids: string[]) => void;
}) {
  const open = !project.collapsed;
  const item = useSortableItem(project.id);
  // Service changes are published on the project topic.
  useLiveTopic(`project:${project.id}`);
  const cards = services?.filter((service) => service.parentId === null) ?? [];
  return (
    <article ref={item.ref} style={item.style} className={cn("group/card flex min-w-0 flex-col gap-3", item.dragging && "z-20")}>
      <div
        {...item.handle}
        className={cn(
          "relative flex min-h-8 items-center gap-2.5 rounded-control",
          draggingClass(item.dragging),
          item.dragging && "bg-background",
        )}
      >
        {item.enabled && <SortableGrip grip={item.grip} name={project.name} />}
        <ProjectTile id={project.id} name={project.name} isProtected={project.protected} size="md" />
        <Link
          to="/p/$projectId"
          params={{ projectId: project.id }}
          className="flex min-w-0 cursor-pointer items-baseline gap-2 text-foreground hover:text-foreground"
        >
          <span className="truncate text-sm font-semibold">{project.name}</span>
          <span className="text-xs whitespace-nowrap text-muted-foreground max-sm:hidden">
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
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Link
            to="/p/$projectId"
            params={{ projectId: project.id }}
            aria-label={t("dashboard.openProject", { name: project.name })}
            className={action}
          >
            <IconArrowUpRight size={15} stroke={2} aria-hidden="true" />
          </Link>
          <Link
            to="/p/$projectId"
            params={{ projectId: project.id }}
            search={{ tab: "settings" }}
            aria-label={t("dashboard.projectSettings", { name: project.name })}
            className={action}
          >
            <IconSettings size={15} stroke={2} aria-hidden="true" />
          </Link>
          {/* The protected Panel project takes no new services, as in the sidebar. */}
          {!project.protected && (
            <NewServiceMenu
              projectId={project.id}
              trigger={
                <button type="button" aria-label={t("sidebar.newServiceIn", { name: project.name })} className={action}>
                  <IconPlus size={15} stroke={2} aria-hidden="true" />
                </button>
              }
            />
          )}
          <ProjectMenu name={project.name} hidden={hidden} onHiddenChange={onHiddenChange} className={action} />
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={t(open ? "sidebar.collapse" : "sidebar.expand", { name: project.name })}
            className={action}
          >
            <IconChevronDown
              size={14}
              stroke={2}
              aria-hidden="true"
              className={cn("transition-transform duration-200", !open && "-rotate-90")}
            />
          </button>
        </div>
      </div>
      {open && (
        <SortableGroup ids={cards.map((service) => service.id)} onMove={onServiceOrder} layout="grid">
          <SectionBody project={project} loaded={services !== undefined}>
            {cards.map((service) => (
              <SortableCard key={service.id} id={service.id} name={service.name}>
                <ServiceCard service={service} memoryTotal={memoryTotals.get(service.placements[0]?.nodeId ?? "") ?? 0} compact />
              </SortableCard>
            ))}
          </SectionBody>
        </SortableGroup>
      )}
    </article>
  );
}

/** A project's cards, its placeholders while its services load, or the way to add its first one. */
function SectionBody({ project, loaded, children }: { project: Project; loaded: boolean; children: ReactNode }) {
  if (project.serviceCount === 0) {
    if (project.protected) return <p className="m-0 text-[12.5px] text-muted-foreground">{t("dashboard.noServices")}</p>;
    return (
      <div className={cardGrid}>
        <NewServiceMenu
          projectId={project.id}
          trigger={
            <button
              type="button"
              className="flex min-h-[88px] cursor-pointer items-center justify-center gap-2.5 rounded-card border-[1.5px] border-dashed border-input bg-card/55 text-[13px] font-medium text-ink-strong transition-colors duration-200 hover:bg-card"
            >
              <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <IconPlus size={15} stroke={2.2} />
              </span>
              {t("project.addService")}
            </button>
          }
        />
      </div>
    );
  }
  if (!loaded)
    return (
      <LoadingRegion label={t("common.loading")} className={cardGrid}>
        {Array.from({ length: project.serviceCount }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
          <ServiceCardSkeleton key={i} compact />
        ))}
      </LoadingRegion>
    );
  return <div className={cardGrid}>{children}</div>;
}

/** The Cards view before the projects load: two title rows over a few placeholder cards. */
export function ProjectSectionsSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="@container flex flex-col gap-6">
      {[4, 2].map((count) => (
        <div key={count} aria-hidden="true" className="flex min-w-0 flex-col gap-3">
          <div className="flex min-h-8 items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 bg-track" />
            <SkeletonText ground className="w-24 text-sm" />
            <SkeletonText ground className="w-28 text-xs max-sm:hidden" />
          </div>
          <div className={cardGrid}>
            {Array.from({ length: count }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <ServiceCardSkeleton key={i} compact />
            ))}
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}
