import { createFileRoute } from "@tanstack/react-router";
import { DeploymentsPage } from "../../../../../../components/service/deployments-page";
import { prefetchDeployments } from "../../../../../../components/service/tab-prefetch";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/deployments")({
  loader: ({ context, params }) => {
    prefetchDeployments(context, params);
  },
  component: withService(DeploymentsPage),
});
