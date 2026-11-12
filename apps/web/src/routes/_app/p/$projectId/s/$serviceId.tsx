// Layout of every service screen: breadcrumb, header with the run actions,
// the live usage strip (on every tab, so the tabs below never move when
// you switch), and the section tabs for the
// service's kind. Tabs render even when services.get fails, so a screen
// whose own ops work is still reachable.

import { domains, projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { TabIndicator, TabList, tabClassName } from "@seylo/ui/components/tabs";
import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { DataCopyNote } from "../../../../../components/service/copy/data-copy-note";
import { domainsNeedingSetup } from "../../../../../components/service/domains/needs-setup";
import { OpErrorNote } from "../../../../../components/service/op-state";
import { ParentCrumb } from "../../../../../components/service/parent-crumb";
import { ServiceHeader } from "../../../../../components/service/service-header";
import { ServiceHeaderSkeleton, UsageStripSkeleton } from "../../../../../components/service/service-skeletons";
import { prefetchServiceLayout } from "../../../../../components/service/tab-prefetch";
import { TransferNote } from "../../../../../components/service/transfer/transfer-note";
import { UsageStrip } from "../../../../../components/service/usage-strip";
import { useService } from "../../../../../components/service/use-service";
import { tabsFor } from "../../../../../components/service-tabs";
import { t } from "../../../../../i18n/t";
import { useLiveTopic } from "../../../../../lib/live";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId")({
  // The service and its project start on hover, not after the layout rendered (tab-prefetch.ts).
  loader: ({ context, params }) => prefetchServiceLayout(context, params),
  component: ServiceLayout,
});

function ServiceLayout() {
  const { projectId, serviceId } = Route.useParams();
  const project = useOp(projects.get, { projectId });
  const service = useService();
  useLiveTopic(`service:${serviceId}`);
  const kind = service.data?.kind;
  // A stack or a cron service shows the Domains tab only for the domains it has from before (service-tabs.ts).
  const strayKind = kind === "compose" || kind === "cron";
  // The same query the Domains tab and the overview read: the count costs nothing more.
  const domainList = useOp(domains.list, { serviceId }, { enabled: strayKind || tabsFor(kind).some((tab) => tab.path === "domains") });
  const tabs = tabsFor(kind, { strayDomains: strayKind && (domainList.data?.domains.length ?? 0) > 0 });
  const domainsToFix = domainsNeedingSetup(domainList.data?.domains);
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
      {service.data && <TransferNote service={service.data} />}
      {service.isPending && <UsageStripSkeleton />}
      {service.data && service.data.kind !== "compose" && <UsageStrip service={service.data} />}
      {/*
        A phone keeps one swipe row: the tabs scroll sideways (the hidden edge fades) and TabList keeps
        the current tab in view. From md up every tab shows, since a mouse cannot scroll a sideways row:
        a little closer together, an app's 16 tabs fit one row at 1440px; on a narrower screen they wrap,
        and each row gets its own track line (every tab is 40px tall there, so rows start every 40px and
        the line is each row's last pixel), so the current tab's underline sits on a line in any row.
      */}
      <TabList
        aria-label={t("service.sections")}
        className="md:flex-wrap md:gap-0 md:overflow-visible md:bg-[repeating-linear-gradient(to_bottom,transparent_0_39px,var(--border)_39px_40px)] md:shadow-none"
      >
        {tabs.map((tab) => (
          <Link
            key={tab.path}
            to={`/p/$projectId/s/$serviceId${tab.path ? `/${tab.path}` : ""}` as "/p/$projectId/s/$serviceId"}
            params={{ projectId, serviceId }}
            // A tab's own search (the Console tab's ?mode=shell) keeps the tab current.
            activeOptions={{ exact: true, includeSearch: false }}
            className={`${tabClassName} md:h-10 md:px-2 md:leading-5`}
          >
            {({ isActive }) => (
              <>
                {isActive && <TabIndicator layoutId="service-tabs" />}
                {t(tab.label)}
                {tab.path === "domains" && domainsToFix > 0 && (
                  <span
                    title={t("service.tabs.domainsToFix", { count: domainsToFix })}
                    className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-chip-red-bg px-1 text-[11px] font-semibold text-chip-red-fg"
                  >
                    <span aria-hidden="true">{domainsToFix}</span>
                    <span className="sr-only">{t("service.tabs.domainsToFix", { count: domainsToFix })}</span>
                  </span>
                )}
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
