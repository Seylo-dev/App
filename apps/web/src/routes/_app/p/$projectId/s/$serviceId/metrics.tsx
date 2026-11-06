import { createFileRoute } from "@tanstack/react-router";
import { MetricsPage } from "../../../../../../components/service/metrics/metrics-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/metrics")({
  component: withService(MetricsPage),
});
