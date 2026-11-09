// A project (Project.dc.html): breadcrumb, name, counts, the private
// network, and five sections as tabs (?tab=): services, shared
// environment, people, activity and settings.

import { projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { TabIndicator, tabClassName } from "@seylo/ui/components/tabs";
import { scrollFadeRef } from "@seylo/ui/lib/scroll-fade";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { NewServiceMenu } from "../../../../components/new-service/new-service-menu";
import { PageHeader } from "../../../../components/page-header";
import { ProjectActivity } from "../../../../components/project/project-activity";
import { ProjectPeople, ShareDialog } from "../../../../components/project/project-people";
import { ProjectSettings } from "../../../../components/project/project-settings";
import { ServicesGrid, ServicesGridSkeleton } from "../../../../components/project/services-grid";
import { SharedEnv } from "../../../../components/project/shared-env";
import { QueryError } from "../../../../components/query-error";
import { type MessageKey, t } from "../../../../i18n/t";
import { useLiveTopic } from "../../../../lib/live";

const tabs = ["services", "env", "people", "activity", "settings"] as const;
type Tab = (typeof tabs)[number];

const tabLabels: Record<Tab, MessageKey> = {
  services: "project.tabs.services",
  env: "project.tabs.env",
  people: "project.tabs.people",
  activity: "project.tabs.activity",
  settings: "project.tabs.settings",
};

export const Route = createFileRoute("/_app/p/$projectId/")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab) && search.tab !== "services" ? { tab: search.tab as Tab } : {},
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { tab = "services" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = useOp(projects.get, { projectId });
  const [shareOpen, setShareOpen] = useState(false);
  useLiveTopic(`project:${projectId}`);

  // On a phone the tabs are one swipe row (like the service tabs): bring the
  // current tab into it, so ?tab=settings never opens with Settings off screen.
  const tabRow = useRef<HTMLElement | null>(null);
  const tabRowRef = useCallback((el: HTMLElement | null) => {
    tabRow.current = el;
    return scrollFadeRef(el);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the current tab changes.
  useEffect(() => {
    const row = tabRow.current;
    const current = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !current || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.left < box.left) row.scrollLeft -= box.left - item.left + 24;
    else if (item.right > box.right) row.scrollLeft += item.right - box.right + 24;
  }, [tab]);

  if (project.isError) return <QueryError error={project.error} onRetry={() => void project.refetch()} />;
  const { data } = project;
  const goTo = (next: Tab) => void navigate({ search: next === "services" ? {} : { tab: next } });

  return (
    <>
      {/* While the project loads, the header and the open tab show placeholders; the tab bar works right away. */}
      {!data ? (
        <ProjectHeaderSkeleton />
      ) : (
        <PageHeader
          breadcrumb={
            <>
              <Link to="/">{t("nav.projects")}</Link>
              <span aria-hidden="true">/</span>
              <span className="text-foreground">{data.name}</span>
            </>
          }
          title={data.name}
          subtitle={
            <span className="mt-1 flex flex-wrap gap-1.5 text-xs text-ink-strong">
              <Chip tone="track">{t("sidebar.serviceCount", { count: data.serviceCount })}</Chip>
              <Chip tone="track">{t("dashboard.nodeCount", { count: data.nodeCount })}</Chip>
              <Chip tone="track">
                {t("project.network")} <span className="font-mono text-[11.5px]">{data.networkName}</span>
              </Chip>
              {data.guestCount > 0 && <Chip tone="track">{t("project.guestCount", { count: data.guestCount })}</Chip>}
              {data.protected && <Chip tone="blue">{t("project.protected")}</Chip>}
              {data.description && <span className="self-center px-1 text-muted-foreground">{data.description}</span>}
            </span>
          }
          actions={
            <>
              <Button onClick={() => setShareOpen(true)}>{t("project.share")}</Button>
              <Button onClick={() => goTo("settings")}>{t("project.tabs.settings")}</Button>
              {!data.protected && <NewServiceMenu projectId={data.id} />}
            </>
          }
        />
      )}

      {/* One swipe row on a phone (the hidden edge fades); from md up the tabs wrap, so every tab shows. */}
      <div
        ref={tabRowRef}
        role="tablist"
        aria-label={t("project.sections")}
        className="scroll-row flex flex-nowrap gap-1 border-b border-border md:flex-wrap md:overflow-visible"
      >
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => goTo(item)}
            className={`shrink-0 cursor-pointer border-x-0 border-t-0 bg-transparent whitespace-nowrap ${tabClassName}`}
          >
            {tab === item && <TabIndicator layoutId="project-tabs" />}
            {t(tabLabels[item])}
          </button>
        ))}
      </div>

      {/* The shared environment, people and activity need only the id, so they load next to the project; services and settings wait for it. */}
      <EnterOnChange motionKey={tab} subtle role="tabpanel" aria-label={t(tabLabels[tab])}>
        {tab === "services" && (data ? <ServicesGrid projectId={data.id} canCreate={!data.protected} /> : <ServicesGridSkeleton />)}
        {tab === "env" && <SharedEnv projectId={projectId} />}
        {tab === "people" && <ProjectPeople projectId={projectId} onShare={() => setShareOpen(true)} />}
        {tab === "activity" && <ProjectActivity projectId={projectId} />}
        {tab === "settings" && (data ? <ProjectSettings key={data.updatedAt} project={data} /> : <SettingsSkeleton />)}
      </EnterOnChange>
      {data && <ShareDialog projectId={data.id} open={shareOpen} onOpenChange={setShareOpen} />}
    </>
  );
}

/** PageHeader's layout while the project loads: breadcrumb, name, the count chips and the three actions. */
function ProjectHeaderSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-2.5">
      <nav className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground [&_a]:text-muted-foreground [&_a:hover]:text-foreground">
        <Link to="/">{t("nav.projects")}</Link>
        <span aria-hidden="true">/</span>
        <SkeletonText ground className="w-20" />
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SkeletonText ground className="w-44 text-2xl" />
          <div className="mt-1 flex flex-wrap gap-1.5">
            {["w-[74px]", "w-16", "w-56", "w-[68px]"].map((width) => (
              <Skeleton key={width} className={`h-[22px] rounded-chip bg-track ${width}`} />
            ))}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <ButtonSkeleton className="w-[68px] bg-track" />
          <ButtonSkeleton className="w-[84px] bg-track" />
          <ButtonSkeleton className="w-[132px] bg-track" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** The settings tab while the project loads: the General card with its two fields and save bar. */
function SettingsSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="max-w-[760px]">
      <SectionCardSkeleton titleWidth="w-16" description={false} footer={<ButtonSkeleton className="ml-auto w-[62px]" />}>
        <div className="flex flex-col gap-4">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
      </SectionCardSkeleton>
    </LoadingRegion>
  );
}

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <SkeletonText className="w-24 text-[13px]" />
      <Skeleton className="h-[38px]" />
    </div>
  );
}
