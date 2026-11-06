import { createFileRoute } from "@tanstack/react-router";
import { AlertsPage } from "../../../../../../components/service/alerts/alerts-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/alerts")({
  component: withService(AlertsPage),
});
