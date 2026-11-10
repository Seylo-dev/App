import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage, OverviewSkeleton } from "../../../../../../components/service/overview/overview-page";
import { prefetchOverview } from "../../../../../../components/service/tab-prefetch";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/")({
  loader: ({ context, params }) => {
    prefetchOverview(context, params);
  },
  component: withService(OverviewPage, OverviewSkeleton),
});
