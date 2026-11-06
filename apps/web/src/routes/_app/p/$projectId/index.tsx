// A project (Project.dc.html): breadcrumb, name, counts, the private
// network, and five sections as tabs (?tab=): services, shared
// environment, people, activity and settings.

import { projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { TabIndicator, tabClassName } from "@seylo/ui/components/tabs";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { NewServiceMenu } from "../../../../components/new-service/new-service-menu";
import { PageHeader } from "../../../../components/page-header";
import { ProjectActivity } from "../../../../components/project/project-activity";
import { ProjectPeople, ShareDialog } from "../../../../components/project/project-people";
import { ProjectSettings } from "../../../../components/project/project-settings";
import { ServicesGrid } from "../../../../components/project/services-grid";
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

  if (project.isPending) return <Skeleton className="h-10 w-64" />;
  if (project.isError) return <QueryError error={project.error} onRetry={() => void project.refetch()} />;
  const { data } = project;
  const goTo = (next: Tab) => void navigate({ search: next === "services" ? {} : { tab: next } });

  return (
    <>
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

      <div role="tablist" aria-label={t("project.sections")} className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => goTo(item)}
            className={`cursor-pointer border-x-0 border-t-0 bg-transparent ${tabClassName}`}
          >
            {tab === item && <TabIndicator layoutId="project-tabs" />}
            {t(tabLabels[item])}
          </button>
        ))}
      </div>

      <EnterOnChange motionKey={tab} subtle role="tabpanel" aria-label={t(tabLabels[tab])}>
        {tab === "services" && <ServicesGrid projectId={data.id} canCreate={!data.protected} />}
        {tab === "env" && <SharedEnv projectId={data.id} />}
        {tab === "people" && <ProjectPeople projectId={data.id} onShare={() => setShareOpen(true)} />}
        {tab === "activity" && <ProjectActivity projectId={data.id} />}
        {tab === "settings" && <ProjectSettings key={data.updatedAt} project={data} />}
      </EnterOnChange>
      <ShareDialog projectId={data.id} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  );
}
