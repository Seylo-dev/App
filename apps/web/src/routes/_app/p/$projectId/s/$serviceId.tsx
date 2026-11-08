// Layout of every service screen: breadcrumb, header with the run actions,
// the live usage strip on runtime tabs, and the section tabs for the
// service's kind. Tabs render even when services.get fails, so a screen
// whose own ops work is still reachable.

import { projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { TabIndicator, TabList, tabClassName } from "@seylo/ui/components/tabs";
import { scrollFadeRef } from "@seylo/ui/lib/scroll-fade";
import { createFileRoute, Link, Outlet, useChildMatches, useRouterState } from "@tanstack/react-router";
import { DataCopyNote } from "../../../../../components/service/copy/data-copy-note";
import { OpErrorNote } from "../../../../../components/service/op-state";
import { ParentCrumb } from "../../../../../components/service/parent-crumb";
import { ServiceHeader } from "../../../../../components/service/service-header";
import { ServiceHeaderSkeleton, UsageStripSkeleton } from "../../../../../components/service/service-skeletons";
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
          {project.data?.name ?? (project.isPending ? <SkeletonText ground className="w-16" /> : projectId)}
        </Link>
        {parent && <ParentCrumb projectId={projectId} parentId={parent} />}
        <span aria-hidden="true">/</span>
        <span className="font-medium text-foreground">
          {service.data?.name ?? (service.isPending ? <SkeletonText ground className="w-14" /> : serviceId)}
        </span>
      </nav>
      {service.isPending ? (
        <ServiceHeaderSkeleton />
      ) : service.data ? (
        <ServiceHeader service={service.data} />
      ) : (
        <OpErrorNote error={service.error} />
      )}
      {service.data && <DataCopyNote service={service.data} />}
      {service.isPending && usageStripTabs.has(tabPath) && <UsageStripSkeleton />}
      {service.data && usageStripTabs.has(tabPath) && service.data.kind !== "compose" && <UsageStrip service={service.data} />}
      {/* One swipe row on a phone (the hidden edge fades); from md up the tabs wrap, so every tab shows. */}
      <TabList ref={scrollFadeRef} aria-label={t("service.sections")} className="scroll-row flex-nowrap md:flex-wrap md:overflow-visible">
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
