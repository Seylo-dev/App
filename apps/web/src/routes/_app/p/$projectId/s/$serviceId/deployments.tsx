import { createFileRoute } from "@tanstack/react-router";
import { DeploymentsPage } from "../../../../../../components/service/deployments-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/deployments")({
  component: withService(DeploymentsPage),
});
