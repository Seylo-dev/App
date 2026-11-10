// What each service screen asks for first, started from its route's loader
// (lib/prefetch.ts): when a link to it is hovered and again on navigation,
// in parallel with the screen's code, instead of after the layout rendered
// and services.get answered (withService). The inputs here are the ones the
// screens pass to useOp; the screens import the shared limits from this file
// so the two cannot drift apart.
//
// Keep this module light: route loaders stay in the app's first bundle
// (only route components are split), so it imports ops and helpers only,
// never a screen.

import { builds, deployments, domains, env, exposures, maintenance, metrics, projects, services } from "@seylo/ops";
import { prefetchOp, startPrefetch } from "../../lib/prefetch";
import type { RouterContext } from "../../lib/router-context";
import { isDatabaseKind } from "./status";

/** The Overview's latest-deploy card (overview-page.tsx LatestDeploy). */
export const latestDeployLimit = 5;
/** The Deployments tab's first page (deployments-page.tsx). */
export const deploymentsPageSize = 20;

type ServiceParams = { projectId: string; serviceId: string };

/** The service layout: the service and its project (the breadcrumb, header and tabs). */
export function prefetchServiceLayout(context: RouterContext, { projectId, serviceId }: ServiceParams): void {
  startPrefetch(() => Promise.all([prefetchOp(context, services.get, { serviceId }), prefetchOp(context, projects.get, { projectId })]));
}

/** Overview of an app (not a database, stack, box or cron job: those screens ask for other things). */
export function prefetchOverview(context: RouterContext, { serviceId }: ServiceParams): void {
  startPrefetch(() =>
    prefetchOp(context, services.get, { serviceId }).then((service) => {
      const kind = service?.kind;
      if (!kind || isDatabaseKind(kind) || kind === "compose" || kind === "box" || kind === "cron") return;
      return Promise.all([
        prefetchOp(context, deployments.list, { serviceId, limit: latestDeployLimit }),
        prefetchOp(context, domains.list, { serviceId }),
        prefetchOp(context, metrics.service, { serviceId, range: "1h" }),
      ]);
    }),
  );
}

export function prefetchDeployments(context: RouterContext, { serviceId }: ServiceParams): void {
  startPrefetch(() =>
    Promise.all([
      prefetchOp(context, deployments.list, { serviceId, limit: deploymentsPageSize }),
      prefetchOp(context, builds.getSettings, { serviceId }),
    ]),
  );
}

/**
 * The saved variables and the references; env.get keeps its answer for as
 * long as the editor is open (staleTime Infinity there), so a hover never
 * refetches what is cached.
 */
export function prefetchEnvironment(context: RouterContext, { serviceId }: ServiceParams): void {
  startPrefetch(() =>
    Promise.all([
      prefetchOp(context, env.get, { serviceId }, { staleTime: Number.POSITIVE_INFINITY }),
      prefetchOp(context, env.references, { serviceId }),
    ]),
  );
}

export function prefetchDomains(context: RouterContext, { serviceId }: ServiceParams): void {
  startPrefetch(() =>
    Promise.all([
      prefetchOp(context, domains.list, { serviceId }),
      prefetchOp(context, exposures.get, { serviceId }),
      prefetchOp(context, maintenance.get, { serviceId }),
    ]),
  );
}
