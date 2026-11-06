// Layout of every service screen: breadcrumb, header with the run actions,
// the live usage strip on runtime tabs, and the section tabs for the
// service's kind. Tabs render even when services.get fails, so a screen
// whose own ops work is still reachable.

import { projects, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { TabIndicator, TabList, tabClassName } from "@seylo/ui/components/tabs";
import { createFileRoute, Link, Outlet, useChildMatches, useRouterState } from "@tanstack/react-router";
import { OpErrorNote, retryOp } from "../../../../../components/service/op-state";
import { ServiceHeader } from "../../../../../components/service/service-header";
import { UsageStrip } from "../../../../../components/service/usage-strip";
import { useService } from "../../../../../components/service/use-service";
import { type TabPath, tabsFor, usageStripTabs } from "../../../../../components/service-tabs";
import { t } from "../../../../../i18n/t";
import { useLiveTopic } from "../../../../../lib/live";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId")({
  component: ServiceLayout,
});

function ServiceLayout() {
  const { projectId, serviceId } = Route.useParams();
  const project = useOp(projects.get, { projectId });
  const service = useService();
  useLiveTopic(`service:${serviceId}`);
  const tabPath = useRouterState({
    select: (s) => (s.location.pathname.split(`/s/${serviceId}`)[1] ?? "").replace(/^\//, "").split("/")[0] as TabPath,
  });
  const tabs = tabsFor(service.data?.kind);
  const tabMatch = useChildMatches({ select: (matches) => matches[0]?.id ?? "" });
  const parent = service.data?.parentId;

  return (
    <>
      <nav aria-label={t("nav.breadcrumb")} className="flex flex-wrap gap-1.5 text-[13px] text-muted-foreground">
        <Link to="/p/$projectId" params={{ projectId }} className="text-muted-foreground">
          {project.data?.name ?? projectId}
        </Link>
        {parent && <ParentCrumb projectId={projectId} parentId={parent} />}
        <span aria-hidden="true">/</span>
        <span className="font-medium text-foreground">{service.data?.name ?? serviceId}</span>
      </nav>
      {service.isPending ? (
        <Skeleton className="h-10 w-80" />
      ) : service.data ? (
        <ServiceHeader service={service.data} />
      ) : (
        <OpErrorNote error={service.error} />
      )}
      {service.data && usageStripTabs.has(tabPath) && service.data.kind !== "compose" && <UsageStrip service={service.data} />}
      <TabList aria-label={t("service.sections")} className="flex-nowrap overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => (
          <Link
            key={tab.path}
            to={`/p/$projectId/s/$serviceId${tab.path ? `/${tab.path}` : ""}` as "/p/$projectId/s/$serviceId"}
            params={{ projectId, serviceId }}
            activeOptions={{ exact: true }}
            className={`${tabClassName} shrink-0 whitespace-nowrap`}
          >
            {({ isActive }) => (
              <>
                {isActive && <TabIndicator layoutId="service-tabs" />}
                {t(tab.label)}
              </>
            )}
          </Link>
        ))}
      </TabList>
      {/* A tab's screen fades in when you switch tabs; the header and tabs above stay put. */}
      <EnterOnChange motionKey={tabMatch} subtle className="flex min-w-0 flex-1 flex-col gap-5">
        <Outlet />
      </EnterOnChange>
    </>
  );
}

/** Compose members show their stack in the breadcrumb. */
function ParentCrumb({ projectId, parentId }: { projectId: string; parentId: string }) {
  const parent = useOp(services.get, { serviceId: parentId }, { retry: retryOp });
  return (
    <>
      <span aria-hidden="true">/</span>
      <Link to="/p/$projectId/s/$serviceId" params={{ projectId, serviceId: parentId }} className="text-muted-foreground">
        {parent.data?.name ?? parentId}
      </Link>
    </>
  );
}
