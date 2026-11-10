// The dashboard (Main.dc.html): node graphs, projects with their services,
// recent deploys and alerts. The layout follows the "panel" live topic, so
// every list here refreshes when something changes.

import { auth, type OpOutput, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconBox, IconLoader2, IconServer2 } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertsCard, RecentDeploys } from "../../components/dashboard/activity-cards";
import { NodeUsage } from "../../components/dashboard/node-usage";
import { ProjectCards } from "../../components/dashboard/project-cards";
import { NewServiceMenu } from "../../components/new-service/new-service-menu";
import { PageHeader } from "../../components/page-header";
import { useNow } from "../../components/service/use-now";
import { useShell } from "../../components/shell/shell-context";
import { t } from "../../i18n/t";
import { greeting } from "../../lib/greeting";
import { isBusy } from "../../lib/service-display";
import { type ServicesByProject, useAllServices } from "../../lib/use-all-services";

export const Route = createFileRoute("/_app/")({
  component: Dashboard,
});

function Dashboard() {
  const shell = useShell();
  const me = useOp(auth.whoami, {});
  // The hour on this device; a page left open past a boundary updates on the next minute tick.
  const now = useNow(60_000);
  const info = useOp(system.info, {});
  const everything = useAllServices();
  const busy = everything.all.filter(({ service }) => isBusy(service.status)).length;

  return (
    <>
      <PageHeader
        title={greeting(me.data?.viewer.name, new Date(now))}
        subtitle={
          // Counts only once they are known: "0 projects" while the lists load would be wrong.
          info.isPending || everything.pending ? (
            <SkeletonText ground className="w-44" />
          ) : (
            <DashboardCounts info={info.data} everything={everything} busy={busy} />
          )
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
      {/*
        Projects are the page's main list; deploys and alerts are a separate, quieter part under a line.
        On the page ground the line is the border token (the tab underline's): the divider token is for
        rows inside a card and vanishes on the light ground.
      */}
      <hr className="my-2 h-px shrink-0 border-0 bg-border" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentDeploys />
        <AlertsCard />
      </div>
    </>
  );
}

/**
 * "2 nodes", "5 services" (or projects while no project's list is in) and
 * "1 deploying" as small chips under the greeting; nodes opens the Nodes page.
 */
function DashboardCounts({
  info,
  everything,
  busy,
}: {
  info: OpOutput<typeof system.info> | undefined;
  everything: ServicesByProject;
  busy: number;
}) {
  const chip = "inline-flex items-center gap-1.5 rounded-chip bg-muted px-2 py-0.5 text-[12.5px] text-ink-strong";
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="dashboard-counts">
      {info && (
        <Link to="/nodes" className={cn(chip, "cursor-pointer no-underline transition-colors duration-200 hover:bg-track")}>
          <IconServer2 size={13} stroke={1.8} aria-hidden="true" />
          {t("dashboard.nodeCount", { count: info.nodes.total })}
        </Link>
      )}
      <span className={chip}>
        <IconBox size={13} stroke={1.8} aria-hidden="true" />
        {everything.services.size > 0
          ? t("sidebar.serviceCount", { count: everything.all.length })
          : t("dashboard.projectCount", { count: everything.projects.length })}
      </span>
      {busy > 0 && (
        <span className={cn(chip, "bg-chip-amber-bg text-chip-amber-fg")}>
          <IconLoader2 size={13} stroke={2} className="animate-spin" aria-hidden="true" />
          {t("dashboard.deploying", { count: busy })}
        </span>
      )}
    </span>
  );
}
