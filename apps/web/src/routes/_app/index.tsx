// The dashboard (Main.dc.html): node graphs, projects with their services,
// recent deploys and alerts. The layout follows the "panel" live topic, so
// every list here refreshes when something changes.

import { type OpOutput, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { AlertsCard, RecentDeploys } from "../../components/dashboard/activity-cards";
import { NodeUsage } from "../../components/dashboard/node-usage";
import { ProjectCards } from "../../components/dashboard/project-cards";
import { NewServiceMenu } from "../../components/new-service/new-service-menu";
import { PageHeader } from "../../components/page-header";
import { useShell } from "../../components/shell/shell-context";
import { t } from "../../i18n/t";
import { isBusy } from "../../lib/service-display";
import { type ServicesByProject, useAllServices } from "../../lib/use-all-services";

export const Route = createFileRoute("/_app/")({
  component: Dashboard,
});

function Dashboard() {
  const shell = useShell();
  const info = useOp(system.info, {});
  const everything = useAllServices();
  const busy = everything.all.filter(({ service }) => isBusy(service.status)).length;

  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        subtitle={
          // Counts only once they are known: "0 projects" while the lists load would be wrong.
          info.isPending || everything.pending ? <SkeletonText ground className="w-44" /> : dashboardSubtitle(info.data, everything, busy)
        }
        actions={
          <>
            <Button onClick={shell.openNewProject}>{t("nav.newProject")}</Button>
            <NewServiceMenu />
          </>
        }
      />
      <NodeUsage />
      <ProjectCards data={everything} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentDeploys />
        <AlertsCard />
      </div>
    </>
  );
}

/** "2 nodes · 5 services · 1 deploying": services once any project's list is in, else projects. */
function dashboardSubtitle(info: OpOutput<typeof system.info> | undefined, everything: ServicesByProject, busy: number): string {
  const parts: string[] = [];
  if (info) parts.push(t("dashboard.nodeCount", { count: info.nodes.total }));
  if (everything.services.size > 0) parts.push(t("sidebar.serviceCount", { count: everything.all.length }));
  else parts.push(t("dashboard.projectCount", { count: everything.projects.length }));
  if (busy > 0) parts.push(t("dashboard.deploying", { count: busy }));
  return parts.join(t("format.separator"));
}
