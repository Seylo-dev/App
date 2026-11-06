import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "../../../../../../components/service/overview/overview-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/")({
  component: withService(OverviewPage),
});
